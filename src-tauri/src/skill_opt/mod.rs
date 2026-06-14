pub mod judge;
pub mod optimizer;
pub mod proposals;
pub mod runner;
pub mod score;
pub mod seed;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillOptProgressEvent {
    pub stage: String,
    pub message: String,
    pub progress: Option<f64>,
    pub detail: Option<serde_json::Value>,
}
