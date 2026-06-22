use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::db::{self, models::FileAttachment};
use crate::llm::tool_leak::{
    contains_tool_leakage, parse_embedded_tool_calls, sanitize_assistant_content,
};
use crate::llm::types::{ChatMessage, ChatRequest, ToolCall};
use crate::llm::LlmEngine;
use crate::mcp::manager::McpManager;
use crate::security::path_sandbox::PathSandbox;
use crate::skills::agent_classifier::{self, AgentMode, ClassifyContext, ClassifyResult};
use crate::skills::loader;
use crate::skills::SkillRegistry;
use crate::workspace::{get_status_for_path, hash_root_path};
use sqlx::{Pool, Sqlite};

use super::chat_tools::{
    append_tool_results, build_all_tools, build_messages, emit_text_response, execute_tool,
    extract_http_urls, parse_ask_user_args, stream_response, update_system_prompt, AskUserRequest,
    ToolContext, MAX_TOOL_ROUNDS,
};
use super::files::{grant_directory_access, prepare_directory_context};
use super::trace::{preview, Tracer};
use super::workspace::spawn_bind_and_index;

/// Same request is retried verbatim this many times when the provider leaks
/// unparseable tool markup into content (gateway-side, intermittent) —
/// polluting history with the leaked text only teaches the model the syntax.
const MAX_LEAK_RETRIES: usize = 3;

/// Auto-continue this many times when the final answer hits the token limit
/// (`finish_reason == "length"`).
const MAX_CONTINUATIONS: usize = 4;

const RESPONSE_MAX_TOKENS: u64 = 8192;

const CONTINUE_INSTRUCTION: &str =
    "你的上一条输出因长度限制被截断。请直接从中断处继续输出剩余内容：\
不要重复任何已输出的文字，不要重新开头，不要解释，直接续写。";

const LEAK_FALLBACK_INSTRUCTION: &str = "注意：请不要再尝试调用任何工具。\
请基于以上已获取的工具结果与上下文，直接输出完整的 Markdown 分析正文。\
如证据不足，请明确列出缺失的材料清单。正文中禁止出现任何工具调用语法或标记。";

const LEAK_ERROR_MESSAGE: &str =
    "**分析未完成：** 模型多次返回无法解析的工具调用残留，未能生成可读报告。\
请重试，或在设置中更换支持标准工具调用的模型。";

