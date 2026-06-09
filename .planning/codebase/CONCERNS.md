# Codebase Concerns

**Analysis Date:** 2026-06-10

## Tech Debt

### Single Mega-Commit (No Incremental History)
- **Issue:** The entire feature implementation was committed in one shot (`4f880c2` — "feat: implement lawyer assistant desktop app with chat, LLM, and document generation") with the prior commit being only Tauri + SolidJS scaffolding (`778f167`). There is no incremental commit history showing how features evolved.
- **Impact:** Impossible to `git bisect` or `git blame` to find when specific bugs were introduced. Code review of the 9000+ line diff is impractical. Rollback of individual features is not possible.
- **Fix approach:** Future work must use atomic commits per feature/task. Consider using GSD workflow with phases and incremental commits.

### No Test Suite
- **Issue:** Zero test files exist — no `*.test.ts`, `*.spec.ts`, or Rust tests (`#[test]`). `package.json` has no test runner configured; `Cargo.toml` has no test dependencies.
- **Files:** Entire codebase
- **Impact:** No regression safety. All verification is manual. Refactoring is high-risk. The LLM provider abstraction (`src-tauri/src/llm/provider.rs`), streaming logic (`src-tauri/src/commands/chat.rs`), and MCP client (`src-tauri/src/mcp/client.rs`) are critical paths with zero test coverage.
- **Fix approach:** Add Vitest for TypeScript, `#[cfg(test)]` modules in Rust. Prioritize tests for `llm/openai_compat.rs`, `commands/chat.rs`, `skills/loader.rs`.

### No Linting or Formatting Config
- **Issue:** No `.eslintrc`, `.prettierrc`, `biome.json`, or any linter configuration. `tsconfig.json` has `strict: true` but no enforcements run in CI or as a pre-commit hook.
- **Impact:** Code style is inconsistent. There's no automated enforcement of TypeScript strictness. Potential dead code, unused imports, or type errors could exist silently (only caught when running `bunx tsc --noEmit` manually).
- **Fix approach:** Add ESLint (or Biome) with SolidJS-specific rules and Prettier. Configure pre-commit hooks.

### Mock Data Pervasive in Frontend
- **Issue:** The entire home page (`src/components/home/HomePage.tsx`) and workspace document preview (`src/components/workspace/Workspace.tsx`) are fully driven by hardcoded mock data from `src/data/mockData.ts` and `src/data/docData.ts`. The `Workspace` component uses `MOCK_DOC` directly — there is no loading state or real API fetch for document data. The `CitationPanel` displays `MOCK_CITATIONS` with hardcoded references.
- **Files:** `src/data/mockData.ts`, `src/data/docData.ts`, `src/components/home/HomePage.tsx`, `src/components/workspace/Workspace.tsx`, `src/components/workspace/CitationPanel.tsx`, `src/components/workspace/DocPreview.tsx`
- **Impact:** The app is a demo-only presentation. Real document drafting, citation retrieval, and project history features are not implemented. Users cannot create real documents from the UI.
- **Fix approach:** Replace mock data with API-driven flows. The Rust backend's `generate_docx` command exists but the frontend still uses hardcoded `MOCK_DOC` content.

### Conversation Not Persisted to Database
- **Issue:** The `create_conversation` command (`src-tauri/src/commands/chat.rs` lines 594-603) creates a `Conversation` object entirely in memory with `Uuid::new_v4()` and returns it directly — there is no database `INSERT`. The system prompt is rebuilt each time. The database schema (`migrations/001_init.sql`) defines `conversations`, `messages`, and `llm_providers` tables, but **the backend never writes to them**.
- **Files:** `src-tauri/src/commands/chat.rs`, `src-tauri/src/db/mod.rs`, `src-tauri/migrations/001_init.sql`
- **Impact:** Conversations are ephemeral. Restarting the app loses all chat history. Provider configurations must be re-entered on every launch. The entire SQLite database infrastructure is present but unused for persistence.
- **Fix approach:** Wire `create_conversation`, `send_message`, and `setup_provider` to perform actual SQLite writes using `tauri-plugin-sql`.

