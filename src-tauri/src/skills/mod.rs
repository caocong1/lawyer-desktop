pub mod agent_classifier;
pub mod loader;
pub mod router;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use self::loader::SkillMetadata;

pub struct SkillRegistry {
    skills: Arc<RwLock<Vec<SkillMetadata>>>,
    skills_root: Arc<RwLock<Option<PathBuf>>>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self {
            skills: Arc::new(RwLock::new(Vec::new())),
            skills_root: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn get_skills_root(&self) -> Option<PathBuf> {
        self.skills_root.read().await.clone()
    }

    pub async fn set_skills_root(&self, path: PathBuf) -> anyhow::Result<()> {
        let mut root = self.skills_root.write().await;
        *root = Some(path);
        Ok(())
    }

    pub async fn reload(&self) -> anyhow::Result<usize> {
        let root = self.skills_root.read().await;
        if let Some(ref root_path) = *root {
            let skills = loader::scan_skills_dir(root_path).await?;
            let count = skills.len();
            let mut current = self.skills.write().await;
            *current = skills;
            Ok(count)
        } else {
            Ok(0)
        }
    }

    pub async fn get_skills(&self) -> Vec<SkillMetadata> {
        self.skills.read().await.clone()
    }

    pub async fn find_skill(&self, name: &str) -> Option<SkillMetadata> {
        self.skills
            .read()
            .await
            .iter()
            .find(|s| s.name == name)
            .cloned()
    }

    /// Match by skill name, or by plugin folder name (e.g. `commercial-legal`).
    pub async fn find_skill_fuzzy(&self, name: &str) -> Option<SkillMetadata> {
        let skills = self.skills.read().await;
        if let Some(s) = skills.iter().find(|s| s.name == name) {
            return Some(s.clone());
        }

        let plugin_matches: Vec<_> = skills
            .iter()
            .filter(|s| s.plugin_name == name)
            .collect();
        if plugin_matches.is_empty() {
            return None;
        }

        plugin_matches
            .iter()
            .find(|s| s.name == "contract-drafting")
            .or_else(|| plugin_matches.iter().find(|s| s.name.contains("drafting")))
            .or_else(|| plugin_matches.first())
            .map(|s| (*s).clone())
    }
}
