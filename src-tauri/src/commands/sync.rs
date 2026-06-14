use sqlx::{Pool, Sqlite};
use std::sync::Arc;
use tauri::State;

use crate::security::key_store::KeyStore;
use crate::sync::settings::{self, SyncSettings, SyncSettingsUpdate};
use crate::sync::worker::{flush_outbox_once, get_sync_status, SyncStatus};

#[tauri::command]
pub async fn get_sync_settings(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
) -> Result<SyncSettings, String> {
    settings::get_sync_settings(&db, &key_store)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_sync_settings(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
    update: SyncSettingsUpdate,
) -> Result<(), String> {
    settings::set_sync_settings(&db, &key_store, &update)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sync_status_cmd(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
) -> Result<SyncStatus, String> {
    get_sync_status(&db, &key_store)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn flush_feedback_outbox(
    app: tauri::AppHandle,
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
) -> Result<usize, String> {
    let app_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    flush_outbox_once(&db, &key_store, &app_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_sync_connection(
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
) -> Result<(), String> {
    let settings = settings::get_sync_settings(&db, &key_store)
        .await
        .map_err(|e| e.to_string())?;
    let base = settings
        .sync_base_url
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "未配置同步服务地址".to_string())?;
    let api_key = settings::get_sync_api_key(&db, &key_store)
        .await
        .map_err(|e| e.to_string())?;
    let client = crate::sync::client::SyncClient::new(&base, api_key);
    client.health().await.map_err(|e| e.to_string())
}
