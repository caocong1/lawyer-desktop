use std::fs::{self, File};
use std::io::copy;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::skills::SkillRegistry;
use crate::sync::client::SyncClient;
use crate::sync::settings;

const PACKAGE_NAME: &str = "ai-for-china-legal";

pub fn managed_skills_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("skills").join(PACKAGE_NAME)
}

pub fn managed_skills_current(app_data_dir: &Path) -> PathBuf {
    managed_skills_root(app_data_dir).join("current")
}

pub fn ensure_managed_layout(app_data_dir: &Path) -> anyhow::Result<PathBuf> {
    let root = managed_skills_root(app_data_dir);
    fs::create_dir_all(root.join("staging"))?;
    fs::create_dir_all(root.join("current"))?;
    Ok(root.join("current"))
}

/// Bootstrap managed skills from dev vendor path if current dir is empty.
pub fn bootstrap_from_vendor(current: &Path, vendor: &Path) -> anyhow::Result<bool> {
    if !vendor.is_dir() {
        return Ok(false);
    }
    let has_skill = walkdir::WalkDir::new(current)
        .into_iter()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_str() == Some("SKILL.md"));

    if has_skill {
        return Ok(false);
    }

    log::info!("Bootstrapping managed skills from {:?}", vendor);
    copy_dir_recursive(vendor, current)?;
    Ok(true)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

pub fn validate_skill_tree(root: &Path) -> anyhow::Result<()> {
    let marketplace = root.join(".claude-plugin/marketplace.json");
    if !marketplace.is_file() {
        anyhow::bail!("missing .claude-plugin/marketplace.json");
    }
    let research_gate = root.join("shared/research-gate/SKILL.md");
    if !research_gate.is_file() {
        anyhow::bail!("missing shared/research-gate/SKILL.md");
    }
    let skill_count = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_str() == Some("SKILL.md"))
        .count();
    if skill_count < 3 {
        anyhow::bail!("expected at least 3 SKILL.md files, found {}", skill_count);
    }
    Ok(())
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn extract_zip_to_dir(zip_bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        fs::remove_dir_all(dest)?;
    }
    fs::create_dir_all(dest)?;
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&outpath)?;
            copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

/// Detect single top-level folder in extracted staging (common zip layout).
pub fn normalize_staging_root(staging: &Path) -> anyhow::Result<PathBuf> {
    let mut dirs = Vec::new();
    let mut files = 0usize;
    for entry in fs::read_dir(staging)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            dirs.push(entry.path());
        } else {
            files += 1;
        }
    }
    if dirs.len() == 1 && files == 0 {
        Ok(dirs.remove(0))
    } else {
        Ok(staging.to_path_buf())
    }
}

pub async fn check_and_apply_skill_update(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    key_store: &crate::security::key_store::KeyStore,
    app_data_dir: &Path,
    skills: &SkillRegistry,
    sync_client: &SyncClient,
    channel: &str,
) -> anyhow::Result<Option<String>> {
    let current_version = settings::get_skills_version(pool).await?;
    let manifest = sync_client
        .fetch_skill_manifest(channel, current_version.as_deref())
        .await?;

    let Some(manifest) = manifest else {
        return Ok(None);
    };

    if current_version.as_deref() == Some(manifest.version.as_str()) {
        return Ok(None);
    }

    log::info!(
        "Skill update available: {} -> {}",
        current_version.as_deref().unwrap_or("none"),
        manifest.version
    );

    let zip_bytes = sync_client.download_bytes(&manifest.download_url).await?;
    let hash = sha256_bytes(&zip_bytes);
    if hash != manifest.sha256 {
        anyhow::bail!(
            "skill package sha256 mismatch: expected {}, got {}",
            manifest.sha256,
            hash
        );
    }

    let root = managed_skills_root(app_data_dir);
    let staging = root.join("staging");
    let current = root.join("current");
    let backup = root.join("_prev");

    extract_zip_to_dir(&zip_bytes, &staging)?;
    let skill_root = normalize_staging_root(&staging)?;
    validate_skill_tree(&skill_root)?;

    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if current.exists() {
        fs::rename(&current, &backup)?;
    }

    if skill_root != staging {
        fs::rename(&skill_root, &current)?;
        let _ = fs::remove_dir_all(&staging);
    } else {
        fs::rename(&staging, &current)?;
    }

    settings::set_skills_version(pool, &manifest.version).await?;
    skills.set_skills_root(current.clone()).await?;
    skills.reload().await?;

    let _ = key_store; // reserved for future signature verification

    Ok(Some(manifest.version))
}

pub async fn initialize_managed_skills(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    key_store: &crate::security::key_store::KeyStore,
    app_data_dir: &Path,
    skills: &SkillRegistry,
    dev_vendor: Option<PathBuf>,
    sync_base_url: Option<String>,
    sync_api_key: Option<String>,
    channel: &str,
) -> anyhow::Result<PathBuf> {
    let current = ensure_managed_layout(app_data_dir)?;

    if let Some(vendor) = dev_vendor {
        let _ = bootstrap_from_vendor(&current, &vendor);
    }

    skills.set_skills_root(current.clone()).await?;
    skills.reload().await?;

    if let Some(base) = sync_base_url.filter(|u| !u.trim().is_empty()) {
        let client = SyncClient::new(&base, sync_api_key);
        match check_and_apply_skill_update(pool, key_store, app_data_dir, skills, &client, channel).await
        {
            Ok(Some(v)) => log::info!("Applied skill update v{}", v),
            Ok(None) => log::info!("Skills up to date"),
            Err(e) => log::warn!("Skill auto-update skipped: {}", e),
        }
    }

    Ok(current)
}
