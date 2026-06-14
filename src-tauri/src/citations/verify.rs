//! Three-state citation verification: verified / retrieved / unverified.

use super::extract::{CitationKind, ExtractedCitation};
use super::CitationAuditItem;
use crate::law_library::{self, ArticleLookup};

const EXCERPT_CHARS: usize = 160;

fn excerpt(text: &str) -> String {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s: String = cleaned.chars().take(EXCERPT_CHARS).collect();
    if cleaned.chars().count() > EXCERPT_CHARS {
        s.push('…');
    }
    s
}

/// First 来源层级 provenance line in a retrieval result, if any.
fn tier_from_result(result: &str) -> Option<String> {
    result.lines().find_map(|line| {
        line.trim()
            .strip_prefix("来源层级:")
            .map(|v| v.trim().to_string())
    })
}

/// Did any retrieval result this turn mention all the given fragments?
fn find_in_retrievals<'a>(
    retrievals: &'a [(String, String)],
    fragments: &[&str],
) -> Option<&'a (String, String)> {
    retrievals.iter().find(|(_, result)| {
        fragments
            .iter()
            .all(|f| !f.is_empty() && result.contains(f))
    })
}

async fn verify_law_article(
    c: &ExtractedCitation,
    retrievals: &[(String, String)],
) -> CitationAuditItem {
    let base = CitationAuditItem {
        kind: c.kind,
        source: c.source.clone(),
        reference: c.reference.clone(),
        status: "unverified".into(),
        tier: None,
        excerpt: None,
        url: None,
        note: None,
    };

    match law_library::lookup_article(&c.source, &c.reference).await {
        Ok(ArticleLookup::Found {
            entry,
            heading,
            text,
        }) => {
            let mut note = None;
            if let Some(status) = entry.status.as_deref() {
                if status != "现行有效" {
                    note = Some(format!("⚠ 该法规时效状态为「{}」，请核对最新版本", status));
                }
            }
            CitationAuditItem {
                status: "verified".into(),
                tier: Some("L1-法规（本地库）".into()),
                excerpt: Some(excerpt(&format!("{} {}", heading, text))),
                url: entry.source_url.clone(),
                note,
                ..base
            }
        }
        Ok(ArticleLookup::LawFoundArticleMissing { entry, article_count }) => CitationAuditItem {
            note: Some(format!(
                "《{}》共 {} 条，未找到该条文号 — 引用可能有误",
                entry.name, article_count
            )),
            ..base
        },
        Ok(ArticleLookup::LawNotFound { .. }) | Ok(ArticleLookup::BadArticleRef) | Err(_) => {
            // Not in the local library — accept this turn's retrieval evidence.
            if let Some((_, result)) =
                find_in_retrievals(retrievals, &[&c.source, &c.reference])
            {
                CitationAuditItem {
                    status: "retrieved".into(),
                    tier: tier_from_result(result),
                    note: Some("本地库未收录，依据本轮在线检索结果".into()),
                    ..base
                }
            } else {
                CitationAuditItem {
                    note: Some("本地库未收录且本轮未检索到 — 待律师复核".into()),
                    ..base
                }
            }
        }
    }
}

