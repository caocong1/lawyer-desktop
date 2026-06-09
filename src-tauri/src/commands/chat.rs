use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use chrono::Utc;
use futures::StreamExt;

use crate::db::models::{Conversation, FileAttachment};
use crate::llm::LlmEngine;
use crate::llm::types::{ChatMessage, ChatRequest};
use crate::skills::SkillRegistry;
use crate::skills::router;

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
    req: SendMessageRequest,
) -> Result<String, String> {
    let provider = engine.get_provider().await.map_err(|e| e.to_string())?;
    let all_skills = skills.get_skills().await;

    // Build system prompt
    let system_prompt = router::build_system_prompt(&all_skills, None);
    let tools = router::build_tool_definitions();

    // Build message history
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: system_prompt,
        name: None,
        tool_calls: None,
        tool_call_id: None,
    }];

    // Add user message with attachments
    let mut user_content = req.content.clone();
    if let Some(ref attachments) = req.attachments {
        for att in attachments {
            if let Some(ref preview) = att.content_preview {
                user_content.push_str(&format!(
                    "\n\n--- 文件: {} ---\n{}",
                    att.name, preview
                ));
            }
        }
    }

    messages.push(ChatMessage {
        role: "user".into(),
        content: user_content,
        name: None,
        tool_calls: None,
        tool_call_id: None,
    });

    let message_id = Uuid::new_v4().to_string();
    let chat_request = ChatRequest {
        model: provider.model_name().to_string(),
        messages,
        tools: Some(tools),
        temperature: Some(0.3),
        max_tokens: Some(4096),
        stream: true,
    };

    // Stream response
    let stream = provider.chat_stream(&chat_request).await.map_err(|e| e.to_string())?;

    let mut full_response = String::new();
    let mut stream = stream;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(text) => {
                // Parse SSE lines
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            continue;
                        }
                        if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(choices) = chunk.get("choices").and_then(|c| c.as_array()) {
                                for choice in choices {
                                    if let Some(delta) = choice.get("delta") {
                                        if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                            full_response.push_str(content);
                                            let _ = app.emit("chat-stream", StreamChunk {
                                                conversation_id: req.conversation_id.clone(),
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

    // Send done event
    let _ = app.emit("chat-stream", StreamChunk {
        conversation_id: req.conversation_id.clone(),
        message_id: message_id.clone(),
        chunk: String::new(),
        done: true,
    });

    Ok(message_id)
}

#[tauri::command]
pub async fn create_conversation() -> Result<Conversation, String> {
    let now = Utc::now().to_rfc3339();
    Ok(Conversation {
        id: Uuid::new_v4().to_string(),
        title: "新会话".to_string(),
        created_at: now.clone(),
        updated_at: now,
        settings_json: None,
    })
}
