use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub plugin_name: String,
    pub skill_md_path: PathBuf,
    pub full_content: String,
}

pub async fn scan_skills_dir(skills_root: &Path) -> Result<Vec<SkillMetadata>> {
    let mut skills = Vec::new();

    if !skills_root.exists() {
        return Ok(skills);
    }

    let mut plugins = fs::read_dir(skills_root)
        .await
        .context("Failed to read skills root directory")?;

    while let Some(plugin_entry) = plugins.next_entry().await? {
        let plugin_path = plugin_entry.path();
        if !plugin_path.is_dir() {
            continue;
        }

        let plugin_name = plugin_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if plugin_name.starts_with('.') || plugin_name == "scripts" {
            continue;
        }

        if plugin_name == "shared" {
            skills.extend(scan_for_skills_in_dir(&plugin_path, &plugin_name).await);
            continue;
        }

        skills.extend(scan_for_skills_in_dir(&plugin_path, &plugin_name).await);
    }

    Ok(skills)
}

async fn scan_for_skills_in_dir(plugin_path: &Path, plugin_name: &str) -> Vec<SkillMetadata> {
    let mut skills = Vec::new();
    let skills_dir = plugin_path.join("skills");

    if !skills_dir.exists() {
        return skills;
    }

    let mut entries = match fs::read_dir(&skills_dir).await {
        Ok(e) => e,
        Err(_) => return skills,
    };

    while let Some(entry) = entries.next_entry().await.ok().flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }

        let skill_name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if skill_name.starts_with('_') {
            continue;
        }

        let skill_md = entry_path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }

        if let Ok(content) = fs::read_to_string(&skill_md).await {
            skills.push(parse_skill_frontmatter(
                &content,
                plugin_name,
                &skill_name,
                &skill_md,
            ));
        }
    }

    skills
}

fn parse_skill_frontmatter(
    content: &str,
    plugin_name: &str,
    skill_name: &str,
    skill_md_path: &Path,
) -> SkillMetadata {
    let mut name = skill_name.to_string();
    let mut description = String::new();
    let mut argument_hint = None;

    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            let frontmatter = &content[3..3 + end];
            for line in frontmatter.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("name:") {
                    name = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("description:") {
                    let val = val.trim().trim_matches('"');
                    if !val.is_empty() {
                        description = val.to_string();
                    }
                } else if let Some(val) = line.strip_prefix("argument-hint:") {
                    argument_hint = Some(val.trim().trim_matches('"').to_string());
                }
            }

            if description.is_empty() {
                let after_frontmatter = &content[6 + end..];
                for line in after_frontmatter.lines() {
                    let line = line.trim();
                    if line.starts_with('#') {
                        description = line.trim_start_matches('#').trim().to_string();
                        break;
                    }
                    if !line.is_empty() {
                        description = line.to_string();
                        break;
                    }
                }
            }
        }
    }

    if description.is_empty() {
        description = format!("{} - {}", plugin_name, skill_name);
    }

    SkillMetadata {
        name,
        description,
        argument_hint,
        plugin_name: plugin_name.to_string(),
        skill_md_path: skill_md_path.to_path_buf(),
        full_content: content.to_string(),
    }
}

/// Load research-gate skill content from skills root if present.
pub async fn load_research_gate(skills_root: &Path) -> Option<String> {
    // The canonical location is shared/research-gate/SKILL.md (the shared dir
    // has no skills/ subdir, so the generic skill scan never finds it).
    let candidates = [
        skills_root.join("shared/research-gate/SKILL.md"),
        skills_root.join("shared/skills/research-gate/SKILL.md"),
        skills_root.join("research-gate/skills/research-gate/SKILL.md"),
    ];

    let mut gate: Option<String> = None;
    for path in &candidates {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path).await {
                gate = Some(content);
                break;
            }
        }
    }

    if gate.is_none() {
        // Scan all plugins; the skill's frontmatter name is cn-law-research-gate.
        let skills = scan_skills_dir(skills_root).await.ok()?;
        gate = skills
            .into_iter()
            .find(|s| s.name == "research-gate" || s.name == "cn-law-research-gate")
            .map(|s| s.full_content);
    }

    let gate = strip_frontmatter(&gate?).to_string();
    Some(with_source_policy_markers(skills_root, gate).await)
}

/// Drop YAML frontmatter — it is loader metadata, not prompt content.
fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start();
        }
    }
    content
}

/// Append the citation-marker vocabulary from source-policy.md so the model
/// emits the exact markers ([L1-法规] … [待律师复核]) the audit pipeline expects.
async fn with_source_policy_markers(skills_root: &Path, gate: String) -> String {
    let policy_path = skills_root.join("shared/research-gate/references/source-policy.md");
    let Ok(policy) = fs::read_to_string(&policy_path).await else {
        return gate;
    };
    let Some(markers) = extract_section(&policy, "## 引用标记") else {
        return gate;
    };
    format!(
        "{}\n\n## 引用标记（source-policy 摘录）\n{}\n",
        gate.trim_end(),
        markers.trim_end()
    )
}

/// Body of a `## heading` section, up to the next `## `.
fn extract_section<'a>(content: &'a str, heading: &str) -> Option<&'a str> {
    let start = content.find(heading)? + heading.len();
    let rest = &content[start..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    Some(&rest[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_skills_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lawyer-skills-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("shared/research-gate/references")).unwrap();
        dir
    }

    #[tokio::test]
    async fn loads_gate_from_shared_research_gate_dir() {
        let root = temp_skills_root();
        std::fs::write(
            root.join("shared/research-gate/SKILL.md"),
            "---\nname: cn-law-research-gate\ndescription: x\n---\n\n# 中国法研究闸门\n\n## 强制工作流\n正文",
        )
        .unwrap();
        std::fs::write(
            root.join("shared/research-gate/references/source-policy.md"),
            "# 引用策略\n\n## 引用标记\n\n| 标记 | 含义 |\n|---|---|\n| `[L1-法规]` | 全文 |\n\n## 禁止引用\n略",
        )
        .unwrap();

        let gate = load_research_gate(&root).await.expect("gate should load");
        assert!(gate.contains("强制工作流"));
        assert!(gate.contains("[L1-法规]"), "source-policy markers appended");
        assert!(!gate.contains("禁止引用"), "only the marker section is appended");
        assert!(!gate.starts_with("---"), "frontmatter stripped");

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn returns_none_when_gate_absent() {
        let root = std::env::temp_dir().join(format!("lawyer-skills-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(load_research_gate(&root).await.is_none());
        std::fs::remove_dir_all(&root).ok();
    }
}
