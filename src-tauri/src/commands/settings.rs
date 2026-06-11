use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use tauri::State;
use uuid::Uuid;

use crate::db;
use crate::llm::types::ProviderConfig;
use crate::llm::{self, LlmEngine, ProviderPreset};
use crate::mcp::manager::McpManager;
use crate::mcp::types::McpServerHealth;
use crate::security::key_store::KeyStore;
use crate::security::path_sandbox::PathSandbox;
use crate::skills::SkillRegistry;
use std::sync::Arc;
use tokio::sync::RwLock;

async fn resolve_fast_api_key(
    db: &Pool<Sqlite>,
    key_store: &KeyStore,
    from_req: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(key) = from_req.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(Some(key.to_string()));
    }
    if let Ok(Some(cfg)) = db::queries::get_fast_provider_config(db, key_store).await {
        if cfg.api_key.is_some() {
            return Ok(cfg.api_key);
        }
    }
    Ok(db::queries::get_active_provider(db, key_store)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|p| p.api_key))
}

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
pub async fn get_fast_model_presets() -> Result<Vec<ProviderPreset>, String> {
    Ok(llm::fast_model_presets())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FastProviderSetupRequest {
    pub enabled: bool,
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub api_key: Option<String>,
    pub model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FastProviderResponse {
    pub enabled: bool,
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub model_name: String,
    pub has_api_key: bool,
}

#[tauri::command]
pub async fn get_fast_provider(
    db: State<'_, Pool<Sqlite>>,
) -> Result<Option<FastProviderResponse>, String> {
    let meta = db::queries::get_fast_provider_meta(&db)
        .await
        .map_err(|e| e.to_string())?;
    let Some(meta) = meta else {
        return Ok(None);
    };
    let has_key = db::queries::fast_provider_has_api_key(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(FastProviderResponse {
        enabled: true,
        name: meta.name,
        display_name: meta.display_name,
        api_base_url: meta.api_base_url,
        model_name: meta.model_name,
        has_api_key: has_key,
    }))
}

#[tauri::command]
pub async fn setup_fast_provider(
    engine: State<'_, LlmEngine>,
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
    req: FastProviderSetupRequest,
) -> Result<(), String> {
    if !req.enabled {
        db::queries::clear_fast_provider_config(&db)
            .await
            .map_err(|e| e.to_string())?;
        engine
            .set_fast_provider(None)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let api_key = resolve_fast_api_key(&db, &key_store, req.api_key.as_deref()).await?;

    let meta = db::queries::FastProviderMeta {
        name: req.name.clone(),
        display_name: req.display_name.clone(),
        api_base_url: req.api_base_url.clone(),
        model_name: req.model_name.clone(),
    };

    db::queries::save_fast_provider_config(&db, &key_store, &meta, api_key.clone())
        .await
        .map_err(|e| e.to_string())?;

    let config = llm::types::ProviderConfig {
        id: "fast".into(),
        name: req.name,
        display_name: req.display_name,
        api_base_url: req.api_base_url,
        api_key,
        model_name: req.model_name,
        temperature: None,
        max_tokens: None,
    };
    engine
        .set_fast_provider(Some(config))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_fast_provider(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
    req: FastProviderSetupRequest,
) -> Result<String, String> {
    let api_key = resolve_fast_api_key(&db, &key_store, req.api_key.as_deref()).await?;

    test_provider(ProviderSetupRequest {
        name: req.name,
        display_name: req.display_name,
        api_base_url: req.api_base_url,
        api_key,
        model_name: req.model_name,
    })
    .await
}

#[tauri::command]
pub async fn setup_provider(
    engine: State<'_, LlmEngine>,
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
    req: ProviderSetupRequest,
) -> Result<(), String> {
    let api_key = match req
        .api_key
        .as_ref()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
    {
        Some(key) => Some(key.to_string()),
        None => db::queries::get_active_provider(&db, &key_store)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|p| p.api_key),
    };

    let config = ProviderConfig {
        id: Uuid::new_v4().to_string(),
        name: req.name.clone(),
        display_name: req.display_name.clone(),
        api_base_url: req.api_base_url.clone(),
        api_key: api_key.clone(),
        model_name: req.model_name.clone(),
        temperature: None,
        max_tokens: None,
    };

    engine
        .set_provider(config.clone())
        .await
        .map_err(|e| e.to_string())?;

    let now = Utc::now().to_rfc3339();
    let provider = db::models::LlmProvider {
        id: config.id,
        name: req.name,
        display_name: req.display_name,
        api_base_url: req.api_base_url,
        api_key,
        model_name: req.model_name,
        is_active: true,
        config_json: None,
        created_at: now,
    };

    db::queries::save_provider(&db, &key_store, &provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
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
            reasoning_content: None,
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
pub async fn get_skills_root(skills: State<'_, SkillRegistry>) -> Result<Option<String>, String> {
    Ok(skills
        .get_skills_root()
        .await
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn set_skills_root(
    skills: State<'_, SkillRegistry>,
    db: State<'_, Pool<Sqlite>>,
    path: String,
) -> Result<usize, String> {
    let path_buf = std::path::PathBuf::from(&path);
    skills
        .set_skills_root(path_buf.clone())
        .await
        .map_err(|e| e.to_string())?;

    db::queries::set_setting(&db, "skills_root", &path)
        .await
        .map_err(|e| e.to_string())?;

    skills.reload().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reload_skills(skills: State<'_, SkillRegistry>) -> Result<usize, String> {
    skills.reload().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_skills(
    skills: State<'_, SkillRegistry>,
) -> Result<Vec<crate::skills::loader::SkillMetadata>, String> {
    Ok(skills.get_skills().await)
}

#[tauri::command]
pub async fn get_active_provider(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
) -> Result<Option<db::models::LlmProvider>, String> {
    db::queries::get_active_provider(&db, &key_store)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_active_conversation(
    db: State<'_, Pool<Sqlite>>,
    conversation_id: String,
) -> Result<(), String> {
    db::queries::set_active_conversation_id(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mcp_health(mcp: State<'_, McpManager>) -> Result<Vec<McpServerHealth>, String> {
    Ok(mcp.check_health().await)
}

#[tauri::command]
pub async fn get_allowed_file_dirs(db: State<'_, Pool<Sqlite>>) -> Result<Vec<String>, String> {
    db::queries::get_allowed_file_dirs(&db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_allowed_file_dirs(
    dirs: Vec<String>,
    db: State<'_, Pool<Sqlite>>,
    sandbox: State<'_, Arc<RwLock<PathSandbox>>>,
) -> Result<(), String> {
    db::queries::set_allowed_file_dirs(&db, &dirs)
        .await
        .map_err(|e| e.to_string())?;
    crate::commands::files::reload_sandbox_from_db(&db, &sandbox).await
}
