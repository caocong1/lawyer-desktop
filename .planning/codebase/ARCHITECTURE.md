# Architecture

**Analysis Date:** 2026-06-10

## Pattern Overview

**Overall:** Tauri 2 desktop app — SolidJS frontend (TypeScript) + Rust backend, communicating via IPC (`invoke`/`emit`).

**Key Characteristics:**
- **Frontend-driven IPC**: Frontend calls `invoke("command_name", { args })` to trigger Rust commands; Rust emits events via `app.emit("event-name", payload)` for streaming data back
- **Module-level signals**: All state is module-level `createSignal` exported via `useX()` hook functions (no `createStore`, no context providers)
- **Manual screen routing**: No router library — `App.tsx` uses a `createSignal<"home" | "workspace">` for screen switching via `<Show>`
- **CSS custom properties theming**: Three themes (a, b, c) swapped via `data-theme` attribute on `<html>`, defined in `molv-tokens.css`
- **Plugin-based Tauri setup**: 6+ Tauri plugins registered in `lib.rs` (sql, dialog, fs, shell, opener, mcp-bridge)
- **Multi-turn tool loop**: Chat supports up to 10 rounds of LLM tool calls (file read, doc gen, skill select, MCP tools) within a single `send_message` command

## Layers

**Frontend — Component Layer:**
- Purpose: UI rendering and user interaction
- Location: `src/components/{home,layout,settings,workspace}/`
- Contains: SolidJS components (`.tsx` + co-located `.css`)
- Depends on: Stores (`src/stores/`), Services (`src/services/`), Data (`src/data/`)
- Used by: `src/App.tsx`

**Frontend — Store Layer:**
- Purpose: Application state management
- Location: `src/stores/{conversation,settings,theme}.ts`
- Contains: Module-level `createSignal` calls, `useX()` hook functions returning { signal, actions }
- Depends on: Nothing (pure SolidJS signals)
- Used by: All components via `useX()` imports

**Frontend — Service Layer:**
- Purpose: Tauri IPC bridge — wraps `invoke()` and `listen()` calls
- Location: `src/services/api.ts`
- Contains: Typed async functions for all Tauri commands, event listener setup (`onChatStream`)
- Depends on: `@tauri-apps/api/core` (invoke), `@tauri-apps/api/event` (listen)
- Used by: Components directly (ChatPanel, SettingsPanel, Workspace)

**Backend — Command Layer:**
- Purpose: Tauri command handlers exposed to frontend via `#[tauri::command]`
- Location: `src-tauri/src/commands/{chat,settings,files,documents,feedback}.rs`
- Contains: Public async functions with `State<'_, T>` injection
- Depends on: LLM engine, SkillRegistry, McpManager, DB models
- Used by: Registered in `lib.rs` `generate_handler![]` macro

**Backend — LLM Engine Layer:**
- Purpose: Provider abstraction and LLM chat execution
- Location: `src-tauri/src/llm/{mod,provider,openai_compat,types}.rs`
- Contains: `LlmEngine` (state holder), `LlmProvider` trait, `OpenAiCompatProvider` impl, shared types (`ChatMessage`, `ChatRequest`, `ToolCall`, etc.)
- Depends on: `reqwest` for HTTP, `futures` for stream handling
- Used by: `commands::chat::send_message`

**Backend — Skills Layer:**
- Purpose: Load, cache, and route SKILL.md files from external directories
- Location: `src-tauri/src/skills/{mod,loader,router}.rs`
- Contains: `SkillRegistry` (state), `scan_skills_dir()` (filesystem scanner), `build_system_prompt()` (prompt injection), `build_tool_definitions()` (built-in tool definitions)
- Depends on: `serde_yaml` for frontmatter parsing, `sha2` for content hashing
- Used by: `commands::chat::send_message`, `commands::settings`

**Backend — MCP Layer:**
- Purpose: Model Context Protocol client — JSON-RPC over stdio to external servers
- Location: `src-tauri/src/mcp/{mod,client,manager,types}.rs`
- Contains: `McpClient` (spawns writer/reader tasks), `McpManager` (manages multiple servers), types (`JsonRpcRequest`, `McpTool`, `McpServerConfig`)
- Depends on: `tokio::process` for child process management, oneshot channels for response dispatch
- Used by: `commands::chat::send_message` (tool execution), `lib.rs` setup (auto-start from `.mcp.json`)

