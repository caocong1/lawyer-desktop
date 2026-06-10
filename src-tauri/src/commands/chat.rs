use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::db::{self, models::FileAttachment};
use crate::llm::tool_leak::{contains_tool_leakage, parse_embedded_tool_calls, sanitize_assistant_content};
use crate::llm::types::{ChatMessage, ChatRequest};
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
    stream_response, update_system_prompt, ToolContext, MAX_TOOL_ROUNDS,
};
use super::files::{grant_directory_access, prepare_directory_context};
use super::workspace::spawn_bind_and_index;

/// Same request is retried verbatim this many times when the provider leaks
/// unparseable tool markup into content (gateway-side, intermittent) —
/// polluting history with the leaked text only teaches the model the syntax.
const MAX_LEAK_RETRIES: usize = 3;

/// Auto-continue this many times when the final answer hits the token limit
/// (`finish_reason == "length"`).
const MAX_CONTINUATIONS: usize = 4;

const RESPONSE_MAX_TOKENS: u64 = 8192;

const CONTINUE_INSTRUCTION: &str = "你的上一条输出因长度限制被截断。请直接从中断处继续输出剩余内容：\
不要重复任何已输出的文字，不要重新开头，不要解释，直接续写。";

const LEAK_FALLBACK_INSTRUCTION: &str = "注意：请不要再尝试调用任何工具。\
请基于以上已获取的工具结果与上下文，直接输出完整的 Markdown 分析正文。\
如证据不足，请明确列出缺失的材料清单。正文中禁止出现任何工具调用语法或标记。";

const LEAK_ERROR_MESSAGE: &str = "**分析未完成：** 模型多次返回无法解析的工具调用残留，未能生成可读报告。\
请重试，或在设置中更换支持标准工具调用的模型。";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyAgentModeRequest {
    pub content: String,
    pub context_refs: Option<Vec<ContextRef>>,
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
    };

    let fast = engine.get_fast_provider().await.map_err(|e| e.to_string())?;
    Ok(agent_classifier::classify_agent_mode(fast.as_ref(), &ctx).await)
}