### `test_provider` Creates Ephemeral Provider, Ignores Active Engine
- **Issue:** `test_provider` (`src-tauri/src/commands/settings.rs` lines 43-84) creates a new `OpenAiCompatProvider` directly instead of using the `LlmEngine`'s active provider. It constructs its own `ProviderConfig` with `id: "test"` and ignores the engine state entirely.
- **Impact:** The "Test Connection" feature tests a throwaway provider, not the one that will actually be used for chat. If the engine's provider fails silently during chat, the test won't catch it.
- **Fix approach:** Have `test_provider` temporarily set the provider on the engine, send one message, then rollback, or at minimum share the same reqwest `Client` lifecycle.

### Skills Router Uses String Comparison Without Caching
- **Issue:** `route_skill` (`src-tauri/src/skills/router.rs` line 131) performs a linear scan `skills.iter().find(|s| s.name == skill_name)` every call. `build_system_prompt` (line 17) reconstructs the entire prompt string on every message round, including iterating all skills.
- **Files:** `src-tauri/src/skills/router.rs`, `src-tauri/src/commands/chat.rs` (line 87-88)
- **Impact:** With many skills, the system prompt grows unboundedly. The active skill's full `SKILL.md` content is injected into every LLM request. This increases token usage and latency on every turn.
- **Fix approach:** Cache the built system prompt and only rebuild when skills change. Limit injected skill content to a summary or excerpt.

## Known Bugs

### `removeConversation` Accesses Stale Signal
- **Symptoms:** In `src/stores/conversation.ts` line 43, `removeConversation` reads `conversations()` after calling `setConversations` on line 37, but SolidJS signals are synchronous for reads — the closure `remaining = conversations().filter(...)` is computed from the **updated** value since `setConversations` completed synchronously. However, the `setActiveConversationId` fallback on line 44 references `remaining[0].id` but `remaining` is derived from `conversations()` which is the **new** value. If the active conversation is removed and others remain, this works, but the logic is fragile.
- **Files:** `src/stores/conversation.ts` (lines 40-46)
- **Trigger:** Deleting a conversation that is currently active when other conversations exist.
- **Workaround:** Not reported — may cause `setActiveConversationId(null)` incorrectly.

### DOCX Text Extraction Stubbed
- **Symptoms:** `src-tauri/src/commands/files.rs` line 60: `"DOCX 文本提取功能待实现"` — DOCX file content always returns a stub message saying extraction is not yet implemented.
- **Files:** `src-tauri/src/commands/files.rs`
- **Trigger:** Attaching a `.docx` file to a conversation.
- **Impact:** Users cannot get AI analysis of uploaded DOCX documents — a critical feature for a legal document assistant.

### MCP Health Check Always Returns `true`
- **Symptoms:** `src-tauri/src/mcp/manager.rs` line 113: `health.insert(name.clone(), true);` — the health check always assumes the MCP server is healthy if the client object exists. There is no actual connectivity probe.
- **Files:** `src-tauri/src/mcp/manager.rs`
- **Trigger:** Any use of `check_health()`.
- **Impact:** A crashed MCP server appears healthy until a tool call fails at runtime.

### System Prompt Replaced Mid-Stream Without Proper Isolation
- **Symptoms:** In `src-tauri/src/commands/chat.rs` lines 213-218, after every tool round, the system message in `messages[0]` is replaced with the updated system prompt. If `select_skill` was called during the round, the system prompt changes, but the original system message content is lost for previous rounds.
- **Trigger:** Multi-turn tool usage where skill changes mid-conversation.
- **Impact:** The model loses original context. History rewriting can cause inconsistent model behavior.

## Security Considerations

### API Keys in Memory and Insecure Persistence
- **Risk:** LLM provider API keys (`src-tauri/src/llm/types.rs` line 84: `pub api_key: Option<String>`) are held in Rust memory as plain strings. When `setup_provider` is called, the key is passed through the Tauri IPC bridge as a Tauri command argument. The key is never encrypted at rest — the database schema stores `api_key TEXT` in `llm_providers` (`src-tauri/migrations/001_init.sql` line 29), but no database writes currently happen. When they do, keys will be stored in plaintext in `lawyer-desktop.db`.
- **Files:** `src-tauri/src/llm/types.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/db/models.rs`, `src-tauri/migrations/001_init.sql`
- **Current mitigation:** The SettingsPanel uses `type="password"` input field for the API key (`SettingsPanel.tsx` line 168). The `.env` file is gitignored.
- **Recommendations:** Use OS keychain (via `tauri-plugin-credential` or similar) for API key storage. Never persist keys in SQLite without encryption. Consider key masking in logs.

