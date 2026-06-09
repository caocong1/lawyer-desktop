use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackEntry {
    pub id: String,
    pub message_id: Option<String>,
    pub conversation_id: String,
    pub rating: i32,
    pub comment: Option<String>,
    pub context_json: Option<String>,
    pub created_at: String,
}

pub fn export_feedback_json(entries: &[FeedbackEntry]) -> Result<String> {
    serde_json::to_string_pretty(entries).map_err(|e| anyhow::anyhow!("Failed to export feedback: {}", e))
}

pub fn export_feedback_csv(entries: &[FeedbackEntry]) -> Result<String> {
    let mut csv = String::from("id,message_id,conversation_id,rating,comment,created_at\n");
    for entry in entries {
        csv.push_str(&format!(
            "{},{},{},{},\"{}\",{}\n",
            entry.id,
            entry.message_id.as_deref().unwrap_or(""),
            entry.conversation_id,
            entry.rating,
            entry.comment.as_deref().unwrap_or("").replace('"', "\"\""),
            entry.created_at,
        ));
    }
    Ok(csv)
}
