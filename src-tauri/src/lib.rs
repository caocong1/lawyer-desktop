mod commands;
mod db;
mod documents;
mod feedback;
mod llm;
mod mcp;
mod skills;

use llm::LlmEngine;
use mcp::manager::McpManager;
use mcp::types::McpServerConfig;
use skills::SkillRegistry;
use tauri::Manager;

/// Reads `.mcp.json` from the project root (parent of `src-tauri/`)
/// and returns parsed `McpServerConfig` entries.
fn load_mcp_config(project_root: &std::path::Path) -> Vec<McpServerConfig> {
    let config_path = project_root.join(".mcp.json");
    if !config_path.exists() {
        log::info!("No .mcp.json found at {:?}", config_path);
        return Vec::new();
    }

    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to read .mcp.json: {}", e);
            return Vec::new();
        }
    };

    // .mcp.json format: { "mcpServers": { "name": { "command": ..., "args": ..., "env": ... } } }
    #[derive(serde::Deserialize)]
    struct McpJsonConfig {
        #[serde(rename = "mcpServers")]
        mcp_servers: std::collections::HashMap<String, McpJsonServer>,
    }

    #[derive(serde::Deserialize)]
    struct McpJsonServer {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::HashMap<String, String>,
    }

    let parsed: McpJsonConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to parse .mcp.json: {}", e);
            return Vec::new();
        }
    };

    let mut configs = Vec::new();
    for (name, server) in parsed.mcp_servers {
        // Resolve environment variable placeholders like ${VAR_NAME}
        let resolved_env = server
            .env
            .into_iter()
            .map(|(k, v)| {
                let resolved = if v.starts_with("${") && v.ends_with('}') {
                    let var_name = &v[2..v.len() - 1];
                    std::env::var(var_name).unwrap_or_else(|_| {
                        log::warn!(
                            "MCP '{}': env var {} not set, using literal value",
                            name,
                            var_name
                        );
                        v.clone()
                    })
                } else {
                    v
                };
                (k, resolved)
            })
            .collect();

        configs.push(McpServerConfig {
            name,
            command: server.command,
            args: server.args,
            env: Some(resolved_env),
        });
    }

    configs
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file from project root (parent of src-tauri)
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .expect("CARGO_MANIFEST_DIR should have a parent")
        .to_path_buf();
    let env_path = project_root.join(".env");
    if env_path.exists() {
        let _ = dotenvy::from_path(&env_path);
    }

    env_logger::init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:lawyer-desktop.db", db::get_migrations())
                .build(),
        );

    builder
        .manage(LlmEngine::new())
        .manage(SkillRegistry::new())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to get app data dir: {}", e))?;
            let db_file = data_dir.join("lawyer-desktop.db");
            let db_url = format!("sqlite:{}?mode=rwc", db_file.display());

            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

            tauri::async_runtime::spawn(async move {
                match sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&db_url)
                    .await
                {
                    Ok(pool) => {
                        handle.manage(pool);
                        let _ = tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("db pool creation failed: {}", e)));
                    }
                }
            });

            rx.recv()
                .map_err(|_| "channel closed during pool creation".to_string())?
                .map_err(|e| e)?;

            log::info!("Database pool created at {:?}", db_file);

            // Auto-start MCP servers from .mcp.json
            let mcp_manager = McpManager::new();
            let configs = load_mcp_config(&project_root);
            if !configs.is_empty() {
                log::info!("Found {} MCP server(s) in .mcp.json, starting...", configs.len());
                let mgr = mcp_manager.clone();
                tauri::async_runtime::spawn(async move {
                    for config in configs {
                        log::info!("Starting MCP server: {} ({} {})", config.name, config.command, config.args.join(" "));
                        if let Err(e) = mgr.register(config).await {
                            log::error!("Failed to start MCP server: {}", e);
                        }
                    }
                    let health = mgr.check_health().await;
                    log::info!("MCP server health: {:#?}", health);
                });
            }
            app.manage(mcp_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chat::send_message,
            commands::chat::create_conversation,
            commands::chat::get_conversations,
            commands::chat::get_messages,
            commands::chat::delete_conversation,
            commands::chat::set_active_skill,
            commands::chat::update_conversation_title,
            commands::settings::get_provider_presets,
            commands::settings::setup_provider,
            commands::settings::test_provider,
            commands::settings::set_skills_root,
            commands::settings::reload_skills,
            commands::settings::list_skills,
            commands::settings::get_active_provider,
            commands::settings::set_active_conversation,
            commands::files::read_file_content,
            commands::files::list_directory,
            commands::files::prepare_attachment,
            commands::documents::generate_docx,
            commands::feedback::submit_feedback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
