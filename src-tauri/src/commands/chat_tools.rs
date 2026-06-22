use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use reqwest::header::USER_AGENT;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Emitter};
use tokio::time::timeout;

use crate::db;
use crate::documents::docx_gen;
use crate::llm::types::{ChatMessage, ToolCall, ToolDefinition};
use crate::mcp::manager::{mcp_result_to_text, McpManager};
use crate::security::path_sandbox::PathSandbox;
use crate::skills::{agent_classifier::AgentMode, loader::SkillMetadata, router, SkillRegistry};

use crate::workspace::{
    get_status, list_files, read_chunk as ws_read_chunk, read_file_relative, search,
};

use super::chat::StreamChunk;
use super::files::read_file_inner;
use super::trace::Tracer;
use crate::llm::tool_leak::{contains_tool_leakage, sanitize_assistant_content};
use serde_json::json;

pub const MAX_TOOL_ROUNDS: usize = 10;
const FETCH_URL_TIMEOUT_SECS: u64 = 20;
const FETCH_URL_DEFAULT_CHARS: usize = 20_000;
const FETCH_URL_MAX_CHARS: usize = 60_000;
const FETCH_URL_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskUserOption {
    pub label: String,
    pub value: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskUserQuestion {
    pub id: Option<String>,
    pub question: String,
    pub options: Vec<AskUserOption>,
    /// When true, the user may select multiple options; default single-select.
    pub allow_multiple: Option<bool>,
    pub allow_free_text: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskUserRequest {
    pub id: Option<String>,
    pub intro: Option<String>,
    pub questions: Vec<AskUserQuestion>,
}

pub struct ToolContext<'a> {
    pub app: &'a AppHandle,
    pub skills: &'a SkillRegistry,
    pub mcp: &'a McpManager,
    pub db: &'a Pool<Sqlite>,
    pub sandbox: &'a PathSandbox,
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    /// root_hash values for workspace directories bound to this message.
    pub workspace_root_ids: &'a [String],
    /// http/https URLs explicitly present in this user turn.
    pub allowed_urls: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadablePage {
    title: Option<String>,
    text: String,
}

fn http_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https?://[^\s<>"'`，。；、]+"#).expect("http url regex"))
}

fn trim_url_punctuation(raw: &str) -> &str {
    raw.trim_end_matches(|c: char| {
        matches!(
            c,
            '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '）' | '】' | '》'
        )
    })
}

pub(crate) fn extract_http_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for m in http_url_re().find_iter(text) {
        let candidate = trim_url_punctuation(m.as_str());
        if let Some(normalized) = normalize_http_url(candidate) {
            if !urls.iter().any(|u| u == &normalized) {
                urls.push(normalized);
            }
        }
    }
    urls
}

fn normalize_http_url(raw: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.to_string())
}

pub(crate) fn url_allowed_this_turn(url: &str, allowed_urls: &[String]) -> bool {
    let Some(normalized) = normalize_http_url(url) else {
        return false;
    };
    allowed_urls
        .iter()
        .filter_map(|u| normalize_http_url(u))
        .any(|allowed| allowed == normalized)
}

fn compact_text_segments<'a>(segments: impl Iterator<Item = &'a str>) -> String {
    let mut text = segments
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    for (from, to) in [
        (" .", "."),
        (" ,", ","),
        (" ;", ";"),
        (" :", ":"),
        (" !", "!"),
        (" ?", "?"),
        (" ）", "）"),
        (" 】", "】"),
        (" 》", "》"),
    ] {
        text = text.replace(from, to);
    }
    text
}

fn strip_html_noise(html: &str) -> String {
    let mut clean = html.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        let pattern = format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>");
        if let Ok(re) = Regex::new(&pattern) {
            clean = re.replace_all(&clean, " ").into_owned();
        }
    }
    clean
}

