use std::sync::Arc;
use std::time::Instant;

use crate::commands::chat_tools::{
    build_all_tools, build_messages, execute_tool, update_system_prompt, MAX_TOOL_ROUNDS,
};
use crate::db::queries::EvalCaseRow;
use crate::llm::provider::LlmProvider;
use crate::llm::tool_leak::{contains_tool_leakage, sanitize_assistant_content};
use crate::llm::types::{ChatMessage, ChatRequest, ToolCall};
use crate::mcp::manager::McpManager;
use crate::security::eval_sandbox::EvalPathSandbox;
use crate::security::path_sandbox::PathSandbox;
use crate::skills::agent_classifier::AgentMode;
use crate::skills::loader::{load_research_gate, SkillMetadata};
use crate::skills::SkillRegistry;
use sqlx::{Pool, Sqlite};
use tauri::AppHandle;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnCoreResult {
    pub answer: String,
    pub retrievals: Vec<(String, String)>,
    pub tokens: u64,
    pub latency_ms: u64,
    pub active_skill: Option<SkillMetadata>,
}

/// Headless turn for eval replay — no stream events, no DB writes.
pub async fn run_turn_core(
    app: &AppHandle,
    provider: Arc<dyn LlmProvider>,
    skills: &SkillRegistry,
    mcp: &McpManager,
    db: &Pool<Sqlite>,
    eval_sandbox: &EvalPathSandbox,
    user_content: &str,
    skill_override: Option<SkillMetadata>,
    evidence_mode: bool,
) -> anyhow::Result<TurnCoreResult> {
    let started = Instant::now();
    let all_skills = skills.get_skills().await;
    let research_gate = if let Some(root) = skills.get_skills_root().await {
        load_research_gate(&root).await
    } else {
        None
    };
    let research_gate_ref = research_gate.as_deref();

    let mut active_skill = skill_override;
    // The eval runner only replays drafting/evidence skills, never Q&A.
    let mode = if evidence_mode {
        AgentMode::Evidence
    } else {
        AgentMode::Draft
    };
    let tools = build_all_tools(mcp, mode, true).await;
    let retrieval_tool_names: Vec<String> = tools
        .iter()
        .filter(|t| {
            let n = t.function.name.as_str();
            n.contains("search") || n.contains("legal") || n.contains("law") || n == "web_search"
        })
        .map(|t| t.function.name.clone())
        .collect();

    let mut messages = build_messages(
        &all_skills,
        research_gate_ref,
        active_skill.as_ref(),
        mode,
        &retrieval_tool_names,
        vec![],
        user_content.to_string(),
    );

    // Combined sandbox: eval roots + skills root parent for output paths
    let mut sandbox_roots: Vec<std::path::PathBuf> =
        eval_sandbox.allowed_roots().to_vec();
    if let Some(sr) = skills.get_skills_root().await {
        if let Some(parent) = sr.parent() {
            sandbox_roots.push(parent.to_path_buf());
        }
    }
    let sandbox = PathSandbox::new(sandbox_roots);

    let eval_id = uuid::Uuid::new_v4().to_string();
    let tool_ctx = crate::commands::chat_tools::ToolContext {
        app,
        skills,
        mcp,
        db,
        sandbox: &sandbox,
        conversation_id: "eval",
        message_id: &eval_id,
        workspace_root_ids: &[],
    };

    let mut turn_retrievals: Vec<(String, String)> = Vec::new();
    let mut full_response = String::new();
    let mut leak_retries = 0usize;
    let mut total_tokens: u64 = 0;

    for round in 0..MAX_TOOL_ROUNDS {
        let chat_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: Some(tools.clone()),
            temperature: Some(0.3),
            max_tokens: Some(8192),
            stream: false,
        };

        let response = provider.chat(&chat_request).await?;
        if let Some(ref usage) = response.usage {
            total_tokens += usage.total_tokens;
        }

        let choice = response
            .choices
            .first()
            .ok_or_else(|| anyhow::anyhow!("no response from provider"))?;
        let assistant_msg = choice.message.clone().unwrap_or(ChatMessage {
            reasoning_content: None,
            role: "assistant".into(),
            content: String::new(),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        if let Some(ref tool_calls) = assistant_msg.tool_calls {
            if !tool_calls.is_empty() {
                let batch = run_headless_tools(&tool_ctx, tool_calls, &mut active_skill).await;
                turn_retrievals.extend(batch.retrievals);
                append_tool_results(&mut messages, assistant_msg, batch.results);
                if active_skill.is_some() {
                    update_system_prompt(
                        &mut messages,
                        &all_skills,
                        research_gate_ref,
                        active_skill.as_ref(),
                        mode,
                        &retrieval_tool_names,
                    );
                }
                continue;
            }
        }

        if contains_tool_leakage(&assistant_msg.content) {
            if leak_retries < 3 {
                leak_retries += 1;
                continue;
            }
            break;
        }

        if !assistant_msg.content.trim().is_empty() {
            full_response = sanitize_assistant_content(&assistant_msg.content);
            break;
        }

        // Stream fallback for empty content
        let stream_request = ChatRequest {
            model: provider.model_name().to_string(),
            messages: messages.clone(),
            tools: None,
            temperature: Some(0.3),
            max_tokens: Some(8192),
            stream: true,
        };
        let mut stream = provider.chat_stream(&stream_request).await?;
        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            full_response.push_str(&chunk?);
        }
        full_response = sanitize_assistant_content(&full_response);
        break;
    }

    Ok(TurnCoreResult {
        answer: full_response,
        retrievals: turn_retrievals,
        tokens: total_tokens,
        latency_ms: started.elapsed().as_millis() as u64,
        active_skill,
    })
}