### API Key Leaked via `.env` in Repo (Accidental)
- **Risk:** The `.env` file was read during analysis and contains a live `STITCH_API_KEY`. Although `.env` is in `.gitignore`, the file was not properly excluded from the session's read context. The key value existed in the workspace file system.
- **Files:** `.env` (gitignored, but present on disk)
- **Current mitigation:** `.gitignore` excludes `.env`. The `STITCH_API_KEY` is used by `.mcp.json` via `npx @_davideast/stitch-mcp proxy`.
- **Recommendations:** Rotate the current key immediately. Educate on secure handling.

### No Path Sanitization in File Commands
- **Risk:** `read_file_content` (`src-tauri/src/commands/files.rs` line 17) and `list_directory` (line 114) accept arbitrary paths as Tauri command arguments. While Tauri 2's `fs` plugin permissions can restrict access, the custom Rust commands have no path allowlist or sandboxing. An LLM tool call (via `read_user_file` or `list_user_directory` in chat) could read any file the user process has access to.
- **Files:** `src-tauri/src/commands/files.rs`, `src-tauri/src/commands/chat.rs` (lines 444-476)
- **Current mitigation:** Only basic existence checks (`if !file_path.exists()`) and file type filtering for binary files.
- **Recommendations:** Implement a path allowlist or sandbox to `Documents`, `Desktop`, and explicit user-configured directories. Restrict access to system directories and application internals.

### MCP Server Environment Variables Exposed
- **Risk:** In `src-tauri/src/lib.rs` lines 67-73, environment variables from `.mcp.json` are parsed and passed to spawned child processes as plain strings. The `STITCH_API_KEY` environment variable is passed to `npx @_davideast/stitch-mcp proxy`.
- **Files:** `src-tauri/src/lib.rs` (lines 47-92), `.mcp.json`
- **Current mitigation:** MCP bridge is only enabled in debug builds (`#[cfg(debug_assertions)]`).
- **Recommendations:** Validate that MCP env vars are never logged or exposed in error messages. Consider a credential manager for MCP env secrets.

### CSP Disabled
- **Risk:** `tauri.conf.json` line 26: `"csp": null` — Content Security Policy is completely disabled. This means the Tauri webview has no protection against XSS or data injection attacks.
- **Files:** `src-tauri/tauri.conf.json`
- **Current mitigation:** None.
- **Recommendations:** Implement a strict CSP that allows only the necessary origins (Google Fonts, LLM provider API endpoints).

### `shell:default` Permission Granted
- **Risk:** `capabilities/default.json` line 11 includes `"shell:default"` — this grants the Tauri webview permission to execute arbitrary shell commands. Combined with CSP being null, this is a significant privilege escalation risk if the webview is compromised.
- **Files:** `src-tauri/capabilities/default.json`
- **Current mitigation:** The shell plugin's permission can be refined, but currently uses the broad `default`.
- **Recommendations:** Restrict shell permissions to specific commands or remove if not needed by the frontend.

## Performance Bottlenecks

### Full Conversation History Sent on Every Tool Round
- **Problem:** In `src-tauri/src/commands/chat.rs`, the multi-turn tool loop (lines 127-249) sends the entire `messages` history (including tool results, system prompt, and all prior exchanges) to the LLM on every round. With `MAX_TOOL_ROUNDS = 10`, each round doubles the conversation size. Large tool results (file contents, directory listings) are included verbatim.
- **Files:** `src-tauri/src/commands/chat.rs`
- **Cause:** The loop accumulates messages but never truncates or summarizes. Tool results can include large file contents.
- **Improvement path:** Implement conversation windowing (token budget), summarize or compress tool results, reduce MAX_TOOL_ROUNDS.

### Streaming Accumulates All Content in Memory
- **Problem:** `process_stream_round` (`src-tauri/src/commands/chat.rs` line 260) accumulates the entire `content: String` for each streaming round. The `content` variable grows with each SSE chunk. For long responses (e.g., drafting a full legal document), this is an unbounded memory allocation.
- **Files:** `src-tauri/src/commands/chat.rs`
- **Cause:** Content is collected as a flat `String` for the entire round, even though chunks are emitted to the frontend incrementally.
- **Improvement path:** Stream directly to the event bus without full-round buffering, or use a bounded buffer.