fn build_classify_context(content: &str, context_refs: Option<&Vec<ContextRef>>) -> ClassifyContext {
    let refs = context_refs.cloned().unwrap_or_default();
    let has_directory_ref = refs.iter().any(|r| r.kind == "directory")
        || !extract_directory_paths(content).is_empty();
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
    }
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
    let all_skills = skills.get_skills().await;

    let research_gate = if let Some(root) = skills.get_skills_root().await {
        loader::load_research_gate(&root).await
    } else {
        None
    };
    let research_gate_ref = research_gate.as_deref();

    let mut active_skill: Option<crate::skills::loader::SkillMetadata> = None;
    let mut workspace_root_ids: Vec<String> = Vec::new();

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
                        .await?;
                    }
                    "file" => {
                        let canon = std::fs::canonicalize(&cref.path)
                            .map_err(|e| format!("无法解析文件路径: {}", e))?;
                        let parent = canon
                            .parent()
                            .ok_or_else(|| format!("文件无父目录: {}", cref.path))?;
                        grant_directory_access(
                            &db,
                            &sandbox,
                            &parent.to_string_lossy(),
                        )
                        .await?;
                        user_content.push_str(&format!(
                            "@{} (文件: {})\n\n",
                            cref.alias,
                            canon.to_string_lossy()
                        ));
                    }
                    _ => {
                        user_content.push_str(&format!(
                            "@{} (未知类型: {})\n\n",
                            cref.alias, cref.path
                        ));
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
            .await?;
        }
    }

    let classify_ctx = build_classify_context(&req.content, req.context_refs.as_ref());
    let fast = engine.get_fast_provider().await.map_err(|e| e.to_string())?;
    let classification =
        agent_classifier::classify_agent_mode(fast.as_ref(), &classify_ctx).await;
    let evidence_mode = classification.mode == AgentMode::Evidence;

    let _ = app.emit(
        "agent-mode-classified",
        &classification,
    );

    let history = load_conversation_history(&db, &req.conversation_id).await?;

    let tools = build_all_tools(&mcp, evidence_mode).await;

    let mut messages = build_messages(
        &all_skills,
        research_gate_ref,
        active_skill.as_ref(),
        evidence_mode,
        history,
        user_content.clone(),
    );

    let message_id = Uuid::new_v4().to_string();
    let conversation_id = req.conversation_id.clone();

    let attachments_json = req
        .attachments
        .as_ref()
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    if let Err(e) = db::queries::save_message(
        &db,
        &conversation_id,
        "user",
        &user_content,
        &attachments_json,
        "[]",
    )
    .await
    {
        log::warn!("Failed to save user message: {}", e);
    }

    maybe_auto_title(&db, &conversation_id, &user_content).await;

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
    };

    let mut full_response = String::new();
    let mut streamed = false;
    let mut leak_retries = 0usize;
    let mut leak_fallback = false;

    for _round in 0..MAX_TOOL_ROUNDS {
        emit_stream_status(
            &app,
            &conversation_id,
            &message_id,
            "thinking",
        );

        let chat_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: Some(tools.clone()),
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: false,
        };

        let response = match provider.chat(&chat_request).await {
            Ok(r) => r,
            Err(e) => {
                let msg = e.to_string();
                emit_stream_error(&app, &conversation_id, &message_id, &msg);
                return Err(msg);
            }
        };

        let choice = response
            .choices
            .first()
            .ok_or_else(|| "No response from provider".to_string())?;
        let finish_reason = choice.finish_reason.clone();

        let assistant_msg = choice.message.clone().unwrap_or(ChatMessage {
            role: "assistant".into(),
            content: String::new(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        if let Some(ref tool_calls) = assistant_msg.tool_calls {
            if !tool_calls.is_empty() {
                emit_stream_status(&app, &conversation_id, &message_id, "tool");
                let mut results = Vec::new();
                for tc in tool_calls {
                    let result = match execute_tool(&tool_ctx, tc, &mut active_skill).await {
                        Ok(r) => r,
                        Err(e) => format!("工具执行失败：{}。请改用其他工具或继续作答。", e),
                    };
                    results.push((tc.id.clone(), result));
                }

                append_tool_results(&mut messages, assistant_msg, results);

                if active_skill.is_some() {
                    update_system_prompt(
                        &mut messages,
                        &all_skills,
                        research_gate_ref,
                        active_skill.as_ref(),
                        evidence_mode,
                    );
                }
                continue;
            }
        }

        let embedded = parse_embedded_tool_calls(&assistant_msg.content);
        if !embedded.is_empty() {
            emit_stream_status(&app, &conversation_id, &message_id, "tool");
            let mut results = Vec::new();
            for tc in &embedded {
                let result = match execute_tool(&tool_ctx, tc, &mut active_skill).await {
                    Ok(r) => r,
                    Err(e) => format!("工具执行失败：{}。请改用其他工具或继续作答。", e),
                };
                results.push((tc.id.clone(), result));
            }
            let mut tool_msg = assistant_msg.clone();
            tool_msg.tool_calls = Some(embedded);
            tool_msg.content = String::new();
            append_tool_results(&mut messages, tool_msg, results);
            if active_skill.is_some() {
                update_system_prompt(
                    &mut messages,
                    &all_skills,
                    research_gate_ref,
                    active_skill.as_ref(),
                    evidence_mode,
                );
            }
            continue;
        }

        if contains_tool_leakage(&assistant_msg.content) {
            // Intermittent gateway-side degradation: the same request usually
            // succeeds on retry. Never feed the leaked text back into history.
            if leak_retries < MAX_LEAK_RETRIES {
                leak_retries += 1;
                log::warn!(
                    "Unparseable tool leakage (retry {}/{}): {:?}",
                    leak_retries,
                    MAX_LEAK_RETRIES,
                    assistant_msg.content.chars().take(120).collect::<String>()
                );
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
            )
            .await;
            full_response = sanitize_assistant_content(&final_text);
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

        full_response = match stream_response(
            &app,
            provider.clone(),
            stream_request,
            &conversation_id,
            &message_id,
            false,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = e.to_string();
                emit_stream_error(&app, &conversation_id, &message_id, &msg);
                return Err(msg);
            }
        };

        if contains_tool_leakage(&full_response) {
            let embedded = parse_embedded_tool_calls(&full_response);
            if !embedded.is_empty() {
                emit_stream_status(&app, &conversation_id, &message_id, "tool");
                let mut results = Vec::new();
                for tc in &embedded {
                    let result = match execute_tool(&tool_ctx, tc, &mut active_skill).await {
                        Ok(r) => r,
                        Err(e) => format!("工具执行失败：{}。请改用其他工具或继续作答。", e),
                    };
                    results.push((tc.id.clone(), result));
                }
                let tool_msg = ChatMessage {
                    role: "assistant".into(),
                    content: String::new(),
                    name: None,
                    tool_calls: Some(embedded),
                    tool_call_id: None,
                };
                append_tool_results(&mut messages, tool_msg, results);
                continue;
            }
            if leak_retries < MAX_LEAK_RETRIES {
                leak_retries += 1;
                log::warn!(
                    "Streamed response leaked tool markup (retry {}/{})",
                    leak_retries,
                    MAX_LEAK_RETRIES
                );
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
        emit_stream_status(&app, &conversation_id, &message_id, "thinking");
        let mut fb_messages = messages.clone();
        fb_messages.push(ChatMessage {
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
        if let Ok(resp) = provider.chat(&fb_request).await {
            if let Some(msg) = resp.choices.first().and_then(|c| c.message.clone()) {
                let clean = sanitize_assistant_content(&msg.content);
                if !clean.is_empty() {
                    emit_stream_status(&app, &conversation_id, &message_id, "streaming");
                    emit_text_response(&app, &conversation_id, &message_id, &clean);
                    full_response = clean;
                    streamed = true;
                }
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
        emit_stream_status(&app, &conversation_id, &message_id, "streaming");
        let stream_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(RESPONSE_MAX_TOKENS),
            stream: true,
        };
        full_response = stream_response(
            &app,
            provider.clone(),
            stream_request,
            &conversation_id,
            &message_id,
            true,
        )
        .await
        .unwrap_or_default();
        full_response = sanitize_assistant_content(&full_response);
    }

    if !full_response.is_empty() {
        if let Err(e) = db::queries::save_message(
            &db,
            &conversation_id,
            "assistant",
            &full_response,
            "[]",
            "[]",
        )
        .await
        {
            log::warn!("Failed to save assistant message: {}", e);
        }
    }

    Ok(message_id)
}

/// Collect the full answer, auto-continuing while the provider reports
/// `finish_reason == "length"` (token-limit truncation).
async fn collect_with_continuations(
    provider: &dyn crate::llm::provider::LlmProvider,
    messages: &[ChatMessage],
    first_segment: String,
    first_finish_reason: Option<String>,
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
        cont_messages.push(ChatMessage {
            role: "assistant".into(),
            content: last_segment.clone(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });
        cont_messages.push(ChatMessage {
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

async fn maybe_auto_title(pool: &Pool<Sqlite>, conversation_id: &str, user_content: &str) {
    if let Ok(Some(conv)) = db::queries::get_conversation(pool, conversation_id).await {
        if conv.title == "新会话" && !user_content.is_empty() {
            let new_title = user_content.chars().take(20).collect::<String>().trim().to_string();
            if !new_title.is_empty() {
                let _ =
                    db::queries::update_conversation_title(pool, conversation_id, &new_title).await;
            }
        }
    }
}

#[tauri::command]
pub async fn create_conversation(db: State<'_, Pool<Sqlite>>) -> Result<db::models::Conversation, String> {
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
    db::queries::update_conversation_title(&db, &conversation_id, &title)
        .await
        .map_err(|e| e.to_string())
}
