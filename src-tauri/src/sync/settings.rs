use crate::db;
use crate::security::key_store::KeyStore;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

const SYNC_BASE_URL: &str = "sync_base_url";
const SYNC_API_KEY: &str = "sync_api_key_encrypted";
const DEVICE_ID: &str = "sync_device_id";
const FEEDBACK_UPLOAD: &str = "sync_feedback_upload_enabled";
const UPLOAD_FULL_ANSWER: &str = "sync_upload_full_answer";
const SKILLS_CHANNEL: &str = "sync_skills_channel";
const APP_UPDATE_CHANNEL: &str = "sync_app_update_channel";
const SKILLS_VERSION: &str = "managed_skills_version";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncSettings {
    pub sync_base_url: Option<String>,
    pub has_api_key: bool,
    pub device_id: String,
    pub feedback_upload_enabled: bool,
    pub upload_full_answer: bool,
    pub skills_channel: String,
    pub app_update_channel: String,
    pub skills_version: Option<String>,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            sync_base_url: None,
            has_api_key: false,
            device_id: String::new(),
            feedback_upload_enabled: true,
            upload_full_answer: false,
            skills_channel: "stable".into(),
            app_update_channel: "stable".into(),
            skills_version: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncSettingsUpdate {
    pub sync_base_url: Option<String>,
    pub sync_api_key: Option<String>,
    pub feedback_upload_enabled: bool,
    pub upload_full_answer: bool,
    pub skills_channel: String,
    pub app_update_channel: String,
}

pub async fn get_sync_settings(pool: &Pool<Sqlite>, key_store: &KeyStore) -> anyhow::Result<SyncSettings> {
    let device_id = ensure_device_id(pool).await?;
    let sync_base_url = db::queries::get_setting(pool, SYNC_BASE_URL).await?;
    let has_api_key = db::queries::get_setting(pool, SYNC_API_KEY)
        .await?
        .is_some();
    let feedback_upload_enabled = db::queries::get_setting(pool, FEEDBACK_UPLOAD)
        .await?
        .map(|v| v == "true" || v == "1")
        .unwrap_or(true);
    let upload_full_answer = db::queries::get_setting(pool, UPLOAD_FULL_ANSWER)
        .await?
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let skills_channel = db::queries::get_setting(pool, SKILLS_CHANNEL)
        .await?
        .unwrap_or_else(|| "stable".into());
    let app_update_channel = db::queries::get_setting(pool, APP_UPDATE_CHANNEL)
        .await?
        .unwrap_or_else(|| "stable".into());
    let skills_version = db::queries::get_setting(pool, SKILLS_VERSION).await?;

    let _ = key_store; // api key not returned to frontend

    Ok(SyncSettings {
        sync_base_url,
        has_api_key,
        device_id,
        feedback_upload_enabled,
        upload_full_answer,
        skills_channel,
        app_update_channel,
        skills_version,
    })
}

pub async fn set_sync_settings(
    pool: &Pool<Sqlite>,
    key_store: &KeyStore,
    update: &SyncSettingsUpdate,
) -> anyhow::Result<()> {
    if let Some(ref url) = update.sync_base_url {
        db::queries::set_setting(pool, SYNC_BASE_URL, url.trim()).await?;
    }
    if let Some(ref key) = update.sync_api_key {
        if key.trim().is_empty() {
            sqlx::query("DELETE FROM app_settings WHERE key = ?")
                .bind(SYNC_API_KEY)
                .execute(pool)
                .await?;
        } else {
            let encrypted = key_store.encrypt(key.trim())?;
            db::queries::set_setting(pool, SYNC_API_KEY, &encrypted).await?;
        }
    }
    db::queries::set_setting(
        pool,
        FEEDBACK_UPLOAD,
        if update.feedback_upload_enabled {
            "true"
        } else {
            "false"
        },
    )
    .await?;
    db::queries::set_setting(
        pool,
        UPLOAD_FULL_ANSWER,
        if update.upload_full_answer { "true" } else { "false" },
    )
    .await?;
    db::queries::set_setting(pool, SKILLS_CHANNEL, &update.skills_channel).await?;
    db::queries::set_setting(pool, APP_UPDATE_CHANNEL, &update.app_update_channel).await?;
    Ok(())
}

pub async fn get_sync_api_key(pool: &Pool<Sqlite>, key_store: &KeyStore) -> anyhow::Result<Option<String>> {
    let enc = db::queries::get_setting(pool, SYNC_API_KEY).await?;
    key_store.decrypt_optional(enc.as_deref())
}

async fn ensure_device_id(pool: &Pool<Sqlite>) -> anyhow::Result<String> {
    if let Some(id) = db::queries::get_setting(pool, DEVICE_ID).await? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    db::queries::set_setting(pool, DEVICE_ID, &id).await?;
    Ok(id)
}

pub async fn get_device_id(pool: &Pool<Sqlite>) -> anyhow::Result<String> {
    ensure_device_id(pool).await
}

pub async fn set_skills_version(pool: &Pool<Sqlite>, version: &str) -> anyhow::Result<()> {
    db::queries::set_setting(pool, SKILLS_VERSION, version).await
}

pub async fn get_skills_version(pool: &Pool<Sqlite>) -> anyhow::Result<Option<String>> {
    db::queries::get_setting(pool, SKILLS_VERSION).await
}
