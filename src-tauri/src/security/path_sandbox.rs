use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// Validates file paths against an allowlist of directory roots.
pub struct PathSandbox {
    allowed_roots: Vec<PathBuf>,
}

impl PathSandbox {
    pub fn new(allowed_roots: Vec<PathBuf>) -> Self {
        Self { allowed_roots }
    }

    /// Build default sandbox: Documents + Desktop + optional extra dirs.
    pub fn with_defaults(extra_dirs: &[String]) -> Result<Self> {
        let mut roots = Vec::new();

        if let Some(home) = user_home_dir() {
            let docs = home.join("Documents");
            if docs.is_dir() {
                roots.push(docs);
            }
            let desktop = home.join("Desktop");
            if desktop.is_dir() {
                roots.push(desktop);
            }
        }

        for dir in extra_dirs {
            let path = PathBuf::from(dir);
            if path.is_dir() {
                roots.push(path);
            }
        }

        if roots.is_empty() {
            bail!("no allowed directories configured for file access");
        }

        Ok(Self::new(roots))
    }

    /// Canonicalize and verify the path is under an allowed root.
    pub fn validate(&self, path: &str) -> Result<PathBuf> {
        let input = Path::new(path);

        if input.components().any(|c| matches!(c, Component::ParentDir)) {
            bail!("path traversal not allowed: {}", path);
        }

        let canonical = if input.is_absolute() {
            std::fs::canonicalize(input).with_context(|| format!("cannot resolve path: {}", path))?
        } else {
            let joined = std::env::current_dir()
                .context("cannot get current directory")?
                .join(input);
            std::fs::canonicalize(&joined)
                .with_context(|| format!("cannot resolve path: {}", path))?
        };

        for root in &self.allowed_roots {
            let root_canon = std::fs::canonicalize(root)
                .with_context(|| format!("cannot resolve allowed root: {}", root.display()))?;
            if canonical.starts_with(&root_canon) {
                return Ok(canonical);
            }
        }

        bail!(
            "access denied: {} is outside allowed directories",
            canonical.display()
        )
    }

    pub fn allowed_roots(&self) -> &[PathBuf] {
        &self.allowed_roots
    }

    /// Replace allowed roots from defaults (Documents, Desktop) plus extra dirs.
    pub fn reload(&mut self, extra_dirs: &[String]) -> Result<()> {
        *self = Self::with_defaults(extra_dirs)?;
        Ok(())
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// Deduplicate roots while preserving order.
pub fn merge_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots.retain(|p| {
        let key = p.to_string_lossy().to_string();
        seen.insert(key)
    });
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn temp_root() -> PathBuf {
        let dir = temp_dir().join(format!("lawyer-sandbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_file_inside_root() {
        let root = temp_root();
        let file = root.join("test.txt");
        std::fs::write(&file, "hello").unwrap();

        let sandbox = PathSandbox::new(vec![root.clone()]);
        let validated = sandbox.validate(&file.to_string_lossy()).unwrap();
        assert!(validated.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_path_outside_roots() {
        let root = temp_root();
        let outside = temp_dir().join(format!("outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("secret.txt");
        std::fs::write(&file, "secret").unwrap();

        let sandbox = PathSandbox::new(vec![root.clone()]);
        assert!(sandbox.validate(&file.to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let root = temp_root();
        let sandbox = PathSandbox::new(vec![root.clone()]);
        assert!(sandbox.validate("../etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
