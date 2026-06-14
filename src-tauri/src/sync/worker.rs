use std::sync::Arc;

use sqlx::{Pool, Sqlite};
use tauri::AppHandle;

use crate::security::key_store::KeyStore;
use crate::sync::client::SyncClient;
use crate::sync::outbox;
use crate::sync::settings;

const BATCH_LIMIT: i64 = 20;
const FLUSH_INTERVAL_SECS: u64 = 120;

pub async fn flush_outbox_once(
    pool: &Pool<Sqlite>,
    key_store: &KeyStore,
    app_version: &str,
) -> anyhow::Result<usize> {
    let sync_settings = settings::get_sync_settings(pool, key_store).await?;
    if !sync_settings.feedback_upload_enabled {
        return Ok(0);
    }
    let base = match sync_settings.sync_base_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => return Ok(0),
    };

    let api_key = settings::get_sync_api_key(pool, key_store).await?;
    let client = SyncClient::new(&base, api_key);

    let pending = outbox::list_pending_outbox(pool, BATCH_LIMIT).await?;
    if pending.is_empty() {
        return Ok(0);
    }

    for row in &pending {
        outbox::mark_outbox_sending(pool, &row.id).await?;
    }

    let batch = SyncClient::build_batch(
        &sync_settings.device_id,
        app_version,
        sync_settings.skills_version.clone(),
        &pending,
    );

    match client.send_feedback_batch(&batch).await {
        Ok(resp) => {
            let count = resp.accepted.len();
            for item in resp.accepted {
                outbox::mark_outbox_sent(pool, &item.outbox_id, Some(&item.remote_id)).await?;
            }
            Ok(count)
        }
        Err(e) => {
            for row in pending {
                outbox::mark_outbox_failed(pool, &row.id, row.attempt_count, &e.to_string())
                    .await?;
            }
            Err(e)
        }
    }
}

pub fn spawn_sync_worker(app: AppHandle, pool: Pool<Sqlite>, key_store: Arc<KeyStore>) {
    tauri::async_runtime::spawn(async move {
        let app_version = app
            .config()
            .version
            .clone()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

        // Startup flush
        if let Err(e) = flush_outbox_once(&pool, &key_store, &app_version).await {
            log::warn!("Startup feedback sync failed: {}", e);
        }

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(FLUSH_INTERVAL_SECS));
        loop {
            interval.tick().await;
            if let Err(e) = flush_outbox_once(&pool, &key_store, &app_version).await {
                log::debug!("Periodic feedback sync failed: {}", e);
            }
        }
    });
}

pub async fn get_sync_status(
    pool: &Pool<Sqlite>,
    key_store: &KeyStore,
) -> anyhow::Result<SyncStatus> {
    let settings = settings::get_sync_settings(pool, key_store).await?;
    let pending = outbox::count_pending_outbox(pool).await?;
    Ok(SyncStatus {
        settings,
        pending_outbox: pending,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncStatus {
    pub settings: settings::SyncSettings,
    pub pending_outbox: i64,
}
