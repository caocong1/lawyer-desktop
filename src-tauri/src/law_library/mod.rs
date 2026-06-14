//! Bundled local law library (本地法规库) — the deterministic anchor for
//! citation verification.
//!
//! Layout: `{app_data}/law-library/` holds one markdown file per statute
//! (every article is a `### 第N条` heading — see resources/law-library/) plus
//! `manifest.json`. Full-text search reuses the workspace FTS5 pipeline;
//! exact article lookup scans the file directly because trigram FTS is
//! unreliable for article numbers.

pub mod cn_num;
pub mod monitor;
pub mod orchestrator;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::workspace::{self, hash_root_path, IndexStats};
use cn_num::{parse_article_ref, ArticleRef};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LawManifestEntry {
    pub file: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub doc_type: Option<String>,
    #[serde(default)]
    pub issuing_authority: Option<String>,
    #[serde(default)]
    pub doc_number: Option<String>,
    #[serde(default)]
    pub promulgation_date: Option<String>,
    #[serde(default)]
    pub effective_date: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub article_count: Option<u32>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub source_level: Option<String>,
    #[serde(default)]
    pub text_verification: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub retrieved_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LawManifest {
    pub version: u32,
    #[serde(default)]
    pub generated_at: Option<String>,
    pub laws: Vec<LawManifestEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryStatus {
    pub root_path: String,
    pub law_count: usize,
    pub article_count: u32,
    pub index_status: Option<workspace::WorkspaceStatus>,
    pub laws: Vec<LawManifestEntry>,
}

struct LibraryState {
    root: PathBuf,
    root_id: String,
}

static STATE: OnceLock<Mutex<Option<LibraryState>>> = OnceLock::new();

fn state_mutex() -> &'static Mutex<Option<LibraryState>> {
    STATE.get_or_init(|| Mutex::new(None))
}

fn set_state(root: PathBuf, root_id: String) {
    if let Ok(mut guard) = state_mutex().lock() {
        *guard = Some(LibraryState { root, root_id });
    }
}

/// (library root, workspace root_id) once the library is initialized.
pub fn library_paths() -> Option<(PathBuf, String)> {
    let guard = state_mutex().lock().ok()?;
    guard
        .as_ref()
        .map(|s| (s.root.clone(), s.root_id.clone()))
}

pub(crate) async fn load_manifest(root: &Path) -> Result<LawManifest> {
    let raw = tokio::fs::read_to_string(root.join("manifest.json"))
        .await
        .context("read law-library manifest.json")?;
    serde_json::from_str(&raw).context("parse law-library manifest.json")
}

/// Persist 时效状态 changes detected by the regulation monitor.
pub(crate) async fn apply_status_changes(
    root: &Path,
    changes: &[monitor::LawStatusChange],
) -> Result<()> {
    let mut manifest = load_manifest(root).await?;
    let now = chrono::Utc::now().to_rfc3339();
    for law in &mut manifest.laws {
        if let Some(change) = changes.iter().find(|c| c.name == law.name) {
            law.status = Some(change.new_status.clone());
            law.notes = Some(format!(
                "{}监测到时效状态变化：{} → {}（{}）",
                law.notes
                    .as_deref()
                    .map(|n| format!("{}；", n))
                    .unwrap_or_default(),
                change.old_status,
                change.new_status,
                now
            ));
        }
        law.retrieved_at.get_or_insert_with(|| now.clone());
    }
    let serialized = serde_json::to_string_pretty(&manifest)?;
    tokio::fs::write(root.join("manifest.json"), serialized)
        .await
        .context("write updated manifest.json")
}

fn manifest_version(root: &Path) -> Option<(u32, String)> {
    let raw = std::fs::read_to_string(root.join("manifest.json")).ok()?;
    let manifest: LawManifest = serde_json::from_str(&raw).ok()?;
    Some((manifest.version, manifest.generated_at.unwrap_or_default()))
}

/// Copy the bundled corpus into app data (first run or on corpus update) and
/// build/refresh the FTS index. `resource_candidates` are tried in order; the
/// first existing directory wins (packaged resource dir, then repo checkout).
pub async fn ensure_library(
    resource_candidates: Vec<PathBuf>,
    app_data_dir: &Path,
) -> Result<IndexStats> {
    let target = app_data_dir.join("law-library");

    if let Some(source) = resource_candidates.iter().find(|p| p.is_dir()) {
        let needs_copy = match (manifest_version(source), manifest_version(&target)) {
            (Some(src), Some(dst)) => src != dst,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if needs_copy {
            std::fs::create_dir_all(&target).context("create law-library dir")?;
            for entry in std::fs::read_dir(source).context("read bundled law-library")? {
                let entry = entry?;
                let path = entry.path();
                let is_corpus_file = path
                    .extension()
                    .is_some_and(|e| e == "md" || e == "json");
                if path.is_file() && is_corpus_file {
                    std::fs::copy(&path, target.join(entry.file_name()))
                        .with_context(|| format!("copy {}", path.display()))?;
                }
            }
            log::info!("Law library corpus copied from {}", source.display());
        }
    }

    if !target.is_dir() {
        anyhow::bail!("law library not present at {}", target.display());
    }

    let canonical = target
        .canonicalize()
        .with_context(|| format!("canonicalize law library root {}", target.display()))?;
    let root_id = hash_root_path(&canonical.to_string_lossy());
    set_state(canonical.clone(), root_id);

    workspace::bind_and_index(canonical, |_| {}).await
}

/// Re-run indexing over the current library root.
pub async fn reindex() -> Result<IndexStats> {
    let (root, _) = library_paths().context("法规库尚未初始化")?;
    workspace::bind_and_index(root, |_| {}).await
}

/// Library + index status for the settings UI.
pub async fn status() -> Result<LibraryStatus> {
    let (root, root_id) = library_paths().context("法规库尚未初始化")?;
    let manifest = load_manifest(&root).await?;
    let index_status = workspace::get_status(&root_id).await.unwrap_or(None);
    Ok(LibraryStatus {
        root_path: root.to_string_lossy().to_string(),
        law_count: manifest.laws.len(),
        article_count: manifest.laws.iter().filter_map(|l| l.article_count).sum(),
        index_status,
        laws: manifest.laws,
    })
}

fn provenance_block(entry: &LawManifestEntry) -> String {
    format!(
        "来源层级: L1-法规（本地法规库）\n渠道等级: {}\n链接: {}\n时效状态: {}\n文本核验: {}",
        entry.source_level.as_deref().unwrap_or("A"),
        entry.source_url.as_deref().unwrap_or("（未记录）"),
        entry.status.as_deref().unwrap_or("未知"),
        entry.text_verification.as_deref().unwrap_or("待核验"),
    )
}

fn status_warning(entry: &LawManifestEntry) -> Option<String> {
    let status = entry.status.as_deref()?;
    if status == "现行有效" {
        return None;
    }
    Some(format!(
        "⚠ 注意：《{}》时效状态为「{}」，引用前请核对最新版本。\n\n",
        entry.name, status
    ))
}

/// Full-text search over the law library (semantic discovery; for exact
/// article text use `get_article`).
pub async fn search_law(query: &str, k: usize) -> Result<String> {
    let (root, root_id) = library_paths().context("法规库尚未初始化，请稍后重试或在设置中重新索引")?;
    let manifest = load_manifest(&root).await?;

    let hits = workspace::search(&root_id, query, k).await?;
    if hits.is_empty() {
        return Ok(format!(
            "本地法规库未找到与「{}」相关的条文。可换关键词重试，或用 get_law_article 精确取条文；已收录 {} 部法规。",
            query,
            manifest.laws.len()
        ));
    }

    let entry_for = |relative_path: &str| {
        manifest
            .laws
            .iter()
            .find(|l| l.file == relative_path)
    };

    let mut blocks = Vec::new();
    for hit in &hits {
        // heading_path (法名 > 编章 > 第N条) lives on the chunk detail.
        let heading = match workspace::read_chunk(&hit.chunk_id).await {
            Ok(detail) if !detail.heading_path.is_empty() => detail.heading_path.join(" > "),
            _ => hit.relative_path.clone(),
        };
        let preview: String = hit.text.chars().take(220).collect();
        let mut block = format!("### {}\n{}\nchunk_id={}", heading, preview, hit.chunk_id);
        if let Some(entry) = entry_for(&hit.relative_path) {
            if let Some(warn) = status_warning(entry) {
                block = format!("{}{}", warn, block);
            }
            block.push('\n');
            block.push_str(&provenance_block(entry));
        }
        blocks.push(block);
    }

    Ok(format!(
        "本地法规库命中 {} 条（用 get_law_article 取条文全文）：\n\n{}",
        hits.len(),
        blocks.join("\n\n")
    ))
}

/// Match a manifest entry by name or alias (tolerates 《》 and short forms).
fn match_law<'a>(manifest: &'a LawManifest, raw: &str) -> Option<&'a LawManifestEntry> {
    let needle = raw
        .trim()
        .trim_matches(|c| c == '《' || c == '》')
        .trim();
    if needle.is_empty() {
        return None;
    }

    manifest
        .laws
        .iter()
        .find(|l| l.name == needle || l.aliases.iter().any(|a| a == needle))
        .or_else(|| {
            manifest.laws.iter().find(|l| {
                l.name.contains(needle)
                    || needle.contains(l.name.as_str())
                    || l.aliases
                        .iter()
                        .any(|a| a.contains(needle) || needle.contains(a.as_str()))
            })
        })
}

