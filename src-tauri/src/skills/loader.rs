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
    let candidates = [
        skills_root.join("shared/skills/research-gate/SKILL.md"),
        skills_root.join("research-gate/skills/research-gate/SKILL.md"),
    ];

    for path in &candidates {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path).await {
                return Some(content);
            }
        }
    }

    // Scan all plugins for research-gate skill
    let skills = scan_skills_dir(skills_root).await.ok()?;
    skills
        .into_iter()
        .find(|s| s.name == "research-gate")
        .map(|s| s.full_content)
}