### Skills Loaded Fully Into Memory
- **Problem:** `SkillMetadata` includes `full_content: String` — the entire `SKILL.md` file content. The active skill's full content is injected into every system prompt. With dozens of skills, all content is resident in memory.
- **Files:** `src-tauri/src/skills/loader.rs` (line 16), `src-tauri/src/commands/chat.rs` (line 87-88)
- **Cause:** No lazy loading or content trimming. Every skill's full markdown is loaded and held.
- **Improvement path:** Load only metadata (name, description) eagerly. Load `full_content` on demand when a skill is activated. Truncate or summarize injected content.

### No Request Deduplication or Rate Limiting
- **Problem:** The `reqwest::Client` (`src-tauri/src/llm/openai_compat.rs` line 13) has no timeout configuration, no connection pooling tuning, and no retry logic. Network errors result in immediate failure messages to the user.
- **Files:** `src-tauri/src/llm/openai_compat.rs`
- **Cause:** `Client::new()` uses defaults. No retry, no timeout, no circuit breaker.
- **Improvement path:** Configure `Client::builder().timeout(...).connect_timeout(...)`. Add retry with exponential backoff for transient errors.

## Fragile Areas

### `src-tauri/src/commands/chat.rs` (616 lines) — Monolithic Command
- **Files:** `src-tauri/src/commands/chat.rs`
- **Why fragile:** This single file handles streaming, tool execution (file reading, directory listing, DOCX generation, MCP calls, skill routing), multi-turn orchestration, and event emission. It's the largest file in the project at 616 lines. Any change to tool handling, streaming, or conversation flow risks breaking other functionality. The deeply nested match/if/loop logic has high cyclomatic complexity.
- **Safe modification:** Add tests first. Extract tool execution to a separate module. Split streaming accumulation from orchestration. Use an enum for tool dispatch instead of string matching.
- **Test coverage:** Zero.

### MCP Client Process Management
- **Files:** `src-tauri/src/mcp/client.rs`
- **Why fragile:** The MCP client spawns a child process and manages stdin/stdout via two background tokio tasks. If the child process crashes, the reader task detects closed stdout and exits, but there is no auto-restart. The pending oneshot channels are never cleaned up, potentially causing memory leaks. The `stop()` method drops the writer channel but does not gracefully terminate the child (uses `child.kill()`).
- **Safe modification:** Always test with a real MCP server process. Ensure `stop()` is called in Drop. Add health check pings. Consider process supervision.
- **Test coverage:** Zero.

### Skill Registry Config Path Race
- **Files:** `src-tauri/src/skills/mod.rs`
- **Why fragile:** `init_config` (line 50) is called from Tauri's `setup` hook as a spawned async task. The `persist_config` (line 147) writes to disk on a background task. If `set_skills_root` is called before `init_config` completes, `config_path` is `None` and `persist_config` returns silently without persisting (line 151: `return Ok(())`). The user's skills_root setting would be lost on restart.
- **Safe modification:** Synchronize `init_config` and `set_skills_root` with a startup barrier or initialization flag.
- **Test coverage:** Zero.

### Hardcoded CSS and Theme Assets
- **Files:** `src/themes/molv-tokens.css`, `src/themes/molv-base.css`, `src/App.css`, all component `.css` files
- **Why fragile:** All styling is done via hardcoded CSS files with no CSS-in-JS or design token system. Theme variations are handled by `data-theme` attribute switching (`src/stores/theme.ts`) but only one theme (`"a"`) is actually applied on mount (`src/App.tsx` line 24: `setTheme("a")`). The other theme values (`"b"`, `"c"`) are defined in the theme store but may not have corresponding CSS.
- **Safe modification:** Verify `data-theme="b"` and `data-theme="c"` produce valid visual states before exposing theme switching.
- **Test coverage:** Zero.

### `onChatStream` Listener Leak
- **Files:** `src/components/workspace/ChatPanel.tsx` (line 39)
- **Why fragile:** `onChatStream` is called at module scope (not inside `onMount` or `createEffect`). It registers a Tauri event listener and returns an unsubscribe function, but the unsubscribe function is never called. If the component mounts/unmounts multiple times, multiple listeners accumulate.
- **Safe modification:** Call `onChatStream` inside `onMount` and store the cleanup function, calling it in `onCleanup`.
- **Test coverage:** Zero.

