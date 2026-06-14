//! Citation extraction from generated legal documents (pure functions).
//!
//! The prompt's 引用书写规范 is the contract: 《法名》第N条, 法释〔YYYY〕N号,
//! full case numbers like （2024）渝01民初1234号, and 入库案例编号.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CitationKind {
    /// 《法名》第N条
    Law,
    /// 法释〔YYYY〕N号 / 国务院令第N号
    Interpretation,
    /// 案号 or 入库案例编号
    Case,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedCitation {
    pub kind: CitationKind,
    /// 法名 (without 《》) for laws/interpretations; empty for bare case numbers.
    pub source: String,
    /// 第N条 / 法释〔YYYY〕N号 / full case number / 入库编号.
    pub reference: String,
}

fn law_article_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"《([^《》\n]{2,48})》\s*(第[零一二三四五六七八九十百千0-9]+条(?:之[一二三四五六七八九十])?(?:[、和及与]\s*第[零一二三四五六七八九十百千0-9]+条(?:之[一二三四五六七八九十])?)*)",
        )
        .expect("law article regex")
    })
}

fn article_list_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"第[零一二三四五六七八九十百千0-9]+条(?:之[一二三四五六七八九十])?")
            .expect("article list regex")
    })
}

fn interpretation_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:《([^《》\n]{2,64})》[^《》\n]{0,12})?(法释[〔\[（(]\d{4}[〕\]）)]\d{1,3}号)")
            .expect("interpretation regex")
    })
}

fn state_council_decree_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:《([^《》\n]{2,64})》[^《》\n]{0,12})?(国务院令第\d{1,4}号)")
            .expect("decree regex")
    })
}

fn case_number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"[（(]\d{4}[）)][一-龥]{1,8}\d{0,4}(?:民初|民终|民申|民再|民辖终|民特|民督|商初|商终|刑初|刑终|刑申|行初|行终|行申|行赔|执异|执复|执恢|执|知民初|知民终|知行终|破申|破|赔|仲|清申)\d{1,6}号",
        )
        .expect("case number regex")
    })
}

fn db_case_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d{4}-\d{2}-\d-\d{3}-\d{3}").expect("db case id regex"))
}

/// Normalize bracket variants so 法释〔2020〕28号 == 法释[2020]28号 for dedup.
fn normalize_doc_number(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '[' | '（' | '(' => '〔',
            ']' | '）' | ')' => '〕',
            other => other,
        })
        .collect()
}

