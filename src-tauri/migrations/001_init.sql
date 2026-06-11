-- 会话表
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settings_json TEXT
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments_json TEXT,
  tool_calls_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- 文书表
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  document_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_conversation ON documents(conversation_id);

-- LLM Provider 配置表
CREATE TABLE IF NOT EXISTS llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_base_url TEXT NOT NULL,
  api_key TEXT,
  model_name TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  config_json TEXT,
  created_at TEXT NOT NULL
);

-- 应用设置（key-value）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
