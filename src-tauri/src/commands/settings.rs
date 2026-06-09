use serde::{Deserialize, Serialize};
use tauri::State;

use crate::llm::{self, LlmEngine, ProviderPreset};
use crate::llm::types::ProviderConfig;
use crate::skills::SkillRegistry;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSetupRequest {
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub api_key: Option<String>,
    pub model_name: String,
}

#[tauri::command]
pub async fn get_provider_presets() -> Result<Vec<ProviderPreset>, String> {
    Ok(llm::default_providers())
}

#[tauri::command]
pub async fn setup_provider(
    engine: State<'_, LlmEngine>,
    req: ProviderSetupRequest,
) -> Result<(), String> {
    let config = ProviderConfig {
        id: Uuid::new_v4().to_string(),
        name: req.name,
        display_name: req.display_name,
        api_base_url: req.api_base_url,
        api_key: req.api_key,
        model_name: req.model_name,
        temperature: None,
        max_tokens: None,
    };

    engine.set_provider(config).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_provider(req: ProviderSetupRequest) -> Result<String, String> {
    use crate::llm::openai_compat::OpenAiCompatProvider;
    use crate::llm::provider::LlmProvider;
    use crate::llm::types::{ChatMessage, ChatRequest};

    let config = ProviderConfig {
        id: "test".into(),
        name: req.name.clone(),
        display_name: req.display_name,
        api_base_url: req.api_base_url,
        api_key: req.api_key,
        model_name: req.model_name.clone(),
        temperature: None,
        max_tokens: None,
    };

    let provider = OpenAiCompatProvider::new(config);
    let request = ChatRequest {
        model: req.model_name,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "请回复：连接成功".into(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: None,
        temperature: Some(0.1),
        max_tokens: Some(50),
        stream: false,
    };

    let response = provider.chat(&request).await.map_err(|e| e.to_string())?;

    if let Some(choice) = response.choices.first() {
        if let Some(ref msg) = choice.message {
            return Ok(msg.content.clone());
        }
    }

    Err("No response from provider".into())
}

#[tauri::command]
pub async fn set_skills_root(
    skills: State<'_, SkillRegistry>,
    path: String,
) -> Result<usize, String> {
    skills
        .set_skills_root(path.into())
        .await
        .map_err(|e| e.to_string())?;
    skills.reload().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reload_skills(skills: State<'_, SkillRegistry>) -> Result<usize, String> {
    skills.reload().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_skills(skills: State<'_, SkillRegistry>) -> Result<Vec<crate::skills::loader::SkillMetadata>, String> {
    Ok(skills.get_skills().await)
}