struct HeadlessBatch {
    results: Vec<(String, String)>,
    retrievals: Vec<(String, String)>,
}

async fn run_headless_tools(
    ctx: &crate::commands::chat_tools::ToolContext<'_>,
    tool_calls: &[ToolCall],
    active_skill: &mut Option<SkillMetadata>,
) -> HeadlessBatch {
    let mut results = Vec::new();
    let mut retrievals = Vec::new();
    for tc in tool_calls {
        let name = tc.function.name.as_str();
        if name == "ask_user" {
            results.push((tc.id.clone(), "评测模式：跳过澄清，请直接继续。".into()));
            continue;
        }
        let outcome = execute_tool(ctx, tc, active_skill).await;
        let text = outcome.unwrap_or_else(|e| format!("工具错误: {}", e));
        if name.contains("search") || name.contains("legal") || name.contains("law") {
            retrievals.push((name.to_string(), text.clone()));
        }
        results.push((tc.id.clone(), text));
    }
    HeadlessBatch { results, retrievals }
}

fn append_tool_results(
    messages: &mut Vec<ChatMessage>,
    assistant_msg: ChatMessage,
    results: Vec<(String, String)>,
) {
    messages.push(assistant_msg);
    for (id, content) in results {
        messages.push(ChatMessage {
            reasoning_content: None,
            role: "tool".into(),
            content,
            name: None,
            tool_calls: None,
            tool_call_id: Some(id),
        });
    }
}

pub fn build_eval_user_content(case: &EvalCaseRow, eval_sandbox: &EvalPathSandbox) -> anyhow::Result<String> {
    let mut content = case.prompt.clone();
    if let Some(ref materials) = case.materials_path {
        let validated = eval_sandbox.validate(materials)?;
        content.push_str("\n\n--- 上下文引用 ---\n");
        content.push_str(&format!(
            "@案件材料 (目录: {})\n\n",
            validated.to_string_lossy()
        ));
        if let Ok(entries) = std::fs::read_dir(&validated) {
            content.push_str("目录文件清单:\n");
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?");
                if path.is_file() {
                    content.push_str(&format!("- {}\n", name));
                }
            }
        }
    }
    Ok(content)
}

pub async fn run_case(
    app: &AppHandle,
    provider: Arc<dyn LlmProvider>,
    skills: &SkillRegistry,
    mcp: &McpManager,
    db: &Pool<Sqlite>,
    eval_sandbox: &EvalPathSandbox,
    case: &EvalCaseRow,
    skill_override: Option<SkillMetadata>,
) -> anyhow::Result<TurnCoreResult> {
    let user_content = build_eval_user_content(case, eval_sandbox)?;
    let evidence_mode = false;
    run_turn_core(
        app,
        provider,
        skills,
        mcp,
        db,
        eval_sandbox,
        &user_content,
        skill_override,
        evidence_mode,
    )
    .await
}

pub fn skill_content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}
