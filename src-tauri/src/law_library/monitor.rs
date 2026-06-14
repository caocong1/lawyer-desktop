//! Regulation update monitor (法规更新监测) — periodically re-checks every
//! library statute against the online law-database connector; on a 时效状态
//! change it updates the manifest, lists affected saved documents, and emits a
//! `law-update-alert` event so the user can re-verify citations.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use sqlx::{Pool, Row, Sqlite};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

use crate::mcp::manager::{mcp_result_to_text, McpManager};

const DEFAULT_INTERVAL_SECS: u64 = 24 * 3600;
const STARTUP_DELAY_SECS: u64 = 600;
/// Pause between per-law online checks (connector is rate-limited anyway).
const PER_LAW_PAUSE_SECS: u64 = 2;

#[derive(Debug, Clone, Serialize)]
pub struct LawStatusChange {
    pub name: String,
    pub old_status: String,
    pub new_status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AffectedDocument {
    pub id: String,
    pub title: String,
    pub law_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LawUpdateAlert {
    pub changes: Vec<LawStatusChange>,
    pub affected_documents: Vec<AffectedDocument>,
    pub checked: usize,
}

fn interval_secs() -> u64 {
    std::env::var("INKSTATUTE_LAW_MONITOR_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECS)
}

pub fn spawn_regulation_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(STARTUP_DELAY_SECS.min(interval_secs()))).await;
        loop {
            match run_check(&app).await {
                Ok(Some(alert)) => {
                    log::info!(
                        "Law monitor: {} 部法规时效状态变化，{} 份文书受影响",
                        alert.changes.len(),
                        alert.affected_documents.len()
                    );
                    let _ = app.emit("law-update-alert", &alert);
                }
                Ok(None) => log::info!("Law monitor: 本轮无时效状态变化"),
                Err(e) => log::warn!("Law monitor failed: {}", e),
            }
            sleep(Duration::from_secs(interval_secs())).await;
        }
    });
}

/// Extract the 时效状态 reported for `law_name` from a connector search
/// result: the first `时效状态:` provenance line within the block that
/// mentions the exact statute title.
pub fn extract_status_for(law_name: &str, result_text: &str) -> Option<String> {
    let mut in_match_block = false;
    let mut lines_since_match = 0usize;
    for line in result_text.lines() {
        if line.contains(law_name) {
            in_match_block = true;
            lines_since_match = 0;
            continue;
        }
        if in_match_block {
            lines_since_match += 1;
            if let Some(v) = line.trim().strip_prefix("时效状态:") {
                let v = v.trim();
                if !v.is_empty() && v != "未知" {
                    return Some(v.to_string());
                }
            }
            // Past the block without a status line — stop attributing lines.
            if lines_since_match > 10 || line.trim().is_empty() {
                in_match_block = false;
            }
        }
    }
    None
}

async fn run_check(app: &AppHandle) -> Result<Option<LawUpdateAlert>> {
    let (root, _) = super::library_paths().context("law library not initialized")?;
    let manifest = super::load_manifest(&root).await?;
    if manifest.laws.is_empty() {
        return Ok(None);
    }

    let mcp = app.state::<McpManager>().inner().clone();
    let mut changes: Vec<LawStatusChange> = Vec::new();
    let mut checked = 0usize;

    for law in &manifest.laws {
        let result = mcp
            .call_tool_by_name(
                "mcp__law-database__search_laws",
                json!({ "keyword": law.name, "pageSize": 3 }),
            )
            .await;
        let Ok(result) = result else {
            // Connector offline — abort quietly, next cycle retries.
            log::info!("Law monitor: law-database 连接器不可用，跳过本轮");
            return Ok(None);
        };
        checked += 1;

        let text = mcp_result_to_text(&result);
        if let Some(online_status) = extract_status_for(&law.name, &text) {
            let local_status = law.status.as_deref().unwrap_or("未知");
            if online_status != local_status {
                changes.push(LawStatusChange {
                    name: law.name.clone(),
                    old_status: local_status.to_string(),
                    new_status: online_status,
                });
            }
        }
        sleep(Duration::from_secs(PER_LAW_PAUSE_SECS)).await;
    }

    if changes.is_empty() {
        return Ok(None);
    }

    super::apply_status_changes(&root, &changes)
        .await
        .unwrap_or_else(|e| log::warn!("Law monitor: manifest update failed: {}", e));

    let affected_documents = match app.try_state::<Pool<Sqlite>>() {
        Some(pool) => find_affected_documents(pool.inner(), &changes).await,
        None => Vec::new(),
    };

    Ok(Some(LawUpdateAlert {
        changes,
        affected_documents,
        checked,
    }))
}

/// Saved documents citing a changed statute (LIKE scan over document_json).
async fn find_affected_documents(
    pool: &Pool<Sqlite>,
    changes: &[LawStatusChange],
) -> Vec<AffectedDocument> {
    let mut affected = Vec::new();
    for change in changes {
        let pattern = format!("%{}%", change.name);
        let rows = sqlx::query("SELECT id, title FROM documents WHERE document_json LIKE ?")
            .bind(&pattern)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        for row in rows {
            affected.push(AffectedDocument {
                id: row.get("id"),
                title: row.get("title"),
                law_name: change.name.clone(),
            });
        }
    }
    affected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_status_from_matching_block() {
        let result = "找到 2 条：\n\
            标题: 中华人民共和国公司法\n类型: 法律\n时效状态: 已修改\n链接: https://flk.npc.gov.cn/x\n\
            \n标题: 中华人民共和国公司法实施条例\n时效状态: 现行有效\n";
        assert_eq!(
            extract_status_for("中华人民共和国公司法", result).as_deref(),
            Some("已修改")
        );
    }

    #[test]
    fn ignores_unknown_status_and_missing_law() {
        let result = "标题: 某法\n时效状态: 未知\n";
        assert_eq!(extract_status_for("某法", result), None);
        assert_eq!(extract_status_for("不存在的法", result), None);
    }
}
