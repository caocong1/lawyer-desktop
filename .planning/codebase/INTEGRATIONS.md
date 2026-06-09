# External Integrations

**Analysis Date:** 2026-06-10

## APIs & External Services

### LLM Providers (OpenAI-Compatible API)

**Pattern:** All providers are consumed via a single `OpenAiCompatProvider` implementation (`src-tauri/src/llm/openai_compat.rs`) that speaks the OpenAI `/v1/chat/completions` REST API format. The app supports runtime-configurable provider switching.

| Provider | Default Base URL | Default Model | Preset Name |
|---|---|---|---|
| 通义千问 (Qwen / DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `qwen` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `deepseek` |
| Kimi (月之暗面 / Moonshot) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `kimi` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | `openai` |
| Ollama (本地) | `http://localhost:11434/v1` | `qwen2.5:7b` | `ollama` |
| Custom (任意 OpenAI 兼容) | User-defined | User-defined | `custom` |

**Presets defined in:** `src-tauri/src/llm/mod.rs` (function `default_providers()`)

**Auth:** API key passed as Bearer token in HTTP `Authorization` header per request (`src-tauri/src/llm/openai_compat.rs:29-31`)

**Implementation:**
- HTTP client: `reqwest 0.12` with `stream` and `json` features (`src-tauri/Cargo.toml`)
- Streaming: Server-Sent Events (SSE) parsed via `reqwest::Response::bytes_stream()` + line-by-line `data: ` prefix parsing (`src-tauri/src/llm/openai_compat.rs:66-93`)
- Tool calls: Accumulated from SSE `delta.tool_calls` chunks and reassembled (`src-tauri/src/commands/chat.rs:254-421`)
- Multi-turn: Up to 10 tool-calling rounds per user message (`MAX_TOOL_ROUNDS` in `src-tauri/src/commands/chat.rs:15`)
- Provider interface: `LlmProvider` trait (`src-tauri/src/llm/provider.rs`) with `chat()`, `chat_stream()`, `supports_tools()`, `model_name()`, `config()`

### MCP (Model Context Protocol) Servers

**Protocol:** JSON-RPC 2.0 over stdio to child processes.

**Architecture:**
- `McpClient` (`src-tauri/src/mcp/client.rs`): Spawns child process, manages bidirectional stdio via tokio tasks (writer drains mpsc channel to stdin, reader dispatches responses via oneshot channels)
- `McpManager` (`src-tauri/src/mcp/manager.rs`): Registry of named `McpClient` instances, exposes tool aggregation and LLM tool definition conversion
- Protocol version: `2024-11-05` (`src-tauri/src/mcp/client.rs:161`)

**Auto-start:** On app startup, `.mcp.json` is parsed and all `mcpServers` are registered (`src-tauri/src/lib.rs:41-93`)

**Stitch MCP Integration:**
- Config: `.mcp.json` (project root)
- Server command: `npx @_davideast/stitch-mcp proxy`
- Auth env var: `STITCH_API_KEY` (read from `${STITCH_API_KEY}` in `.mcp.json`)
- Env var template: `.env.example` documents this as required

**Tauri MCP Integration (debug only):**
- `tauri-plugin-mcp-bridge 0.11` enabled only in `#[cfg(debug_assertions)]` builds (`src-tauri/src/lib.rs:33-36`)
- OpenCode IDE integration configured in `opencode.json` via `@hypothesi/tauri-mcp-server`

**MCP Tool Resolution:** Tools prefixed with `server_name:tool_name` format and exposed to LLM as function tools. Execution dispatched to `McpManager::call_tool()` in `src-tauri/src/commands/chat.rs:569-581`.

### Google Fonts (Material Symbols)

**Service:** Google Fonts CDN
**Usage:** `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap`
**Loading:** Dynamically injected via `<link>` in `App.tsx:onMount` (`src/App.tsx:27-29`)
**Scope:** Used throughout UI for iconography (search, settings, send, tool indicators, etc.)

## Data Storage

### Database

**Engine:** SQLite via `tauri-plugin-sql 2` (sqlite feature)

**Connection:** `sqlite:lawyer-desktop.db` (stored in Tauri app data directory)

**Migrations:** Embedded via `include_str!()` in `src-tauri/src/db/mod.rs`
- Migration file: `src-tauri/migrations/001_init.sql`
- Version 1 — initial schema (71 lines)

**Schema tables (`src-tauri/migrations/001_init.sql`):**
| Table | Purpose |
|---|---|
| `conversations` | Chat sessions (id, title, timestamps, settings_json) |
| `messages` | Chat messages per conversation (id, role, content, attachments_json, tool_calls_json) |
| `llm_providers` | Saved LLM provider configs (api_base_url, api_key, model_name, is_active) |
| `registered_skills` | Skill registry (plugin_name, skill_name, path, is_enabled) |
| `feedback` | User feedback entries (message_id, rating, comment) |
| `practice_profiles` | Lawyer practice profile (plugin-specific config) |
| `app_settings` | Key-value app settings |

**ORM:** None — raw SQL via `tauri-plugin-sql` queries (Rust models defined as `#[derive(Serialize, Deserialize)]` structs in `src-tauri/src/db/models.rs`)

**Migration registration:** `src-tauri/src/db/mod.rs` — `.add_migrations("sqlite:lawyer-desktop.db", db::get_migrations())` in Tauri builder

### File Storage

**Approach:** Local filesystem only. No cloud storage.

- File reading: `src-tauri/src/commands/files.rs` — supports `.txt`, `.md`, `.json`, `.csv`, `.xml`, `.html`, `.yaml`, `.toml`, `.log`, `.pdf` (via `pdf-extract`), `.docx` (metadata only, text extraction TBD)
- Directory listing: Recursive scan with `FileInfo` results
- File attachments: Content preview up to 50000 chars, truncated with indicator
- DOCX output: Written to app data directory with timestamped filenames (`{title}_{YYYYMMDD_HHMMSS}.docx`)

### Caching

**None detected.** No Redis, in-memory cache, or disk cache layer.

## Authentication & Identity

**Auth Provider:** None (desktop app, no user authentication)

- No login/signup flow
- No JWT or session management
- No OAuth integration
- LLM provider API keys are entered at runtime via Settings panel UI (`src/components/settings/SettingsPanel.tsx`) and stored in memory (`src/stores/settings.ts`), not persisted to disk

## Monitoring & Observability

**Error Tracking:**
- None — no Sentry, Datadog, or similar integration
- Errors logged to console via `log` crate (Rust) and `console.error` (TypeScript)

**Logs:**
- Rust: `env_logger 0.11` initialized in `src-tauri/src/lib.rs:16` — `env_logger::init()`
- Frontend: Raw `console.log` / `console.error` calls

**Performance Monitoring:** Not detected

## CI/CD & Deployment

**Hosting:**
- Desktop application only (no server deployment)
- Built via `bun run tauri build` producing native Windows installer

**CI Pipeline:**
- Not detected — no GitHub Actions, no CI config files found

## Environment Configuration

**Required env vars:**
- `STITCH_API_KEY` — API key for Stitch MCP integration

**Optional env vars:**
- `QWEN_API_KEY` — Qwen/DashScope API key
- `DEEPSEEK_API_KEY` — DeepSeek API key
- `KIMI_API_KEY` — Kimi/Moonshot API key
- `OPENAI_API_KEY` — OpenAI API key
- `TAURI_DEV_HOST` — Host for remote Tauri dev debugging

**Secrets location:**
- `.env` file at project root (git-ignored)
- `.env.example` documents available variables (committed)

## Webhooks & Callbacks

**Incoming:**
- None — desktop app is not a server, no webhook endpoints

**Outgoing:**
- None — no configured outgoing webhooks

## Built-in Tools (Function Calling)

The LLM has access to these built-in tools (exposed as OpenAI function tools alongside MCP tools):

| Tool Name | Purpose | Implementation |
|---|---|---|
| `read_user_file` | Read local file content (text, PDF, DOCX) | `src-tauri/src/commands/files.rs:17` |
| `list_user_directory` | List directory contents | `src-tauri/src/commands/files.rs:114` |
| `generate_docx` | Generate DOCX legal document | `src-tauri/src/commands/documents.rs:16` + `src-tauri/src/documents/docx_gen.rs` |
| `select_skill` | Activate a legal skill | `src-tauri/src/commands/chat.rs:534` + `src-tauri/src/skills/router.rs` |

Tool definitions built in: `src-tauri/src/skills/router.rs:40-129`

## Skills System

**Data source:** External directory with `SKILL.md` files (path configured at runtime via Settings panel)

**Directory structure conventions:**
- `<plugin-name>/skills/<skill-name>/SKILL.md` — standard layout
- `shared/<skill-name>/SKILL.md` — shared skills layout
- Supports hierarchical sub-skills: `plugin:skill:sub-skill` naming

**Key files:**
- `src-tauri/src/skills/loader.rs` — Directory scanning, YAML frontmatter parsing, content hashing (SHA-256)
- `src-tauri/src/skills/router.rs` — System prompt construction, tool definition builder
- `src-tauri/src/skills/mod.rs` — `SkillRegistry` managing skills_root, per-conversation active skill, config persistence

## DOCX Document Generation

**Library:** `docx-rs 0.4` (`src-tauri/Cargo.toml`)

**Implementation:** `src-tauri/src/documents/docx_gen.rs`
- Converts markdown to DOCX paragraphs (headings, bullet lists, paragraphs)
- Adds disclaimer header in Chinese
- Strips basic markdown formatting (`**`, `*`, `_`)
- Supports templates enum: `memo`, `lawyer_letter`, `legal_opinion`, `contract_review`
- Output via `docx_rs::Docx::build()` → `pack()` to in-memory buffer → `std::fs::write()`

---

*Integration audit: 2026-06-10*
