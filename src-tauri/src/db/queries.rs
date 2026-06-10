use anyhow::Context;
use chrono::Utc;
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

use super::models::{Conversation, LlmProvider, Message};

// ---------------------------------------------------------------------------
// Conversation CRUD
// ---------------------------------------------------------------------------

pub async fn list_conversations(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<Conversation>> {
    let rows = sqlx::query(
        "SELECT id, title, created_at, updated_at, settings_json \
         FROM conversations ORDER BY created_at DESC",
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
// LLM Provider
// ---------------------------------------------------------------------------

pub async fn get_active_provider(pool: &Pool<Sqlite>) -> anyhow::Result<Option<LlmProvider>> {
    let row = sqlx::query(
        "SELECT id, name, display_name, api_base_url, api_key, model_name, is_active, config_json, created_at \
         FROM llm_providers WHERE is_active = 1 LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .context("failed to get active provider")?;

    row.as_ref().map(row_to_provider).transpose()
}

pub async fn save_provider(
    pool: &Pool<Sqlite>,
    config: &LlmProvider,
) -> anyhow::Result<LlmProvider> {
    // Deactivate all existing providers
    sqlx::query("UPDATE llm_providers SET is_active = 0")
        .execute(pool)
        .await
        .context("failed to deactivate providers")?;

    // Insert new provider as active
    sqlx::query(
        "INSERT INTO llm_providers \
         (id, name, display_name, api_base_url, api_key, model_name, is_active, config_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&config.id)
    .bind(&config.name)
    .bind(&config.display_name)
    .bind(&config.api_base_url)
    .bind(&config.api_key)
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
// Active conversation tracking
// ---------------------------------------------------------------------------

pub async fn get_active_conversation_id(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Option<String>> {
    let row = sqlx::query(
        "SELECT value FROM app_settings WHERE key = 'active_conversation_id'",
    )
    .fetch_optional(pool)
    .await
    .context("failed to get active conversation id")?;

    Ok(row.map(|r| r.get::<String, _>("value")))
}

pub async fn set_active_conversation_id(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('active_conversation_id', ?)",
    )
    .bind(id)
    .execute(pool)
    .await
    .context("failed to set active conversation id")?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Row extraction helpers
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
