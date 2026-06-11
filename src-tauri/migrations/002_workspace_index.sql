-- Workspace root bindings (one row per indexed directory)
CREATE TABLE IF NOT EXISTS workspace_roots (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  root_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  file_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Indexed files within a workspace root
CREATE TABLE IF NOT EXISTS workspace_files (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES workspace_roots(id) ON DELETE CASCADE,
  absolute_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_secs INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  file_ext TEXT,
  indexed_at TEXT,
  UNIQUE(root_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_workspace_files_root ON workspace_files(root_id);

-- Text chunks derived from parsed files
CREATE TABLE IF NOT EXISTS workspace_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES workspace_roots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  heading_path TEXT,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_chunks_root ON workspace_chunks(root_id);
CREATE INDEX IF NOT EXISTS idx_workspace_chunks_file ON workspace_chunks(file_id);

-- FTS5 full-text index (external content table)
CREATE VIRTUAL TABLE IF NOT EXISTS workspace_chunks_fts USING fts5(
  content,
  heading_path,
  relative_path,
  content='workspace_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

-- Keep FTS in sync with workspace_chunks (external content pattern)
CREATE TRIGGER IF NOT EXISTS workspace_chunks_ai AFTER INSERT ON workspace_chunks BEGIN
  INSERT INTO workspace_chunks_fts(rowid, content, heading_path, relative_path)
  VALUES (new.rowid, new.content, new.heading_path, new.relative_path);
END;

CREATE TRIGGER IF NOT EXISTS workspace_chunks_ad AFTER DELETE ON workspace_chunks BEGIN
  INSERT INTO workspace_chunks_fts(workspace_chunks_fts, rowid, content, heading_path, relative_path)
  VALUES ('delete', old.rowid, old.content, old.heading_path, old.relative_path);
END;

CREATE TRIGGER IF NOT EXISTS workspace_chunks_au AFTER UPDATE ON workspace_chunks BEGIN
  INSERT INTO workspace_chunks_fts(workspace_chunks_fts, rowid, content, heading_path, relative_path)
  VALUES ('delete', old.rowid, old.content, old.heading_path, old.relative_path);
  INSERT INTO workspace_chunks_fts(rowid, content, heading_path, relative_path)
  VALUES (new.rowid, new.content, new.heading_path, new.relative_path);
END;
