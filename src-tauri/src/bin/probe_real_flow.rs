//! Replay the real evidence-mode agent loop against the saved provider,
//! with full per-round diagnostics. Reads the same APPDATA DB and workspace
//! index that the GUI uses.
//! Usage: cargo run --bin probe_real_flow [-- max_rounds]

use std::path::PathBuf;
use std::sync::Arc;

use lawyer_desktop_lib::db;
use lawyer_desktop_lib::llm::openai_compat::OpenAiCompatProvider;
use lawyer_desktop_lib::llm::provider::LlmProvider;
use lawyer_desktop_lib::llm::tool_leak::{contains_tool_leakage, parse_embedded_tool_calls};
use lawyer_desktop_lib::llm::types::{ChatMessage, ChatRequest, ProviderConfig, ToolCall};
use lawyer_desktop_lib::security::key_store::KeyStore;
use lawyer_desktop_lib::skills::{loader, router};
use lawyer_desktop_lib::workspace;

const ROOT_PATH: &str = r"\\?\C:\Users\sorawatcher\workspace\cn-lawyer-docs-skill\learning-materials\guohang-chongqing-shuangye\case-materials\案件资料";

const TOOL_LEAK_NUDGE: &str =
    "上一条回复包含了工具调用标记（DSML / invoke / parameter 等），不是正式分析正文。\
请仅通过工具 API 调用 search_workspace、read_chunk 等获取案卷内容，再输出完整 Markdown 诉讼方案。\
禁止在正文中输出任何工具调用语法。";

fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("INKSTATUTE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("com.sorawatcher.inkstatute");
    }
    PathBuf::from(".")
}

