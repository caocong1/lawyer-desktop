mod commands;
pub mod citations;
pub mod db;
mod documents;
pub mod law_library;
pub mod llm;
mod mcp;
pub mod security;
pub mod skills;
pub mod skill_opt;
pub mod sync;
pub mod workspace;

use llm::LlmEngine;
use mcp::manager::McpManager;
use mcp::types::McpServerConfig;
use security::key_store::KeyStore;
use skills::SkillRegistry;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tauri::Emitter;
use tokio::sync::RwLock;

/// Resolve default skills root: `vendor/ai-for-china-legal` or sibling `../ai-for-china-legal`.
fn resolve_default_skills_root(project_root: &Path) -> Option<PathBuf> {
    let vendor = project_root.join("vendor/ai-for-china-legal");
    if vendor.is_dir() {
        return Some(vendor);
    }

    if let Some(parent) = project_root.parent() {
        let sibling = parent.join("ai-for-china-legal");
        if sibling.is_dir() {
            return Some(sibling);
        }
    }

    None
}

fn load_mcp_config(project_root: &Path) -> Vec<McpServerConfig> {
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

        // McpClient passes args verbatim to Command; relative script paths
        // would resolve against the process cwd (wrong in packaged builds).
        let resolved_args = server
            .args
            .into_iter()
            .map(|arg| {
                let candidate = project_root.join(&arg);
                if !std::path::Path::new(&arg).is_absolute() && candidate.exists() {
                    candidate.to_string_lossy().to_string()
                } else {
                    arg
                }
            })
            .collect();

        configs.push(McpServerConfig {
            name,
            command: server.command,
            args: resolved_args,
            env: Some(resolved_env),
        });
    }

    configs
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:lawyer-desktop.db", db::get_migrations())
                .build(),
        );

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .manage(LlmEngine::new())
        .manage(SkillRegistry::new())
        .manage(McpManager::new())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to get app data dir: {}", e))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("failed to create app data dir: {}", e))?;
            let db_file = data_dir.join("lawyer-desktop.db");
            let db_file_for_pool = db_file.clone();

            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

            tauri::async_runtime::spawn(async move {
                let options = sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_file_for_pool)
                    .create_if_missing(true);

                match sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect_with(options)
                    .await
                {
                    Ok(pool) => {
                        let migration_sql = include_str!("../migrations/001_init.sql");
                        if let Err(e) = sqlx::raw_sql(migration_sql).execute(&pool).await {
                            let _ = tx.send(Err(format!("db migration failed: {}", e)));
                            return;
                        }
                        if let Err(e) = db::queries::ensure_message_metadata_schema(&pool).await {
                            let _ = tx.send(Err(format!("db metadata migration failed: {}", e)));
                            return;
                        }
                        if let Err(e) = db::queries::ensure_skill_opt_schema(&pool).await {
                            let _ = tx.send(Err(format!("db skill_opt migration failed: {}", e)));
                            return;
                        }
                        if let Err(e) = db::queries::ensure_sync_schema(&pool).await {
                            let _ = tx.send(Err(format!("db sync migration failed: {}", e)));
                            return;
                        }
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

            if let Err(e) = workspace::set_app_data_dir(data_dir.clone()) {
                log::warn!("Failed to set workspace app data dir: {}", e);
            }

            let key_store = Arc::new(
                KeyStore::load_or_create(&data_dir)
                    .map_err(|e| format!("key store init failed: {}", e))?,
            );
            app.manage(key_store.clone());

            let pool = app.state::<sqlx::Pool<sqlx::Sqlite>>().inner().clone();

            // Path sandbox
            let extra_dirs = tauri::async_runtime::block_on(async {
                db::queries::get_allowed_file_dirs(&pool)
                    .await
                    .unwrap_or_default()
            });
            let sandbox = Arc::new(RwLock::new(
                commands::files::build_sandbox(&extra_dirs)
                    .map_err(|e| format!("path sandbox init failed: {}", e))?,
            ));
            app.manage(sandbox);

            // Eval sandbox (separate from lawyer allowed_file_dirs)
            let eval_roots = tauri::async_runtime::block_on(async {
                db::queries::get_eval_data_roots(&pool)
                    .await
                    .unwrap_or_default()
            });
            let eval_sandbox = Arc::new(RwLock::new(
                security::eval_sandbox::EvalPathSandbox::with_defaults(&eval_roots)
                    .unwrap_or_else(|_| security::eval_sandbox::EvalPathSandbox::new(Vec::new())),
            ));
            app.manage(eval_sandbox);

            // Restore active LLM provider
            let engine = app.state::<LlmEngine>().inner();
            if let Ok(Some(provider)) =
                tauri::async_runtime::block_on(db::queries::get_active_provider(&pool, &key_store))
            {
                let config = llm::types::ProviderConfig {
                    id: provider.id,
                    name: provider.name,
                    display_name: provider.display_name,
                    api_base_url: provider.api_base_url,
                    api_key: provider.api_key,
                    model_name: provider.model_name,
                    temperature: None,
                    max_tokens: None,
                };
                tauri::async_runtime::block_on(async {
                    if let Err(e) = engine.set_provider(config).await {
                        log::warn!("Failed to restore LLM provider: {}", e);
                    } else {
                        log::info!("Restored active LLM provider from database");
                    }
                });
            }

            if let Ok(Some(fast_config)) = tauri::async_runtime::block_on(
                db::queries::get_fast_provider_config(&pool, &key_store),
            ) {
                let engine = app.state::<LlmEngine>().inner();
                tauri::async_runtime::block_on(async {
                    if let Err(e) = engine.set_fast_provider(Some(fast_config)).await {
                        log::warn!("Failed to restore fast LLM provider: {}", e);
                    } else {
                        log::info!("Restored fast LLM provider from settings");
                    }
                });
            }

            // Skills: AppData managed directory with optional sync auto-update
            let dev_vendor = resolve_default_skills_root(&project_root);
            let sync_settings = tauri::async_runtime::block_on(async {
                crate::sync::settings::get_sync_settings(&pool, &key_store)
                    .await
                    .unwrap_or_default()
            });
            let sync_api_key = tauri::async_runtime::block_on(async {
                crate::sync::settings::get_sync_api_key(&pool, &key_store)
                    .await
                    .ok()
                    .flatten()
            });
            let data_dir_for_skills = data_dir.clone();
            tauri::async_runtime::block_on(async {
                let skills_reg = app.state::<SkillRegistry>();
                match crate::sync::skills_update::initialize_managed_skills(
                    &pool,
                    &key_store,
                    &data_dir_for_skills,
                    skills_reg.inner(),
                    dev_vendor,
                    sync_settings.sync_base_url.clone(),
                    sync_api_key,
                    &sync_settings.skills_channel,
                )
                .await
                {
                    Ok(root) => {
                        let _ = db::queries::set_setting(&pool, "skills_root", &root.to_string_lossy())
                            .await;
                        let count = skills_reg.inner().get_skills().await.len();
                        log::info!("Managed skills ready at {:?} ({} skills)", root, count);
                    }
                    Err(e) => log::warn!("Managed skills init failed: {}", e),
                }
            });

            // Background feedback sync worker
            crate::sync::worker::spawn_sync_worker(app.handle().clone(), pool.clone(), key_store.clone());

            // Periodic skill update check (every 6 hours)
            {
                let app_handle = app.handle().clone();
                let pool_skills = pool.clone();
                let key_store_skills = key_store.clone();
                let data_dir_skills = data_dir.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
                    loop {
                        interval.tick().await;
                        let settings = match crate::sync::settings::get_sync_settings(
                            &pool_skills,
                            &key_store_skills,
                        )
                        .await
                        {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        let base = match settings.sync_base_url.filter(|u| !u.trim().is_empty()) {
                            Some(u) => u,
                            None => continue,
                        };
                        let api_key = crate::sync::settings::get_sync_api_key(
                            &pool_skills,
                            &key_store_skills,
                        )
                        .await
                        .ok()
                        .flatten();
                        let client = crate::sync::client::SyncClient::new(&base, api_key);
                        let skills_reg = app_handle.state::<SkillRegistry>();
                        if let Ok(Some(version)) = crate::sync::skills_update::check_and_apply_skill_update(
                            &pool_skills,
                            &key_store_skills,
                            &data_dir_skills,
                            skills_reg.inner(),
                            &client,
                            &settings.skills_channel,
                        )
                        .await
                        {
                            let _ = app_handle.emit(
                                "skills-updated",
                                serde_json::json!({ "version": version }),
                            );
                        }
                    }
                });
            }

            // Law library: copy bundled corpus into app data and index it.
            {
                let mut resource_candidates: Vec<PathBuf> = Vec::new();
                if let Ok(res_dir) = app.path().resource_dir() {
                    resource_candidates.push(res_dir.join("resources/law-library"));
                }
                // Dev fallback: the repo checkout next to the manifest dir.
                resource_candidates.push(project_root.join("src-tauri/resources/law-library"));

                let data_dir_for_law = data_dir.clone();
                let app_handle_for_monitor = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match law_library::ensure_library(resource_candidates, &data_dir_for_law).await
                    {
                        Ok(stats) => {
                            log::info!(
                                "Law library ready: {} files / {} chunks indexed",
                                stats.file_count,
                                stats.chunk_count
                            );
                            // 法规更新监测：每日比对在线时效状态，提示受影响文书。
                            law_library::monitor::spawn_regulation_monitor(app_handle_for_monitor);
                        }
                        Err(e) => log::warn!("Law library init failed: {}", e),
                    }
                });
            }

            // Auto-start MCP servers from .mcp.json
            let mcp_manager = app.state::<McpManager>().inner().clone();
            let configs = load_mcp_config(&project_root);
            if !configs.is_empty() {
                log::info!(
                    "Found {} MCP server(s) in .mcp.json, starting...",
                    configs.len()
                );
                let mgr = mcp_manager.clone();
                tauri::async_runtime::spawn(async move {
                    for config in configs {
                        log::info!(
                            "Starting MCP server: {} ({} {})",
                            config.name,
                            config.command,
                            config.args.join(" ")
                        );
                        if let Err(e) = mgr.register(config).await {
                            log::error!("Failed to start MCP server: {}", e);
                        }
                    }
                    let health = mgr.check_health().await;
                    log::info!("MCP server health: {:#?}", health);
                });
            }

            // Optional sleep cycle: when enabled, schedule a dry-run refinement after idle
            {
                let app_handle = app.handle().clone();
                let pool_for_sleep = pool.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    if let Ok(settings) = db::queries::get_skillopt_settings(&pool_for_sleep).await {
                        if settings.enabled {
                            log::info!("SkillOpt sleep cycle: enabled (trigger refinement from admin panel Ctrl+Shift+O)");
                            let _ = app_handle.emit(
                                "skillopt-progress",
                                skill_opt::SkillOptProgressEvent {
                                    stage: "sleep_hint".into(),
                                    message: "技能精炼已启用。按 Ctrl+Shift+O 打开管理面板运行睡眠周期。".into(),
                                    progress: None,
                                    detail: None,
                                },
                            );
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chat::send_message,
            commands::chat::classify_agent_mode,
            commands::chat::update_message_metadata,
            commands::chat::generate_followup_prompts,
            commands::chat::create_conversation,
            commands::chat::get_conversations,
            commands::chat::get_messages,
            commands::chat::delete_conversation,
            commands::chat::update_conversation_title,
            commands::settings::get_provider_presets,
            commands::settings::setup_provider,
            commands::settings::test_provider,
            commands::settings::get_skills_root,
            commands::settings::set_skills_root,
            commands::settings::reload_skills,
            commands::settings::list_skills,
            commands::settings::get_active_provider,
            commands::settings::get_fast_provider,
            commands::settings::get_fast_model_presets,
            commands::settings::setup_fast_provider,
            commands::settings::test_fast_provider,
            commands::settings::set_active_conversation,
            commands::settings::get_mcp_health,
            commands::settings::get_allowed_file_dirs,
            commands::settings::set_allowed_file_dirs,
            commands::settings::get_law_library_status,
            commands::settings::reindex_law_library,
            commands::files::grant_path_access,
            commands::files::read_file_content,
            commands::files::list_directory,
            commands::files::prepare_attachment,
            commands::files::classify_dropped_paths,
            commands::workspace::bind_workspace,
            commands::workspace::get_workspace_index_status,
            commands::workspace::search_workspace,
            commands::documents::generate_docx,
            commands::documents::parse_legal_document,
            commands::skillopt::get_skillopt_settings,
            commands::skillopt::set_skillopt_settings,
            commands::skillopt::submit_message_feedback,
            commands::skillopt::get_message_feedback,
            commands::skillopt::list_all_feedback,
            commands::skillopt::list_eval_cases,
            commands::skillopt::set_eval_case_active,
            commands::skillopt::run_eval_case,
            commands::skillopt::list_eval_runs,
            commands::skillopt::list_proposals,
            commands::skillopt::adopt_proposal,
            commands::skillopt::reject_proposal,
            commands::skillopt::run_skill_refinement,
            commands::skillopt::mine_eval_cases,
            commands::skillopt::get_skillopt_overview,
            commands::sync::get_sync_settings,
            commands::sync::set_sync_settings,
            commands::sync::get_sync_status_cmd,
            commands::sync::flush_feedback_outbox,
            commands::sync::test_sync_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
