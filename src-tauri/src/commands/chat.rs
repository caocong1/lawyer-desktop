use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use chrono::Utc;
use futures::StreamExt;

use crate::db::{self, models::{Conversation, FileAttachment}};
use crate::llm::LlmEngine;
use crate::llm::types::{ChatMessage, ChatRequest};
use crate::skills::SkillRegistry;
use crate::skills::router;
use sqlx::{Pool, Sqlite};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub conversation_id: String,
    pub content: String,
    pub attachments: Option<Vec<FileAttachment>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub conversation_id: String,
    pub message_id: String,
    pub chunk: String,
    pub done: bool,
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    engine: State<'_, LlmEngine>,
    skills: State<'_, SkillRegistry>,
    db: State<'_, Pool<Sqlite>>,
    req: SendMessageRequest,
) -> Result<String, String> {
    let provider = engine.get_provider().await.map_err(|e| e.to_string())?;
    let all_skills = skills.get_skills().await;

    let system_prompt = router::build_system_prompt(&all_skills, None);
    let tools = router::build_tool_definitions();

    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: system_prompt,
        name: None,
        tool_calls: None,
        tool_call_id: None,
    }];

    let mut user_content = req.content.clone();
    if let Some(ref attachments) = req.attachments {
        for att in attachments {
            if let Some(ref preview) = att.content_preview {
                user_content.push_str(&format!("\n\n--- 文件: {} ---\n{}", att.name, preview));
            }
        }
    }

    messages.push(ChatMessage {
        role: "user".into(),
        content: user_content.clone(),
        name: None,
        tool_calls: None,
        tool_call_id: None,
    });

    let message_id = Uuid::new_v4().to_string();
    let conversation_id = req.conversation_id.clone();

    // Save user message to DB (best-effort)
    let attachments_json = req
        .attachments
        .as_ref()
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    if let Err(e) = db::queries::save_message(
        &db, &conversation_id, "user", &user_content, &attachments_json, "[]",
    ).await {
        log::warn!("Failed to save user message: {}", e);
    }

    let chat_request = ChatRequest {
        model: provider.model_name().to_string(),
        messages,
        tools: Some(tools),
        temperature: Some(0.3),
        max_tokens: Some(4096),
        stream: true,
    };

    let stream = provider.chat_stream(&chat_request).await.map_err(|e| e.to_string())?;
    let mut full_response = String::new();
    let mut stream = stream;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(text) => {
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" { continue; }
                        if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(choices) = chunk.get("choices").and_then(|c| c.as_array()) {
                                for choice in choices {
                                    if let Some(delta) = choice.get("delta") {
                                        if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                            full_response.push_str(content);
                                            let _ = app.emit("chat-stream", StreamChunk {
                                                conversation_id: conversation_id.clone(),
                                                message_id: message_id.clone(),
                                                chunk: content.to_string(),
                                                done: false,
                                            });
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
                break;
            }
        }
    }

    let _ = app.emit("chat-stream", StreamChunk {
        conversation_id: conversation_id.clone(),
        message_id: message_id.clone(),
        chunk: String::new(),
        done: true,
    });

    // Save assistant message to DB (best-effort)
    if !full_response.is_empty() {
        if let Err(e) = db::queries::save_message(
            &db, &conversation_id, "assistant", &full_response, "[]", "[]",
        ).await {
            log::warn!("Failed to save assistant message: {}", e);
        }
    }

    Ok(message_id)
}

#[tauri::command]
pub async fn create_conversation(
    db: State<'_, Pool<Sqlite>>,
) -> Result<Conversation, String> {
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
) -> Result<Vec<Conversation>, String> {
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
pub async fn set_active_skill(
    _conversation_id: String,
    _skill_name: String,
) -> Result<(), String> {
    Ok(())
}