pub(crate) fn html_to_readable_text(html: &str) -> ReadablePage {
    let clean = strip_html_noise(html);
    let document = Html::parse_document(&clean);
    let title = Selector::parse("title")
        .ok()
        .and_then(|selector| document.select(&selector).next())
        .map(|el| compact_text_segments(el.text()))
        .filter(|s| !s.is_empty());

    let text = ["main", "article", "body"]
        .iter()
        .filter_map(|selector| Selector::parse(selector).ok())
        .filter_map(|selector| document.select(&selector).next())
        .map(|el| compact_text_segments(el.text()))
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| compact_text_segments(document.root_element().text()));

    ReadablePage { title, text }
}

pub(crate) fn truncate_with_notice(text: &str, max_chars: usize, label: &str) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let head = text.chars().take(max_chars).collect::<String>();
    format!("{head}\n\n[{label}已截断，共 {total} 字符]")
}

async fn fetch_url_inner(
    url: &str,
    allowed_urls: &[String],
    max_chars: Option<u64>,
) -> Result<String, String> {
    if !url_allowed_this_turn(url, allowed_urls) {
        return Err("只能读取用户本轮消息中明确提供的 http/https URL".into());
    }

    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL 不合法: {}", e))?;
    let max_chars = max_chars
        .map(|n| n as usize)
        .unwrap_or(FETCH_URL_DEFAULT_CHARS)
        .clamp(1, FETCH_URL_MAX_CHARS);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(FETCH_URL_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建网页客户端失败: {}", e))?;

    let resp = client
        .get(parsed.clone())
        .header(USER_AGENT, "Inkstatute/0.1 legal-research")
        .send()
        .await
        .map_err(|e| format!("网页请求失败: {}", e))?;

    let final_url = resp.url().to_string();
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    if !status.is_success() {
        return Err(format!("网页请求返回 HTTP {}", status.as_u16()));
    }
    if resp.content_length().unwrap_or(0) > FETCH_URL_MAX_BYTES {
        return Err(format!("网页响应超过 {} 字节上限", FETCH_URL_MAX_BYTES));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取网页正文失败: {}", e))?;
    let readable = if content_type.to_lowercase().contains("html")
        || body.trim_start().to_lowercase().starts_with("<!doctype")
        || body.trim_start().to_lowercase().starts_with("<html")
    {
        html_to_readable_text(&body)
    } else {
        ReadablePage {
            title: None,
            text: compact_text_segments(body.lines()),
        }
    };
    let text = truncate_with_notice(&readable.text, max_chars, "网页正文");
    let mut out = vec![
        format!("URL: {}", parsed),
        format!("最终 URL: {}", final_url),
        format!("Content-Type: {}", content_type),
    ];
    if let Some(title) = readable.title {
        out.push(format!("标题: {}", title));
    }
    out.push(format!("正文摘录:\n{}", text));
    Ok(out.join("\n"))
}

fn primary_workspace_root(ctx: &ToolContext<'_>) -> Result<String, String> {
    ctx.workspace_root_ids
        .first()
        .cloned()
        .ok_or_else(|| "未绑定 workspace 目录，请先 @ 选择案卷文件夹。".to_string())
}

/// Resolve user file paths, or skill-repo relative paths like `commercial-legal/CLAUDE.md`.
async fn resolve_read_path(ctx: &ToolContext<'_>, path: &str) -> Result<PathBuf, String> {
    if let Ok(p) = ctx.sandbox.validate(path) {
        return Ok(p);
    }

    if let Some(skills_root) = ctx.skills.get_skills_root().await {
        let trimmed = path.trim().trim_start_matches("./");
        let under_root = skills_root.join(trimmed);
        if under_root.exists() {
            return under_root
                .canonicalize()
                .map_err(|e| format!("cannot resolve path: {} ({})", path, e));
        }
    }

    ctx.sandbox.validate(path).map_err(|e| e.to_string())
}

pub async fn build_all_tools(
    mcp: &McpManager,
    mode: AgentMode,
    include_workspace: bool,
) -> Vec<ToolDefinition> {
    let mut tools = router::build_builtin_tool_definitions(mode, include_workspace);
    tools.extend(mcp.build_tool_definitions().await);
    tools
}

pub fn parse_ask_user_args(args: &Value) -> Result<AskUserRequest, String> {
    let mut req: AskUserRequest = serde_json::from_value(args.clone())
        .map_err(|e| format!("Invalid ask_user args: {}", e))?;
    req.questions.retain(|q| !q.question.trim().is_empty());
    if req.questions.is_empty() {
        return Err("ask_user requires at least one question".into());
    }
    req.questions.truncate(4);
    for (idx, q) in req.questions.iter_mut().enumerate() {
        if q.id.as_deref().unwrap_or("").trim().is_empty() {
            q.id = Some(format!("q{}", idx + 1));
        }
        q.options.retain(|o| !o.label.trim().is_empty());
        for opt in &mut q.options {
            if opt.value.as_deref().unwrap_or("").trim().is_empty() {
                opt.value = Some(opt.label.clone());
            }
        }
        if q.options.is_empty() {
            q.options.push(AskUserOption {
                label: "由我补充".into(),
                value: Some("由我补充".into()),
                description: None,
            });
        }
    }
    Ok(req)
}

pub async fn execute_tool(
    ctx: &ToolContext<'_>,
    tool_call: &ToolCall,
    active_skill: &mut Option<SkillMetadata>,
) -> Result<String, String> {
    let args: Value = serde_json::from_str(&tool_call.function.arguments)
        .map_err(|e| format!("Invalid tool arguments: {}", e))?;

    let name = tool_call.function.name.as_str();

    if McpManager::is_mcp_tool(name) {
        let call = ctx.mcp.call_tool_by_name(name, args);
        return match timeout(Duration::from_secs(60), call).await {
            Ok(Ok(r)) => Ok(mcp_result_to_text(&r)),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("MCP 工具调用超时（60秒）".to_string()),
        };
    }

    match name {
        "select_skill" => {
            let skill_name = args
                .get("skill_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "skill_name required".to_string())?;
            let reason = args.get("reason").and_then(|v| v.as_str()).unwrap_or("");

            if let Some(skill) = ctx.skills.find_skill_fuzzy(skill_name).await {
                *active_skill = Some(skill.clone());
                Ok(format!(
                    "已激活技能「{}」（插件 {}）。原因：{}。请按该技能指引继续。",
                    skill.name, skill.plugin_name, reason
                ))
            } else {
                Ok(format!(
                    "未找到技能「{}」。请调用 select_skill 并传入可用技能列表中的 skill_name，勿使用 read_user_file 读取技能文件。",
                    skill_name
                ))
            }
        }
        "ask_user" => {
            let _ = parse_ask_user_args(&args)?;
            Ok("已向用户提出澄清问题，等待用户回答后继续。".into())
        }
        "read_user_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "path required".to_string())?;
            let validated = resolve_read_path(ctx, path).await?;
            read_file_inner(&validated).await
        }
        "fetch_url" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "url required".to_string())?;
            let max_chars = args.get("max_chars").and_then(|v| v.as_u64());
            fetch_url_inner(url, ctx.allowed_urls, max_chars).await
        }
        "generate_docx" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "title required".to_string())?;
            let content = args
                .get("content_markdown")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "content_markdown required".to_string())?;
            let output_path = args
                .get("output_path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "output_path required".to_string())?;

            let validated = ctx
                .sandbox
                .validate(output_path)
                .map_err(|e| e.to_string())?;
            docx_gen::generate_docx(title, content, &validated).map_err(|e| e.to_string())?;

            if let Ok(doc_json) = serde_json::to_string(&serde_json::json!({
                "title": title,
                "content_markdown": content,
                "output_path": validated.to_string_lossy(),
            })) {
                let _ =
                    db::queries::save_document(ctx.db, Some(ctx.conversation_id), title, &doc_json)
                        .await;
            }

            Ok(format!("DOCX 已生成: {}", validated.display()))
        }
        "legal_search" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "query required".to_string())?;
            let scope = crate::law_library::orchestrator::SearchScope::parse(
                args.get("scope").and_then(|v| v.as_str()),
            );
            let k = args
                .get("k")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 20) as usize;
            crate::law_library::orchestrator::legal_search(ctx.mcp, query, scope, k).await
        }
        "search_law" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "query required".to_string())?;
            let k = args
                .get("k")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 20) as usize;
            crate::law_library::search_law(query, k)
                .await
                .map_err(|e| e.to_string())
        }
        "get_law_article" => {
            let law_name = args
                .get("law_name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "law_name required".to_string())?;
            let article = args
                .get("article")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "article required".to_string())?;
            crate::law_library::get_article(law_name, article)
                .await
                .map_err(|e| e.to_string())
        }
        "search_workspace" => {
            let root_id = primary_workspace_root(ctx)?;
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "query required".to_string())?;
            let k = args
                .get("k")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 30) as usize;
            let hits = search(&root_id, query, k)
                .await
                .map_err(|e| e.to_string())?;
            if hits.is_empty() {
                Ok(format!("未找到与「{}」相关的 chunk。可尝试换关键词或调用 get_index_status 确认索引是否完成。", query))
            } else {
                let lines: Vec<String> = hits
                    .iter()
                    .map(|h| {
                        let preview: String = h.text.chars().take(200).collect();
                        format!(
                            "- chunk_id={} path={} score={:.2}\n  {}",
                            h.chunk_id, h.relative_path, h.score, preview
                        )
                    })
                    .collect();
                Ok(format!(
                    "找到 {} 条结果：\n{}",
                    hits.len(),
                    lines.join("\n")
                ))
            }
        }
        "read_chunk" => {
            let chunk_id = args
                .get("chunk_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "chunk_id required".to_string())?;
            let detail = ws_read_chunk(chunk_id).await.map_err(|e| e.to_string())?;
            Ok(format!(
                "chunk_id: {}\nrelative_path: {}\nheading_path: {}\n\n{}",
                detail.chunk_id,
                detail.relative_path,
                detail.heading_path.join(" > "),
                detail.text
            ))
        }
        "read_file" => {
            let root_id = primary_workspace_root(ctx)?;
            let relative_path = args
                .get("relative_path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "relative_path required".to_string())?;
            let max_chars = args
                .get("max_chars")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            read_file_relative(&root_id, relative_path, max_chars)
                .await
                .map_err(|e| e.to_string())
        }
        "list_files" => {
            let root_id = primary_workspace_root(ctx)?;
            let pattern = args.get("pattern").and_then(|v| v.as_str());
            let paths = list_files(&root_id, pattern)
                .await
                .map_err(|e| e.to_string())?;
            if paths.is_empty() {
                Ok("（无已索引文件）".into())
            } else {
                Ok(format!("共 {} 个文件：\n{}", paths.len(), paths.join("\n")))
            }
        }
        "get_index_status" => {
            let root_id = primary_workspace_root(ctx)?;
            let status = get_status(&root_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "workspace 尚未建立索引".to_string())?;
            Ok(format!(
                "root_id: {}\nroot_path: {}\nstatus: {}\nfile_count: {}\nchunk_count: {}",
                status.root_id,
                status.root_path,
                status.status,
                status.file_count,
                status.chunk_count
            ))
        }
        other => Err(format!("Unknown tool: {}", other)),
    }
}

