use anyhow::Context;
use chrono::Utc;
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

use crate::security::key_store::KeyStore;

use super::models::{Conversation, LegalDocument, LlmProvider, Message};

// ---------------------------------------------------------------------------
// Conversation CRUD
// ---------------------------------------------------------------------------

pub async fn list_conversations(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<Conversation>> {
    let rows = sqlx::query(
        "SELECT id, title, created_at, updated_at, settings_json \
         FROM conversations ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .context("failed to list conversations")?;

    rows.iter().map(row_to_conversation).collect()
}

pub async fn get_conversation(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<Option<Conversation>> {
    let row = sqlx::query(
        "SELECT id, title, created_at, updated_at, settings_json \
         FROM conversations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .context("failed to get conversation")?;

    row.as_ref().map(row_to_conversation).transpose()
}

pub async fn create_conversation(
    pool: &Pool<Sqlite>,
    title: &str,
) -> anyhow::Result<Conversation> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, updated_at, settings_json) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(title)
    .bind(&now)
    .bind(&now)
    .bind(None::<String>)
    .execute(pool)
    .await
    .context("failed to create conversation")?;

    Ok(Conversation {
        id,
        title: title.to_string(),
        created_at: now.clone(),
        updated_at: now,
        settings_json: None,
    })
}

pub async fn update_conversation_title(
    pool: &Pool<Sqlite>,
    id: &str,
    title: &str,
) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();

    sqlx::query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .bind(title)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await
        .context("failed to update conversation title")?;

    Ok(())
}

pub async fn delete_conversation(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .context("failed to delete conversation")?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

pub async fn list_messages(
    pool: &Pool<Sqlite>,
    conversation_id: &str,
) -> anyhow::Result<Vec<Message>> {
    let rows = sqlx::query(
        "SELECT id, conversation_id, role, content, attachments_json, tool_calls_json, created_at \
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .context("failed to list messages")?;

    rows.iter().map(row_to_message).collect()
}

pub async fn save_message(
    pool: &Pool<Sqlite>,
    conversation_id: &str,
    role: &str,
    content: &str,
    attachments: &str,
    tool_calls: &str,
) -> anyhow::Result<Message> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content, attachments_json, tool_calls_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(role)
    .bind(content)
    .bind(attachments)
    .bind(tool_calls)
    .bind(&now)
    .execute(pool)
    .await
    .context("failed to save message")?;

    let now_conv = Utc::now().to_rfc3339();
    let _ = sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(&now_conv)
        .bind(conversation_id)
        .execute(pool)
        .await;

    Ok(Message {
        id,
        conversation_id: conversation_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        attachments_json: if attachments.is_empty() {
            None
        } else {
            Some(attachments.to_string())
        },
        tool_calls_json: if tool_calls.is_empty() {
            None
        } else {
            Some(tool_calls.to_string())
        },
        created_at: now,
    })
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

pub async fn save_document(
    pool: &Pool<Sqlite>,
    conversation_id: Option<&str>,
    title: &str,
    document_json: &str,
) -> anyhow::Result<LegalDocument> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO documents (id, conversation_id, title, document_json, version, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(title)
    .bind(document_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .context("failed to save document")?;

    Ok(LegalDocument {
        id,
        conversation_id: conversation_id.map(|s| s.to_string()),
        title: title.to_string(),
        document_json: document_json.to_string(),
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn get_document(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<Option<LegalDocument>> {
    let row = sqlx::query(
        "SELECT id, conversation_id, title, document_json, version, created_at, updated_at \
         FROM documents WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .context("failed to get document")?;

    row.as_ref().map(row_to_document).transpose()
}

pub async fn list_documents_by_conversation(
    pool: &Pool<Sqlite>,
    conversation_id: &str,
) -> anyhow::Result<Vec<LegalDocument>> {
    let rows = sqlx::query(
        "SELECT id, conversation_id, title, document_json, version, created_at, updated_at \
         FROM documents WHERE conversation_id = ? ORDER BY updated_at DESC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .context("failed to list documents")?;

    rows.iter().map(row_to_document).collect()
}

// ---------------------------------------------------------------------------
// LLM Provider (API keys encrypted at rest)
// ---------------------------------------------------------------------------

pub async fn get_active_provider(
    pool: &Pool<Sqlite>,
    key_store: &KeyStore,
) -> anyhow::Result<Option<LlmProvider>> {
    let row = sqlx::query(
        "SELECT id, name, display_name, api_base_url, api_key, model_name, is_active, config_json, created_at \
         FROM llm_providers WHERE is_active = 1 LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .context("failed to get active provider")?;

    match row.as_ref() {
        Some(r) => {
            let mut provider = row_to_provider(r)?;
            provider.api_key = key_store.decrypt_optional(provider.api_key.as_deref())?;
            Ok(Some(provider))
        }
        None => Ok(None),
    }
}

pub async fn save_provider(
    pool: &Pool<Sqlite>,
    key_store: &KeyStore,
    config: &LlmProvider,
) -> anyhow::Result<LlmProvider> {
    sqlx::query("UPDATE llm_providers SET is_active = 0")
        .execute(pool)
        .await
        .context("failed to deactivate providers")?;

    let encrypted_key = key_store.encrypt_optional(config.api_key.as_deref())?;

    sqlx::query(
        "INSERT INTO llm_providers \
         (id, name, display_name, api_base_url, api_key, model_name, is_active, config_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&config.id)
    .bind(&config.name)
    .bind(&config.display_name)
    .bind(&config.api_base_url)
    .bind(&encrypted_key)
    .bind(&config.model_name)
    .bind(&config.config_json)
    .bind(&config.created_at)
    .execute(pool)
    .await
    .context("failed to save provider")?;

    let mut result = config.clone();
    result.is_active = true;
    Ok(result)
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

pub async fn get_setting(pool: &Pool<Sqlite>, key: &str) -> anyhow::Result<Option<String>> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .context("failed to get setting")?;

    Ok(row.map(|r| r.get::<String, _>("value")))
}

pub async fn set_setting(pool: &Pool<Sqlite>, key: &str, value: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .context("failed to set setting")?;

    Ok(())
}

pub async fn get_active_conversation_id(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Option<String>> {
    get_setting(pool, "active_conversation_id").await
}

pub async fn set_active_conversation_id(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    set_setting(pool, "active_conversation_id", id).await
}

pub async fn get_allowed_file_dirs(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<String>> {
    match get_setting(pool, "allowed_file_dirs").await? {
        Some(json) => {
            serde_json::from_str(&json).context("failed to parse allowed_file_dirs")
        }
        None => Ok(Vec::new()),
    }
}

pub async fn set_allowed_file_dirs(
    pool: &Pool<Sqlite>,
    dirs: &[String],
) -> anyhow::Result<()> {
    let json = serde_json::to_string(dirs).context("failed to serialize allowed_file_dirs")?;
    set_setting(pool, "allowed_file_dirs", &json).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FastProviderMeta {
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub model_name: String,
}

const FAST_PROVIDER_META_KEY: &str = "llm_fast_provider_meta";
const FAST_PROVIDER_API_KEY: &str = "llm_fast_provider_api_key";

pub async fn get_fast_provider_config(
    pool: &Pool<Sqlite>,
    key_store: &crate::security::key_store::KeyStore,
) -> anyhow::Result<Option<crate::llm::types::ProviderConfig>> {
    let meta_json = match get_setting(pool, FAST_PROVIDER_META_KEY).await? {
        Some(v) => v,
        None => return Ok(None),
    };
    let meta: FastProviderMeta =
        serde_json::from_str(&meta_json).context("parse llm_fast_provider_meta")?;

    let encrypted = get_setting(pool, FAST_PROVIDER_API_KEY).await?;
    let mut api_key = key_store.decrypt_optional(encrypted.as_deref())?;

    if api_key.is_none() {
        api_key = get_active_provider(pool, key_store)
            .await?
            .and_then(|p| p.api_key);
    }

    Ok(Some(crate::llm::types::ProviderConfig {
        id: "fast".into(),
        name: meta.name,
        display_name: meta.display_name,
        api_base_url: meta.api_base_url,
        api_key,
        model_name: meta.model_name,
        temperature: None,
        max_tokens: None,
    }))
}

pub async fn save_fast_provider_config(
    pool: &Pool<Sqlite>,
    key_store: &crate::security::key_store::KeyStore,
    meta: &FastProviderMeta,
    api_key: Option<String>,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(meta).context("serialize llm_fast_provider_meta")?;
    set_setting(pool, FAST_PROVIDER_META_KEY, &json).await?;

    if let Some(key) = api_key {
        let encrypted = key_store.encrypt(&key)?;
        set_setting(pool, FAST_PROVIDER_API_KEY, &encrypted).await?;
    }

    Ok(())
}

pub async fn clear_fast_provider_config(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM app_settings WHERE key IN (?, ?)")
        .bind(FAST_PROVIDER_META_KEY)
        .bind(FAST_PROVIDER_API_KEY)
        .execute(pool)
        .await
        .context("clear fast provider")?;
    Ok(())
}

pub async fn get_fast_provider_meta(pool: &Pool<Sqlite>) -> anyhow::Result<Option<FastProviderMeta>> {
    match get_setting(pool, FAST_PROVIDER_META_KEY).await? {
        Some(v) => Ok(Some(serde_json::from_str(&v)?)),
        None => Ok(None),
    }
}

pub async fn fast_provider_has_api_key(pool: &Pool<Sqlite>) -> anyhow::Result<bool> {
    Ok(get_setting(pool, FAST_PROVIDER_API_KEY)
        .await?
        .is_some())
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

fn row_to_conversation(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<Conversation> {
    Ok(Conversation {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        settings_json: row.get("settings_json"),
    })
}

fn row_to_message(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<Message> {
    Ok(Message {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        role: row.get("role"),
        content: row.get("content"),
        attachments_json: row.get("attachments_json"),
        tool_calls_json: row.get("tool_calls_json"),
        created_at: row.get("created_at"),
    })
}

fn row_to_document(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<LegalDocument> {
    Ok(LegalDocument {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        title: row.get("title"),
        document_json: row.get("document_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn row_to_provider(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<LlmProvider> {
    let is_active_int: i32 = row.get("is_active");
    Ok(LlmProvider {
        id: row.get("id"),
        name: row.get("name"),
        display_name: row.get("display_name"),
        api_base_url: row.get("api_base_url"),
        api_key: row.get("api_key"),
        model_name: row.get("model_name"),
        is_active: is_active_int != 0,
        config_json: row.get("config_json"),
        created_at: row.get("created_at"),
    })
}
