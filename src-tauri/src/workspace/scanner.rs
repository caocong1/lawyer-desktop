use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// Directories skipped during workspace scan.
pub const IGNORE_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "venv",
    ".venv",
    "dist",
    "build",
    "__pycache__",
    "target",
    ".cargo",
    ".idea",
    ".vscode",
    ".cursor",
    "coverage",
    ".next",
    ".nuxt",
];

/// File extensions eligible for indexing (lowercase, without dot).
pub const ALLOW_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "xml", "html", "htm", "csv", "log",
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
    "sql", "sh", "bash", "ps1", "pdf", "docx",
];

/// Default maximum file size (50 MB).
pub const DEFAULT_MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub size: u64,
    pub mtime_secs: i64,
    pub sha256: String,
    pub ext: String,
}

fn system_time_to_secs(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_ignored_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name)
}

fn is_allowed_ext(ext: &str) -> bool {
    ALLOW_EXTS.contains(&ext)
}

/// Compute SHA-256 hex digest of file contents.
pub fn hash_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read file for hash: {}", path.display()))?;
    let digest = Sha256::digest(&bytes);
    Ok(hex::encode(digest))
}

/// Recursively scan `root`, returning eligible files with metadata and content hash.
pub fn scan_root(root: &Path, max_file_size: u64) -> Result<Vec<ScannedFile>> {
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize root: {}", root.display()))?;

    if !root.is_dir() {
        anyhow::bail!("not a directory: {}", root.display());
    }

    let mut files = Vec::new();

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !is_ignored_dir(&name);
            }
            true
        })
    {
        let entry = entry.with_context(|| format!("walk dir under {}", root.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !is_allowed_ext(&ext) {
            continue;
        }

        let metadata = entry
            .metadata()
            .with_context(|| format!("metadata: {}", path.display()))?;
        let size = metadata.len();
        if size > max_file_size {
            log::warn!(
                "skip oversized file ({} bytes > {}): {}",
                size,
                max_file_size,
                path.display()
            );
            continue;
        }

        let mtime_secs = metadata
            .modified()
            .map(system_time_to_secs)
            .unwrap_or(0);

        let sha256 = hash_file(path)?;
        let relative_path = path
            .strip_prefix(&root)
            .with_context(|| format!("strip prefix: {}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");

        files.push(ScannedFile {
            absolute_path: path.to_path_buf(),
            relative_path,
            size,
            mtime_secs,
            sha256,
            ext,
        });
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Returns true when an existing DB record matches scan result (skip re-parse).
pub fn is_unchanged(existing_mtime: i64, existing_sha256: &str, scanned: &ScannedFile) -> bool {
    existing_mtime == scanned.mtime_secs && existing_sha256 == scanned.sha256
}

/// Relative paths present in DB but absent from scan (deleted on disk).
pub fn find_removed_paths(existing: &[String], scanned: &[ScannedFile]) -> Vec<String> {
    let current: HashSet<&str> = scanned.iter().map(|f| f.relative_path.as_str()).collect();
    existing
        .into_iter()
        .filter(|p| !current.contains(p.as_str()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lawyer-ws-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_finds_allowed_files_and_ignores_dirs() {
        let root = temp_workspace();
        fs::write(root.join("readme.md"), "# Hello").unwrap();
        fs::write(root.join("notes.txt"), "索赔条款").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "ignored").unwrap();
        fs::write(root.join("binary.exe"), "exe").unwrap();

        let files = scan_root(&root, DEFAULT_MAX_FILE_SIZE).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        assert!(paths.contains(&"readme.md"));
        assert!(paths.contains(&"notes.txt"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.ends_with(".exe")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_unchanged_requires_mtime_and_hash() {
        let scanned = ScannedFile {
            absolute_path: PathBuf::from("/tmp/a.md"),
            relative_path: "a.md".into(),
            size: 10,
            mtime_secs: 100,
            sha256: "abc".into(),
            ext: "md".into(),
        };
        assert!(is_unchanged(100, "abc", &scanned));
        assert!(!is_unchanged(99, "abc", &scanned));
        assert!(!is_unchanged(100, "def", &scanned));
    }

    #[test]
    fn find_removed_paths_detects_deletions() {
        let existing = vec!["a.md".into(), "b.md".into()];
        let scanned = vec![ScannedFile {
            absolute_path: PathBuf::from("/tmp/a.md"),
            relative_path: "a.md".into(),
            size: 1,
            mtime_secs: 1,
            sha256: "x".into(),
            ext: "md".into(),
        }];
        let removed = find_removed_paths(&existing, &scanned);
        assert_eq!(removed, vec!["b.md"]);
    }
}
