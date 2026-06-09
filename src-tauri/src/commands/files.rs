use serde::{Deserialize, Serialize};
use std::path::Path;
use futures::future::BoxFuture;

use crate::db::models::FileAttachment;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub size: u64,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
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
        "pdf" => {
            // Extract text from PDF
            match pdf_extract::extract_text(file_path) {
                Ok(text) => {
                    if text.len() > 50000 {
                        Ok(format!("{}...\n\n[PDF 已截断，共 {} 字符]", &text[..50000], text.len()))
                    } else {
                        Ok(text)
                    }
                }
                Err(e) => {
                    let size = tokio::fs::metadata(file_path)
                        .await
                        .map_err(|e| e.to_string())?
                        .len();
                    Ok(format!("[PDF 文件: {} — {} bytes — 提取失败: {}]", path, size, e))
                }
            }
        }
        "docx" => {
            let size = tokio::fs::metadata(file_path)
                .await
                .map_err(|e| e.to_string())?
                .len();
            Ok(format!("[DOCX 文件: {} — {} bytes — DOCX 文本提取功能待实现]", path, size))
        }
        _ => {
            match tokio::fs::read_to_string(file_path).await {
                Ok(content) => Ok(content),
                Err(_) => {
                    let size = tokio::fs::metadata(file_path)
                        .await
                        .map(|m| m.len())
                        .unwrap_or(0);
                    Ok(format!("[二进制文件: {} — {} bytes]", path, size))
                }
            }
        }
    }
}

fn scan_dir_recursive<'a>(dir: &'a Path, files: &'a mut Vec<FileInfo>, recursive: bool) -> BoxFuture<'a, Result<(), String>> {
    Box::pin(async move {
        let mut entries = tokio::fs::read_dir(dir)
            .await
            .map_err(|e| e.to_string())?;

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
pub async fn list_directory(path: String, recursive: Option<bool>) -> Result<Vec<FileInfo>, String> {
    let dir_path = Path::new(&path);

    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let recursive = recursive.unwrap_or(false);
    let mut files = Vec::new();

    scan_dir_recursive(dir_path, &mut files, recursive).await?;
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub async fn prepare_attachment(path: String) -> Result<FileAttachment, String> {
    let file_path = Path::new(&path);
    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| e.to_string())?;

    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_type = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content_preview = match read_file_content(path.clone()).await {
        Ok(content) => {
            if content.len() > 50000 {
                Some(format!("{}...\n\n[文件已截断，共 {} 字符]", &content[..50000], content.len()))
            } else {
                Some(content)
            }
        }
        Err(_) => None,
    };

    Ok(FileAttachment {
        path,
        name,
        file_type,
        size: metadata.len(),
        content_preview,
    })
}
