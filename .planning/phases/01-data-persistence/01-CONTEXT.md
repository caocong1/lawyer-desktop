# Phase 1: 数据持久化 - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire SQLite persistence for conversations, messages, and provider configurations so they survive app restarts. This is a brownfield brownfield wiring task — the schema (`001_init.sql`) and models (`models.rs`) already exist; the work is creating CRUD operations, wiring them into Tauri commands, and updating frontend stores to hydrate from DB on startup.

**In scope:**
- Conversation CRUD (create, list, delete, get by ID)
- Message persistence (save on stream complete, load per conversation)
- Provider config persistence (save on setup, restore on startup)
- Auto-generate conversation titles from first message
- Auto-restore last active conversation
- Startup bootstrap flow (load conversations, restore provider)
- Loading state UX during DB hydration

**Out of scope:**
- UI redesign (sidebar stays as-is, just wired to real data)
- Title editing by user (future phase)
- Multi-provider management UI (history tracked but no UI)
- API key encryption (Phase 4)
- Document persistence (Phase 3)

</domain>

<decisions>
## Implementation Decisions

### Database Access Architecture
- DB operations live in **backend Tauri commands** (Rust) — type-safe, single source of truth, frontend stays thin
- Separate **`src-tauri/src/db/queries.rs`** module with typed functions wrapping raw SQL, called from commands
- Use **`State<'_, tauri_plugin_sql::Db>`** parameter on each command — idiomatic Tauri pattern with DB access via `.execute()` and `.select()`
- Message persistence: **save on stream complete** — one INSERT per complete message after streaming finishes, not per-chunk

### Startup Bootstrapping & Session Lifecycle
- Load **all conversations list on app start** into sidebar, **lazy-load messages** per conversation when user opens it — sidebar appears immediately, messages load on demand
- Trigger data loading in **`App.tsx` onMount** — call `loadConversations()` and `restoreProvider()` before first render
- **Auto-restore last active conversation** — save active conversation ID to `app_settings` table on switch, restore on startup and navigate to it
- Brief **"加载中..." toast/overlay** while DB queries run on startup — simple indicator, not a full splash screen

### Conversation Title Generation
- Title = **first ~20 characters of first message** — simple, fast, deterministic, no extra LLM call needed
- Trigger title generation **immediately when first message is saved** to DB — title appears in sidebar as soon as message persists
- **No user editing in Phase 1** — auto-generated only; title editing deferred as future scope
- Placeholder for pre-message conversations: **"新会话"** — matches existing UI convention

### Provider Configuration Persistence
- Save provider config **on every `setup_provider` call** — immediately persist when user clicks "保存配置" in Settings panel
- **Single active row pattern** — `llm_providers` table stores history, but only one row has `is_active=true`. Old configs remain for audit trail.
- If no provider configured on startup: **auto-show Settings panel** — navigate user to settings to configure before using the app
- Provider switching: **deactivate old row + insert new row** — `UPDATE is_active=false` for old provider, `INSERT` new with `is_active=true`, update `LlmEngine` in same flow

### the agent's Discretion
- Exact column types and SQL queries are at the agent's discretion based on existing schema
- Error messages shown to user should be in Chinese (existing convention)
- Exact loading UX (toast vs overlay) is at the agent's discretion

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/db/models.rs` — 7 Rust structs (Conversation, Message, LlmProvider, etc.) with Serialize/Deserialize derives, matching SQL schema exactly
- `src-tauri/migrations/001_init.sql` — full schema with 7 tables already created and embedded in `lib.rs` via `include_str!`
- `src-tauri/src/commands/chat.rs` — `create_conversation` and `send_message` already exist, just need DB wiring
- `src-tauri/src/commands/settings.rs` — `setup_provider` exists, needs DB save
- `src/stores/conversation.ts` — module-level `createSignal` with `useConversation()` hook; just needs `loadConversations()` and `loadMessages(id)` actions
- `src/stores/settings.ts` — `useSettings()` hook with `isConfigured`, `activeProvider` signals; needs `restoreProvider()` action
- `src/services/api.ts` — central `invoke()` wrapper; needs new DB-backed command wrappers added

### Established Patterns
- Tauri commands: `pub async fn name(...) -> Result<T, String>` with `State<'_, T>` injection
- Error propagation: `anyhow::Result` internally → `.map_err(|e| e.to_string())` at command boundary
- Frontend stores: module-level `createSignal`, export `useX()` function returning signals + action functions
- All signals MUST be called with `()` — `messages()` not `messages`
- CSS: custom properties with `data-theme` attribute, no component rewrites needed
- Error UX: Chinese strings via `props.onToast()` for transient notifications

### Integration Points
- `src-tauri/src/lib.rs` — must register new commands in `generate_handler![]` macro and pass DB state
- `src/App.tsx` — onMount must trigger `loadConversations()` and `restoreProvider()` calls
- `src-tauri/src/llm/mod.rs` — `LlmEngine` holds provider in-memory; must integrate DB save/load with existing `set_provider()` flow
- `src-tauri/src/commands/chat.rs::send_message` — after stream completes, must save message to DB before emitting done event
- `src/stores/conversation.ts` — sidebar must call new `get_conversations` API on init, messages must lazy-load when conversation opens

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches based on codebase conventions.

</specifics>

<deferred>
## Deferred Ideas

- User-editable conversation titles (future enhancement)
- Multi-provider management UI (history tracked in DB but no management interface in Phase 1)
- Document persistence (Phase 3 scope)
- API key encryption at rest (Phase 4 scope)
- MCP server state persistence

</deferred>