async fn verify_interpretation(
    c: &ExtractedCitation,
    retrievals: &[(String, String)],
) -> CitationAuditItem {
    let base = CitationAuditItem {
        kind: c.kind,
        source: c.source.clone(),
        reference: c.reference.clone(),
        status: "unverified".into(),
        tier: None,
        excerpt: None,
        url: None,
        note: None,
    };

    // Match by 文号 first, then by adjacent 《name》.
    if let Ok(Some(entry)) = law_library::find_by_doc_number(&c.reference).await {
        return CitationAuditItem {
            status: "verified".into(),
            tier: Some("L1-法规（本地库）".into()),
            url: entry.source_url.clone(),
            note: entry.status.as_deref().and_then(|s| {
                (s != "现行有效").then(|| format!("⚠ 时效状态「{}」", s))
            }),
            ..base
        };
    }
    if !c.source.is_empty() {
        if let Ok(ArticleLookup::Found { entry, .. } | ArticleLookup::LawFoundArticleMissing { entry, .. }) =
            law_library::lookup_article(&c.source, "第一条").await
        {
            return CitationAuditItem {
                status: "verified".into(),
                tier: Some("L1-法规（本地库）".into()),
                url: entry.source_url.clone(),
                note: Some("按名称匹配本地库（文号未逐字比对）".into()),
                ..base
            };
        }
    }

    if let Some((_, result)) = find_in_retrievals(retrievals, &[&c.reference])
        .or_else(|| find_in_retrievals(retrievals, &[&c.source]))
    {
        return CitationAuditItem {
            status: "retrieved".into(),
            tier: tier_from_result(result),
            ..base
        };
    }

    CitationAuditItem {
        note: Some("本地库未收录且本轮未检索到 — 待律师复核".into()),
        ..base
    }
}

fn verify_case(c: &ExtractedCitation, retrievals: &[(String, String)]) -> CitationAuditItem {
    let base = CitationAuditItem {
        kind: c.kind,
        source: c.source.clone(),
        reference: c.reference.clone(),
        status: "unverified".into(),
        tier: None,
        excerpt: None,
        url: None,
        note: None,
    };

    // Weak verification: the case number must appear in this turn's retrieval
    // output (also try halfwidth-bracket form).
    let halfwidth: String = c
        .reference
        .chars()
        .map(|ch| match ch {
            '（' => '(',
            '）' => ')',
            other => other,
        })
        .collect();
    if let Some((_, result)) = find_in_retrievals(retrievals, &[&c.reference])
        .or_else(|| find_in_retrievals(retrievals, &[&halfwidth]))
    {
        CitationAuditItem {
            status: "retrieved".into(),
            tier: tier_from_result(result),
            ..base
        }
    } else {
        CitationAuditItem {
            note: Some("本轮检索结果中未出现该案号 — 待律师复核".into()),
            ..base
        }
    }
}

pub async fn verify_items(
    extracted: Vec<ExtractedCitation>,
    retrievals: &[(String, String)],
) -> Vec<CitationAuditItem> {
    let mut items = Vec::with_capacity(extracted.len());
    for c in &extracted {
        let item = match c.kind {
            CitationKind::Law => verify_law_article(c, retrievals).await,
            CitationKind::Interpretation => verify_interpretation(c, retrievals).await,
            CitationKind::Case => verify_case(c, retrievals),
        };
        items.push(item);
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::citations::extract::extract_citations;

    #[tokio::test]
    async fn case_numbers_verify_against_retrievals_only() {
        let text = "参见（2024）渝01民初1234号判决与（2021）粤03民终99号。";
        let retrievals = vec![(
            "mcp__wenshu__search_cases".to_string(),
            "找到案例：（2024）渝01民初1234号 …\n来源层级: L2-入库\n链接: https://rmfyalk.court.gov.cn/x".to_string(),
        )];
        let items = verify_items(extract_citations(text), &retrievals).await;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].status, "retrieved");
        assert_eq!(items[0].tier.as_deref(), Some("L2-入库"));
        assert_eq!(items[1].status, "unverified");
        assert!(items[1].note.as_deref().unwrap_or("").contains("待律师复核"));
    }

    #[tokio::test]
    async fn law_articles_without_library_fall_back_to_retrievals() {
        // No library initialized in unit tests → lookup errors → retrieval path.
        let text = "依据《测试专用法》第三条。";
        let retrievals = vec![(
            "mcp__law-database__search_laws".to_string(),
            "《测试专用法》第三条：……\n来源层级: L1-法规".to_string(),
        )];
        let items = verify_items(extract_citations(text), &retrievals).await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, "retrieved");

        let items_none = verify_items(extract_citations(text), &[]).await;
        assert_eq!(items_none[0].status, "unverified");
    }
}
