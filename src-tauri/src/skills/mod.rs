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
}