### Citation Map Hardcoded
- **Files:** `src/components/workspace/Workspace.tsx` (line 37)
- **Why fragile:** The `handleLocateCite` function uses a hardcoded `Record<string, string>` mapping citation keys to article IDs. This is tightly coupled to `MOCK_DOC`'s structure and would break with any real data.
- **Safe modification:** Make citation-to-article mapping data-driven from `DocData` or the backend.
- **Test coverage:** Zero.

## Missing Critical Features

### No Conversation Persistence
- **Problem:** Conversations are ephemeral in-memory objects. The database schema supports persistence but the backend never writes to it. Application restart loses all conversations, messages, and provider settings.
- **Files:** `src-tauri/src/commands/chat.rs`, `src-tauri/src/db/mod.rs`
- **Blocks:** Real-world usability. Users expect their chat history and provider configuration to persist between sessions.

### No Environment Validation on Startup
- **Problem:** There is no `--validate` or startup check that required env vars are set. The app silently starts without `STITCH_API_KEY`, and MCP server registration will fail silently (the `if let Err(e)` in `lib.rs` line 82 only prints to stderr).
- **Files:** `src-tauri/src/lib.rs`, `.env.example`
- **Blocks:** Debugging startup failures. Users may not realize MCP integration is broken.

### No Production Build Configuration
- **Problem:** No `.env.production`, no build optimization configuration for Vite beyond defaults, no code signing configuration in `tauri.conf.json`.
- **Files:** `vite.config.ts`, `src-tauri/tauri.conf.json`
- **Blocks:** Distribution readiness.

## Dependencies at Risk

### `docx-rs = "0.4"` — Unmaintained
- **Risk:** `docx-rs` version 0.4 has infrequent updates and limited feature support. The current DOCX generation (`src-tauri/src/documents/docx_gen.rs`) is a rough markdown-to-DOCX converter that does not handle tables, images, styled code blocks, or complex formatting required for legal documents.
- **Impact:** Generated documents are plain text with basic headings and bullet points. Legal documents require proper formatting (indentation, numbered clauses, signatures, headers/footers, table of contents).
- **Migration plan:** Consider `rustdocx` or generate DOCX via a template engine (e.g., handlebars with a `.docx` template).

### `pdf-extract = "0.7"` — Limited Extraction
- **Risk:** PDF extraction (`src-tauri/src/commands/files.rs` line 38) uses `pdf_extract::extract_text` which has known issues with CJK text extraction, embedded fonts, and scanned PDFs. Error handling falls back to returning a stub message.
- **Impact:** Chinese legal documents (often scanned or image-based PDFs) may not be extractable.
- **Migration plan:** Consider OCR integration (`tesseract`) or a more robust PDF library.

## Test Coverage Gaps

### Critical Untested Areas
- **What's not tested:** All Rust backend modules — LLM streaming (`commands/chat.rs`), MCP client/server lifecycle (`mcp/client.rs`, `mcp/manager.rs`), skills loading and routing (`skills/loader.rs`, `skills/router.rs`, `skills/mod.rs`), file system access (`commands/files.rs`), DOCX generation (`documents/docx_gen.rs`), database operations (`db/mod.rs`, `db/models.rs`), feedback collection (`feedback/collector.rs`).
- **Files:** `src-tauri/src/commands/chat.rs`, `src-tauri/src/mcp/client.rs`, `src-tauri/src/mcp/manager.rs`, `src-tauri/src/skills/loader.rs`, `src-tauri/src/commands/files.rs`, `src-tauri/src/documents/docx_gen.rs`
- **Risk:** Any refactoring of streaming, tool execution, or MCP communication is completely blind. Production crashes in these areas cannot be caught before shipping.
- **Priority:** High

### Untested Frontend
- **What's not tested:** All SolidJS components — `ChatPanel`, `SettingsPanel`, `Workspace`, `DocPreview`, `CitationPanel`, `HomePage`, `TitleBar`. All stores (`conversation.ts`, `settings.ts`, `theme.ts`). The API service layer (`api.ts`).
- **Files:** All `src/components/`, `src/stores/`, `src/services/`
- **Risk:** UI regressions, signal reactivity bugs (forgetting `()` calling convention), and API integration errors are not caught automatically.
- **Priority:** Medium

---

*Concerns audit: 2026-06-10*
