use chrono::{Duration, Utc};
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FeedbackOutboxRow {
    pub id: String,
    pub payload_json: String,
    pub status: String,
    pub attempt_count: i64,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
    pub remote_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn enqueue_feedback(
    pool: &Pool<Sqlite>,
    feedback_id: &str,
    payload_json: &str,
) -> anyhow::Result<FeedbackOutboxRow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO feedback_outbox (id, feedback_id, payload_json, status, attempt_count, next_retry_at, created_at, updated_at) \
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(feedback_id)
    .bind(payload_json)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(FeedbackOutboxRow {
        id,
        payload_json: payload_json.to_string(),
        status: "pending".into(),
        attempt_count: 0,
        next_retry_at: Some(now.clone()),
        last_error: None,
        remote_id: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Drop still-pending (not yet sent) outbox rows for this feedback so an edit
/// made before the upload flushes does not ship a stale version. Rows already
/// `sending`/`sent`/`failed` are left untouched.
pub async fn supersede_pending_feedback(
    pool: &Pool<Sqlite>,
    feedback_id: &str,
) -> anyhow::Result<u64> {
    let res = sqlx::query("DELETE FROM feedback_outbox WHERE feedback_id = ? AND status = 'pending'")
        .bind(feedback_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn list_pending_outbox(pool: &Pool<Sqlite>, limit: i64) -> anyhow::Result<Vec<FeedbackOutboxRow>> {
    let now = Utc::now().to_rfc3339();
    let rows = sqlx::query(
        "SELECT id, payload_json, status, attempt_count, next_retry_at, last_error, remote_id, created_at, updated_at \
         FROM feedback_outbox \
         WHERE status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= ?) \
         ORDER BY created_at ASC LIMIT ?",
    )
    .bind(&now)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(row_to_outbox).collect()
}

pub async fn mark_outbox_sending(pool: &Pool<Sqlite>, id: &str) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE feedback_outbox SET status = 'sending', updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_outbox_sent(pool: &Pool<Sqlite>, id: &str, remote_id: Option<&str>) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE feedback_outbox SET status = 'sent', remote_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(remote_id)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_outbox_failed(pool: &Pool<Sqlite>, id: &str, attempt_count: i64, error: &str) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    let backoff_secs = (60_i64 * 2_i64.pow(attempt_count.min(6) as u32)).min(3600);
    let next = (Utc::now() + Duration::seconds(backoff_secs)).to_rfc3339();
    sqlx::query(
        "UPDATE feedback_outbox SET status = 'failed', attempt_count = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(attempt_count + 1)
    .bind(error)
    .bind(&next)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn count_pending_outbox(pool: &Pool<Sqlite>) -> anyhow::Result<i64> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM feedback_outbox WHERE status IN ('pending', 'failed', 'sending')",
    )
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

fn row_to_outbox(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<FeedbackOutboxRow> {
    Ok(FeedbackOutboxRow {
        id: row.get("id"),
        payload_json: row.get("payload_json"),
        status: row.get("status"),
        attempt_count: row.get("attempt_count"),
        next_retry_at: row.get("next_retry_at"),
        last_error: row.get("last_error"),
        remote_id: row.get("remote_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/005_sync_skill_update.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE feedback_outbox ADD COLUMN feedback_id TEXT")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn supersede_removes_only_pending_same_feedback() {
        let pool = test_pool().await;
        enqueue_feedback(&pool, "fb1", "{\"v\":1}").await.unwrap();
        enqueue_feedback(&pool, "fb1", "{\"v\":2}").await.unwrap();
        enqueue_feedback(&pool, "fb2", "{\"v\":1}").await.unwrap();

        // fb2 already shipped - must survive supersede.
        sqlx::query("UPDATE feedback_outbox SET status='sent' WHERE feedback_id='fb2'")
            .execute(&pool)
            .await
            .unwrap();

        let removed = supersede_pending_feedback(&pool, "fb1").await.unwrap();
        assert_eq!(removed, 2, "both pending fb1 rows dropped");

        let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM feedback_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total.0, 1, "only the sent fb2 row remains");

        let removed_sent = supersede_pending_feedback(&pool, "fb2").await.unwrap();
        assert_eq!(removed_sent, 0, "sent rows are never superseded");
    }
}