async fn execute_evidence_tool(root_id: &str, tc: &ToolCall) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
        .map_err(|e| format!("Invalid tool arguments: {}", e))?;

    match tc.function.name.as_str() {
        "search_workspace" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "query required".to_string())?;
            let k = args
                .get("k")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 30) as usize;
            let hits = workspace::search(root_id, query, k)
                .await
                .map_err(|e| e.to_string())?;
            if hits.is_empty() {
                Ok(format!("未找到与「{}」相关的 chunk。", query))
            } else {
                let lines: Vec<String> = hits
                    .iter()
                    .map(|h| {
                        let preview: String = h.text.chars().take(200).collect();
                        format!(
                            "- chunk_id={} path={} score={:.2}\n  {}",
                            h.chunk_id, h.relative_path, h.score, preview
                        )
                    })
                    .collect();
                Ok(format!(
                    "找到 {} 条结果：\n{}",
                    hits.len(),
                    lines.join("\n")
                ))
            }
        }
        "read_chunk" => {
            let chunk_id = args
                .get("chunk_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "chunk_id required".to_string())?;
            let d = workspace::read_chunk(chunk_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "chunk_id: {}\nrelative_path: {}\n\n{}",
                d.chunk_id, d.relative_path, d.text
            ))
        }
        "read_file" => {
            let relative_path = args
                .get("relative_path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "relative_path required".to_string())?;
            let max_chars = args
                .get("max_chars")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            workspace::read_file_relative(root_id, relative_path, max_chars)
                .await
                .map_err(|e| e.to_string())
        }
        "list_files" => {
            let pattern = args.get("pattern").and_then(|v| v.as_str());
            let paths = workspace::list_files(root_id, pattern)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("共 {} 个文件：\n{}", paths.len(), paths.join("\n")))
        }
        "get_index_status" => {
            let st = workspace::get_status(root_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "workspace 尚未建立索引".to_string())?;
            Ok(format!(
                "status: {}\nfile_count: {}\nchunk_count: {}",
                st.status, st.file_count, st.chunk_count
            ))
        }
        other => Err(format!("Unknown tool: {}", other)),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let max_rounds: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let data_dir = default_data_dir();
    workspace::set_app_data_dir(data_dir.clone())?;

    let db_file = data_dir.join("lawyer-desktop.db");
    let key_store = Arc::new(KeyStore::load_or_create(&data_dir)?);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect(&format!("sqlite:{}", db_file.display()))
        .await?;

    let primary = db::queries::get_active_provider(&pool, &key_store)
        .await?
        .ok_or_else(|| anyhow::anyhow!("未配置主模型"))?;
    println!(
        "provider: {} @ {}",
        primary.model_name, primary.api_base_url
    );

    let provider = OpenAiCompatProvider::new(ProviderConfig {
        id: primary.id,
        name: primary.name,
        display_name: primary.display_name,
        api_base_url: primary.api_base_url,
        api_key: primary.api_key,
        model_name: primary.model_name,
        temperature: None,
        max_tokens: None,
    });

    // Skills list for the system prompt (same as GUI: vendor/ai-for-china-legal)
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let skills_root = manifest_dir
        .parent()
        .map(|p| p.join("vendor/ai-for-china-legal"))
        .filter(|p| p.is_dir());
    let skills_meta = match &skills_root {
        Some(root) => loader::scan_skills_dir(root).await.unwrap_or_default(),
        None => Vec::new(),
    };
    println!("skills loaded: {}", skills_meta.len());

    let root_id = workspace::hash_root_path(ROOT_PATH);
    let needs_index = match workspace::get_status(&root_id).await {
        Ok(Some(st)) => {
            println!(
                "workspace: status={} files={} chunks={}",
                st.status, st.file_count, st.chunk_count
            );
            st.status != "ready"
        }
        other => {
            println!("workspace status unavailable: {:?}", other);
            true
        }
    };
    if needs_index {
        println!("re-indexing workspace with current parser...");
        let stats = workspace::bind_and_index(PathBuf::from(ROOT_PATH), |p| {
            if let Some(f) = &p.current_file {
                println!("  [{}/{}] {}", p.processed, p.total, f);
            }
        })
        .await?;
        println!(
            "re-index done: files={} chunks={}",
            stats.file_count, stats.chunk_count
        );
    }

    let system_prompt = router::build_system_prompt(&skills_meta, None, None, true);
    let tools = router::build_builtin_tool_definitions(true);
    println!("tools in request: {}", tools.len());

    let user_content = format!(
        "读取目录下全部材料，生成诉讼方案\n\n--- 上下文引用 ---\n@案件资料 (目录: {})\nworkspace 已索引：8 个文件，13 个 chunk。请使用 search_workspace 检索，勿 inline 全目录。root_id={}\n\n",
        ROOT_PATH, root_id
    );

    let mut messages = vec![
        ChatMessage {
            reasoning_content: None,
            role: "system".into(),
            content: system_prompt,
            name: None,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: user_content,
            name: None,
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    for round in 0..max_rounds {
        println!(
            "\n========== ROUND {} (messages={}) ==========",
            round,
            messages.len()
        );
        let request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: Some(tools.clone()),
            temperature: Some(0.3),
            max_tokens: Some(4096),
            stream: false,
        };

        let started = std::time::Instant::now();
        let response = match provider.chat(&request).await {
            Ok(r) => r,
            Err(e) => {
                println!("CHAT ERROR: {:#}", e);
                break;
            }
        };
        println!("latency: {}ms", started.elapsed().as_millis());

        let choice = match response.choices.first() {
            Some(c) => c,
            None => {
                println!("NO CHOICES");
                break;
            }
        };
        println!("finish_reason: {:?}", choice.finish_reason);

        let msg = choice.message.clone().unwrap_or(ChatMessage {
            reasoning_content: None,
            role: "assistant".into(),
            content: String::new(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        let n_native = msg.tool_calls.as_ref().map(|t| t.len()).unwrap_or(0);
        println!("native tool_calls: {}", n_native);
        if let Some(ref tcs) = msg.tool_calls {
            for tc in tcs {
                println!("  -> {} args={}", tc.function.name, tc.function.arguments);
            }
        }
        println!(
            "content ({} chars): {:?}",
            msg.content.chars().count(),
            msg.content
        );
        println!("leak detected: {}", contains_tool_leakage(&msg.content));
        let embedded = parse_embedded_tool_calls(&msg.content);
        println!("embedded parsed: {}", embedded.len());

        if n_native > 0 {
            let tcs = msg.tool_calls.clone().unwrap();
            messages.push(msg);
            for tc in &tcs {
                let result = execute_evidence_tool(&root_id, tc)
                    .await
                    .unwrap_or_else(|e| format!("工具执行失败：{}。请改用其他工具或继续作答。", e));
                println!(
                    "  tool result ({}): {} chars",
                    tc.function.name,
                    result.chars().count()
                );
                messages.push(ChatMessage {
                    reasoning_content: None,
                    role: "tool".into(),
                    content: result,
                    name: None,
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
            continue;
        }

        if !embedded.is_empty() {
            let mut tool_msg = msg.clone();
            tool_msg.tool_calls = Some(embedded.clone());
            tool_msg.content = String::new();
            messages.push(tool_msg);
            for tc in &embedded {
                let result = execute_evidence_tool(&root_id, tc)
                    .await
                    .unwrap_or_else(|e| format!("工具执行失败：{}。请改用其他工具或继续作答。", e));
                println!(
                    "  embedded tool result ({}): {} chars",
                    tc.function.name,
                    result.chars().count()
                );
                messages.push(ChatMessage {
                    reasoning_content: None,
                    role: "tool".into(),
                    content: result,
                    name: None,
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
            continue;
        }

        if contains_tool_leakage(&msg.content) {
            println!("  >> NUDGING (same as GUI loop)");
            messages.push(msg);
            messages.push(ChatMessage {
                reasoning_content: None,
                role: "user".into(),
                content: TOOL_LEAK_NUDGE.into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            });
            continue;
        }

        if !msg.content.trim().is_empty() {
            println!(
                "\n===== FINAL TEXT ({} chars) — clean exit =====",
                msg.content.chars().count()
            );
            return Ok(());
        }

        println!("  (empty content, no tool calls — GUI would fall through to plain stream)");
        break;
    }

    println!("\n===== ROUNDS EXHAUSTED OR ERROR =====");
    Ok(())
}
