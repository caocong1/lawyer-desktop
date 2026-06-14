use anyhow::{bail, Context, Result};
use std::path::{Component, Path, PathBuf};

/// Path sandbox for eval replay — separate from lawyer-facing allowed_file_dirs.
#[derive(Clone)]
pub struct EvalPathSandbox {
    allowed_roots: Vec<PathBuf>,
}

impl EvalPathSandbox {
    pub fn new(allowed_roots: Vec<PathBuf>) -> Self {
        Self { allowed_roots }
    }

    pub fn with_defaults(extra_dirs: &[String]) -> Result<Self> {
        let mut roots = Vec::new();
        for dir in extra_dirs {
            let path = PathBuf::from(dir);
            if path.is_dir() {
                roots.push(path);
            }
        }
        if roots.is_empty() {
            bail!("no eval data roots configured");
        }
        Ok(Self::new(roots))
    }

    pub fn validate(&self, path: &str) -> Result<PathBuf> {
        let input = Path::new(path);
        if input
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            bail!("path traversal not allowed: {}", path);
        }
        let canonical = if input.is_absolute() {
            std::fs::canonicalize(input)
                .with_context(|| format!("cannot resolve path: {}", path))?
        } else {
            let joined = std::env::current_dir()
                .context("cannot get current directory")?
                .join(input);
            std::fs::canonicalize(&joined)
                .with_context(|| format!("cannot resolve path: {}", path))?
        };
        for root in &self.allowed_roots {
            let root_canon = std::fs::canonicalize(root)
                .with_context(|| format!("cannot resolve eval root: {}", root.display()))?;
            if canonical.starts_with(&root_canon) {
                return Ok(canonical);
            }
        }
        bail!(
            "eval access denied: {} is outside eval data roots",
            canonical.display()
        )
    }

    pub fn allowed_roots(&self) -> &[PathBuf] {
        &self.allowed_roots
    }

    pub fn reload(&mut self, extra_dirs: &[String]) -> Result<()> {
        *self = Self::with_defaults(extra_dirs)?;
        Ok(())
    }
}
