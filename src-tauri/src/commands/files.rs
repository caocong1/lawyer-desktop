use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::db::models::FileAttachment;
use crate::security::path_sandbox::PathSandbox;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub size: u64,
    pub is_dir: bool,
}

pub async fn read_file_inner(file_path: &Path) -> Result<String, String> {
    if !file_path.exists() {
        return Err(format!("File not found: {}", file_path.display()));
    }

    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "txt" | "md" | "json" | "csv" | "xml" | "html" | "yaml" | "yml" | "toml" | "log" => {
            tokio::fs::read_to_string(file_path)
                .await
                .map_err(|e| format!("Failed to read file: {}", e))
        }
        "pdf" => match pdf_extract::extract_text(file_path) {
            Ok(text) => {
                if text.len() > 50000 {
                    Ok(format!(
                        "{}...\n\n[PDF 已截断，共 {} 字符]",
                        &text[..50000],
                        text.len()
                    ))
                } else {
                    Ok(text)
                }
            }
            Err(e) => {
                let size = tokio::fs::metadata(file_path)
                    .await
                    .map_err(|e| e.to_string())?
                    .len();
                Ok(format!(
                    "[PDF 文件: {} — {} bytes — 提取失败: {}]",
                    file_path.display(),
                    size,
                    e
                ))
            }
        },
        "docx" => {
            let size = tokio::fs::metadata(file_path)
                .await
                .map_err(|e| e.to_string())?
                .len();
            Ok(format!(
                "[DOCX 文件: {} — {} bytes — DOCX 文本提取功能待实现]",
                file_path.display(),
                size
            ))
        }
        _ => match tokio::fs::read_to_string(file_path).await {
            Ok(content) => Ok(content),
            Err(_) => {
                let size = tokio::fs::metadata(file_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                Ok(format!(
                    "[二进制文件: {} — {} bytes]",
                    file_path.display(),
                    size
                ))
            }
        },
    }
}

#[tauri::command]
pub async fn read_file_content(
    path: String,
    sandbox: tauri::State<'_, Arc<RwLock<PathSandbox>>>,
) -> Result<String, String> {
    let validated = sandbox
        .read()
        .await
        .validate(&path)
        .map_err(|e| e.to_string())?;
    read_file_inner(&validated).await
}

#[tauri::command]
pub async fn list_directory(
    path: String,
    recursive: Option<bool>,
    sandbox: tauri::State<'_, Arc<RwLock<PathSandbox>>>,
) -> Result<Vec<FileInfo>, String> {
    let dir_path = sandbox
        .read()
        .await
        .validate(&path)
        .map_err(|e| e.to_string())?;

    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let recursive = recursive.unwrap_or(false);
    let mut files = Vec::new();
    scan_dir_recursive(&dir_path, &mut files, recursive).await?;
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn scan_dir_recursive<'a>(
    dir: &'a Path,
    files: &'a mut Vec<FileInfo>,
    recursive: bool,
) -> BoxFuture<'a, Result<(), String>> {
    Box::pin(async move {
        let mut entries = tokio::fs::read_dir(dir).await.map_err(|e| e.to_string())?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
            let file_type = if metadata.is_dir() {
                "directory".to_string()
            } else {
                entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            };

            files.push(FileInfo {
                path: entry.path().to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
                file_type,
                size: metadata.len(),
                is_dir: metadata.is_dir(),
            });

            if recursive && metadata.is_dir() {
                scan_dir_recursive(&entry.path(), files, recursive).await?;
            }
        }

        Ok(())
    })
}

#[tauri::command]
pub async fn prepare_attachment(
    path: String,
    sandbox: tauri::State<'_, Arc<RwLock<PathSandbox>>>,
) -> Result<FileAttachment, String> {
    let validated = sandbox
        .read()
        .await
        .validate(&path)
        .map_err(|e| e.to_string())?;
    let metadata = tokio::fs::metadata(&validated)
        .await
        .map_err(|e| e.to_string())?;

    let name = validated
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_type = validated
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content_preview = match read_file_inner(&validated).await {
        Ok(content) => {
            if content.len() > 50000 {
                Some(format!(
                    "{}...\n\n[文件已截断，共 {} 字符]",
                    &content[..50000],
                    content.len()
                ))
            } else {
                Some(content)
            }
        }
        Err(_) => None,
    };

    Ok(FileAttachment {
        path: validated.to_string_lossy().to_string(),
        name,
        file_type,
        size: metadata.len(),
        content_preview,
    })
}

pub fn build_sandbox(extra_dirs: &[String]) -> Result<PathSandbox, String> {
    PathSandbox::with_defaults(extra_dirs).map_err(|e| e.to_string())
}

pub async fn build_sandbox_from_db(pool: &sqlx::Pool<sqlx::Sqlite>) -> Result<PathSandbox, String> {
    let extra = crate::db::queries::get_allowed_file_dirs(pool)
        .await
        .map_err(|e| e.to_string())?;
    build_sandbox(&extra)
}

/// Persist a directory in `allowed_file_dirs` and hot-reload the sandbox.
pub async fn grant_directory_access(
    db: &Pool<Sqlite>,
    sandbox: &Arc<RwLock<PathSandbox>>,
    path: &str,
) -> Result<String, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| format!("无法解析路径: {}", e))?;
    if !canon.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }
    let path_str = canon.to_string_lossy().to_string();

    let mut dirs = crate::db::queries::get_allowed_file_dirs(db)
        .await
        .map_err(|e| e.to_string())?;
    if !dirs.iter().any(|d| d == &path_str) {
        dirs.push(path_str.clone());
        crate::db::queries::set_allowed_file_dirs(db, &dirs)
            .await
            .map_err(|e| e.to_string())?;
        reload_sandbox_from_db(db, sandbox).await?;
    }

    Ok(path_str)
}

/// Phase 0 degrade manifest: shallow directory stats until workspace index exists.
pub async fn prepare_directory_context(
    sandbox: &Arc<RwLock<PathSandbox>>,
    path: &str,
) -> Result<String, String> {
    let dir_path = sandbox
        .read()
        .await
        .validate(path)
        .map_err(|e| e.to_string())?;
    if !dir_path.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let mut file_count = 0u32;
    let mut dir_count = 0u32;
    let mut entries = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            dir_count += 1;
        } else {
            file_count += 1;
        }
    }

    Ok(format!(
        "目录清单（顶层）: {} 个文件, {} 个子目录。索引尚未建立，请使用 list_directory / read_file 工具访问；索引完成后请使用 search_workspace。",
        file_count, dir_count
    ))
}

pub async fn reload_sandbox_from_db(
    pool: &Pool<Sqlite>,
    sandbox: &Arc<RwLock<PathSandbox>>,
) -> Result<(), String> {
    let extra = crate::db::queries::get_allowed_file_dirs(pool)
        .await
        .map_err(|e| e.to_string())?;
    sandbox
        .write()
        .await
        .reload(&extra)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn grant_path_access(
    path: String,
    db: tauri::State<'_, Pool<Sqlite>>,
    sandbox: tauri::State<'_, Arc<RwLock<PathSandbox>>>,
) -> Result<Vec<String>, String> {
    grant_directory_access(&db, &sandbox, &path).await?;
    crate::db::queries::get_allowed_file_dirs(&db)
        .await
        .map_err(|e| e.to_string())
}