**Backend — Database Layer:**
- Purpose: SQLite schema and data models
- Location: `src-tauri/src/db/{mod,models}.rs`, `src-tauri/migrations/001_init.sql`
- Contains: Migration definitions via `tauri_plugin_sql::Migration`, `Serialize`/`Deserialize` model structs
- Depends on: `tauri-plugin-sql` (SQLite)
- Used by: Commands (indirectly via the SQL plugin — DB operations are handled on frontend side)

**Backend — Document Generation Layer:**
- Purpose: Convert markdown to DOCX
- Location: `src-tauri/src/documents/{mod,docx_gen}.rs`
- Contains: `generate_docx()` function using `docx-rs` crate
- Depends on: `docx-rs` 0.4
- Used by: `commands::documents::generate_docx`

## Data Flow

**Chat Message Flow:**

1. **User input**: `ChatPanel.tsx` → `handleSend()` → `startStreaming()` → `sendMessage({ conversation_id, content })`
2. **IPC invoke**: `src/services/api.ts` → `invoke("send_message", { req })`
3. **Rust command**: `src-tauri/src/commands/chat.rs::send_message()`:
   - Gets active provider from `LlmEngine`
   - Loads all skills from `SkillRegistry`, resolves active skill for conversation
   - Builds system prompt via `router::build_system_prompt()`
   - Gets built-in tool defs + MCP tool defs
   - Constructs message history (system + user)
   - Enters multi-turn loop (max 10 rounds):
     a. Sends `ChatRequest` with `stream: true` to LLM provider
     b. `process_stream_round()`: reads SSE chunks, forwards `"chat-stream"` events with text fragments to frontend, accumulates tool_calls
     c. If finish_reason is "tool_calls": appends assistant message to history, executes each tool (file read, directory list, docx gen, skill select, or MCP tool), appends tool results as messages, loops
     d. Otherwise: emits final `done: true` event, breaks
4. **Streaming back**: `commands/chat.rs` emits `"chat-stream"` Tauri events with `StreamChunk { conversation_id, message_id, chunk, done }`
5. **Frontend listener**: `src/services/api.ts::onChatStream()` → `listen("chat-stream", callback)`
6. **State update**: `ChatPanel.tsx` `onMount` sets up listener → calls `appendStreamChunk()` or `finishStreaming()` on the conversation store
7. **Render**: `streamingContent()` signal renders via `<SolidMarkdown>` component

**Settings — Provider Setup Flow:**
1. `SettingsPanel.tsx` → calls `setupProvider({ name, display_name, api_base_url, api_key, model_name })`
2. `src/services/api.ts` → `invoke("setup_provider", { req })`
3. `src-tauri/src/commands/settings.rs::setup_provider()`:
   - Creates `ProviderConfig` from request
   - Calls `engine.set_provider(config)` on `LlmEngine`
   - `LlmEngine::set_provider()` wraps config in `OpenAiCompatProvider`, stores as `Arc<dyn LlmProvider>`

**MCP Server Auto-Start Flow:**
1. `lib.rs` setup hook reads `.mcp.json` from app resource directory
2. For each entry in `mcpServers`: creates `McpServerConfig`, calls `mcp_mgr.register(config)`
3. `McpManager::register()` spawns child process, sets up writer/reader background tasks, performs MCP initialize handshake, caches tool list
4. Tool definitions available to LLM as `server_name:tool_name` format

**Document Export Flow:**
1. `Workspace.tsx` → `handleExport()` → `save()` dialog → `generateDocx({ title, content_markdown, output_path })`
2. `invoke("generate_docx", { req })` → Rust `generate_docx()` in `commands/documents.rs`
3. `docx_gen.rs` parses markdown line-by-line, builds `Docx` via `docx-rs`, writes to file

**State Management:**
- All state uses module-level `createSignal` (not `createStore`), returned as getter functions that **must** be called with `()`
- Three store modules:
  - `src/stores/conversation.ts`: conversations list, active conversation, messages, streaming state
  - `src/stores/settings.ts`: provider config, isConfigured, skillsRoot
  - `src/stores/theme.ts`: current theme (a/b/c), persisted to localStorage
- No context providers, no reactive router — state is imported directly via `useX()` in components

## Key Abstractions

**LlmProvider trait** (`src-tauri/src/llm/provider.rs`):
```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse>;
    async fn chat_stream(&self, request: &ChatRequest) -> Result<ChatStream>;
    fn supports_tools(&self) -> bool;
    fn model_name(&self) -> &str;
    fn config(&self) -> &ProviderConfig;
}
```
- Purpose: Abstract over different LLM API providers
- Implementations: `OpenAiCompatProvider` (`src-tauri/src/llm/openai_compat.rs`) — single implementation that works with any OpenAI-compatible API (Qwen, DeepSeek, Kimi, OpenAI, Ollama)

