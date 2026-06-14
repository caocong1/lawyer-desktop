-- SkillOpt / skill refinement tables

CREATE TABLE IF NOT EXISTS skill_feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    skill_name TEXT,
    plugin_name TEXT,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    comment TEXT,
    dimensions_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_feedback_conversation ON skill_feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_skill_feedback_skill ON skill_feedback(skill_name);

CREATE TABLE IF NOT EXISTS eval_cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target_skill TEXT,
    target_plugin TEXT,
    prompt TEXT NOT NULL,
    materials_path TEXT,
    rubric TEXT,
    split TEXT NOT NULL DEFAULT 'val' CHECK (split IN ('train', 'val', 'test')),
    origin TEXT NOT NULL DEFAULT 'real' CHECK (origin IN ('real', 'dream')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_split ON eval_cases(split, active);

CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
    skill_hash TEXT,
    score REAL NOT NULL,
    rubric_json TEXT,
    citation_json TEXT,
    tokens INTEGER,
    latency_ms INTEGER,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_case ON eval_runs(case_id);

CREATE TABLE IF NOT EXISTS skill_proposals (
    id TEXT PRIMARY KEY,
    target_path TEXT NOT NULL,
    base_hash TEXT,
    diff TEXT NOT NULL,
    rationale TEXT,
    val_before REAL,
    val_after REAL,
    status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'adopted', 'rejected')),
    created_at TEXT NOT NULL,
    adopted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status);
