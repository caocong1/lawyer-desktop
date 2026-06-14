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

pub async fn create_conversation(pool: &Pool<Sqlite>, title: &str) -> anyhow::Result<Conversation> {
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
        "SELECT id, conversation_id, role, content, attachments_json, tool_calls_json, metadata_json, created_at \
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .context("failed to list messages")?;

    rows.iter().map(row_to_message).collect()
}

pub async fn get_message_by_id(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<Option<Message>> {
    let row = sqlx::query(
        "SELECT id, conversation_id, role, content, attachments_json, tool_calls_json, metadata_json, created_at \
         FROM messages WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_message).transpose()
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
    save_message_with_id_and_metadata(
        pool,
        &id,
        conversation_id,
        role,
        content,
        attachments,
        tool_calls,
        None,
    )
    .await
}

pub async fn save_message_with_id_and_metadata(
    pool: &Pool<Sqlite>,
    id: &str,
    conversation_id: &str,
    role: &str,
    content: &str,
    attachments: &str,
    tool_calls: &str,
    metadata: Option<&str>,
) -> anyhow::Result<Message> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content, attachments_json, tool_calls_json, metadata_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(conversation_id)
    .bind(role)
    .bind(content)
    .bind(attachments)
    .bind(tool_calls)
    .bind(metadata)
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
        id: id.to_string(),
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
        metadata_json: metadata.map(|m| m.to_string()),
        created_at: now,
    })
}

pub async fn update_message_metadata(
    pool: &Pool<Sqlite>,
    message_id: &str,
    metadata_json: &str,
) -> anyhow::Result<()> {
    let changed = sqlx::query("UPDATE messages SET metadata_json = ? WHERE id = ?")
        .bind(metadata_json)
        .bind(message_id)
        .execute(pool)
        .await
        .context("failed to update message metadata")?
        .rows_affected();
    anyhow::ensure!(changed > 0, "message not found");
    Ok(())
}

