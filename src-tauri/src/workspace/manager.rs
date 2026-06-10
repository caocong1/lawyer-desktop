use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Pool;
use sqlx::Sqlite;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::chunker::chunk_markdown;
use super::index_store::{find_chunk_in_dir, index_db_path, ChunkDetail, ChunkHit, IndexStore};
use super::parser::parse_file;
use super::scanner::{
    find_removed_paths, is_unchanged, scan_root, ScannedFile, DEFAULT_MAX_FILE_SIZE,
};

/// Bump when parser output changes (e.g. new DOCX extraction) so existing
/// indexes are rebuilt even though file hashes are unchanged.
/// Stored as `PRAGMA user_version` in each per-root index DB.
const PARSER_VERSION: i32 = 2;

/// Progress payload for callbacks and future `workspace-index-progress` events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexProgress {
    pub processed: u32,
    pub total: u32,
    pub current_file: Option<String>,
}

/// Summary returned after indexing completes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexStats {
    pub file_count: u32,
    pub chunk_count: u32,
}

struct WorkspaceConfig {
    app_data_dir: PathBuf,
}

static CONFIG: OnceLock<Mutex<WorkspaceConfig>> = OnceLock::new();

fn config_mutex() -> &'static Mutex<WorkspaceConfig> {
    CONFIG.get_or_init(|| {
        Mutex::new(WorkspaceConfig {
            app_data_dir: default_app_data_dir().unwrap_or_else(|_| PathBuf::from(".")),
        })
    })
}

/// Phase 0: call from `lib.rs` setup with Tauri `app_data_dir`.
pub fn set_app_data_dir(dir: PathBuf) -> Result<()> {
    config_mutex()
        .lock()
        .map_err(|e| anyhow::anyhow!("workspace config lock poisoned: {}", e))?
        .app_data_dir = dir;
    Ok(())
}

fn app_data_dir() -> Result<PathBuf> {
    let guard = config_mutex()
        .lock()
        .map_err(|e| anyhow::anyhow!("workspace config lock poisoned: {}", e))?;
    Ok(guard.app_data_dir.clone())
}

fn default_app_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var("APPDATA").context("APPDATA not set")?;
        return Ok(PathBuf::from(base).join("inkstatute"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").context("HOME not set")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("inkstatute"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").context("HOME not set")?;
        return Ok(PathBuf::from(home).join(".local").join("share").join("inkstatute"));
    }
    #[cfg(not(any(windows, unix)))]
    {
        anyhow::bail!("unsupported platform for workspace index");
    }
}

pub fn hash_root_path(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    hex::encode(digest)
}

async fn open_index_pool(root_hash: &str) -> Result<Pool<Sqlite>> {
    let data_dir = app_data_dir()?;
    let db_path = index_db_path(&data_dir, root_hash);
    IndexStore::open(&db_path, root_hash).await
}

/// Bind a directory root and run incremental indexing into `app_data_dir/workspaces/{root_hash}/index.db`.
pub async fn bind_and_index<F>(root: PathBuf, on_progress: F) -> Result<IndexStats>
where
    F: Fn(IndexProgress) + Send + Sync,
{
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace root: {}", root.display()))?;

    let root_path = root.to_string_lossy().to_string();
    let root_hash = hash_root_path(&root_path);
    let pool = open_index_pool(&root_hash).await?;
    let store = IndexStore::new(&pool, &root_hash);
    store.upsert_root(&root_path, &root_hash).await?;

    let indexed_parser_version: i32 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    let force_reindex = indexed_parser_version != PARSER_VERSION;
    if force_reindex {
        log::info!(
            "workspace {}: parser version {} -> {}, full re-index",
            root_path,
            indexed_parser_version,
            PARSER_VERSION
        );
    }

    let scanned = scan_root(&root, DEFAULT_MAX_FILE_SIZE)?;
    let total = scanned.len() as u32;

    let existing = store.list_file_records().await?;
    let existing_by_path: std::collections::HashMap<String, _> = existing
        .into_iter()
        .map(|r| (r.relative_path.clone(), r))
        .collect();

    let mut processed = 0u32;

    for file in &scanned {
        processed += 1;
        let progress = IndexProgress {
            processed,
            total,
            current_file: Some(file.relative_path.clone()),
        };
        on_progress(progress);

        if !force_reindex {
            if let Some(record) = existing_by_path.get(&file.relative_path) {
                if is_unchanged(record.mtime_secs, &record.sha256, file) {
                    continue;
                }
            }
        }

        index_one_file(&store, file).await?;
    }

    let existing_paths: Vec<String> = existing_by_path.keys().cloned().collect();
    for rel in find_removed_paths(&existing_paths, &scanned) {
        store.delete_file_by_relative_path(&rel).await?;
    }

    let (file_count, chunk_count) = store.count_files_and_chunks().await?;
    store
        .set_root_status("ready", file_count, chunk_count)
        .await?;

    sqlx::query(&format!("PRAGMA user_version = {}", PARSER_VERSION))
        .execute(&pool)
        .await
        .context("set index parser version")?;

    on_progress(IndexProgress {
        processed: total,
        total,
        current_file: None,
    });

    Ok(IndexStats {
        file_count: file_count as u32,
        chunk_count: chunk_count as u32,
    })
}