**LlmEngine** (`src-tauri/src/llm/mod.rs`):
- Holds `Arc<RwLock<Option<Arc<dyn LlmProvider>>>>` as managed Tauri state
- `set_provider()` replaces the active provider
- `get_provider()` clones the Arc or returns error if none configured

**SkillRegistry** (`src-tauri/src/skills/mod.rs`):
- Cloneable wrapper around `Arc<SkillRegistryInner>` (managed Tauri state)
- Stores: loaded skills, skills root path, per-conversation active skills, config file path
- `init_config()` called from setup hook to load persisted config
- `scan_skills_dir()` scans `plugins/<name>/skills/` or `shared/<name>/SKILL.md` structure
- Skills have YAML frontmatter (name, description, version, tags, dependencies)
- Content hashed with SHA-256 for change detection

**McpManager** (`src-tauri/src/mcp/manager.rs`):
- Holds `Arc<RwLock<HashMap<String, Arc<McpClient>>>>`
- `register()` spawns MCP server process, performs initialize handshake, caches tools
- `get_all_tool_definitions()` returns tools in LLM `ToolDefinition` format (prefixed as `server:tool`)

**McpClient** (`src-tauri/src/mcp/client.rs`):
- JSON-RPC 2.0 over stdio to child process
- Writer task: drains `mpsc::UnboundedReceiver<String>` → child stdin
- Reader task: reads child stdout line-by-line → dispatches responses via `oneshot` channels
- `send_request()` is fully async-multiplexable via request-id matching
- Handles: initialize, tools/list, tools/call

**Store Pattern** (`src/stores/*.ts`):
```typescript
// Module-level signals
const [conversations, setConversations] = createSignal<Conversation[]>([]);
// Hook function returns { signal getters, action functions }
export function useConversation() {
  return { conversations, addConversation, ... };
}
```
- Purpose: Simple, direct state access without context providers
- Convention: Always call signals with `()` — `messages()` not `messages`

## Entry Points

**Frontend Entry:**
- Location: `src/index.tsx`
- Triggers: SolidJS `render()` on DOMContentLoaded
- Responsibilities: Mounts `<App />` to `#root`

**Backend Binary Entry:**
- Location: `src-tauri/src/main.rs`
- Responsibilities: Calls `lawyer_desktop_lib::run()`

**Backend App Entry:**
- Location: `src-tauri/src/lib.rs` → `pub fn run()`
- Triggers: Tauri app lifecycle (startup via `tauri::Builder`)
- Responsibilities:
  - Initialize `env_logger`
  - Register Tauri plugins: opener, shell, fs, dialog, sql (with migrations), mcp-bridge (debug only)
  - Create managed state: `LlmEngine`, `SkillRegistry`, `McpManager`
  - Setup hook: load persisted config, auto-start MCP servers from `.mcp.json`
  - Register 15 commands in `invoke_handler(generate_handler![...])`
  - Launch app window via `tauri::generate_context!()`

## Error Handling

**Strategy:** Commands return `Result<T, String>` (Rust) → frontend catches in try/catch

**Patterns:**
- **Backend**: All errors propagate via `anyhow::Result` → `.map_err(|e| e.to_string())` at command boundary → `String` error to frontend
- **Frontend**: Try/catch around all `invoke()` calls in `ChatPanel.tsx`; errors shown as assistant messages with "⚠️ 错误:" prefix
- **Stream errors**: In `chat.rs` multi-turn loop, per-round errors emit `"[Error: {}]"` text via `"chat-stream"` event with `done: true`
- **Toast system**: `App.tsx` `showToast()` function passed via props for transient notifications

## Cross-Cutting Concerns

**Logging:**
- Rust: `env_logger` + `log` crate — `log::info!()`, `log::error!()`, `log::warn!()`, `log::debug!()`
- Frontend: `console.log()` / `console.error()`

**Validation:**
- Minimal — tool call argument validation in `chat.rs::execute_tool()` checks for required JSON fields
- No Zod/validation library on frontend

**Authentication:**
- None built-in. API keys passed through to LLM provider requests via `Authorization: Bearer` header in `OpenAiCompatProvider`.
- MCP server env vars configured in `.mcp.json`

**Theming:**
- CSS custom properties with `data-theme` attribute on `<html>`
- Three themes (a=warm parchment, b=dark cyber, c=clean white)
- Persisted to `localStorage` key `"molv-theme"`
- Fonts loaded from Google Fonts: Noto Serif SC, Noto Sans SC, Newsreader, Spline Sans Mono

---

*Architecture analysis: 2026-06-10*