struct ArticleSection {
    heading: String,
    body: String,
}

/// Scan a corpus file for the `### 第N条` section matching `target`.
fn find_article_section(markdown: &str, target: &ArticleRef) -> Option<ArticleSection> {
    let mut current: Option<(String, Vec<String>)> = None;

    let close = |cur: Option<(String, Vec<String>)>| -> Option<ArticleSection> {
        cur.map(|(heading, lines)| ArticleSection {
            heading,
            body: lines.join("\n").trim().to_string(),
        })
    };

    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("### ") {
            // Close a matched section at the next article heading.
            if current.is_some() {
                return close(current);
            }
            let heading = rest.trim();
            if heading.starts_with('第') && heading.contains('条') {
                if let Some(parsed) = parse_article_ref(heading) {
                    if parsed.number == target.number && parsed.suffix == target.suffix {
                        current = Some((heading.to_string(), Vec::new()));
                    }
                }
            }
        } else if trimmed.starts_with("## ") || trimmed.starts_with("# ") {
            if current.is_some() {
                return close(current);
            }
        } else if let Some((_, lines)) = current.as_mut() {
            lines.push(line.to_string());
        }
    }

    close(current)
}

/// Count `### 第N条` headings (for "article not found" feedback).
fn count_articles(markdown: &str) -> usize {
    markdown
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("### 第") && t.contains('条')
        })
        .count()
}

