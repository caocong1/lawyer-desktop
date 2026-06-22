use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

use crate::db;
use crate::db::queries::{
    EvalCaseRow, EvalRunRow, SkillFeedbackRow, SkillOptSettings, SkillProposalRow,
};
use crate::llm::LlmEngine;
use crate::mcp::manager::McpManager;
use crate::security::eval_sandbox::EvalPathSandbox;
use crate::security::key_store::KeyStore;
use crate::skill_opt::judge::{judge_output, load_gold_reference, load_rubric_for_case};
use crate::skill_opt::optimizer::{mine_eval_cases_from_feedback, run_refinement, RefinementOptions};
use crate::skill_opt::proposals::adopt_proposal_to_disk;
use crate::skill_opt::runner::{run_case, skill_content_hash};
use crate::skill_opt::score::composite_score;
use crate::skills::SkillRegistry;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_skillopt_settings(db: State<'_, Pool<Sqlite>>) -> Result<SkillOptSettings, String> {
    db::queries::get_skillopt_settings(&db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_skillopt_settings(
    db: State<'_, Pool<Sqlite>>,
    eval_sandbox: State<'_, Arc<RwLock<EvalPathSandbox>>>,
    settings: SkillOptSettings,
) -> Result<(), String> {
    db::queries::set_skillopt_settings(&db, &settings)
        .await
        .map_err(|e| e.to_string())?;
    let mut sandbox = eval_sandbox.write().await;
    sandbox
        .reload(&settings.eval_data_roots)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SubmitFeedbackRequest {
    pub message_id: String,
    pub conversation_id: String,
    pub skill_name: Option<String>,
    pub plugin_name: Option<String>,
    pub rating: String,
    pub comment: Option<String>,
    pub dimensions: Option<Vec<String>>,
    pub app_version: Option<String>,
    pub skills_version: Option<String>,
}

#[tauri::command]
pub async fn submit_message_feedback(
    app: AppHandle,
    db: State<'_, Pool<Sqlite>>,
    key_store: State<'_, Arc<KeyStore>>,
    req: SubmitFeedbackRequest,
) -> Result<SkillFeedbackRow, String> {
    if req.rating != "up" && req.rating != "down" {
        return Err("rating 必须是 up 或 down".into());
    }
    let dims_json = req
        .dimensions
        .as_ref()
        .map(|d| serde_json::to_string(d).unwrap_or_default());
    let row = db::queries::insert_skill_feedback(
        &db,
        &req.message_id,
        &req.conversation_id,
        req.skill_name.as_deref(),
        req.plugin_name.as_deref(),
        &req.rating,
        req.comment.as_deref(),
        dims_json.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let sync_settings = crate::sync::settings::get_sync_settings(&db, &key_store)
        .await
        .map_err(|e| e.to_string())?;

    let msg = db::queries::get_message_by_id(&db, &req.message_id)
        .await
        .map_err(|e| e.to_string())?;

    let answer_text = msg.as_ref().map(|m| m.content.as_str()).unwrap_or("");
    let answer_payload = if sync_settings.upload_full_answer {
        answer_text.to_string()
    } else {
        answer_text.chars().take(500).collect::<String>()
    };

    let metadata: Option<serde_json::Value> = msg
        .as_ref()
        .and_then(|m| m.metadata_json.as_deref())
        .and_then(|j| serde_json::from_str(j).ok());

    let app_version = req
        .app_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            app.config()
                .version
                .clone()
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
        });
    let skills_version = req
        .skills_version
        .or(sync_settings.skills_version.clone());

    let payload = serde_json::json!({
        "feedback_id": row.id,
        "message_id": req.message_id,
        "conversation_id": req.conversation_id,
        "skill_name": req.skill_name,
        "plugin_name": req.plugin_name,
        "rating": req.rating,
        "comment": req.comment,
        "dimensions": req.dimensions,
        "answer": answer_payload,
        "upload_full_answer": sync_settings.upload_full_answer,
        "message_metadata": metadata,
        "app_version": app_version,
        "device_id": sync_settings.device_id,
        "skills_version": skills_version,
        "created_at": row.created_at,
        "updated_at": row.created_at,
    });

    crate::sync::outbox::supersede_pending_feedback(&db, &row.id)
        .await
        .map_err(|e| e.to_string())?;
    crate::sync::outbox::enqueue_feedback(&db, &row.id, &payload.to_string())
        .await
        .map_err(|e| e.to_string())?;

    Ok(row)
}

#[tauri::command]
pub async fn get_message_feedback(
    db: State<'_, Pool<Sqlite>>,
    conversation_id: String,
) -> Result<Vec<SkillFeedbackRow>, String> {
    db::queries::list_skill_feedback_by_conversation(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_all_feedback(
    db: State<'_, Pool<Sqlite>>,
    limit: Option<i64>,
) -> Result<Vec<SkillFeedbackRow>, String> {
    db::queries::list_all_skill_feedback(&db, limit.unwrap_or(100))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_eval_cases(db: State<'_, Pool<Sqlite>>) -> Result<Vec<EvalCaseRow>, String> {
    db::queries::list_eval_cases(&db, false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_eval_case_active(
    db: State<'_, Pool<Sqlite>>,
    case_id: String,
    active: bool,
) -> Result<(), String> {
    db::queries::set_eval_case_active(&db, &case_id, active)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct EvalRunResult {
    pub run: EvalRunRow,
    pub answer_preview: String,
}

#[tauri::command]
pub async fn run_eval_case(
    app: AppHandle,
    engine: State<'_, LlmEngine>,
    skills: State<'_, SkillRegistry>,
    mcp: State<'_, McpManager>,
    db: State<'_, Pool<Sqlite>>,
    eval_sandbox: State<'_, Arc<RwLock<EvalPathSandbox>>>,
    case_id: String,
) -> Result<EvalRunResult, String> {
    let case = db::queries::get_eval_case(&db, &case_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "用例不存在".to_string())?;

    let provider = engine.get_provider().await.map_err(|e| e.to_string())?;
    let sandbox = eval_sandbox.read().await;

    let skill_override = if let Some(ref sn) = case.target_skill {
        skills.find_skill_fuzzy(sn).await.or({
            let all = skills.get_skills().await;
            all.into_iter().find(|s| s.name == *sn)
        })
    } else {
        None
    };

    let turn = run_case(
        &app,
        provider,
        &skills,
        &mcp,
        &db,
        &sandbox,
        &case,
        skill_override,
    )
    .await
    .map_err(|e| e.to_string())?;

    let settings = db::queries::get_skillopt_settings(&db)
        .await
        .map_err(|e| e.to_string())?;
    let skills_root = skills.get_skills_root().await;
    let rubric = load_rubric_for_case(case.rubric.as_deref(), skills_root.as_deref());
    let gold = load_gold_reference(
        case.gold_reference_path.as_deref(),
        skills_root.as_deref(),
    );

    let provider2 = engine.get_provider().await.map_err(|e| e.to_string())?;
    let judge = judge_output(
        provider2.as_ref(),
        &turn.answer,
        &rubric,
        gold.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    let audit = crate::citations::audit(&turn.answer, &turn.retrievals).await;
    let composite = composite_score(&judge, &audit, None, &settings.weights);

    let skill_hash = turn
        .active_skill
        .as_ref()
        .map(|s| skill_content_hash(&s.full_content));

    let run = db::queries::insert_eval_run(
        &db,
        &case_id,
        skill_hash.as_deref(),
        composite.total,
        Some(&serde_json::to_string(&judge).unwrap_or_default()),
        Some(&serde_json::to_string(&audit).unwrap_or_default()),
        Some(turn.tokens as i64),
        Some(turn.latency_ms as i64),
    )
    .await
    .map_err(|e| e.to_string())?;

    let preview: String = turn.answer.chars().take(500).collect();
    Ok(EvalRunResult {
        run,
        answer_preview: preview,
    })
}

#[tauri::command]
pub async fn list_eval_runs(
    db: State<'_, Pool<Sqlite>>,
    case_id: String,
    limit: Option<i64>,
) -> Result<Vec<EvalRunRow>, String> {
    db::queries::list_eval_runs(&db, &case_id, limit.unwrap_or(20))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Proposals & refinement
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_proposals(
    db: State<'_, Pool<Sqlite>>,
    status: Option<String>,
) -> Result<Vec<SkillProposalRow>, String> {
    db::queries::list_skill_proposals(&db, status.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn adopt_proposal(
    db: State<'_, Pool<Sqlite>>,
    skills: State<'_, SkillRegistry>,
    proposal_id: String,
) -> Result<String, String> {
    let proposal = db::queries::get_skill_proposal(&db, &proposal_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "提案不存在".to_string())?;

    let path = adopt_proposal_to_disk(&skills, &proposal)
        .await
        .map_err(|e| e.to_string())?;

    db::queries::update_skill_proposal_status(&db, &proposal_id, "adopted")
        .await
        .map_err(|e| e.to_string())?;

    skills.reload().await.map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn reject_proposal(
    db: State<'_, Pool<Sqlite>>,
    proposal_id: String,
) -> Result<(), String> {
    db::queries::update_skill_proposal_status(&db, &proposal_id, "rejected")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_skill_refinement(
    app: AppHandle,
    engine: State<'_, LlmEngine>,
    skills: State<'_, SkillRegistry>,
    mcp: State<'_, McpManager>,
    db: State<'_, Pool<Sqlite>>,
    eval_sandbox: State<'_, Arc<RwLock<EvalPathSandbox>>>,
    target_skill: Option<String>,
    dry_run: Option<bool>,
    rollouts_k: Option<u32>,
    nights: Option<u32>,
) -> Result<Vec<String>, String> {
    let sandbox = eval_sandbox.read().await.clone();
    run_refinement(
        app,
        &engine,
        &skills,
        &mcp,
        &db,
        sandbox,
        RefinementOptions {
            target_skill,
            dry_run: dry_run.unwrap_or(true),
            rollouts_k: rollouts_k.unwrap_or(1),
            nights: nights.unwrap_or(1),
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mine_eval_cases(db: State<'_, Pool<Sqlite>>) -> Result<usize, String> {
    mine_eval_cases_from_feedback(&db)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct SkillOptOverview {
    pub feedback_count: i64,
    pub eval_case_count: i64,
    pub staged_proposals: i64,
    pub settings: SkillOptSettings,
}

#[tauri::command]
pub async fn get_skillopt_overview(db: State<'_, Pool<Sqlite>>) -> Result<SkillOptOverview, String> {
    let feedback_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM skill_feedback")
            .fetch_one(&*db)
            .await
            .map_err(|e| e.to_string())?;
    let eval_case_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM eval_cases WHERE active = 1")
            .fetch_one(&*db)
            .await
            .map_err(|e| e.to_string())?;
    let staged: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM skill_proposals WHERE status = 'staged'")
            .fetch_one(&*db)
            .await
            .map_err(|e| e.to_string())?;
    let settings = db::queries::get_skillopt_settings(&db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(SkillOptOverview {
        feedback_count: feedback_count.0,
        eval_case_count: eval_case_count.0,
        staged_proposals: staged.0,
        settings,
    })
}