/// Recover workspace root hashes recorded as `root_id=<sha256-hex>` lines in
/// earlier user-turn context blocks.
fn extract_workspace_root_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for chunk in text.split("root_id=").skip(1) {
        let id: String = chunk
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if id.len() == 64 && !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

/// Extract Windows absolute paths from free-form user text (supports CJK path segments).
fn extract_directory_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i + 2 < chars.len() {
        if chars[i].is_ascii_alphabetic() && chars[i + 1] == ':' {
            let start = i;
            i += 2;
            while i < chars.len() {
                let c = chars[i];
                if c.is_whitespace() || "，。；,.".contains(c) {
                    break;
                }
                i += 1;
            }
            let candidate: String = chars[start..i].iter().collect();
            let trimmed = candidate.trim_end_matches(|c: char| "，。；,.".contains(c));
            if let Ok(canon) = std::path::Path::new(trimmed).canonicalize() {
                if canon.is_dir() {
                    let s = canon.to_string_lossy().to_string();
                    if !paths.iter().any(|p| p == &s) {
                        paths.push(s);
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    paths
}

async fn append_directory_workspace_context(
    app: &AppHandle,
    db: &Pool<Sqlite>,
    sandbox: &Arc<RwLock<PathSandbox>>,
    conversation_id: &str,
    alias: &str,
    path: &str,
    user_content: &mut String,
    workspace_root_ids: &mut Vec<String>,
) -> Result<(), String> {
    let granted = grant_directory_access(db, sandbox, path).await?;
    let root_id = hash_root_path(&granted);
    if !workspace_root_ids.contains(&root_id) {
        workspace_root_ids.push(root_id.clone());
    }

    spawn_bind_and_index(app, granted.clone(), Some(conversation_id.to_string()));

    let status_line = match get_status_for_path(&granted).await {
        Ok(Some(st)) if st.status == "ready" => format!(
            "workspace 已索引：{} 个文件，{} 个 chunk。请使用 search_workspace 检索，勿 inline 全目录。root_id={}",
            st.file_count, st.chunk_count, st.root_id
        ),
        Ok(Some(st)) => format!(
            "workspace 索引中（status={}，已索引 {} 文件 / {} chunk）。可先 search_workspace 检索已解析部分。root_id={}",
            st.status, st.file_count, st.chunk_count, st.root_id
        ),
        _ => {
            let manifest = prepare_directory_context(sandbox, &granted).await?;
            format!(
                "workspace 正在后台建立索引。{}\nroot_id={}",
                manifest, root_id
            )
        }
    };

    user_content.push_str(&format!(
        "@{} (目录: {})\n{}\n\n",
        alias, granted, status_line
    ));
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRef {
    pub alias: String,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub conversation_id: String,
    pub content: String,
    pub attachments: Option<Vec<FileAttachment>>,
    pub context_refs: Option<Vec<ContextRef>>,
    pub ui_hidden: Option<bool>,
    /// When the client already resolved the mode (per-turn pre-flight classify
    /// or a confirmed switch), the backend honors it and skips re-classifying.
    #[serde(default)]
    pub forced_mode: Option<String>,
    #[serde(default)]
    pub forced_label: Option<String>,
    /// Current producing task context, used only if the backend must classify
    /// because no forced_mode was supplied.
    #[serde(default)]
    pub current_mode: Option<String>,
    #[serde(default)]
    pub current_task_label: Option<String>,
    #[serde(default)]
    pub has_active_document: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyAgentModeRequest {
    pub content: String,
    pub context_refs: Option<Vec<ContextRef>>,
    /// Mode of the task currently owning the right-side artifact, if any.
    #[serde(default)]
    pub current_mode: Option<String>,
    #[serde(default)]
    pub current_task_label: Option<String>,
    #[serde(default)]
    pub has_active_document: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenerateFollowupPromptsRequest {
    pub conversation_id: String,
    pub message_id: String,
    pub mode: Option<String>,
    pub user_prompt: Option<String>,
    pub summary: Option<String>,
}

#[tauri::command]
pub async fn classify_agent_mode(
    engine: State<'_, LlmEngine>,
    req: ClassifyAgentModeRequest,
) -> Result<ClassifyResult, String> {
    let refs = req.context_refs.unwrap_or_default();
    let has_directory_ref = refs.iter().any(|r| r.kind == "directory")
        || !extract_directory_paths(&req.content).is_empty();
    let has_file_ref = refs.iter().any(|r| r.kind == "file");
    let directory_aliases: Vec<String> = refs
        .iter()
        .filter(|r| r.kind == "directory")
        .map(|r| r.alias.clone())
        .collect();

    let ctx = ClassifyContext {
        user_message: req.content,
        has_directory_ref,
        has_file_ref,
        directory_aliases,
        current_mode: req.current_mode,
        current_task_label: req.current_task_label,
        has_active_document: req.has_active_document.unwrap_or(false),
    };

    let fast = engine
        .get_fast_provider()
        .await
        .map_err(|e| e.to_string())?;
    let primary = engine.get_provider().await.map_err(|e| e.to_string())?;
    Ok(
        agent_classifier::classify_agent_mode_with_retry(fast.as_ref(), primary.as_ref(), &ctx)
            .await,
    )
}

#[tauri::command]
pub async fn update_message_metadata(
    db: State<'_, Pool<Sqlite>>,
    message_id: String,
    metadata_json: String,
) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&metadata_json)
        .map_err(|e| format!("metadata_json 不是合法 JSON: {}", e))?;
    db::queries::update_message_metadata(&db, &message_id, &metadata_json)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_followup_prompts(
    app: AppHandle,
    engine: State<'_, LlmEngine>,
    db: State<'_, Pool<Sqlite>>,
    req: GenerateFollowupPromptsRequest,
) -> Result<Vec<String>, String> {
    let tracer = Tracer::new(&app, &req.conversation_id, &req.message_id);
    let provider = match engine.get_fast_provider().await {
        Ok(p) => p,
        Err(e) => {
            tracer.emit(
                "followup_result",
                json!({ "ok": false, "reason": "no_fast_provider", "error": e.to_string() }),
            );
            return Ok(Vec::new());
        }
    };

    let rows = db::queries::list_messages(&db, &req.conversation_id)
        .await
        .unwrap_or_default();
    let last_user = rows
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| preview(&m.content, 500))
        .unwrap_or_default();
    let mode = req.mode.unwrap_or_else(|| "chat".into());
    let summary = req.summary.unwrap_or_default();
    let user_prompt = req.user_prompt.unwrap_or(last_user);
    let prompt = format!(
        "你是中国律师桌面助手的提示词推荐器。请基于刚完成的一轮任务生成 3 个后续可点击提示词。\n\
要求：中文；每条 6-18 个字；必须是用户下一步可直接发给助手的动作；不要解释；只输出 JSON 字符串数组。\n\
模式：{}\n用户需求：{}\n完成摘要：{}\n消息ID：{}",
        mode, user_prompt, summary, req.message_id
    );

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![
            ChatMessage {
                reasoning_content: None,
                role: "system".into(),
                content: "只输出 JSON 字符串数组，不要 Markdown。".into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                reasoning_content: None,
                role: "user".into(),
                content: prompt,
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        tools: None,
        temperature: Some(0.4),
        max_tokens: Some(256),
        stream: false,
    };

    // One retry — the deepseek gateway intermittently fails short requests.
    let response = match provider.chat(&request).await {
        Ok(r) => Ok(r),
        Err(first_err) => {
            log::warn!("Followup prompt request failed, retrying: {}", first_err);
            provider.chat(&request).await
        }
    };
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            tracer.emit(
                "followup_result",
                json!({ "ok": false, "reason": "llm_error", "error": e.to_string() }),
            );
            return Err(e.to_string());
        }
    };
    let content = response
        .choices
        .first()
        .and_then(|c| c.message.as_ref())
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let items = parse_followup_prompts(&content);
    tracer.emit(
        "followup_result",
        json!({
            "ok": true,
            "count": items.len(),
            "items": items.clone(),
            "raw_preview": preview(&content, 300),
        }),
    );
    Ok(items)
}

fn build_classify_context(
    content: &str,
    context_refs: Option<&Vec<ContextRef>>,
    current_mode: Option<String>,
    current_task_label: Option<String>,
    has_active_document: bool,
) -> ClassifyContext {
    let refs = context_refs.cloned().unwrap_or_default();
    let has_directory_ref =
        refs.iter().any(|r| r.kind == "directory") || !extract_directory_paths(content).is_empty();
    let has_file_ref = refs.iter().any(|r| r.kind == "file");
    let directory_aliases: Vec<String> = refs
        .iter()
        .filter(|r| r.kind == "directory")
        .map(|r| r.alias.clone())
        .collect();
    ClassifyContext {
        user_message: content.to_string(),
        has_directory_ref,
        has_file_ref,
        directory_aliases,
        current_mode,
        current_task_label,
        has_active_document,
    }
}

fn parse_followup_prompts(content: &str) -> Vec<String> {
    let trimmed = content.trim();
    if let Ok(items) = serde_json::from_str::<Vec<String>>(trimmed) {
        return clean_followup_items(items);
    }
    if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        if start < end {
            if let Ok(items) = serde_json::from_str::<Vec<String>>(&trimmed[start..=end]) {
                return clean_followup_items(items);
            }
        }
    }
    let items = trimmed
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(|c: char| {
                    c.is_ascii_digit() || c == '.' || c == '-' || c == '*' || c == '、'
                })
                .trim()
                .trim_matches('"')
                .to_string()
        })
        .collect::<Vec<_>>();
    clean_followup_items(items)
}

fn clean_followup_items(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let cleaned = item.trim().trim_matches('`').trim().to_string();
        if cleaned.is_empty() || out.iter().any(|s| s == &cleaned) {
            continue;
        }
        out.push(cleaned.chars().take(24).collect());
        if out.len() >= 3 {
            break;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub conversation_id: String,
    pub message_id: String,
    pub chunk: String,
    pub done: bool,
    /// Frontend progress hint: thinking | tool | streaming | error
    pub status: Option<String>,
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    engine: State<'_, LlmEngine>,
    skills: State<'_, SkillRegistry>,
    mcp: State<'_, McpManager>,
    db: State<'_, Pool<Sqlite>>,
    sandbox: State<'_, Arc<RwLock<PathSandbox>>>,
    req: SendMessageRequest,
) -> Result<String, String> {
    let provider = engine.get_provider().await.map_err(|e| e.to_string())?;

    let message_id = Uuid::new_v4().to_string();
    let conversation_id = req.conversation_id.clone();
    let tracer = Tracer::new(&app, &conversation_id, &message_id);
    tracer.emit(
        "turn_start",
        json!({
            "model": provider.model_name(),
            "content_chars": req.content.chars().count(),
            "content_preview": preview(&req.content, 400),
            "attachments": req.attachments.as_ref().map(|a| a.len()).unwrap_or(0),
            "context_refs": req.context_refs.as_ref().map(|refs| {
                refs.iter()
                    .map(|c| json!({"alias": c.alias, "kind": c.kind, "path": c.path}))
                    .collect::<Vec<_>>()
            }).unwrap_or_default(),
        }),
    );

    let all_skills = skills.get_skills().await;
    tracer.emit(
        "skills_loaded",
        json!({
            "count": all_skills.len(),
            "names": all_skills.iter().take(60).map(|s| s.name.clone()).collect::<Vec<_>>(),
        }),
    );

    let research_gate = if let Some(root) = skills.get_skills_root().await {
        loader::load_research_gate(&root).await
    } else {
        None
    };
    let research_gate_ref = research_gate.as_deref();

    let mut active_skill: Option<crate::skills::loader::SkillMetadata> = None;
    let mut workspace_root_ids: Vec<String> = Vec::new();
    let allowed_urls = extract_http_urls(&req.content);

    let mut user_content = req.content.clone();
    if let Some(ref attachments) = req.attachments {
        for att in attachments {
            if let Some(ref preview) = att.content_preview {
                user_content.push_str(&format!("\n\n--- 文件: {} ---\n{}", att.name, preview));
            }
        }
    }

    if let Some(ref context_refs) = req.context_refs {
        if !context_refs.is_empty() {
            user_content.push_str("\n\n--- 上下文引用 ---\n");
            for cref in context_refs {
                match cref.kind.as_str() {
                    "directory" => {
                        append_directory_workspace_context(
                            &app,
                            &db,
                            &sandbox,
                            &req.conversation_id,
                            &cref.alias,
                            &cref.path,
                            &mut user_content,
                            &mut workspace_root_ids,
                        )
                        .await
                        .map_err(|e| turn_fail(&tracer, "context_ref", e))?;
                    }
                    "file" => {
                        let canon = std::fs::canonicalize(&cref.path).map_err(|e| {
                            turn_fail(&tracer, "context_ref", format!("无法解析文件路径: {}", e))
                        })?;
                        let parent = canon.parent().ok_or_else(|| {
                            turn_fail(
                                &tracer,
                                "context_ref",
                                format!("文件无父目录: {}", cref.path),
                            )
                        })?;
                        grant_directory_access(&db, &sandbox, &parent.to_string_lossy())
                            .await
                            .map_err(|e| turn_fail(&tracer, "context_ref", e))?;
                        user_content.push_str(&format!(
                            "@{} (文件: {})\n\n",
                            cref.alias,
                            canon.to_string_lossy()
                        ));
                    }
                    _ => {
                        user_content
                            .push_str(&format!("@{} (未知类型: {})\n\n", cref.alias, cref.path));
                    }
                }
            }
        }
    }

    let inline_dirs = extract_directory_paths(&req.content);
    if !inline_dirs.is_empty() {
        if !user_content.contains("--- 上下文引用 ---") {
            user_content.push_str("\n\n--- 上下文引用 ---\n");
        }
        for dir in inline_dirs {
            let alias = std::path::Path::new(&dir)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("案件资料");
            append_directory_workspace_context(
                &app,
                &db,
                &sandbox,
                &req.conversation_id,
                alias,
                &dir,
                &mut user_content,
                &mut workspace_root_ids,
            )
            .await
            .map_err(|e| turn_fail(&tracer, "context_ref", e))?;
        }
    }

    let history = load_conversation_history(&db, &req.conversation_id)
        .await
        .map_err(|e| turn_fail(&tracer, "history", e))?;
    tracer.emit("history_loaded", json!({ "messages": history.len() }));

    // Clarification answers and follow-up turns arrive without context_refs —
    // recover the conversation's workspace bindings (recorded as `root_id=…`
    // in earlier user-turn context blocks) so evidence tools and the
    // classifier keep working after an ask_user pause.
    let mut inherited_workspace = false;
    if workspace_root_ids.is_empty() {
        for msg in history.iter().rev() {
            if msg.role != "user" {
                continue;
            }
            let ids = extract_workspace_root_ids(&msg.content);
            if !ids.is_empty() {
                workspace_root_ids = ids;
                inherited_workspace = true;
                break;
            }
        }
    }

    let mut classify_ctx = build_classify_context(
        &req.content,
        req.context_refs.as_ref(),
        req.current_mode.clone(),
        req.current_task_label.clone(),
        req.has_active_document.unwrap_or(false),
    );
    if inherited_workspace {
        classify_ctx.has_directory_ref = true;
    }
    tracer.emit(
        "classify_start",
        json!({
            "has_directory_ref": classify_ctx.has_directory_ref,
            "has_file_ref": classify_ctx.has_file_ref,
            "directory_aliases": classify_ctx.directory_aliases,
            "inherited_workspace": inherited_workspace,
        }),
    );
    let classify_started = Instant::now();
    // The client pre-classifies each turn (with committed-task context) and
    // passes the resolved mode as forced_mode; honor it and skip re-guessing.
    // Only fall back to a server-side classify when no override is supplied.
    let forced = req.forced_mode.as_deref().and_then(|m| {
        let parsed = agent_classifier::parse_mode_str(m);
        if parsed.is_none() {
            log::warn!("ignoring unrecognized forced_mode from client: {:?}", m);
        }
        parsed
    });
    let classification = if let Some(mode) = forced {
        ClassifyResult {
            label: req
                .forced_label
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| mode.ui_label().to_string()),
            mode,
            reason: "客户端已确认事项类型".into(),
            action: "continue".into(),
            source: "override".into(),
            fallback_reason: None,
            diagnostic: None,
        }
    } else {
        let fast = engine
            .get_fast_provider()
            .await
            .map_err(|e| turn_fail(&tracer, "fast_provider", e.to_string()))?;
        agent_classifier::classify_agent_mode_with_retry(
            fast.as_ref(),
            provider.as_ref(),
            &classify_ctx,
        )
        .await
    };
    let mode = classification.mode;
    let evidence_mode = classification.mode == AgentMode::Evidence;
    tracer.emit(
        "classify_result",
        json!({
            "mode": classification.mode,
            "label": classification.label.clone(),
            "reason": classification.reason.clone(),
            "source": classification.source.clone(),
            "fallback_reason": classification.fallback_reason.clone(),
            "diagnostic": classification.diagnostic.clone(),
            "duration_ms": classify_started.elapsed().as_millis() as u64,
        }),
    );

    let _ = app.emit("agent-mode-classified", &classification);

    let tools = build_all_tools(&mcp, mode, evidence_mode).await;
    {
        let (mcp_tools, builtin_tools): (Vec<String>, Vec<String>) = tools
            .iter()
            .map(|t| t.function.name.clone())
            .partition(|n| McpManager::is_mcp_tool(n));
        tracer.emit(
            "tools_built",
            json!({
                "total": tools.len(),
                "builtin": builtin_tools,
                "mcp": mcp_tools,
                "evidence_mode": evidence_mode,
            }),
        );
    }

    // Tool names the prompt may legitimately reference for legal research —
    // the mapping section only promises tools that exist this turn.
    let retrieval_tool_names: Vec<String> = tools
        .iter()
        .filter(|t| {
            crate::skills::router::is_retrieval_tool(&t.function.name, &t.function.description)
        })
        .map(|t| t.function.name.clone())
        .collect();

    let history_count = history.len();
    let mut messages = build_messages(
        &all_skills,
        research_gate_ref,
        active_skill.as_ref(),
        mode,
        &retrieval_tool_names,
        history,
        user_content.clone(),
    );
    tracer.emit(
        "context_built",
        json!({
            "message_count": messages.len(),
            "history_count": history_count,
            "system_prompt_chars": messages
                .first()
                .map(|m| m.content.chars().count())
                .unwrap_or(0),
            "user_content_chars": user_content.chars().count(),
        }),
    );

    let attachments_json = req
        .attachments
        .as_ref()
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    let ui_hidden = req.ui_hidden.unwrap_or(false);
    let save_user_result = if ui_hidden {
        let hidden_user_id = Uuid::new_v4().to_string();
        let metadata = json!({ "content_hidden": true }).to_string();
        db::queries::save_message_with_id_and_metadata(
            &db,
            &hidden_user_id,
            &conversation_id,
            "user",
            &user_content,
            &attachments_json,
            "[]",
            Some(&metadata),
        )
        .await
    } else {
        db::queries::save_message(
            &db,
            &conversation_id,
            "user",
            &user_content,
            &attachments_json,
            "[]",
        )
        .await
    };

    if let Err(e) = save_user_result {
        log::warn!("Failed to save user message: {}", e);
    }

    let sandbox_guard = sandbox.read().await;
    let tool_ctx = ToolContext {
        app: &app,
        skills: &skills,
        mcp: &mcp,
        db: &db,
        sandbox: &*sandbox_guard,
        conversation_id: &conversation_id,
        message_id: &message_id,
        workspace_root_ids: &workspace_root_ids,
        allowed_urls: &allowed_urls,
    };

    let mut full_response = String::new();
    let mut streamed = false;
    let mut leak_retries = 0usize;
    let mut leak_fallback = false;
    // Retrieval evidence accumulated across all tool rounds for citation audit.
    let mut turn_retrievals: Vec<(String, String)> = Vec::new();

    for round in 0..MAX_TOOL_ROUNDS {
        tracer.emit(
            "round_start",
            json!({
                "round": round + 1,
                "max_rounds": MAX_TOOL_ROUNDS,
                "message_count": messages.len(),
            }),
        );
        emit_stream_status(&app, &conversation_id, &message_id, "thinking");

        let chat_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: Some(tools.clone()),
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: false,
        };

        tracer.emit(
            "llm_request",
            json!({
                "round": round + 1,
                "model": chat_request.model,
                "stream": false,
                "temperature": 0.3,
                "max_tokens": RESPONSE_MAX_TOKENS,
                "message_count": chat_request.messages.len(),
                "tool_count": tools.len(),
            }),
        );
        let llm_started = Instant::now();

        let response = match provider.chat(&chat_request).await {
            Ok(r) => r,
            Err(e) => {
                let msg = turn_fail(&tracer, "llm_request", e.to_string());
                emit_stream_error(&app, &conversation_id, &message_id, &msg);
                return Err(msg);
            }
        };
        let llm_duration_ms = llm_started.elapsed().as_millis() as u64;

        let choice = response.choices.first().ok_or_else(|| {
            turn_fail(
                &tracer,
                "llm_response",
                "No response from provider".to_string(),
            )
        })?;
        let finish_reason = choice.finish_reason.clone();

        let assistant_msg = choice.message.clone().unwrap_or(ChatMessage {
            reasoning_content: None,
            role: "assistant".into(),
            content: String::new(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        tracer.emit(
            "llm_response",
            json!({
                "round": round + 1,
                "duration_ms": llm_duration_ms,
                "finish_reason": finish_reason.clone(),
                "usage": response.usage.clone(),
                "tool_call_count": assistant_msg
                    .tool_calls
                    .as_ref()
                    .map(|t| t.len())
                    .unwrap_or(0),
                "content_chars": assistant_msg.content.chars().count(),
                "content_preview": preview(&assistant_msg.content, 600),
            }),
        );
        if let Some(ref reasoning) = assistant_msg.reasoning_content {
            if !reasoning.trim().is_empty() {
                tracer.emit(
                    "thinking",
                    json!({ "round": round + 1, "text": preview(reasoning, 20000) }),
                );
            }
        }

        if let Some(ref tool_calls) = assistant_msg.tool_calls {
            if !tool_calls.is_empty() {
                emit_stream_status(&app, &conversation_id, &message_id, "tool");
                let batch = run_traced_tool_calls(
                    &tracer,
                    &tool_ctx,
                    tool_calls,
                    &mut active_skill,
                    "native",
                    round + 1,
                )
                .await;
                if let Some(ask) = batch.ask_user {
                    return finish_ask_user_turn(
                        &app,
                        &db,
                        &conversation_id,
                        &message_id,
                        &tracer,
                        ask,
                    )
                    .await;
                }

                turn_retrievals.extend(batch.retrievals);
                append_tool_results(&mut messages, assistant_msg, batch.results);

                if active_skill.is_some() {
                    update_system_prompt(
                        &mut messages,
                        &all_skills,
                        research_gate_ref,
                        active_skill.as_ref(),
                        mode,
                        &retrieval_tool_names,
                    );
                }
                continue;
            }
        }

        let embedded = parse_embedded_tool_calls(&assistant_msg.content);
        if !embedded.is_empty() {
            emit_stream_status(&app, &conversation_id, &message_id, "tool");
            let batch = run_traced_tool_calls(
                &tracer,
                &tool_ctx,
                &embedded,
                &mut active_skill,
                "embedded",
                round + 1,
            )
            .await;
            if let Some(ask) = batch.ask_user {
                return finish_ask_user_turn(
                    &app,
                    &db,
                    &conversation_id,
                    &message_id,
                    &tracer,
                    ask,
                )
                .await;
            }
            let mut tool_msg = assistant_msg.clone();
            tool_msg.tool_calls = Some(embedded);
            tool_msg.content = String::new();
            turn_retrievals.extend(batch.retrievals);
            append_tool_results(&mut messages, tool_msg, batch.results);
            if active_skill.is_some() {
                update_system_prompt(
                    &mut messages,
                    &all_skills,
                    research_gate_ref,
                    active_skill.as_ref(),
                    mode,
                    &retrieval_tool_names,
                );
            }
            continue;
        }

        if contains_tool_leakage(&assistant_msg.content) {
            // Intermittent gateway-side degradation: the same request usually
            // succeeds on retry. Never feed the leaked text back into history.
            if leak_retries < MAX_LEAK_RETRIES {
                leak_retries += 1;
                tracer.emit(
                    "leak_retry",
                    json!({
                        "attempt": leak_retries,
                        "max": MAX_LEAK_RETRIES,
                        "stage": "tool_round",
                        "sample": preview(&assistant_msg.content, 300),
                    }),
                );
                log::warn!(
                    "Unparseable tool leakage (retry {}/{}): {:?}",
                    leak_retries,
                    MAX_LEAK_RETRIES,
                    assistant_msg.content.chars().take(120).collect::<String>()
                );
                emit_stream_status(&app, &conversation_id, &message_id, "thinking");
                continue;
            }
            leak_fallback = true;
            break;
        }

        if !assistant_msg.content.trim().is_empty() {
            emit_stream_status(&app, &conversation_id, &message_id, "streaming");
            let final_text = collect_with_continuations(
                provider.as_ref(),
                &messages,
                assistant_msg.content.clone(),
                finish_reason,
                Some(&tracer),
            )
            .await;
            full_response = sanitize_assistant_content(&final_text);
            tracer.emit(
                "final_answer",
                json!({
                    "round": round + 1,
                    "source": "tool_round",
                    "chars": full_response.chars().count(),
                }),
            );
            emit_text_response(&app, &conversation_id, &message_id, &full_response);
            streamed = true;
            break;
        }

        emit_stream_status(&app, &conversation_id, &message_id, "streaming");

        let stream_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: true,
        };

        tracer.emit(
            "llm_request",
            json!({
                "round": round + 1,
                "model": stream_request.model,
                "stream": true,
                "temperature": 0.3,
                "max_tokens": RESPONSE_MAX_TOKENS,
                "message_count": stream_request.messages.len(),
                "tool_count": 0,
            }),
        );

        full_response = match stream_response(
            &app,
            provider.clone(),
            stream_request,
            &conversation_id,
            &message_id,
            false,
            Some(&tracer),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = turn_fail(&tracer, "stream", e.to_string());
                emit_stream_error(&app, &conversation_id, &message_id, &msg);
                return Err(msg);
            }
        };

        if contains_tool_leakage(&full_response) {
            let embedded = parse_embedded_tool_calls(&full_response);
            if !embedded.is_empty() {
                emit_stream_status(&app, &conversation_id, &message_id, "tool");
                let batch = run_traced_tool_calls(
                    &tracer,
                    &tool_ctx,
                    &embedded,
                    &mut active_skill,
                    "stream-embedded",
                    round + 1,
                )
                .await;
                if let Some(ask) = batch.ask_user {
                    return finish_ask_user_turn(
                        &app,
                        &db,
                        &conversation_id,
                        &message_id,
                        &tracer,
                        ask,
                    )
                    .await;
                }
                let tool_msg = ChatMessage {
                    reasoning_content: None,
                    role: "assistant".into(),
                    content: String::new(),
                    name: None,
                    tool_calls: Some(embedded),
                    tool_call_id: None,
                };
                turn_retrievals.extend(batch.retrievals);
                append_tool_results(&mut messages, tool_msg, batch.results);
                continue;
            }
            if leak_retries < MAX_LEAK_RETRIES {
                leak_retries += 1;
                tracer.emit(
                    "leak_retry",
                    json!({
                        "attempt": leak_retries,
                        "max": MAX_LEAK_RETRIES,
                        "stage": "stream",
                        "sample": preview(&full_response, 300),
                    }),
                );
                log::warn!(
                    "Streamed response leaked tool markup (retry {}/{})",
                    leak_retries,
                    MAX_LEAK_RETRIES
                );
                emit_stream_status(&app, &conversation_id, &message_id, "thinking");
                continue;
            }
            leak_fallback = true;
            break;
        }

        let clean = sanitize_assistant_content(&full_response);
        if clean != full_response {
            full_response = clean;
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

        streamed = true;
        break;
    }

    if leak_fallback {
        log::warn!("Tool-call leakage persisted after retries; answering without tools");
        tracer.emit(
            "leak_fallback",
            json!({ "retries": leak_retries, "max": MAX_LEAK_RETRIES }),
        );
        emit_stream_status(&app, &conversation_id, &message_id, "thinking");
        let mut fb_messages = messages.clone();
        fb_messages.push(ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: LEAK_FALLBACK_INSTRUCTION.into(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });
        let fb_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: fb_messages,
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: false,
        };
        tracer.emit(
            "llm_request",
            json!({
                "round": 0,
                "model": fb_request.model,
                "stream": false,
                "temperature": 0.3,
                "max_tokens": RESPONSE_MAX_TOKENS,
                "message_count": fb_request.messages.len(),
                "tool_count": 0,
                "purpose": "leak_fallback",
            }),
        );
        let fb_started = Instant::now();
        match provider.chat(&fb_request).await {
            Ok(resp) => {
                let fb_msg = resp.choices.first().and_then(|c| c.message.clone());
                tracer.emit(
                    "llm_response",
                    json!({
                        "round": 0,
                        "duration_ms": fb_started.elapsed().as_millis() as u64,
                        "finish_reason": resp.choices.first().and_then(|c| c.finish_reason.clone()),
                        "usage": resp.usage.clone(),
                        "tool_call_count": 0,
                        "content_chars": fb_msg.as_ref().map(|m| m.content.chars().count()).unwrap_or(0),
                        "content_preview": fb_msg
                            .as_ref()
                            .map(|m| preview(&m.content, 600))
                            .unwrap_or_default(),
                    }),
                );
                if let Some(msg) = fb_msg {
                    let clean = sanitize_assistant_content(&msg.content);
                    if !clean.is_empty() {
                        emit_stream_status(&app, &conversation_id, &message_id, "streaming");
                        emit_text_response(&app, &conversation_id, &message_id, &clean);
                        full_response = clean;
                        streamed = true;
                    }
                }
            }
            Err(e) => {
                log::warn!("Leak-fallback request failed: {}", e);
                tracer.emit(
                    "error",
                    json!({ "stage": "leak_fallback", "message": e.to_string() }),
                );
            }
        }
        if !streamed {
            full_response = LEAK_ERROR_MESSAGE.into();
            emit_stream_status(&app, &conversation_id, &message_id, "streaming");
            emit_text_response(&app, &conversation_id, &message_id, &full_response);
            streamed = true;
        }
    }

    if !streamed {
        log::warn!("Tool rounds exhausted without final text; forcing stream");
        tracer.emit("rounds_exhausted", json!({ "max_rounds": MAX_TOOL_ROUNDS }));
        emit_stream_status(&app, &conversation_id, &message_id, "streaming");
        let stream_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: true,
        };
        tracer.emit(
            "llm_request",
            json!({
                "round": 0,
                "model": stream_request.model,
                "stream": true,
                "temperature": 0.3,
                "max_tokens": RESPONSE_MAX_TOKENS,
                "message_count": stream_request.messages.len(),
                "tool_count": 0,
                "purpose": "rounds_exhausted",
            }),
        );
        full_response = match stream_response(
            &app,
            provider.clone(),
            stream_request,
            &conversation_id,
            &message_id,
            true,
            Some(&tracer),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracer.emit(
                    "error",
                    json!({ "stage": "stream", "message": e.to_string() }),
                );
                String::new()
            }
        };
        full_response = sanitize_assistant_content(&full_response);
    }

    // Citation audit: extract every legal citation from the answer and verify
    // against the local law library + this turn's retrieval evidence.
    let citation_audit = if full_response.is_empty() {
        None
    } else {
        let audit = crate::citations::audit(&full_response, &turn_retrievals).await;
        tracer.emit("citation_audit", json!(audit));
        Some(audit)
    };

    if !full_response.is_empty() {
        let mut meta_obj = citation_audit
            .as_ref()
            .filter(|a| a.total > 0)
            .map(|a| serde_json::json!({ "citation_audit": a }))
            .unwrap_or_else(|| serde_json::json!({}));

        if let Some(ref skill) = active_skill {
            if let Some(obj) = meta_obj.as_object_mut() {
                obj.insert(
                    "active_skill".to_string(),
                    serde_json::json!({
                        "name": skill.name,
                        "plugin_name": skill.plugin_name,
                    }),
                );
            }
        }

        let metadata_json = if meta_obj.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            Some(meta_obj.to_string())
        } else {
            None
        };

        if let Err(e) = db::queries::save_message_with_id_and_metadata(
            &db,
            &message_id,
            &conversation_id,
            "assistant",
            &full_response,
            "[]",
            "[]",
            metadata_json.as_deref(),
        )
        .await
        {
            log::warn!("Failed to save assistant message: {}", e);
        }
    }

    maybe_auto_title(&db, provider.as_ref(), &conversation_id).await;

    tracer.emit(
        "turn_end",
        json!({
            "ok": true,
            "duration_ms": tracer.elapsed_ms(),
            "response_chars": full_response.chars().count(),
            "streamed": streamed,
            "leak_fallback": leak_fallback,
        }),
    );

    Ok(message_id)
}

