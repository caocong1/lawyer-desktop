mod commands;
mod db;
mod documents;
mod feedback;
mod llm;
mod mcp;
mod skills;

use llm::LlmEngine;
use skills::SkillRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:lawyer-desktop.db", db::get_migrations())
                .build(),
        )
        .manage(LlmEngine::new())
        .manage(SkillRegistry::new())
        .invoke_handler(tauri::generate_handler![
            // Chat
            commands::chat::send_message,
            commands::chat::create_conversation,
            // Settings
            commands::settings::get_provider_presets,
            commands::settings::setup_provider,
            commands::settings::test_provider,
            commands::settings::set_skills_root,
            commands::settings::reload_skills,
            commands::settings::list_skills,
            // Files
            commands::files::read_file_content,
            commands::files::list_directory,
            commands::files::prepare_attachment,
            // Documents
            commands::documents::generate_docx,
            // Feedback
            commands::feedback::submit_feedback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