async fn index_one_file(store: &IndexStore<'_>, file: &ScannedFile) -> Result<()> {
    let path = file.absolute_path.clone();
    let ext = file.ext.clone();

    let parsed = tokio::task::spawn_blocking(move || parse_file(&path, &ext))
        .await
        .context("parse task join")??;

    let chunks = chunk_markdown(&file.relative_path, &parsed.markdown);
    store.upsert_file_and_chunks(file, &chunks).await
}

/// FTS search within a workspace index. `root_id` is the workspace `root_hash`.
pub async fn search(root_id: &str, query: &str, k: usize) -> Result<Vec<ChunkHit>> {
    let pool = open_index_pool(root_id).await?;
    IndexStore::new(&pool, root_id)
        .search(query, k)
        .await
}

/// Read a chunk by id (scans workspace index databases under app data dir).
pub async fn read_chunk(chunk_id: &str) -> Result<ChunkDetail> {
    let data_dir = app_data_dir()?;
    let workspaces_dir = data_dir.join("workspaces");
    find_chunk_in_dir(&workspaces_dir, chunk_id)
        .await?
        .with_context(|| format!("chunk not found: {}", chunk_id))
}

/// Index status for a bound workspace root (by absolute path or root_hash).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceStatus {
    pub root_id: String,
    pub root_path: String,
    pub status: String,
    pub file_count: u32,
    pub chunk_count: u32,
}

pub async fn get_status_for_path(root_path: &str) -> Result<Option<WorkspaceStatus>> {
    let canon = std::path::Path::new(root_path)
        .canonicalize()
        .with_context(|| format!("canonicalize root path: {}", root_path))?;
    let root_path_str = canon.to_string_lossy().to_string();
    let root_id = hash_root_path(&root_path_str);
    get_status(&root_id).await
}

pub async fn get_status(root_id: &str) -> Result<Option<WorkspaceStatus>> {
    let pool = open_index_pool(root_id).await?;
    let row = sqlx::query(
        "SELECT root_path, status, file_count, chunk_count FROM workspace_roots WHERE id = ?",
    )
    .bind(root_id)
    .fetch_optional(&pool)
    .await
    .context("lookup workspace status")?;

    let indexed_parser_version: i32 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);

    Ok(row.map(|row| {
        use sqlx::Row;
        let mut status: String = row.try_get("status").unwrap_or_else(|_| "unknown".into());
        // Parser upgraded since last index: report stale so callers re-bind.
        if status == "ready" && indexed_parser_version != PARSER_VERSION {
            status = "stale".into();
        }
        WorkspaceStatus {
            root_id: root_id.to_string(),
            root_path: row.try_get("root_path").unwrap_or_default(),
            status,
            file_count: row.try_get::<i32, _>("file_count").unwrap_or(0) as u32,
            chunk_count: row.try_get::<i32, _>("chunk_count").unwrap_or(0) as u32,
        }
    }))
}

pub async fn list_files(root_id: &str, pattern: Option<&str>) -> Result<Vec<String>> {
    let pool = open_index_pool(root_id).await?;
    let rows = if let Some(pat) = pattern.filter(|p| !p.is_empty()) {
        let like = format!("%{}%", pat);
        sqlx::query_scalar(
            "SELECT relative_path FROM workspace_files WHERE root_id = ? AND relative_path LIKE ? ORDER BY relative_path",
        )
        .bind(root_id)
        .bind(&like)
        .fetch_all(&pool)
        .await
        .context("list workspace files with pattern")?
    } else {
        sqlx::query_scalar(
            "SELECT relative_path FROM workspace_files WHERE root_id = ? ORDER BY relative_path",
        )
        .bind(root_id)
        .fetch_all(&pool)
        .await
        .context("list workspace files")?
    };
    Ok(rows)
}