pub async fn stream_response(
    app: &AppHandle,
    provider: Arc<dyn crate::llm::provider::LlmProvider>,
    request: crate::llm::types::ChatRequest,
    conversation_id: &str,
    message_id: &str,
    emit_done: bool,
    tracer: Option<&Tracer>,
) -> Result<String, String> {
    use futures::StreamExt;

    if let Some(t) = tracer {
        t.emit("stream_start", json!({ "model": request.model }));
    }

    let stream = match provider.chat_stream(&request).await {
        Ok(s) => s,
        Err(e) => {
            // Keep stream_start/stream_done paired even when connect fails.
            if let Some(t) = tracer {
                t.emit(
                    "stream_done",
                    json!({ "chars": 0, "reasoning_chars": 0, "connect_error": e.to_string() }),
                );
            }
            return Err(e.to_string());
        }
    };
    let mut full_response = String::new();
    let mut reasoning_chars = 0usize;
    let mut stream = stream;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(text) => {
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            continue;
                        }
                        if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                            // Some providers attach usage to the final SSE chunk.
                            if let Some(usage) = chunk.get("usage") {
                                if !usage.is_null() {
                                    if let Some(t) = tracer {
                                        t.emit("stream_usage", json!({ "usage": usage }));
                                    }
                                }
                            }
                            if let Some(choices) = chunk.get("choices").and_then(|c| c.as_array()) {
                                for choice in choices {
                                    if let Some(delta) = choice.get("delta") {
                                        if let Some(reasoning) = delta
                                            .get("reasoning_content")
                                            .or_else(|| delta.get("reasoning"))
                                            .and_then(|c| c.as_str())
                                        {
                                            if !reasoning.is_empty() {
                                                reasoning_chars += reasoning.chars().count();
                                                if let Some(t) = tracer {
                                                    t.emit(
                                                        "thinking_delta",
                                                        json!({ "text": reasoning }),
                                                    );
                                                }
                                            }
                                        }
                                        if let Some(content) =
                                            delta.get("content").and_then(|c| c.as_str())
                                        {
                                            full_response.push_str(content);
                                            // Raw delta for the dev trace — including
                                            // leaked markup the chat channel filters out.
                                            if let Some(t) = tracer {
                                                t.emit("stream_delta", json!({ "text": content }));
                                            }
                                            if !contains_tool_leakage(content)
                                                && !contains_tool_leakage(&full_response)
                                            {
                                                let _ = app.emit(
                                                    "chat-stream",
                                                    StreamChunk {
                                                        conversation_id: conversation_id
                                                            .to_string(),
                                                        message_id: message_id.to_string(),
                                                        chunk: content.to_string(),
                                                        done: false,
                                                        status: None,
                                                    },
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Stream error: {}", e);
                if let Some(t) = tracer {
                    t.emit(
                        "error",
                        json!({ "stage": "stream", "message": e.to_string() }),
                    );
                }
                break;
            }
        }
    }

    if let Some(t) = tracer {
        t.emit(
            "stream_done",
            json!({
                "chars": full_response.chars().count(),
                "reasoning_chars": reasoning_chars,
            }),
        );
    }

    if emit_done {
        let _ = app.emit(
            "chat-stream",
            StreamChunk {
                conversation_id: conversation_id.to_string(),
                message_id: message_id.to_string(),
                chunk: String::new(),
                done: true,
                status: None,
            },
        );
    }

    Ok(full_response)
}

/// Emit a complete assistant reply as a single stream event (skip LLM re-stream).
pub fn emit_text_response(app: &AppHandle, conversation_id: &str, message_id: &str, text: &str) {
    let clean = sanitize_assistant_content(text);
    if !clean.is_empty() {
        let _ = app.emit(
            "chat-stream",
            StreamChunk {
                conversation_id: conversation_id.to_string(),
                message_id: message_id.to_string(),
                chunk: clean,
                done: false,
                status: Some("streaming".into()),
            },
        );
    }
    let _ = app.emit(
        "chat-stream",
        StreamChunk {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            chunk: String::new(),
            done: true,
            status: None,
        },
    );
}

pub fn append_tool_results(
    messages: &mut Vec<ChatMessage>,
    assistant_msg: ChatMessage,
    tool_results: Vec<(String, String)>,
) {
    messages.push(assistant_msg);
    for (tool_call_id, result) in tool_results {
        messages.push(ChatMessage {
            reasoning_content: None,
            role: "tool".into(),
            content: result,
            name: None,
            tool_calls: None,
            tool_call_id: Some(tool_call_id),
        });
    }
}

/// Rebuild system prompt when active skill changes.
pub fn build_messages(
    all_skills: &[SkillMetadata],
    research_gate: Option<&str>,
    active_skill: Option<&SkillMetadata>,
    mode: AgentMode,
    retrieval_tools: &[String],
    history: Vec<ChatMessage>,
    user_content: String,
) -> Vec<ChatMessage> {
    let system_prompt = router::build_system_prompt(
        all_skills,
        research_gate,
        active_skill,
        mode,
        retrieval_tools,
    );

    let mut messages = vec![ChatMessage {
        reasoning_content: None,
        role: "system".into(),
        content: system_prompt,
        name: None,
        tool_calls: None,
        tool_call_id: None,
    }];

    messages.extend(history);
    messages.push(ChatMessage {
        reasoning_content: None,
        role: "user".into(),
        content: user_content,
        name: None,
        tool_calls: None,
        tool_call_id: None,
    });

    messages
}

pub fn update_system_prompt(
    messages: &mut Vec<ChatMessage>,
    all_skills: &[SkillMetadata],
    research_gate: Option<&str>,
    active_skill: Option<&SkillMetadata>,
    mode: AgentMode,
    retrieval_tools: &[String],
) {
    let system_prompt = router::build_system_prompt(
        all_skills,
        research_gate,
        active_skill,
        mode,
        retrieval_tools,
    );
    if let Some(first) = messages.first_mut() {
        if first.role == "system" {
            first.content = system_prompt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ask_user_args_preserves_allow_multiple() {
        let args = json!({
            "questions": [{
                "question": "涉及哪类业务？",
                "allow_multiple": true,
                "options": [{ "label": "租赁" }, { "label": "买卖" }]
            }]
        });
        let req = parse_ask_user_args(&args).expect("parse");
        assert_eq!(req.questions.len(), 1);
        assert_eq!(req.questions[0].allow_multiple, Some(true));
    }

    #[test]
    fn parse_ask_user_args_defaults_single_select() {
        let args = json!({
            "questions": [{
                "question": "代理哪一方？",
                "options": [{ "label": "原告" }]
            }]
        });
        let req = parse_ask_user_args(&args).expect("parse");
        assert_eq!(req.questions[0].allow_multiple, None);
    }

    #[test]
    fn extracts_http_urls_from_user_text_and_trims_sentence_punctuation() {
        let urls = extract_http_urls(
            "参考 https://example.com/a?b=1，另见 http://docs.example.test/path.",
        );
        assert_eq!(
            urls,
            vec![
                "https://example.com/a?b=1".to_string(),
                "http://docs.example.test/path".to_string()
            ]
        );
    }

    #[test]
    fn fetch_url_must_be_from_current_user_turn() {
        let allowed = vec!["https://example.com/a?b=1".to_string()];
        assert!(url_allowed_this_turn("https://example.com/a?b=1", &allowed));
        assert!(!url_allowed_this_turn(
            "https://example.com/other",
            &allowed
        ));
        assert!(!url_allowed_this_turn("file:///C:/secret.txt", &allowed));
    }

    #[test]
    fn extracts_readable_text_from_html_without_script_or_style() {
        let page = html_to_readable_text(
            r#"<!doctype html>
            <html>
              <head><title>Example Title</title><style>.x{display:none}</style></head>
              <body>
                <script>console.log("secret")</script>
                <main><h1>Heading</h1><p>First <strong>paragraph</strong>.</p></main>
              </body>
            </html>"#,
        );
        assert_eq!(page.title.as_deref(), Some("Example Title"));
        assert!(page.text.contains("Heading"));
        assert!(page.text.contains("First paragraph."));
        assert!(!page.text.contains("secret"));
    }

    #[test]
    fn truncates_url_content_by_char_count_with_notice() {
        let text = "abcdef";
        let truncated = truncate_with_notice(text, 4, "网页正文");
        assert_eq!(truncated, "abcd\n\n[网页正文已截断，共 6 字符]");
    }
}
