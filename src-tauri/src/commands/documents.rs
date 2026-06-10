use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::RwLock;

use sqlx::{Pool, Sqlite};

use crate::db;
use crate::documents::{docx_gen, types};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateDocxRequest {
    pub title: String,
    pub content_markdown: String,
    pub template: Option<String>,
    pub output_path: String,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseLegalDocumentRequest {
    pub json_content: String,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseLegalDocumentResponse {
    pub document: types::LegalDocumentModel,
    pub markdown: String,
    pub document_id: Option<String>,
}

#[tauri::command]
pub async fn generate_docx(
    req: GenerateDocxRequest,
    sandbox: tauri::State<'_, Arc<RwLock<crate::security::path_sandbox::PathSandbox>>>,
    db: State<'_, Pool<Sqlite>>,
) -> Result<String, String> {
    let validated = sandbox
        .read()
        .await
        .validate(&req.output_path)
        .map_err(|e| e.to_string())?;

    docx_gen::generate_docx(&req.title, &req.content_markdown, &validated)
        .map_err(|e| e.to_string())?;

    if let Ok(doc_json) = serde_json::to_string(&serde_json::json!({
        "title": req.title,
        "content_markdown": req.content_markdown,
        "template": req.template,
        "output_path": validated.to_string_lossy(),
    })) {
        let _ = db::queries::save_document(
            &db,
            req.conversation_id.as_deref(),
            &req.title,
            &doc_json,
        )
        .await;
    }

    Ok(validated.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn parse_legal_document(
    req: ParseLegalDocumentRequest,
    db: State<'_, Pool<Sqlite>>,
) -> Result<ParseLegalDocumentResponse, String> {
    let document = types::parse_legal_document_json(&req.json_content)
        .map_err(|e| e.to_string())?;

    let markdown = document.to_markdown();
    let doc_json = serde_json::to_string(&document).map_err(|e| e.to_string())?;

    let saved = db::queries::save_document(
        &db,
        req.conversation_id.as_deref(),
        &document.title,
        &doc_json,
    )
    .await
    .ok();

    Ok(ParseLegalDocumentResponse {
        document,
        markdown,
        document_id: saved.map(|d| d.id),
    })
}
