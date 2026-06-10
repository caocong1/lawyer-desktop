use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Row, Sqlite};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use uuid::Uuid;

use super::chunker::ChunkDraft;
use super::scanner::ScannedFile;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkHit {
    pub chunk_id: String,
    pub relative_path: String,
    pub text: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkDetail {
    pub chunk_id: String,
    pub relative_path: String,
    pub heading_path: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct ExistingFileRecord {
    pub id: String,
    pub relative_path: String,
    pub mtime_secs: i64,
    pub sha256: String,
}

pub struct IndexStore<'a> {
    pool: &'a Pool<Sqlite>,
    root_id: String,
}

impl<'a> IndexStore<'a> {
    pub fn new(pool: &'a Pool<Sqlite>, root_id: &str) -> Self {
        Self {
            pool,
            root_id: root_id.to_string(),
        }
    }

    pub async fn open(db_path: &Path, _root_id: &str) -> Result<Pool<Sqlite>> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create workspace index dir: {}", parent.display()))?;
        }

        let options = SqliteConnectOptions::from_str(&format!(
            "sqlite:{}",
            db_path.to_string_lossy().replace('\\', "/")
        ))?
        .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .with_context(|| format!("open workspace index db: {}", db_path.display()))?;

        migrate(&pool).await?;
        Ok(pool)
    }

    pub async fn upsert_root(&self, root_path: &str, root_hash: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM workspace_roots WHERE id = ?",
        )
        .bind(&self.root_id)
        .fetch_optional(self.pool)
        .await
        .context("lookup workspace root")?;

        if existing.is_some() {
            sqlx::query(
                "UPDATE workspace_roots SET root_path = ?, root_hash = ?, status = 'indexing', updated_at = ? WHERE id = ?",
            )
            .bind(root_path)
            .bind(root_hash)
            .bind(&now)
            .bind(&self.root_id)
            .execute(self.pool)
            .await
            .context("update workspace root")?;
            return Ok(());
        }

        sqlx::query(
            "INSERT INTO workspace_roots (id, root_path, root_hash, status, file_count, chunk_count, created_at, updated_at)
             VALUES (?, ?, ?, 'indexing', 0, 0, ?, ?)",
        )
        .bind(&self.root_id)
        .bind(root_path)
        .bind(root_hash)
        .bind(&now)
        .bind(&now)
        .execute(self.pool)
        .await
        .context("insert workspace root")?;
        Ok(())
    }

    pub async fn set_root_status(
        &self,
        status: &str,
        file_count: i32,
        chunk_count: i32,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE workspace_roots SET status = ?, file_count = ?, chunk_count = ?, updated_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(file_count)
        .bind(chunk_count)
        .bind(&now)
        .bind(&self.root_id)
        .execute(self.pool)
        .await
        .context("update root status")?;
        Ok(())
    }

    pub async fn list_file_records(&self) -> Result<Vec<ExistingFileRecord>> {
        let rows = sqlx::query(
            "SELECT id, relative_path, mtime_secs, sha256 FROM workspace_files WHERE root_id = ?",
        )
        .bind(&self.root_id)
        .fetch_all(self.pool)
        .await
        .context("list workspace files")?;

        rows.iter()
            .map(|row| {
                Ok(ExistingFileRecord {
                    id: row.try_get("id")?,
                    relative_path: row.try_get("relative_path")?,
                    mtime_secs: row.try_get("mtime_secs")?,
                    sha256: row.try_get("sha256")?,
                })
            })
            .collect()
    }

    pub async fn upsert_file_and_chunks(
        &self,
        scanned: &ScannedFile,
        chunks: &[ChunkDraft],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();

        let existing_id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM workspace_files WHERE root_id = ? AND relative_path = ?",
        )
        .bind(&self.root_id)
        .bind(&scanned.relative_path)
        .fetch_optional(self.pool)
        .await
        .context("lookup workspace file")?;

        let file_id = if let Some(id) = existing_id {
            sqlx::query(
                "UPDATE workspace_files SET absolute_path = ?, size = ?, mtime_secs = ?, sha256 = ?, file_ext = ?, indexed_at = ?
                 WHERE id = ?",
            )
            .bind(scanned.absolute_path.to_string_lossy().as_ref())
            .bind(scanned.size as i64)
            .bind(scanned.mtime_secs)
            .bind(&scanned.sha256)
            .bind(&scanned.ext)
            .bind(&now)
            .bind(&id)
            .execute(self.pool)
            .await
            .context("update workspace file")?;
            self.delete_chunks_for_file(&id).await?;
            id
        } else {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO workspace_files (id, root_id, absolute_path, relative_path, size, mtime_secs, sha256, file_ext, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&self.root_id)
            .bind(scanned.absolute_path.to_string_lossy().as_ref())
            .bind(&scanned.relative_path)
            .bind(scanned.size as i64)
            .bind(scanned.mtime_secs)
            .bind(&scanned.sha256)
            .bind(&scanned.ext)
            .bind(&now)
            .execute(self.pool)
            .await
            .context("insert workspace file")?;
            id
        };

        for chunk in chunks {
            let chunk_id = Uuid::new_v4().to_string();
            let heading_json = serde_json::to_string(&chunk.heading_path)?;
            sqlx::query(
                "INSERT INTO workspace_chunks (id, file_id, root_id, relative_path, heading_path, ordinal, content, sha256, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&chunk_id)
            .bind(&file_id)
            .bind(&self.root_id)
            .bind(&chunk.relative_path)
            .bind(&heading_json)
            .bind(chunk.ordinal)
            .bind(&chunk.content)
            .bind(&scanned.sha256)
            .bind(&now)
            .execute(self.pool)
            .await
            .context("insert workspace chunk")?;
        }

        Ok(())
    }

    pub async fn delete_chunks_for_file(&self, file_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM workspace_chunks WHERE file_id = ?")
            .bind(file_id)
            .execute(self.pool)
            .await
            .context("delete chunks for file")?;
        Ok(())
    }

    pub async fn delete_file_by_relative_path(&self, relative_path: &str) -> Result<()> {
        sqlx::query("DELETE FROM workspace_files WHERE root_id = ? AND relative_path = ?")
            .bind(&self.root_id)
            .bind(relative_path)
            .execute(self.pool)
            .await
            .context("delete workspace file")?;
        Ok(())
    }

    pub async fn count_files_and_chunks(&self) -> Result<(i32, i32)> {
        let file_count: i32 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workspace_files WHERE root_id = ?",
        )
        .bind(&self.root_id)
        .fetch_one(self.pool)
        .await
        .context("count files")?;

        let chunk_count: i32 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workspace_chunks WHERE root_id = ?",
        )
        .bind(&self.root_id)
        .fetch_one(self.pool)
        .await
        .context("count chunks")?;
        Ok((file_count, chunk_count))
    }

    pub async fn search(&self, query: &str, k: usize) -> Result<Vec<ChunkHit>> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // Terms shorter than 3 chars can't match the trigram index; when none
        // remain the LIKE fallback covers them.
        let fts_query = escape_fts_query(trimmed);
        if fts_query.is_empty() {
            return self.search_like(trimmed, k).await;
        }

        let rows = sqlx::query(
            "SELECT c.id, c.relative_path, c.content,
                    bm25(workspace_chunks_fts) AS score
             FROM workspace_chunks_fts
             JOIN workspace_chunks c ON c.rowid = workspace_chunks_fts.rowid
             WHERE workspace_chunks_fts MATCH ? AND c.root_id = ?
             ORDER BY score
             LIMIT ?",
        )
        .bind(&fts_query)
        .bind(&self.root_id)
        .bind(k as i64)
        .fetch_all(self.pool)
        .await
        .context("FTS search workspace chunks")?;

        let hits: Result<Vec<ChunkHit>> = rows.iter().map(|row| row_to_chunk_hit(row)).collect();
        let hits = hits?;
        if hits.is_empty() {
            // Recall fallback: short terms dropped above, or phrase mismatch.
            return self.search_like(trimmed, k).await;
        }
        Ok(hits)
    }

    /// Substring match on any whitespace-separated term (recall fallback).
    async fn search_like(&self, query: &str, k: usize) -> Result<Vec<ChunkHit>> {
        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let conditions = vec!["content LIKE ?"; terms.len()].join(" OR ");
        let sql = format!(
            "SELECT id, relative_path, content
             FROM workspace_chunks
             WHERE root_id = ? AND ({})
             LIMIT ?",
            conditions
        );
        let mut q = sqlx::query(&sql).bind(&self.root_id);
        for term in &terms {
            q = q.bind(format!("%{}%", term));
        }
        let rows = q
            .bind(k as i64)
            .fetch_all(self.pool)
            .await
            .context("LIKE search workspace chunks")?;

        rows.iter()
            .map(|row| {
                Ok(ChunkHit {
                    chunk_id: row.try_get("id")?,
                    relative_path: row.try_get("relative_path")?,
                    text: row.try_get("content")?,
                    score: 0.0,
                })
            })
            .collect()
    }

    pub async fn read_chunk(&self, chunk_id: &str) -> Result<Option<ChunkDetail>> {
        let row = sqlx::query(
            "SELECT id, relative_path, heading_path, content
             FROM workspace_chunks WHERE id = ?",
        )
        .bind(chunk_id)
        .fetch_optional(self.pool)
        .await
        .context("read workspace chunk")?;

        row.map(|row| {
            let heading_raw: String = row.try_get("heading_path")?;
            let heading_path: Vec<String> = if heading_raw.is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&heading_raw).unwrap_or_else(|_| vec![heading_raw])
            };
            Ok(ChunkDetail {
                chunk_id: row.try_get("id")?,
                relative_path: row.try_get("relative_path")?,
                heading_path,
                text: row.try_get("content")?,
            })
        })
        .transpose()
    }
}