/// Structured result of an exact-article lookup, consumed by both the
/// `get_law_article` tool and the citation-audit verifier.
#[derive(Debug, Clone)]
pub enum ArticleLookup {
    Found {
        entry: LawManifestEntry,
        heading: String,
        text: String,
    },
    LawFoundArticleMissing {
        entry: LawManifestEntry,
        article_count: usize,
    },
    BadArticleRef,
    LawNotFound {
        known: Vec<String>,
    },
}

/// Deterministic exact-article lookup — the citation-verification anchor.
pub async fn lookup_article(law_name: &str, article: &str) -> Result<ArticleLookup> {
    let (root, _) = library_paths().context("法规库尚未初始化")?;
    let manifest = load_manifest(&root).await?;

    let Some(entry) = match_law(&manifest, law_name) else {
        return Ok(ArticleLookup::LawNotFound {
            known: manifest.laws.iter().map(|l| l.name.clone()).collect(),
        });
    };

    let Some(target) = parse_article_ref(article) else {
        return Ok(ArticleLookup::BadArticleRef);
    };

    let markdown = tokio::fs::read_to_string(root.join(&entry.file))
        .await
        .with_context(|| format!("read corpus file {}", entry.file))?;

    match find_article_section(&markdown, &target) {
        Some(section) => Ok(ArticleLookup::Found {
            entry: entry.clone(),
            heading: section.heading,
            text: section.body,
        }),
        None => Ok(ArticleLookup::LawFoundArticleMissing {
            entry: entry.clone(),
            article_count: count_articles(&markdown),
        }),
    }
}

/// Find a library entry whose 文号 matches (e.g. 法释〔2020〕28号).
pub async fn find_by_doc_number(doc_number: &str) -> Result<Option<LawManifestEntry>> {
    let (root, _) = library_paths().context("法规库尚未初始化")?;
    let manifest = load_manifest(&root).await?;
    let needle = doc_number.trim();
    Ok(manifest
        .laws
        .iter()
        .find(|l| {
            l.doc_number
                .as_deref()
                .is_some_and(|n| n.contains(needle) || needle.contains(n))
        })
        .cloned())
}