pub async fn ensure_message_metadata_schema(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    let rows = sqlx::query("PRAGMA table_info(messages)")
        .fetch_all(pool)
        .await
        .context("failed to inspect messages schema")?;
    let has_metadata = rows.iter().any(|row| {
        let name: String = row.get("name");
        name == "metadata_json"
    });
    if !has_metadata {
        sqlx::query("ALTER TABLE messages ADD COLUMN metadata_json TEXT")
            .execute(pool)
            .await
            .context("failed to add messages.metadata_json")?;
    }
    Ok(())
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

pub async fn get_document(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<Option<LegalDocument>> {
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

pub async fn get_active_conversation_id(pool: &Pool<Sqlite>) -> anyhow::Result<Option<String>> {
    get_setting(pool, "active_conversation_id").await
}

pub async fn set_active_conversation_id(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<()> {
    set_setting(pool, "active_conversation_id", id).await
}

pub async fn get_allowed_file_dirs(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<String>> {
    match get_setting(pool, "allowed_file_dirs").await? {
        Some(json) => serde_json::from_str(&json).context("failed to parse allowed_file_dirs"),
        None => Ok(Vec::new()),
    }
}

pub async fn set_allowed_file_dirs(pool: &Pool<Sqlite>, dirs: &[String]) -> anyhow::Result<()> {
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

pub async fn get_fast_provider_meta(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Option<FastProviderMeta>> {
    match get_setting(pool, FAST_PROVIDER_META_KEY).await? {
        Some(v) => Ok(Some(serde_json::from_str(&v)?)),
        None => Ok(None),
    }
}

pub async fn fast_provider_has_api_key(pool: &Pool<Sqlite>) -> anyhow::Result<bool> {
    Ok(get_setting(pool, FAST_PROVIDER_API_KEY).await?.is_some())
}

// ---------------------------------------------------------------------------
// SkillOpt schema
// ---------------------------------------------------------------------------

pub async fn ensure_skill_opt_schema(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    let sql = include_str!("../../migrations/004_skill_opt.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .context("failed to apply skill_opt schema")?;
    Ok(())
}

pub async fn ensure_sync_schema(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    let has_col: Option<(i64,)> = sqlx::query_as(
        "SELECT COUNT(*) FROM pragma_table_info('eval_cases') WHERE name = 'gold_reference_path'",
    )
    .fetch_optional(pool)
    .await?;
    if has_col.map(|(c,)| c).unwrap_or(0) == 0 {
        sqlx::query("ALTER TABLE eval_cases ADD COLUMN gold_reference_path TEXT")
            .execute(pool)
            .await
            .context("failed to add eval_cases.gold_reference_path")?;
    }

    let sql = include_str!("../../migrations/005_sync_skill_update.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .context("failed to apply sync schema")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SkillOpt settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillOptSettings {
    pub enabled: bool,
    pub gate: String,
    pub auto_adopt: String,
    pub weights: SkillOptWeights,
    pub budget_tokens: u64,
    pub eval_data_roots: Vec<String>,
    pub optimizer_provider: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillOptWeights {
    pub human: f64,
    pub rubric: f64,
    pub cite: f64,
}

impl Default for SkillOptWeights {
    fn default() -> Self {
        Self {
            human: 0.4,
            rubric: 0.45,
            cite: 0.15,
        }
    }
}

impl Default for SkillOptSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            gate: "on".into(),
            auto_adopt: "off".into(),
            weights: SkillOptWeights::default(),
            budget_tokens: 100_000,
            eval_data_roots: Vec::new(),
            optimizer_provider: None,
        }
    }
}

pub async fn get_skillopt_settings(pool: &Pool<Sqlite>) -> anyhow::Result<SkillOptSettings> {
    let enabled = get_setting(pool, "skillopt_enabled")
        .await?
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let gate = get_setting(pool, "skillopt_gate")
        .await?
        .unwrap_or_else(|| "on".into());
    let auto_adopt = get_setting(pool, "skillopt_auto_adopt")
        .await?
        .unwrap_or_else(|| "off".into());
    let weights: SkillOptWeights = get_setting(pool, "skillopt_weights")
        .await?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let budget_tokens: u64 = get_setting(pool, "skillopt_budget_tokens")
        .await?
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000);
    let eval_data_roots: Vec<String> = get_setting(pool, "skillopt_eval_data_roots")
        .await?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| SkillOptSettings::default().eval_data_roots);
    let optimizer_provider = get_setting(pool, "skillopt_optimizer_provider")
        .await?
        .and_then(|v| serde_json::from_str(&v).ok());

    Ok(SkillOptSettings {
        enabled,
        gate,
        auto_adopt,
        weights,
        budget_tokens,
        eval_data_roots,
        optimizer_provider,
    })
}

pub async fn set_skillopt_settings(
    pool: &Pool<Sqlite>,
    settings: &SkillOptSettings,
) -> anyhow::Result<()> {
    set_setting(
        pool,
        "skillopt_enabled",
        if settings.enabled { "true" } else { "false" },
    )
    .await?;
    set_setting(pool, "skillopt_gate", &settings.gate).await?;
    set_setting(pool, "skillopt_auto_adopt", &settings.auto_adopt).await?;
    set_setting(
        pool,
        "skillopt_weights",
        &serde_json::to_string(&settings.weights)?,
    )
    .await?;
    set_setting(
        pool,
        "skillopt_budget_tokens",
        &settings.budget_tokens.to_string(),
    )
    .await?;
    set_setting(
        pool,
        "skillopt_eval_data_roots",
        &serde_json::to_string(&settings.eval_data_roots)?,
    )
    .await?;
    if let Some(ref op) = settings.optimizer_provider {
        set_setting(
            pool,
            "skillopt_optimizer_provider",
            &serde_json::to_string(op)?,
        )
        .await?;
    } else {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind("skillopt_optimizer_provider")
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn get_eval_data_roots(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<String>> {
    Ok(get_skillopt_settings(pool).await?.eval_data_roots)
}

// ---------------------------------------------------------------------------
// Skill feedback
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillFeedbackRow {
    pub id: String,
    pub message_id: String,
    pub conversation_id: String,
    pub skill_name: Option<String>,
    pub plugin_name: Option<String>,
    pub rating: String,
    pub comment: Option<String>,
    pub dimensions_json: Option<String>,
    pub created_at: String,
}

pub async fn insert_skill_feedback(
    pool: &Pool<Sqlite>,
    message_id: &str,
    conversation_id: &str,
    skill_name: Option<&str>,
    plugin_name: Option<&str>,
    rating: &str,
    comment: Option<&str>,
    dimensions_json: Option<&str>,
) -> anyhow::Result<SkillFeedbackRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO skill_feedback (id, message_id, conversation_id, skill_name, plugin_name, rating, comment, dimensions_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(message_id)
    .bind(conversation_id)
    .bind(skill_name)
    .bind(plugin_name)
    .bind(rating)
    .bind(comment)
    .bind(dimensions_json)
    .bind(&now)
    .execute(pool)
    .await
    .context("insert skill_feedback")?;
    Ok(SkillFeedbackRow {
        id,
        message_id: message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        skill_name: skill_name.map(|s| s.to_string()),
        plugin_name: plugin_name.map(|s| s.to_string()),
        rating: rating.to_string(),
        comment: comment.map(|s| s.to_string()),
        dimensions_json: dimensions_json.map(|s| s.to_string()),
        created_at: now,
    })
}

pub async fn list_skill_feedback_by_conversation(
    pool: &Pool<Sqlite>,
    conversation_id: &str,
) -> anyhow::Result<Vec<SkillFeedbackRow>> {
    let rows = sqlx::query(
        "SELECT id, message_id, conversation_id, skill_name, plugin_name, rating, comment, dimensions_json, created_at \
         FROM skill_feedback WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_skill_feedback).collect()
}

pub async fn list_all_skill_feedback(
    pool: &Pool<Sqlite>,
    limit: i64,
) -> anyhow::Result<Vec<SkillFeedbackRow>> {
    let rows = sqlx::query(
        "SELECT id, message_id, conversation_id, skill_name, plugin_name, rating, comment, dimensions_json, created_at \
         FROM skill_feedback ORDER BY created_at DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_skill_feedback).collect()
}

// ---------------------------------------------------------------------------
// Eval cases & runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvalCaseRow {
    pub id: String,
    pub name: String,
    pub target_skill: Option<String>,
    pub target_plugin: Option<String>,
    pub prompt: String,
    pub materials_path: Option<String>,
    pub rubric: Option<String>,
    pub gold_reference_path: Option<String>,
    pub split: String,
    pub origin: String,
    pub active: bool,
    pub created_at: String,
}

pub async fn insert_eval_case(
    pool: &Pool<Sqlite>,
    name: &str,
    target_skill: Option<&str>,
    target_plugin: Option<&str>,
    prompt: &str,
    materials_path: Option<&str>,
    rubric: Option<&str>,
    gold_reference_path: Option<&str>,
    split: &str,
    origin: &str,
) -> anyhow::Result<EvalCaseRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO eval_cases (id, name, target_skill, target_plugin, prompt, materials_path, rubric, gold_reference_path, split, origin, active, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(target_skill)
    .bind(target_plugin)
    .bind(prompt)
    .bind(materials_path)
    .bind(rubric)
    .bind(gold_reference_path)
    .bind(split)
    .bind(origin)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(EvalCaseRow {
        id,
        name: name.to_string(),
        target_skill: target_skill.map(|s| s.to_string()),
        target_plugin: target_plugin.map(|s| s.to_string()),
        prompt: prompt.to_string(),
        materials_path: materials_path.map(|s| s.to_string()),
        rubric: rubric.map(|s| s.to_string()),
        gold_reference_path: gold_reference_path.map(|s| s.to_string()),
        split: split.to_string(),
        origin: origin.to_string(),
        active: true,
        created_at: now,
    })
}

pub async fn get_eval_case(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<Option<EvalCaseRow>> {
    let row = sqlx::query(
        "SELECT id, name, target_skill, target_plugin, prompt, materials_path, rubric, gold_reference_path, split, origin, active, created_at \
         FROM eval_cases WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_eval_case).transpose()
}

pub async fn list_eval_cases(
    pool: &Pool<Sqlite>,
    active_only: bool,
) -> anyhow::Result<Vec<EvalCaseRow>> {
    let rows = if active_only {
        sqlx::query(
            "SELECT id, name, target_skill, target_plugin, prompt, materials_path, rubric, gold_reference_path, split, origin, active, created_at \
             FROM eval_cases WHERE active = 1 ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, name, target_skill, target_plugin, prompt, materials_path, rubric, gold_reference_path, split, origin, active, created_at \
             FROM eval_cases ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?
    };
    rows.iter().map(row_to_eval_case).collect()
}

pub async fn set_eval_case_active(
    pool: &Pool<Sqlite>,
    id: &str,
    active: bool,
) -> anyhow::Result<()> {
    sqlx::query("UPDATE eval_cases SET active = ? WHERE id = ?")
        .bind(if active { 1 } else { 0 })
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvalRunRow {
    pub id: String,
    pub case_id: String,
    pub skill_hash: Option<String>,
    pub score: f64,
    pub rubric_json: Option<String>,
    pub citation_json: Option<String>,
    pub tokens: Option<i64>,
    pub latency_ms: Option<i64>,
    pub created_at: String,
}

pub async fn insert_eval_run(
    pool: &Pool<Sqlite>,
    case_id: &str,
    skill_hash: Option<&str>,
    score: f64,
    rubric_json: Option<&str>,
    citation_json: Option<&str>,
    tokens: Option<i64>,
    latency_ms: Option<i64>,
) -> anyhow::Result<EvalRunRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO eval_runs (id, case_id, skill_hash, score, rubric_json, citation_json, tokens, latency_ms, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(case_id)
    .bind(skill_hash)
    .bind(score)
    .bind(rubric_json)
    .bind(citation_json)
    .bind(tokens)
    .bind(latency_ms)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(EvalRunRow {
        id,
        case_id: case_id.to_string(),
        skill_hash: skill_hash.map(|s| s.to_string()),
        score,
        rubric_json: rubric_json.map(|s| s.to_string()),
        citation_json: citation_json.map(|s| s.to_string()),
        tokens,
        latency_ms,
        created_at: now,
    })
}

pub async fn list_eval_runs(
    pool: &Pool<Sqlite>,
    case_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<EvalRunRow>> {
    let rows = sqlx::query(
        "SELECT id, case_id, skill_hash, score, rubric_json, citation_json, tokens, latency_ms, created_at \
         FROM eval_runs WHERE case_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(case_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_eval_run).collect()
}

// ---------------------------------------------------------------------------
// Skill proposals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillProposalRow {
    pub id: String,
    pub target_path: String,
    pub base_hash: Option<String>,
    pub diff: String,
    pub rationale: Option<String>,
    pub val_before: Option<f64>,
    pub val_after: Option<f64>,
    pub status: String,
    pub created_at: String,
    pub adopted_at: Option<String>,
}

pub async fn insert_skill_proposal(
    pool: &Pool<Sqlite>,
    target_path: &str,
    base_hash: Option<&str>,
    diff: &str,
    rationale: Option<&str>,
    val_before: Option<f64>,
    val_after: Option<f64>,
) -> anyhow::Result<SkillProposalRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO skill_proposals (id, target_path, base_hash, diff, rationale, val_before, val_after, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?)",
    )
    .bind(&id)
    .bind(target_path)
    .bind(base_hash)
    .bind(diff)
    .bind(rationale)
    .bind(val_before)
    .bind(val_after)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(SkillProposalRow {
        id,
        target_path: target_path.to_string(),
        base_hash: base_hash.map(|s| s.to_string()),
        diff: diff.to_string(),
        rationale: rationale.map(|s| s.to_string()),
        val_before,
        val_after,
        status: "staged".into(),
        created_at: now,
        adopted_at: None,
    })
}

pub async fn list_skill_proposals(
    pool: &Pool<Sqlite>,
    status: Option<&str>,
) -> anyhow::Result<Vec<SkillProposalRow>> {
    let rows = match status {
        Some(s) => {
            sqlx::query(
                "SELECT id, target_path, base_hash, diff, rationale, val_before, val_after, status, created_at, adopted_at \
                 FROM skill_proposals WHERE status = ? ORDER BY created_at DESC",
            )
            .bind(s)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT id, target_path, base_hash, diff, rationale, val_before, val_after, status, created_at, adopted_at \
                 FROM skill_proposals ORDER BY created_at DESC",
            )
            .fetch_all(pool)
            .await?
        }
    };
    rows.iter().map(row_to_skill_proposal).collect()
}

pub async fn get_skill_proposal(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<Option<SkillProposalRow>> {
    let row = sqlx::query(
        "SELECT id, target_path, base_hash, diff, rationale, val_before, val_after, status, created_at, adopted_at \
         FROM skill_proposals WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_skill_proposal).transpose()
}

pub async fn update_skill_proposal_status(
    pool: &Pool<Sqlite>,
    id: &str,
    status: &str,
) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    if status == "adopted" {
        sqlx::query(
            "UPDATE skill_proposals SET status = ?, adopted_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query("UPDATE skill_proposals SET status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

fn row_to_skill_feedback(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<SkillFeedbackRow> {
    Ok(SkillFeedbackRow {
        id: row.get("id"),
        message_id: row.get("message_id"),
        conversation_id: row.get("conversation_id"),
        skill_name: row.get("skill_name"),
        plugin_name: row.get("plugin_name"),
        rating: row.get("rating"),
        comment: row.get("comment"),
        dimensions_json: row.get("dimensions_json"),
        created_at: row.get("created_at"),
    })
}

fn row_to_eval_case(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<EvalCaseRow> {
    let active: i32 = row.get("active");
    Ok(EvalCaseRow {
        id: row.get("id"),
        name: row.get("name"),
        target_skill: row.get("target_skill"),
        target_plugin: row.get("target_plugin"),
        prompt: row.get("prompt"),
        materials_path: row.get("materials_path"),
        rubric: row.get("rubric"),
        gold_reference_path: row.get("gold_reference_path"),
        split: row.get("split"),
        origin: row.get("origin"),
        active: active != 0,
        created_at: row.get("created_at"),
    })
}

fn row_to_eval_run(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<EvalRunRow> {
    Ok(EvalRunRow {
        id: row.get("id"),
        case_id: row.get("case_id"),
        skill_hash: row.get("skill_hash"),
        score: row.get("score"),
        rubric_json: row.get("rubric_json"),
        citation_json: row.get("citation_json"),
        tokens: row.get("tokens"),
        latency_ms: row.get("latency_ms"),
        created_at: row.get("created_at"),
    })
}

fn row_to_skill_proposal(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<SkillProposalRow> {
    Ok(SkillProposalRow {
        id: row.get("id"),
        target_path: row.get("target_path"),
        base_hash: row.get("base_hash"),
        diff: row.get("diff"),
        rationale: row.get("rationale"),
        val_before: row.get("val_before"),
        val_after: row.get("val_after"),
        status: row.get("status"),
        created_at: row.get("created_at"),
        adopted_at: row.get("adopted_at"),
    })
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
        metadata_json: row.get("metadata_json"),
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
