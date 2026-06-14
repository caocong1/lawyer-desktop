use crate::citations::CitationAudit;
use crate::db::queries::SkillOptWeights;
use crate::skill_opt::judge::JudgeResult;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompositeScore {
    pub total: f64,
    pub rubric_score: f64,
    pub cite_score: f64,
    pub human_score: Option<f64>,
    pub weights: SkillOptWeights,
}

pub fn citation_score(audit: &CitationAudit) -> f64 {
    if audit.total == 0 {
        return 0.5;
    }
    (audit.verified + audit.retrieved) as f64 / audit.total as f64
}

pub fn human_feedback_score(rating: Option<&str>) -> Option<f64> {
    match rating {
        Some("up") => Some(1.0),
        Some("down") => Some(0.0),
        _ => None,
    }
}

pub fn composite_score(
    judge: &JudgeResult,
    audit: &CitationAudit,
    human_rating: Option<&str>,
    weights: &SkillOptWeights,
) -> CompositeScore {
    let rubric_score = judge.score;
    let cite_score = citation_score(audit);
    let human_score = human_feedback_score(human_rating);

    let (w_h, w_r, w_c) = if human_score.is_some() {
        (weights.human, weights.rubric, weights.cite)
    } else {
        let total = weights.rubric + weights.cite;
        (0.0, weights.rubric / total, weights.cite / total)
    };

    let total = if let Some(h) = human_score {
        w_h * h + w_r * rubric_score + w_c * cite_score
    } else {
        w_r * rubric_score + w_c * cite_score
    };

    CompositeScore {
        total,
        rubric_score,
        cite_score,
        human_score,
        weights: weights.clone(),
    }
}