pub async fn read_file_relative(
    root_id: &str,
    relative_path: &str,
    max_chars: Option<usize>,
) -> Result<String> {
    let status = get_status(root_id)
        .await?
        .with_context(|| format!("workspace not bound: {}", root_id))?;
    let root = std::path::PathBuf::from(&status.root_path);
    let rel = relative_path.trim().trim_start_matches(['/', '\\']);
    let abs = root.join(rel);
    let canon = abs
        .canonicalize()
        .with_context(|| format!("resolve file: {}", relative_path))?;
    if !canon.starts_with(root.canonicalize().unwrap_or(root.clone())) {
        anyhow::bail!("path escapes workspace root: {}", relative_path);
    }

    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let content = super::parser::parse_file(&canon, &ext)?.markdown;
    let limit = max_chars.unwrap_or(50_000);
    if content.chars().count() > limit {
        let truncated: String = content.chars().take(limit).collect();
        Ok(format!(
            "{}...\n\n[已截断，共 {} 字符]",
            truncated,
            content.chars().count()
        ))
    } else {
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    fn test_app_data_dir() -> PathBuf {
        std::env::temp_dir().join(format!("lawyer-ws-appdata-{}", Uuid::new_v4()))
    }

    fn setup_data_dir() -> PathBuf {
        let dir = test_app_data_dir();
        fs::create_dir_all(&dir).unwrap();
        set_app_data_dir(dir.clone()).unwrap();
        dir
    }

    fn fixture_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lawyer-ws-mgr-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(
            dir.join("docs/诉讼方案.md"),
            "# 诉讼方案\n\n## 索赔依据\n保函与违约金条款\n",
        )
        .unwrap();
        fs::write(dir.join("notes.txt"), "无标题备注：证据清单").unwrap();
        dir
    }

    fn root_hash_for(path: &Path) -> String {
        hash_root_path(&path.canonicalize().unwrap().to_string_lossy())
    }

    #[tokio::test]
    async fn bind_and_index_full_pipeline() {
        let _data = setup_data_dir();
        let root = fixture_root();
        let progress_log = Arc::new(Mutex::new(Vec::new()));
        let log = progress_log.clone();

        let stats = bind_and_index(root.clone(), move |p| {
            log.lock().unwrap().push(p);
        })
        .await
        .unwrap();

        assert_eq!(stats.file_count, 2);
        assert!(stats.chunk_count >= 2);

        let root_id = root_hash_for(&root);
        let hits = search(&root_id, "保函", 5).await.unwrap();
        assert!(!hits.is_empty());

        let detail = read_chunk(&hits[0].chunk_id).await.unwrap();
        assert!(detail.text.contains("保函") || detail.relative_path.contains("诉讼"));

        let progress = progress_log.lock().unwrap();
        assert!(!progress.is_empty());
        assert_eq!(
            progress.last().unwrap().processed,
            progress.last().unwrap().total
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn incremental_skips_unchanged_files() {
        let data = setup_data_dir();
        let root = fixture_root();

        let first = bind_and_index(root.clone(), |_| {}).await.unwrap();
        assert_eq!(first.file_count, 2);

        let second = bind_and_index(root.clone(), |_| {}).await.unwrap();
        assert_eq!(second.file_count, 2);
        assert_eq!(second.chunk_count, first.chunk_count);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn reindexes_when_content_changes() {
        let data = setup_data_dir();
        let root = fixture_root();
        let root_id = root_hash_for(&root);

        bind_and_index(root.clone(), |_| {}).await.unwrap();
        let before = search(&root_id, "证据清单", 5).await.unwrap();
        assert!(!before.is_empty());

        fs::write(root.join("notes.txt"), "更新后的内容：全新关键词 alpha999").unwrap();

        bind_and_index(root.clone(), |_| {}).await.unwrap();

        let after = search(&root_id, "alpha999", 5).await.unwrap();
        assert!(!after.is_empty());

        let old = search(&root_id, "证据清单", 5).await.unwrap();
        assert!(old.is_empty());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn parser_version_bump_marks_stale_and_reindexes() {
        let data = setup_data_dir();
        let root = fixture_root();
        let root_id = root_hash_for(&root);

        bind_and_index(root.clone(), |_| {}).await.unwrap();
        assert_eq!(get_status(&root_id).await.unwrap().unwrap().status, "ready");

        // Simulate an index built by an older parser.
        let pool = open_index_pool(&root_id).await.unwrap();
        sqlx::query("PRAGMA user_version = 1")
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(get_status(&root_id).await.unwrap().unwrap().status, "stale");

        bind_and_index(root.clone(), |_| {}).await.unwrap();
        assert_eq!(get_status(&root_id).await.unwrap().unwrap().status, "ready");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn removes_deleted_files_from_index() {
        let data = setup_data_dir();
        let root = fixture_root();
        let root_id = root_hash_for(&root);

        bind_and_index(root.clone(), |_| {}).await.unwrap();
        fs::remove_file(root.join("notes.txt")).unwrap();
        bind_and_index(root.clone(), |_| {}).await.unwrap();

        let hits = search(&root_id, "证据清单", 5).await.unwrap();
        assert!(hits.is_empty());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&data);
    }
}