/// Emit the terminal failure pair (`error` + `turn_end{ok:false}`) so the
/// trace panel never shows a failed turn as still live. Returns the message
/// so it can be used inside `map_err`/`ok_or_else`.
fn turn_fail(tracer: &Tracer, stage: &str, msg: String) -> String {
    tracer.emit("error", json!({ "stage": stage, "message": msg.clone() }));
    tracer.emit(
        "turn_end",
        json!({
            "ok": false,
            "duration_ms": tracer.elapsed_ms(),
            "error": msg.clone(),
        }),
    );
    msg
}

struct ToolBatch {
    results: Vec<(String, String)>,
    ask_user: Option<AskUserRequest>,
    /// (tool name, result text) for retrieval tools — citation-audit evidence.
    retrievals: Vec<(String, String)>,
}

async fn finish_ask_user_turn(
    app: &AppHandle,
    db: &Pool<Sqlite>,
    conversation_id: &str,
    message_id: &str,
    tracer: &Tracer,
    ask: AskUserRequest,
) -> Result<String, String> {
    emit_stream_status(app, conversation_id, message_id, "clarifying");
    let summary = "请先补充以下信息，以便继续起草。";
    let metadata = json!({
        "display_content": summary,
        "content_hidden": true,
        "workflow": {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "status": "waiting",
            "steps": [
                {"id": "clarify", "kind": "clarify", "label": "已列出待补充问题", "state": "done"},
                {"id": "wait-user", "kind": "clarify", "label": "等待补充信息", "state": "run"}
            ],
            "clarification": {
                "id": ask.id.clone().unwrap_or_else(|| "clarify".into()),
                "intro": ask.intro.clone(),
                "questions": ask.questions,
                "status": "pending"
            }
        }
    });

    if let Err(e) = db::queries::save_message_with_id_and_metadata(
        db,
        message_id,
        conversation_id,
        "assistant",
        summary,
        "[]",
        "[]",
        Some(&metadata.to_string()),
    )
    .await
    {
        log::warn!("Failed to save ask_user assistant message: {}", e);
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
    tracer.emit(
        "turn_end",
        json!({
            "ok": true,
            "waiting_for_user": true,
            "duration_ms": tracer.elapsed_ms(),
        }),
    );
    Ok(message_id.to_string())
}

/// Execute one batch of tool calls, emitting `tool_call` / `tool_result` /
/// `skill_activated` trace events around each execution.
async fn run_traced_tool_calls(
    tracer: &Tracer,
    ctx: &ToolContext<'_>,
    tool_calls: &[ToolCall],
    active_skill: &mut Option<crate::skills::loader::SkillMetadata>,
    origin: &str,
    round: usize,
) -> ToolBatch {
    let mut results = Vec::new();
    let mut ask_user = None;
    let mut retrievals = Vec::new();
    for tc in tool_calls {
        let name = tc.function.name.as_str();
        let tool_kind = if McpManager::is_mcp_tool(name) {
            "mcp"
        } else if name == "select_skill" {
            "skill"
        } else if name == "ask_user" {
            "clarify"
        } else {
            "builtin"
        };
        tracer.emit(
            "tool_call",
            json!({
                "round": round,
                "call_id": tc.id,
                "name": name,
                "origin": origin,
                "tool_kind": tool_kind,
                "arguments": preview(&tc.function.arguments, 6000),
            }),
        );

        let parsed_ask = if name == "ask_user" {
            serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                .ok()
                .and_then(|v| parse_ask_user_args(&v).ok())
        } else {
            None
        };

        let skill_before = active_skill.as_ref().map(|s| s.name.clone());
        let started = Instant::now();
        let outcome = execute_tool(ctx, tc, active_skill).await;
        let duration_ms = started.elapsed().as_millis() as u64;

        let result = match outcome {
            Ok(r) => {
                tracer.emit(
                    "tool_result",
                    json!({
                        "round": round,
                        "call_id": tc.id,
                        "name": name,
                        "ok": true,
                        "duration_ms": duration_ms,
                        "result_chars": r.chars().count(),
                        "result_preview": preview(&r, 3000),
                    }),
                );
                if crate::skills::router::is_retrieval_tool_name(name) {
                    retrievals.push((name.to_string(), r.clone()));
                }
                r
            }
            Err(e) => {
                tracer.emit(
                    "tool_result",
                    json!({
                        "round": round,
                        "call_id": tc.id,
                        "name": name,
                        "ok": false,
                        "duration_ms": duration_ms,
                        "error": e,
                    }),
                );
                format!("工具执行失败：{}。请改用其他工具或继续作答。", e)
            }
        };

        if let Some(skill) = active_skill.as_ref() {
            if skill_before.as_deref() != Some(skill.name.as_str()) {
                tracer.emit(
                    "skill_activated",
                    json!({
                        "name": skill.name,
                        "plugin": skill.plugin_name,
                        "description": preview(&skill.description, 300),
                    }),
                );
            }
        }

        if let Some(ask) = parsed_ask {
            tracer.emit("ask_user", json!(ask));
            ask_user = Some(ask);
        }

        results.push((tc.id.clone(), result));
    }
    ToolBatch {
        results,
        ask_user,
        retrievals,
    }
}

/// Collect the full answer, auto-continuing while the provider reports
/// `finish_reason == "length"` (token-limit truncation).
async fn collect_with_continuations(
    provider: &dyn crate::llm::provider::LlmProvider,
    messages: &[ChatMessage],
    first_segment: String,
    first_finish_reason: Option<String>,
    tracer: Option<&Tracer>,
) -> String {
    let mut full = first_segment.clone();
    let mut last_segment = first_segment;
    let mut finish = first_finish_reason;
    let mut cont_messages = messages.to_vec();
    let mut continuations = 0usize;

    while finish.as_deref() == Some("length") && continuations < MAX_CONTINUATIONS {
        continuations += 1;
        log::info!(
            "Answer truncated at token limit; requesting continuation {}/{}",
            continuations,
            MAX_CONTINUATIONS
        );
        if let Some(t) = tracer {
            t.emit(
                "continuation",
                json!({
                    "n": continuations,
                    "max": MAX_CONTINUATIONS,
                    "collected_chars": full.chars().count(),
                }),
            );
        }
        cont_messages.push(ChatMessage {
            reasoning_content: None,
            role: "assistant".into(),
            content: last_segment.clone(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });
        cont_messages.push(ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: CONTINUE_INSTRUCTION.into(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        let request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: cont_messages.clone(),
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: false,
        };

        let resp = match provider.chat(&request).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Continuation request failed: {}", e);
                break;
            }
        };
        let Some(choice) = resp.choices.first() else {
            break;
        };
        let segment = choice
            .message
            .as_ref()
            .map(|m| m.content.clone())
            .unwrap_or_default();
        if segment.trim().is_empty() {
            break;
        }
        finish = choice.finish_reason.clone();
        if let Some(t) = tracer {
            t.emit(
                "continuation_result",
                json!({
                    "n": continuations,
                    "segment_chars": segment.chars().count(),
                    "finish_reason": finish.clone(),
                    "usage": resp.usage.clone(),
                }),
            );
        }
        full.push_str(&segment);
        last_segment = segment;
    }

    full
}

fn emit_stream_status(app: &AppHandle, conversation_id: &str, message_id: &str, status: &str) {
    let _ = app.emit(
        "chat-stream",
        StreamChunk {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            chunk: String::new(),
            done: false,
            status: Some(status.to_string()),
        },
    );
}

fn emit_stream_error(app: &AppHandle, conversation_id: &str, message_id: &str, error: &str) {
    let _ = app.emit(
        "chat-stream",
        StreamChunk {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            chunk: format!("**发送失败：** {}", error),
            done: false,
            status: Some("error".to_string()),
        },
    );
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

async fn load_conversation_history(
    pool: &Pool<Sqlite>,
    conversation_id: &str,
) -> Result<Vec<ChatMessage>, String> {
    let rows = db::queries::list_messages(pool, conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let mut history = Vec::new();
    for msg in rows {
        if msg.role == "user" || msg.role == "assistant" {
            // Old failed turns may have persisted leaked tool markup; never
            // feed it back to the model.
            let content = if msg.role == "assistant" && contains_tool_leakage(&msg.content) {
                let clean = sanitize_assistant_content(&msg.content);
                if clean.is_empty() {
                    continue;
                }
                clean
            } else {
                msg.content
            };
            history.push(ChatMessage {
                reasoning_content: None,
                role: msg.role,
                content,
                name: None,
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // Exclude the just-saved user message duplicate on rebuild
    if history.len() >= 2 {
        let last = history.last().map(|m| m.role.clone());
        if last == Some("user".into()) {
            history.pop();
        }
    }

    Ok(history)
}

fn message_is_hidden(msg: &db::models::Message) -> bool {
    msg.metadata_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|value| {
            value
                .get("content_hidden")
                .and_then(|hidden| hidden.as_bool())
        })
        .unwrap_or(false)
}

fn clean_title(raw: &str) -> String {
    let first_line = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut title = first_line.to_string();
    for prefix in ["会话标题：", "会话标题:", "标题：", "标题:"] {
        if let Some(rest) = title.strip_prefix(prefix) {
            title = rest.trim().to_string();
            break;
        }
    }
    let title = title
        .trim_matches(|c: char| c.is_whitespace() || "\"'`“”《》【】[]（）()。；;，,".contains(c))
        .to_string();
    title
        .chars()
        .take(30)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Persisted source for a conversation title. `Manual` survives subsequent
/// `maybe_auto_title` calls so the auto-titler never clobbers a title the
/// user picked. `Auto` (or unset) means the auto-titler may keep updating it
/// after each turn until the user manually edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleSource {
    Auto,
    Manual,
}

impl TitleSource {
    fn as_str(self) -> &'static str {
        match self {
            TitleSource::Auto => "auto",
            TitleSource::Manual => "manual",
        }
    }
}

/// True when the conversation record says the title was set by the user and
/// the auto-titler must leave it alone. Tolerant of malformed JSON.
fn is_title_manually_set(settings_json: Option<&str>) -> bool {
    let Some(raw) = settings_json else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    matches!(
        value.get("title_source").and_then(|s| s.as_str()),
        Some(s) if s == TitleSource::Manual.as_str()
    )
}

fn build_title_settings_json(existing: Option<&str>, source: TitleSource) -> String {
    let mut obj: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "title_source".into(),
        serde_json::Value::String(source.as_str().to_string()),
    );
    serde_json::Value::Object(obj).to_string()
}

async fn maybe_auto_title(
    pool: &Pool<Sqlite>,
    provider: &dyn crate::llm::provider::LlmProvider,
    conversation_id: &str,
) {
    let Some(conv) = (match db::queries::get_conversation(pool, conversation_id).await {
        Ok(conv) => conv,
        Err(e) => {
            log::warn!("Failed to load conversation for auto title: {}", e);
            return;
        }
    }) else {
        return;
    };

    // Manual titles win forever — the user owns the row once they touch it.
    if is_title_manually_set(conv.settings_json.as_deref()) {
        return;
    }

    let rows = match db::queries::list_messages(pool, conversation_id).await {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("Failed to load messages for auto title: {}", e);
            return;
        }
    };

    let snippets = rows
        .iter()
        .filter(|msg| {
            (msg.role == "user" || msg.role == "assistant") && !message_is_hidden(msg)
        })
        .take(8)
        .map(|msg| {
            let role = if msg.role == "user" {
                "用户"
            } else {
                "助手"
            };
            let content = preview(&msg.content.replace('\n', " "), 260);
            format!("{}：{}", role, content)
        })
        .collect::<Vec<_>>();

    if snippets.is_empty() {
        return;
    }

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![
            ChatMessage {
                reasoning_content: None,
                role: "system".into(),
                content: "你是法律 AI 桌面应用的会话标题生成器。请根据聊天内容归纳一个简洁中文标题，8 到 24 个汉字为宜，最多 30 字，只输出标题，不要解释，不要加引号。".into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                reasoning_content: None,
                role: "user".into(),
                content: format!("聊天内容：\n{}", snippets.join("\n")),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        tools: None,
        temperature: Some(0.1),
        max_tokens: Some(48),
        stream: false,
    };

    let response = match provider.chat(&request).await {
        Ok(response) => response,
        Err(e) => {
            log::warn!("Failed to generate conversation title: {}", e);
            return;
        }
    };

    let title = response
        .choices
        .first()
        .and_then(|choice| choice.message.as_ref())
        .map(|message| clean_title(&message.content))
        .unwrap_or_default();

    if title.is_empty() || title == conv.title {
        return;
    }

    let settings_json = build_title_settings_json(conv.settings_json.as_deref(), TitleSource::Auto);
    if let Err(e) = db::queries::update_conversation_title_and_source(
        pool,
        conversation_id,
        &title,
        &settings_json,
    )
    .await
    {
        log::warn!("Failed to update generated conversation title: {}", e);
    }
}

#[tauri::command]
pub async fn create_conversation(
    db: State<'_, Pool<Sqlite>>,
) -> Result<db::models::Conversation, String> {
    let conv = db::queries::create_conversation(&db, "新会话")
        .await
        .map_err(|e| e.to_string())?;

    if let Err(e) = db::queries::set_active_conversation_id(&db, &conv.id).await {
        log::warn!("Failed to set active conversation: {}", e);
    }

    Ok(conv)
}

#[tauri::command]
pub async fn get_conversations(
    db: State<'_, Pool<Sqlite>>,
) -> Result<Vec<db::models::Conversation>, String> {
    db::queries::list_conversations(&db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_messages(
    db: State<'_, Pool<Sqlite>>,
    conversation_id: String,
) -> Result<Vec<db::models::Message>, String> {
    db::queries::list_messages(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    db: State<'_, Pool<Sqlite>>,
    conversation_id: String,
) -> Result<(), String> {
    db::queries::delete_conversation(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    if let Ok(Some(active)) = db::queries::get_active_conversation_id(&db).await {
        if active == conversation_id {
            let _ = db::queries::set_active_conversation_id(&db, "").await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_conversation_title(
    db: State<'_, Pool<Sqlite>>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    // Frontend invokes this command only for manual renames, so any call here
    // is by definition the user setting the title — lock it from auto-titling
    // by stamping title_source=manual into settings_json.
    let existing = db::queries::get_conversation(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|c| c.settings_json);
    let settings_json = build_title_settings_json(existing.as_deref(), TitleSource::Manual);
    db::queries::update_conversation_title_and_source(
        &db,
        &conversation_id,
        &title,
        &settings_json,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_root_ids_from_context_block() {
        let hash = "a1b2c3d4".repeat(8);
        let text = format!(
            "@案件资料 (目录: C:\\案卷)\nworkspace 已索引：8 个文件，13 个 chunk。请使用 search_workspace 检索。root_id={}\n",
            hash
        );
        assert_eq!(extract_workspace_root_ids(&text), vec![hash]);
    }

    #[test]
    fn root_id_extraction_dedupes_and_rejects_partials() {
        let hash = "f".repeat(64);
        let text = format!("root_id={} root_id={} root_id=abc123", hash, hash);
        assert_eq!(extract_workspace_root_ids(&text), vec![hash]);
        assert!(extract_workspace_root_ids("无引用内容").is_empty());
    }

    #[test]
    fn clean_title_truncates_long_inputs_to_30_chars() {
        // 40-char string must be hard-truncated at 30 chars.
        let long = "测".repeat(40);
        let out = clean_title(&long);
        assert_eq!(out.chars().count(), 30);
    }

    #[test]
    fn clean_title_strips_label_prefixes_and_quotes() {
        let cases = [
            ("会话标题：股权转让协议起草", "股权转让协议起草"),
            ("标题：房屋租赁合同", "房屋租赁合同"),
            ("标题:某案件分析", "某案件分析"),
            ("\"起诉状模板\"", "起诉状模板"),
            ("  《律师函》  ", "律师函"),
        ];
        for (raw, expected) in cases {
            assert_eq!(clean_title(raw), expected, "input: {raw}");
        }
    }

    #[test]
    fn clean_title_keeps_short_inputs_intact() {
        assert_eq!(clean_title("合同审查"), "合同审查");
        assert_eq!(clean_title(""), "");
    }

    #[test]
    fn conversation_settings_reports_manual_title_lock() {
        assert!(is_title_manually_set(Some(r#"{"title_source":"manual"}"#)));
        assert!(!is_title_manually_set(Some(r#"{"title_source":"auto"}"#)));
        assert!(!is_title_manually_set(Some(r#"{"other":"value"}"#)));
        assert!(!is_title_manually_set(None));
    }
}
