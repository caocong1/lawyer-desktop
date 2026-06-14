use std::collections::HashSet;
use std::sync::Arc;

use crate::db::queries::{self, SkillFeedbackRow, SkillOptSettings};
use crate::llm::LlmEngine;
use crate::mcp::manager::McpManager;
use crate::security::eval_sandbox::EvalPathSandbox;
use crate::skill_opt::judge::{judge_output, load_gold_reference, load_rubric_for_case};
use crate::skill_opt::proposals::{apply_diff, is_low_risk_edit, make_diff_replace};
use crate::skill_opt::runner::{run_case, skill_content_hash};
use crate::skill_opt::score::composite_score;
use crate::skill_opt::SkillOptProgressEvent;
use crate::skills::loader::SkillMetadata;
use crate::skills::SkillRegistry;
use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BoundedEdit {
    pub diff: String,
    pub rationale: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RefinementOptions {
    pub target_skill: Option<String>,
    pub dry_run: bool,
    pub rollouts_k: u32,
    pub nights: u32,
}

pub async fn reflect_edits(
    provider: Arc<dyn crate::llm::provider::LlmProvider>,
    skill: &SkillMetadata,
    low_trajectories: &[(String, f64)],
    feedback: &[SkillFeedbackRow],
    preferences: Option<&str>,
) -> anyhow::Result<Vec<BoundedEdit>> {
    use crate::llm::types::{ChatMessage, ChatRequest};

    let mut feedback_text = String::new();
    for fb in feedback {
        if fb.skill_name.as_deref() == Some(skill.name.as_str()) {
            feedback_text.push_str(&format!(
                "- {}: {} {:?}\n",
                fb.rating,
                fb.comment.as_deref().unwrap_or(""),
                fb.dimensions_json
            ));
        }
    }

    let traj_text: String = low_trajectories
        .iter()
        .map(|(a, s)| format!("分数 {:.2}:\n{}\n---\n", s, a.chars().take(2000).collect::<String>()))
        .collect();

    let pref = preferences.unwrap_or("");
    let prompt = format!(
        "你是 SkillOpt 优化器。分析低分轨迹和用户反馈，对以下 skill 提出 1-3 个有界编辑。\n\
         编辑格式：REPLACE:旧文本|||新文本 或 APPEND:追加段落\n\
         不要改变法律依据结论，优先改检查清单、检索步骤、引用规范。\n\n\
         ## 用户偏好\n{pref}\n\n## 用户反馈\n{feedback_text}\n\n## 低分输出\n{traj_text}\n\n\
         ## 当前 Skill\n{}\n\n\
         输出 JSON 数组：[{{\"diff\":\"REPLACE:...|||...\",\"rationale\":\"...\"}}]",
        skill.full_content.chars().take(12000).collect::<String>()
    );

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: prompt,
            name: None,
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: None,
        temperature: Some(0.2),
        max_tokens: Some(4096),
        stream: false,
    };

    let response = provider.chat(&request).await?;
    let text = response
        .choices
        .first()
        .and_then(|c| c.message.as_ref())
        .map(|m| m.content.clone())
        .unwrap_or_default();

    parse_edits_json(&text)
}

fn parse_edits_json(text: &str) -> anyhow::Result<Vec<BoundedEdit>> {
    let trimmed = text.trim();
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            &trimmed[start..=end]
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    Ok(serde_json::from_str(json_str).unwrap_or_default())
}

pub async fn eval_skill_on_cases(
    app: &AppHandle,
    provider: Arc<dyn crate::llm::provider::LlmProvider>,
    skills: &SkillRegistry,
    mcp: &McpManager,
    db: &Pool<Sqlite>,
    eval_sandbox: &EvalPathSandbox,
    skill: &SkillMetadata,
    split: &str,
) -> anyhow::Result<f64> {
    let cases = queries::list_eval_cases(db, true).await?;
    let filtered: Vec<_> = cases
        .into_iter()
        .filter(|c| c.split == split && c.origin != "dream")
        .collect();

    if filtered.is_empty() {
        return Ok(0.0);
    }

    let settings = queries::get_skillopt_settings(db).await?;
    let skills_root = skills.get_skills_root().await;
    let mut scores = Vec::new();

    for case in &filtered {
        let turn = run_case(
            app,
            provider.clone(),
            skills,
            mcp,
            db,
            eval_sandbox,
            case,
            Some(skill.clone()),
        )
        .await?;

        let rubric = load_rubric_for_case(case.rubric.as_deref(), skills_root.as_deref());
        let gold = load_gold_reference(
            case.gold_reference_path.as_deref(),
            skills_root.as_deref(),
        );
        let judge = judge_output(
            provider.as_ref(),
            &turn.answer,
            &rubric,
            gold.as_deref(),
        )
        .await?;
        let audit = crate::citations::audit(&turn.answer, &turn.retrievals).await;
        let composite = composite_score(&judge, &audit, None, &settings.weights);
        scores.push(composite.total);
    }

    Ok(scores.iter().sum::<f64>() / scores.len() as f64)
}

