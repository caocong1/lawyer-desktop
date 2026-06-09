use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub settings_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub attachments_json: Option<String>,
    pub tool_calls_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProvider {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub api_key: Option<String>,
    pub model_name: String,
    pub is_active: bool,
    pub config_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredSkill {
    pub id: String,
    pub plugin_name: String,
    pub skill_name: String,
    pub description: String,
    pub skill_md_path: String,
    pub argument_hint: Option<String>,
    pub is_enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feedback {
    pub id: String,
    pub message_id: Option<String>,
    pub conversation_id: String,
    pub rating: i32,
    pub comment: Option<String>,
    pub context_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeProfile {
    pub id: String,
    pub plugin_name: String,
    pub profile_content: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAttachment {
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub size: u64,
    pub content_preview: Option<String>,
}
