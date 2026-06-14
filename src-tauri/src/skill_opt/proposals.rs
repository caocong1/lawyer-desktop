use std::path::{Path, PathBuf};

use crate::db::queries::SkillProposalRow;
use crate::skills::SkillRegistry;

/// Apply a unified diff to skill content (simplified line-based patch).
pub fn apply_diff(base: &str, diff: &str) -> anyhow::Result<String> {
    if diff.starts_with("REPLACE:") {
        let rest = diff.strip_prefix("REPLACE:").unwrap_or(diff);
        if let Some((from, to)) = rest.split_once("|||") {
            if base.contains(from) {
                return Ok(base.replace(from, to));
            }
            anyhow::bail!("REPLACE target not found in skill");
        }
    }
    if diff.starts_with("APPEND:") {
        let append = diff.strip_prefix("APPEND:").unwrap_or("");
        return Ok(format!("{}\n\n{}", base.trim_end(), append));
    }
    if diff.starts_with("FULL:") {
        return Ok(diff.strip_prefix("FULL:").unwrap_or(diff).to_string());
    }
    Ok(base.to_string())
}

pub fn make_diff_replace(from: &str, to: &str) -> String {
    format!("REPLACE:{}|||{}", from, to)
}

pub fn is_low_risk_edit(diff: &str) -> bool {
    let legal_keywords = ["案由", "法律依据", "请求权", "诉讼方案", "主体资格", "保证合同"];
    !legal_keywords.iter().any(|k| diff.contains(k))
}

pub async fn adopt_proposal_to_disk(
    skills: &SkillRegistry,
    proposal: &SkillProposalRow,
) -> anyhow::Result<PathBuf> {
    let skills_root = skills
        .get_skills_root()
        .await
        .ok_or_else(|| anyhow::anyhow!("skills root not configured"))?;

    let target = PathBuf::from(&proposal.target_path);
    let full_path = if target.is_absolute() {
        target
    } else {
        skills_root.join(&proposal.target_path)
    };

    let original = std::fs::read_to_string(&full_path)
        .map_err(|e| anyhow::anyhow!("read skill file: {}", e))?;

    let updated = apply_diff(&original, &proposal.diff)?;

    let backup_dir = skills_root.join(".skill-backups").join(chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string());
    std::fs::create_dir_all(&backup_dir)?;
    let backup_name = full_path
        .strip_prefix(&skills_root)
        .unwrap_or(full_path.as_path())
        .to_string_lossy()
        .replace('\\', "/");
    let backup_path = backup_dir.join(backup_name.replace('/', "_"));
    if let Some(parent) = backup_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&backup_path, &original)?;

    std::fs::write(&full_path, &updated)?;

    append_forward_test_log(&skills_root, proposal)?;

    Ok(full_path)
}

fn append_forward_test_log(skills_root: &Path, proposal: &SkillProposalRow) -> anyhow::Result<()> {
    let log_path = skills_root.join("forward-tests.md");
    if !log_path.exists() {
        return Ok(());
    }
    let line = format!(
        "\n| auto-{} | {} | skill-opt | 提案采纳 | — | — | — | — | — | — | — | — | — | — | val {:.2}→{:.2} |\n",
        &proposal.id[..8.min(proposal.id.len())],
        chrono::Utc::now().format("%Y-%m-%d"),
        proposal.val_before.unwrap_or(0.0),
        proposal.val_after.unwrap_or(0.0),
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&log_path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
}