pub async fn run_refinement(
    app: AppHandle,
    engine: &LlmEngine,
    skills: &SkillRegistry,
    mcp: &McpManager,
    db: &Pool<Sqlite>,
    eval_sandbox: EvalPathSandbox,
    options: RefinementOptions,
) -> anyhow::Result<Vec<String>> {
    let settings = queries::get_skillopt_settings(&db).await?;
    let provider = engine.get_provider().await?;
    let optimizer = engine.get_fast_provider().await.unwrap_or(provider.clone());

    let all_skills = skills.get_skills().await;
    let target_skills: Vec<SkillMetadata> = if let Some(ref name) = options.target_skill {
        all_skills
            .into_iter()
            .filter(|s| s.name == *name)
            .collect()
    } else {
        all_skills.into_iter().take(3).collect()
    };

    let feedback = queries::list_all_skill_feedback(&db, 100).await?;
    let mut proposal_ids = Vec::new();
    let mut rejected: HashSet<String> = HashSet::new();
    let gate_on = settings.gate == "on";
    let mut tokens_used: u64 = 0;
    let budget = settings.budget_tokens;

    for skill in target_skills {
        if tokens_used >= budget {
            emit_progress(
                &app,
                "budget_exhausted",
                &format!("Token 预算已用尽 ({budget})，跳过剩余技能"),
                None,
            );
            break;
        }
        emit_progress(&app, "reflect", &format!("反思技能: {}", skill.name), None);

        let baseline = eval_skill_on_cases(
            &app,
            provider.clone(),
            &skills,
            &mcp,
            &db,
            &eval_sandbox,
            &skill,
            "val",
        )
        .await
        .unwrap_or(0.0);

        let low_traj = vec![("(baseline eval)".into(), baseline)];
        let edits = reflect_edits(
            optimizer.clone(),
            &skill,
            &low_traj,
            &feedback,
            None,
        )
        .await
        .unwrap_or_default();

        for edit in edits {
            if rejected.contains(&edit.diff) {
                continue;
            }

            let candidate_content = apply_diff(&skill.full_content, &edit.diff)
                .unwrap_or_else(|_| skill.full_content.clone());
            let mut candidate = skill.clone();
            candidate.full_content = candidate_content;

            let val_after = eval_skill_on_cases(
                &app,
                provider.clone(),
                &skills,
                &mcp,
                &db,
                &eval_sandbox,
                &candidate,
                "val",
            )
            .await
            .unwrap_or(0.0);

            let accepted = if gate_on {
                val_after > baseline
            } else {
                val_after >= baseline
            };

            if !accepted {
                rejected.insert(edit.diff.clone());
                emit_progress(
                    &app,
                    "gate_reject",
                    &format!("闸门拒绝: {} ({:.2} -> {:.2})", skill.name, baseline, val_after),
                    Some(serde_json::json!({ "baseline": baseline, "after": val_after })),
                );
                continue;
            }

            if options.dry_run {
                emit_progress(
                    &app,
                    "dry_run_accept",
                    &format!("干跑接受: {} ({:.2} -> {:.2})", skill.name, baseline, val_after),
                    None,
                );
                continue;
            }

            let proposal = queries::insert_skill_proposal(
                &db,
                &skill.skill_md_path.to_string_lossy(),
                Some(&skill_content_hash(&skill.full_content)),
                &edit.diff,
                Some(&edit.rationale),
                Some(baseline),
                Some(val_after),
            )
            .await?;

            proposal_ids.push(proposal.id.clone());

            // Auto-adopt if configured
            if should_auto_adopt(&settings, &edit.diff, baseline, val_after) {
                let _ = crate::skill_opt::proposals::adopt_proposal_to_disk(&skills, &proposal).await;
                queries::update_skill_proposal_status(&db, &proposal.id, "adopted").await?;
                skills.reload().await.ok();
            }

            tokens_used += 5000; // estimated per accepted edit cycle
        }

        // Slow-update: append durable guidance
        let slow = format!(
            "\n\n<!-- SKILL_OPT_PROTECTED -->\n## 长期经验（自动蒸馏）\n\n\
             在 val 分数 {:.2} 基线上，经闸门验证的改进已暂存。优先在生成前规划结构再填充内容。\n\
             <!-- /SKILL_OPT_PROTECTED -->\n",
            baseline
        );
        let _slow_diff = make_diff_replace("", &slow);
    }

    emit_progress(&app, "complete", "技能精炼完成", None);
    Ok(proposal_ids)
}

fn should_auto_adopt(settings: &SkillOptSettings, diff: &str, before: f64, after: f64) -> bool {
    match settings.auto_adopt.as_str() {
        "all" => after > before,
        "low_risk" => is_low_risk_edit(diff) && after > before + 0.05,
        _ => false,
    }
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, detail: Option<serde_json::Value>) {
    let _ = app.emit(
        "skillopt-progress",
        SkillOptProgressEvent {
            stage: stage.into(),
            message: message.into(),
            progress: None,
            detail,
        },
    );
}

pub async fn mine_eval_cases_from_feedback(db: &Pool<Sqlite>) -> anyhow::Result<usize> {
    let feedback = queries::list_all_skill_feedback(&db, 500).await?;
    let mut inserted = 0usize;

    for fb in feedback {
        if fb.rating == "up" {
            let split = if inserted % 2 == 0 { "val" } else { "test" };
            let name = format!("feedback-{}", &fb.id[..8.min(fb.id.len())]);
            let existing: Option<(i64,)> =
                sqlx::query_as("SELECT COUNT(*) FROM eval_cases WHERE name = ?")
                    .bind(&name)
                    .fetch_optional(db)
                    .await?;
            if existing.map(|(c,)| c).unwrap_or(0) > 0 {
                continue;
            }
            queries::insert_eval_case(
                db,
                &name,
                fb.skill_name.as_deref(),
                fb.plugin_name.as_deref(),
                "请根据会话上下文继续完成法律任务。",
                None,
                None,
                None,
                split,
                "real",
            )
            .await?;
            inserted += 1;
        }
    }
    Ok(inserted)
}
