//! Probe saved LLM provider(s) for native tool_calls support.
//! Usage: cargo run --bin probe_llm_tools

use std::path::PathBuf;
use std::sync::Arc;

use lawyer_desktop_lib::db;
use lawyer_desktop_lib::llm::probe::{probe_provider, ToolSupportReport};
use lawyer_desktop_lib::llm::types::ProviderConfig;
use lawyer_desktop_lib::security::key_store::KeyStore;

fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("INKSTATUTE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("com.sorawatcher.inkstatute");
    }
    PathBuf::from(".")
}

fn print_report(r: &ToolSupportReport) {
    println!("Verdict: {}", r.verdict);
    println!("Latency: {}ms", r.latency_ms);
    if let Some(reason) = &r.finish_reason {
        println!("finish_reason: {reason}");
    }
    println!("native tool_calls: {}", r.native_tool_calls);
    if !r.tool_names.is_empty() {
        println!("tool names: {}", r.tool_names.join(", "));
    }
    if !r.embedded_invoke_names.is_empty() {
        println!("embedded invoke: {}", r.embedded_invoke_names.join(", "));
    }
    if r.dsml_in_content {
        println!("DSML/leakage in content: yes");
    }
    if !r.content_preview.is_empty() {
        println!("content preview: {:?}", r.content_preview);
    }
    if let Some(err) = &r.error {
        println!("error: {err}");
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = default_data_dir();
    let db_file = data_dir.join("lawyer-desktop.db");
    if !db_file.exists() {
        anyhow::bail!(
            "找不到数据库 {}，请先在墨律设置中保存模型，或设置 INKSTATUTE_DATA_DIR",
            db_file.display()
        );
    }

    let key_store = Arc::new(KeyStore::load_or_create(&data_dir)?);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect(&format!("sqlite:{}", db_file.display()))
        .await?;

    let mut ok = false;

    if let Some(primary) = db::queries::get_active_provider(&pool, &key_store).await? {
        println!("=== 主模型 ===");
        println!("  {} / {}", primary.display_name, primary.model_name);
        println!("  {}\n", primary.api_base_url);
        let report = probe_provider(
            "primary",
            ProviderConfig {
                id: primary.id,
                name: primary.name,
                display_name: primary.display_name,
                api_base_url: primary.api_base_url,
                api_key: primary.api_key,
                model_name: primary.model_name,
                temperature: None,
                max_tokens: None,
            },
        )
        .await;
        ok |= report.native_tool_calls > 0;
        print_report(&report);
    } else {
        anyhow::bail!("未配置主模型");
    }

    if let Ok(Some(fast)) = db::queries::get_fast_provider_config(&pool, &key_store).await {
        println!("\n=== 快速模型 ===");
        println!("  {} / {}", fast.display_name, fast.model_name);
        println!("  {}\n", fast.api_base_url);
        let report = probe_provider("fast", fast).await;
        print_report(&report);
    } else {
        println!("\n(未启用快速模型，跳过)\n");
    }

    std::process::exit(if ok { 0 } else { 1 });
}
