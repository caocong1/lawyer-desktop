use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitFeedbackRequest {
    pub message_id: Option<String>,
    pub conversation_id: String,
    pub rating: i32,
    pub comment: Option<String>,
    pub context_json: Option<String>,
}

#[tauri::command]
pub async fn submit_feedback(_req: SubmitFeedbackRequest) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    // Store in database via SQL plugin (handled by frontend)
    Ok(id)
}