/// Tool-facing formatter over `lookup_article`.
pub async fn get_article(law_name: &str, article: &str) -> Result<String> {
    match lookup_article(law_name, article).await? {
        ArticleLookup::Found {
            entry,
            heading,
            text,
        } => {
            let warn = status_warning(&entry).unwrap_or_default();
            Ok(format!(
                "{}《{}》{}（{}）\n\n{}\n\n{}",
                warn,
                entry.name,
                heading,
                entry.doc_type.as_deref().unwrap_or("法律"),
                text,
                provenance_block(&entry)
            ))
        }
        ArticleLookup::LawFoundArticleMissing {
            entry,
            article_count,
        } => Ok(format!(
            "《{}》中未找到「{}」（全文共 {} 条）。条文号可能有误，请核对后重试或标注 [待律师复核]。",
            entry.name, article, article_count
        )),
        ArticleLookup::BadArticleRef => Ok(format!(
            "无法解析条文号「{}」。请用「第N条」格式（支持中文或阿拉伯数字，如 第五百八十五条 / 第585条）。",
            article
        )),
        ArticleLookup::LawNotFound { known } => Ok(format!(
            "本地法规库未收录「{}」。已收录 {} 部：{}。该法条引用请通过在线检索工具核验，或标注 [待律师复核]。",
            law_name,
            known.len(),
            known.join("、")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_manifest() -> LawManifest {
        serde_json::from_str(
            r#"{
              "version": 1,
              "laws": [
                {
                  "file": "minfadian.md",
                  "name": "中华人民共和国民法典",
                  "aliases": ["民法典"],
                  "doc_type": "法律",
                  "status": "现行有效",
                  "article_count": 3,
                  "source_url": "https://flk.npc.gov.cn/",
                  "text_verification": "待核验"
                },
                {
                  "file": "old.md",
                  "name": "某已废止条例",
                  "aliases": [],
                  "status": "已废止"
                }
              ]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn matches_law_by_name_alias_and_fuzzy() {
        let m = sample_manifest();
        assert!(match_law(&m, "民法典").is_some());
        assert!(match_law(&m, "《中华人民共和国民法典》").is_some());
        assert!(match_law(&m, "中华人民共和国民法典").is_some());
        assert!(match_law(&m, "民法").is_some(), "substring fallback");
        assert!(match_law(&m, "不存在的法").is_none());
    }

    #[test]
    fn finds_article_section_by_chinese_or_arabic_number() {
        let md = "# 中华人民共和国民法典\n\n> 文号：x\n\n## 第三编 合同\n\n### 第五百八十四条\n\n旧条文。\n\n### 第五百八十五条\n\n当事人可以约定违约金。\n\n约定的违约金低于造成的损失的，可以请求增加。\n\n### 第五百八十六条\n\n下一条。\n";
        let target = parse_article_ref("第585条").unwrap();
        let section = find_article_section(md, &target).unwrap();
        assert_eq!(section.heading, "第五百八十五条");
        assert!(section.body.contains("违约金"));
        assert!(section.body.contains("请求增加"));
        assert!(!section.body.contains("下一条"));
    }

    #[test]
    fn article_suffix_must_match() {
        let md = "# 法\n\n### 第二百八十七条\n\n本条。\n\n### 第二百八十七条之一\n\n之一条。\n";
        let plain = find_article_section(md, &parse_article_ref("第287条").unwrap()).unwrap();
        assert!(plain.body.contains("本条"));
        let zhi_yi =
            find_article_section(md, &parse_article_ref("第二百八十七条之一").unwrap()).unwrap();
        assert!(zhi_yi.body.contains("之一条"));
    }

    #[test]
    fn missing_article_returns_none_and_count_works() {
        let md = "# 法\n\n### 第一条\n\n一。\n\n### 第二条\n\n二。\n";
        assert!(find_article_section(md, &parse_article_ref("第三条").unwrap()).is_none());
        assert_eq!(count_articles(md), 2);
    }

    #[test]
    fn repealed_law_gets_status_warning() {
        let m = sample_manifest();
        let entry = match_law(&m, "某已废止条例").unwrap();
        let warn = status_warning(entry).unwrap();
        assert!(warn.contains("已废止"));
        assert!(status_warning(match_law(&m, "民法典").unwrap()).is_none());
    }

    /// Integration check against the real bundled corpus (skips while the
    /// corpus is still the empty stub).
    #[tokio::test]
    async fn bundled_corpus_exact_article_lookup() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/law-library");
        let Ok(manifest) = load_manifest(&resources).await else {
            return;
        };
        if manifest.laws.is_empty() {
            return; // corpus not built yet
        }
        let Ok(canonical) = resources.canonicalize() else {
            return;
        };
        set_state(canonical.clone(), hash_root_path(&canonical.to_string_lossy()));

        let r = get_article("民法典", "第五百八十五条").await.unwrap();
        assert!(r.contains("违约金"), "民法典第585条 should mention 违约金: {}", r);

        let r = get_article("独立保函司法解释", "第一条").await.unwrap();
        assert!(
            r.contains("银行或非银行金融机构"),
            "独立保函规定第1条 should mention 开立主体: {}",
            r
        );

        let r = get_article("担保制度解释", "第二十五条").await.unwrap();
        assert!(r.contains("保证"), "担保制度解释第25条: {}", r);
    }
}