fn row_to_chunk_hit(row: &sqlx::sqlite::SqliteRow) -> Result<ChunkHit> {
    Ok(ChunkHit {
        chunk_id: row.try_get("id")?,
        relative_path: row.try_get("relative_path")?,
        text: row.try_get("content")?,
        score: row.try_get::<f64, _>("score")?,
    })
}

/// Build an FTS5 trigram query: each whitespace-separated term becomes a
/// quoted phrase, OR-joined so multi-keyword queries rank by bm25 instead of
/// requiring the whole query as one literal phrase. Terms under 3 characters
/// are dropped (trigram can't match them); returns "" when nothing remains.
fn escape_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|t| t.chars().count() >= 3)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

pub fn index_db_path(app_data_dir: &Path, root_hash: &str) -> PathBuf {
    app_data_dir
        .join("workspaces")
        .join(root_hash)
        .join("index.db")
}

pub async fn migrate(pool: &Pool<Sqlite>) -> Result<()> {
    let sql = include_str!("../../migrations/002_workspace_index.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .context("workspace index migrate")?;
    Ok(())
}

pub async fn find_chunk_in_dir(
    workspaces_dir: &Path,
    chunk_id: &str,
) -> Result<Option<ChunkDetail>> {
    let entries = match std::fs::read_dir(workspaces_dir) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let db_path = entry.path().join("index.db");
        if !db_path.exists() {
            continue;
        }
        let root_hash = entry.file_name().to_string_lossy().to_string();
        let pool = IndexStore::open(&db_path, &root_hash).await?;
        let store = IndexStore::new(&pool, &root_hash);
        if let Some(detail) = store.read_chunk(chunk_id).await? {
            return Ok(Some(detail));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::chunker::chunk_markdown;
    use crate::workspace::scanner::{hash_file, ScannedFile};
    use uuid::Uuid;

    async fn test_pool(root_id: &str) -> Pool<Sqlite> {
        let dir = std::env::temp_dir().join(format!("lawyer-ws-store-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("index.db");
        let pool = IndexStore::open(&db, root_id).await.unwrap();
        pool
    }

    fn make_scanned(root: &std::path::Path, rel: &str, content: &str) -> ScannedFile {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        let sha256 = hash_file(&path).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        ScannedFile {
            absolute_path: path,
            relative_path: rel.replace('\\', "/"),
            size: meta.len(),
            mtime_secs: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            sha256,
            ext: "md".into(),
        }
    }

    #[tokio::test]
    async fn upsert_and_search_chunks() {
        let root_id = "hash1";
        let pool = test_pool(root_id).await;
        let store = IndexStore::new(&pool, root_id);
        store
            .upsert_root("/tmp/case", root_id)
            .await
            .unwrap();

        let temp = std::env::temp_dir().join(format!("lawyer-ws-data-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let scanned = make_scanned(&temp, "索赔函.md", "# 索赔\n保函相关条款\n违约金");
        let chunks = chunk_markdown(&scanned.relative_path, "# 索赔\n保函相关条款\n违约金");
        store
            .upsert_file_and_chunks(&scanned, &chunks)
            .await
            .unwrap();

        let hits = store.search("保函", 5).await.unwrap();
        assert!(!hits.is_empty());
        assert!(hits[0].text.contains("保函"));

        let detail = store
            .read_chunk(&hits[0].chunk_id)
            .await
            .unwrap()
            .expect("chunk exists");
        assert!(detail.text.contains("保函"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn replacing_chunks_on_file_update() {
        let root_id = "hash2";
        let pool = test_pool(root_id).await;
        let store = IndexStore::new(&pool, root_id);
        store.upsert_root("/tmp/case2", root_id).await.unwrap();

        let temp = std::env::temp_dir().join(format!("lawyer-ws-data2-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let mut scanned = make_scanned(&temp, "a.md", "# Old\nold keyword");
        let chunks = chunk_markdown(&scanned.relative_path, "# Old\nold keyword");
        store
            .upsert_file_and_chunks(&scanned, &chunks)
            .await
            .unwrap();

        std::fs::write(temp.join("a.md"), "# New\nnew unique keyword xyz").unwrap();
        scanned.sha256 = hash_file(&temp.join("a.md")).unwrap();
        let chunks = chunk_markdown(&scanned.relative_path, "# New\nnew unique keyword xyz");
        store
            .upsert_file_and_chunks(&scanned, &chunks)
            .await
            .unwrap();

        let old_hits = store.search("old", 5).await.unwrap();
        assert!(old_hits.is_empty());
        let new_hits = store.search("xyz", 5).await.unwrap();
        assert!(!new_hits.is_empty());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn escape_fts_query_or_joins_terms() {
        assert_eq!(escape_fts_query("投标保函"), "\"投标保函\"");
        assert_eq!(
            escape_fts_query("投标保函 中标资格"),
            "\"投标保函\" OR \"中标资格\""
        );
        // Sub-trigram terms are dropped; empty result means LIKE fallback.
        assert_eq!(escape_fts_query("保函"), "");
        assert_eq!(escape_fts_query("索赔 保函"), "");
        assert_eq!(escape_fts_query("保函 投标保函"), "\"投标保函\"");
    }

    #[tokio::test]
    async fn multi_keyword_chinese_search_finds_chunks() {
        let root_id = "hash3";
        let pool = test_pool(root_id).await;
        let store = IndexStore::new(&pool, root_id);
        store.upsert_root("/tmp/case3", root_id).await.unwrap();

        let temp = std::env::temp_dir().join(format!("lawyer-ws-data3-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let content = "# 备忘录\n重庆市双业融资担保有限公司出具投标保函，受益人为国航重庆分公司。";
        let scanned = make_scanned(&temp, "备忘录.md", content);
        let chunks = chunk_markdown(&scanned.relative_path, content);
        store.upsert_file_and_chunks(&scanned, &chunks).await.unwrap();

        // Model-style multi-keyword query: no chunk contains this as one phrase.
        let hits = store
            .search("投标保函 索赔 双业融资担保 广东九洲", 10)
            .await
            .unwrap();
        assert!(!hits.is_empty(), "multi-keyword OR query should match");

        // Two-char term goes through LIKE fallback.
        let hits = store.search("保函", 10).await.unwrap();
        assert!(!hits.is_empty(), "short term should match via LIKE");

        let _ = std::fs::remove_dir_all(&temp);
    }
}
