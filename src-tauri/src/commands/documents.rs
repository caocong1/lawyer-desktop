use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::documents::docx_gen;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateDocxRequest {
    pub title: String,
    pub content_markdown: String,
    pub template: Option<String>,
    pub output_path: String,
}

#[tauri::command]
pub async fn generate_docx(req: GenerateDocxRequest) -> Result<String, String> {
    let output_path = Path::new(&req.output_path);

    docx_gen::generate_docx(&req.title, &req.content_markdown, output_path)
        .map_err(|e| e.to_string())?;

    Ok(req.output_path)
}
