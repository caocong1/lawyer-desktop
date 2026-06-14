//! `legal_search` — aggregated legal retrieval in one tool call.
//!
//! Queries the local law library and the online connectors concurrently,
//! returns per-source sections with explicit provenance, and skips offline
//! sources honestly instead of failing the whole call. Per-source sections
//! (rather than an interleaved merge) keep provenance unambiguous for the
//! model and the citation audit.

use std::time::Duration;
use tokio::time::timeout;

use crate::law_library;
use crate::mcp::manager::{mcp_result_to_text, McpManager};

const MCP_SOURCE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
    Law,
    Case,
    All,
}

impl SearchScope {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("all") {
            "law" => SearchScope::Law,
            "case" => SearchScope::Case,
            _ => SearchScope::All,
        }
    }
}

/// Call an MCP tool, mapping every failure (offline server, timeout, tool
/// error) to a degradation note instead of an error.
async fn mcp_source(
    mcp: &McpManager,
    tool_name: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    match timeout(MCP_SOURCE_TIMEOUT, mcp.call_tool_by_name(tool_name, args)).await {
        Ok(Ok(result)) => Ok(mcp_result_to_text(&result)),
        Ok(Err(e)) => Err(format!("该源当前不可用（{}）", e)),
        Err(_) => Err("该源响应超时（20秒）".into()),
    }
}

pub async fn legal_search(
    mcp: &McpManager,
    query: &str,
    scope: SearchScope,
    k: usize,
) -> Result<String, String> {
    let want_law = scope != SearchScope::Case;
    let want_case = scope != SearchScope::Law;
    let page_size = k.clamp(1, 10) as u64;

    let local_fut = async {
        if !want_law {
            return None;
        }
        Some(law_library::search_law(query, k).await)
    };
    let online_law_fut = async {
        if !want_law {
            return None;
        }
        Some(
            mcp_source(
                mcp,
                "mcp__law-database__search_laws",
                serde_json::json!({ "keyword": query, "pageSize": page_size }),
            )
            .await,
        )
    };
    let case_fut = async {
        if !want_case {
            return None;
        }
        Some(
            mcp_source(
                mcp,
                "mcp__wenshu__search_cases",
                serde_json::json!({ "keyword": query, "pageSize": page_size }),
            )
            .await,
        )
    };

    let (local, online_law, cases) = tokio::join!(local_fut, online_law_fut, case_fut);

    let mut sections: Vec<String> = vec![format!("## 聚合检索：{}", query)];
    let mut available_sources = 0usize;

    if let Some(local) = local {
        let body = match local {
            Ok(text) => {
                available_sources += 1;
                text
            }
            Err(e) => format!("本地法规库不可用：{}", e),
        };
        sections.push(format!("### 本地法规库（L1-法规 · 离线）\n{}", body));
    }

    if let Some(online) = online_law {
        let body = match online {
            Ok(text) => {
                available_sources += 1;
                text
            }
            Err(note) => format!("{}。法条核验可改用本地法规库（search_law / get_law_article）。", note),
        };
        sections.push(format!("### 在线法规检索（law-database · 官方源）\n{}", body));
    }

    if let Some(case_result) = cases {
        let body = match case_result {
            Ok(text) => {
                available_sources += 1;
                text
            }
            Err(note) => format!(
                "{}。案例引用无法核验时必须标注 [待律师复核]。",
                note
            ),
        };
        sections.push(format!("### 案例检索（人民法院案例库/裁判文书网）\n{}", body));
    }

    if available_sources == 0 {
        sections.push(
            "（所有检索源当前均不可用：法条与案例引用必须逐条标注 [待律师复核]，并在文首声明检索局限。）"
                .into(),
        );
    } else {
        sections.push(
            "深挖指引：本地条文全文用 `get_law_article`；在线法规全文用 `mcp__law-database__get_law_detail`；案例详情用 `mcp__wenshu__get_case_detail`。"
                .into(),
        );
    }

    Ok(sections.join("\n\n"))
}
