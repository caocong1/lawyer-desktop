//! Citation audit: extract every legal citation from a generated document and
//! verify it against the local law library (exact article text) and this
//! turn's retrieval-tool results. Annotation-style — never blocks output.

pub mod extract;
mod verify;

use serde::Serialize;

pub use extract::{extract_citations, CitationKind};

#[derive(Debug, Clone, Serialize)]
pub struct CitationAuditItem {
    pub kind: CitationKind,
    /// 法名 (laws/interpretations) or empty (bare case numbers).
    pub source: String,
    /// 第N条 / 法释〔YYYY〕N号 / case number.
    pub reference: String,
    /// verified（本地库逐字核验）| retrieved（本轮检索结果包含）| unverified（待律师复核）
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CitationAudit {
    pub items: Vec<CitationAuditItem>,
    pub total: usize,
    pub verified: usize,
    pub retrieved: usize,
    pub unverified: usize,
}

/// Audit a finished answer. `retrievals` are (tool_name, result_text) pairs
/// from this turn's retrieval tools. Never fails — errors degrade to
/// unverified items.
pub async fn audit(text: &str, retrievals: &[(String, String)]) -> CitationAudit {
    let extracted = extract_citations(text);
    let items = verify::verify_items(extracted, retrievals).await;

    let count = |status: &str| items.iter().filter(|i| i.status == status).count();
    CitationAudit {
        total: items.len(),
        verified: count("verified"),
        retrieved: count("retrieved"),
        unverified: count("unverified"),
        items,
    }
}