/// Extract all citations, deduplicated, in first-occurrence order.
pub fn extract_citations(text: &str) -> Vec<ExtractedCitation> {
    let mut out: Vec<ExtractedCitation> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |c: ExtractedCitation| {
        let key = (c.kind, c.source.clone(), c.reference.clone());
        if seen.insert(key) {
            out.push(c);
        }
    };

    for cap in law_article_re().captures_iter(text) {
        let law = cap[1].trim().to_string();
        // Skip generated-document self references like 《索赔通知书》第1条 is
        // unlikely; legal-source names virtually always end in these suffixes.
        for article in article_list_re().find_iter(&cap[2]) {
            push(ExtractedCitation {
                kind: CitationKind::Law,
                source: law.clone(),
                reference: article.as_str().to_string(),
            });
        }
    }

    for cap in interpretation_re().captures_iter(text) {
        push(ExtractedCitation {
            kind: CitationKind::Interpretation,
            source: cap
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default(),
            reference: normalize_doc_number(&cap[2]),
        });
    }

    for cap in state_council_decree_re().captures_iter(text) {
        push(ExtractedCitation {
            kind: CitationKind::Interpretation,
            source: cap
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default(),
            reference: cap[2].to_string(),
        });
    }

    for m in case_number_re().find_iter(text) {
        let normalized: String = m
            .as_str()
            .chars()
            .map(|c| match c {
                '(' => '（',
                ')' => '）',
                other => other,
            })
            .collect();
        push(ExtractedCitation {
            kind: CitationKind::Case,
            source: String::new(),
            reference: normalized,
        });
    }

    for m in db_case_id_re().find_iter(text) {
        push(ExtractedCitation {
            kind: CitationKind::Case,
            source: String::new(),
            reference: m.as_str().to_string(),
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<(CitationKind, String, String)> {
        extract_citations(text)
            .into_iter()
            .map(|c| (c.kind, c.source, c.reference))
            .collect()
    }

    #[test]
    fn extracts_law_article_chinese_and_arabic() {
        let got = kinds("依据《中华人民共和国民法典》第五百八十五条，以及《公司法》第20条的规定。");
        assert_eq!(
            got,
            vec![
                (
                    CitationKind::Law,
                    "中华人民共和国民法典".into(),
                    "第五百八十五条".into()
                ),
                (CitationKind::Law, "公司法".into(), "第20条".into()),
            ]
        );
    }

    #[test]
    fn expands_article_enumerations() {
        let got = kinds("《民法典》第六百八十六条、第六百八十八条均有规定。");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].2, "第六百八十六条");
        assert_eq!(got[1].2, "第六百八十八条");
    }

    #[test]
    fn extracts_zhi_yi_suffix() {
        let got = kinds("《刑法》第二百八十七条之一规定。");
        assert_eq!(got[0].2, "第二百八十七条之一");
    }

    #[test]
    fn extracts_interpretation_with_adjacent_name() {
        let got = kinds(
            "《最高人民法院关于适用〈中华人民共和国民法典〉有关担保制度的解释》（法释〔2020〕28号）第二十五条",
        );
        // Both the article ref (Law kind, via 《》第N条? no — 第二十五条 follows （法释…号）, not 《》)
        // and the interpretation doc number must be captured.
        assert!(got
            .iter()
            .any(|(k, _, r)| *k == CitationKind::Interpretation && r == "法释〔2020〕28号"));
    }

    #[test]
    fn normalizes_interpretation_bracket_variants() {
        let got = kinds("依据法释[2016]24号第一条。");
        assert!(got
            .iter()
            .any(|(k, _, r)| *k == CitationKind::Interpretation && r == "法释〔2016〕24号"));
    }

    #[test]
    fn extracts_state_council_decree() {
        let got = kinds("《融资担保公司监督管理条例》（国务院令第683号）规定。");
        assert!(got
            .iter()
            .any(|(k, s, r)| *k == CitationKind::Interpretation
                && s == "融资担保公司监督管理条例"
                && r == "国务院令第683号"));
    }

    #[test]
    fn extracts_case_numbers_fullwidth_and_halfwidth() {
        let got = kinds("参见（2024）渝01民初1234号判决，另见(2023)京民终567号。");
        assert_eq!(
            got,
            vec![
                (CitationKind::Case, "".into(), "（2024）渝01民初1234号".into()),
                (CitationKind::Case, "".into(), "（2023）京民终567号".into()),
            ]
        );
    }

    #[test]
    fn extracts_specialized_case_types() {
        let got = kinds("（2022）最高法知民终82号、（2021）粤03执异77号。");
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn extracts_db_case_ids() {
        let got = kinds("入库案例 2024-10-2-358-001 认定担保公司不具备开立独立保函主体资格。");
        assert_eq!(
            got,
            vec![(CitationKind::Case, "".into(), "2024-10-2-358-001".into())]
        );
    }

    #[test]
    fn dedupes_repeated_citations() {
        let got = kinds("《民法典》第五百八十五条……再依《民法典》第五百八十五条。");
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn ignores_plain_text_without_citations() {
        assert!(kinds("本案应当尽快起诉，没有引用任何法条。").is_empty());
        assert!(kinds("第十条没有书名号前缀，不算法条引用。").is_empty());
    }

    #[test]
    fn handles_inner_book_titles_in_law_name() {
        // 《...〈民法典〉...解释》 uses fullwidth inner brackets — outer name must match.
        let got = kinds("《最高人民法院关于适用〈中华人民共和国民法典〉有关担保制度的解释》第二十一条");
        assert!(got
            .iter()
            .any(|(k, s, r)| *k == CitationKind::Law
                && s.contains("担保制度的解释")
                && r == "第二十一条"));
    }
}
