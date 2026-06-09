# Codebase Structure

**Analysis Date:** 2026-06-10

## Directory Layout

```
lawyer-desktop/
├── src/                          # Frontend: SolidJS + TypeScript
│   ├── index.tsx                 # Entry point — mounts <App /> to #root
│   ├── App.tsx                   # Root component — screen routing, toast
│   ├── App.css                   # Global styles (toast, screen transitions)
│   ├── vite-env.d.ts             # Vite env type declarations
│   ├── components/
│   │   ├── home/
│   │   │   ├── HomePage.tsx      # Landing page — prompt input, doc types, recent projects
│   │   │   └── HomePage.css
│   │   ├── layout/
│   │   │   ├── TitleBar.tsx      # Persistent header — brand, crumbs, theme switch, settings
│   │   │   └── TitleBar.css
│   │   ├── settings/
│   │   │   ├── SettingsPanel.tsx  # Modal overlay — LLM provider, skills, about tabs
│   │   │   └── SettingsPanel.css
│   │   └── workspace/
│   │       ├── Workspace.tsx     # Workspace container — ChatPanel + DocPreview + CitationPanel
│   │       ├── Workspace.css
│   │       ├── ChatPanel.tsx     # Chat thread + composer — message list, skill selector, text input
│   │       ├── ChatPanel.css
│   │       ├── DocPreview.tsx    # Document preview/edit — articles, rich text, export
│   │       ├── DocPreview.css
│   │       ├── CitationPanel.tsx # Citations sidebar — law/case tabs, insert/locate
│   │       └── CitationPanel.css
│   ├── stores/
│   │   ├── conversation.ts       # Conversation state — conversations[], messages[], streaming
│   │   ├── settings.ts           # App settings — isConfigured, activeProvider, skillsRoot
│   │   └── theme.ts              # Theme state — theme "a"|"b"|"c", localStorage persistence
│   ├── services/
│   │   └── api.ts                # Tauri IPC wrappers — all invoke() + listen() calls
│   ├── data/
│   │   ├── mockData.ts           # Mock data — doc types, recent projects, greeting/prompt text
│   │   └── docData.ts            # Mock document — contract data, citations, article types
│   ├── themes/
│   │   ├── molv-tokens.css       # CSS custom properties — 3 theme color palettes (a/b/c)
│   │   └── molv-base.css         # Base styles — reset, typography, scrollbar
│   └── assets/                   # Static assets
│
├── src-tauri/                    # Backend: Rust + Tauri 2
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri app config — window, build, bundle, security
│   ├── build.rs                  # Tauri build script
│   ├── src/
│   │   ├── main.rs               # Binary entry — calls lib::run()
│   │   ├── lib.rs                # App setup — plugins, state, invoke_handler, setup hook
│   │   ├── commands/
│   │   │   ├── mod.rs            # Module declarations
│   │   │   ├── chat.rs           # send_message, create_conversation, set_active_skill
│   │   │   ├── settings.rs       # get_provider_presets, setup_provider, test_provider, skills
│   │   │   ├── files.rs          # read_file_content, list_directory, prepare_attachment
│   │   │   ├── documents.rs      # generate_docx
│   │   │   └── feedback.rs       # submit_feedback
│   │   ├── llm/
│   │   │   ├── mod.rs            # LlmEngine struct, default_providers(), ProviderPreset
│   │   │   ├── provider.rs       # LlmProvider trait, ChatStream type alias
│   │   │   ├── openai_compat.rs  # OpenAiCompatProvider impl (reqwest HTTP client)
│   │   │   └── types.rs          # ChatMessage, ChatRequest, ToolCall, ToolDefinition, etc.
│   │   ├── skills/
│   │   │   ├── mod.rs            # SkillRegistry (managed state, config persistence)
│   │   │   ├── loader.rs         # scan_skills_dir(), SKILL.md YAML frontmatter parser
│   │   │   └── router.rs         # build_system_prompt(), build_tool_definitions()
│   │   ├── mcp/
│   │   │   ├── mod.rs            # Module declarations
│   │   │   ├── client.rs         # McpClient — JSON-RPC over stdio with writer/reader tasks
│   │   │   ├── manager.rs        # McpManager — register, unregister, call_tool, health
│   │   │   └── types.rs          # JsonRpcRequest/Response, McpTool, McpServerConfig
│   │   ├── db/
│   │   │   ├── mod.rs            # get_migrations() — embedded SQL migrations
│   │   │   └── models.rs         # Conversation, Message, LlmProvider, Feedback, etc.
│   │   ├── documents/
│   │   │   ├── mod.rs            # Module declarations
│   │   │   └── docx_gen.rs       # generate_docx() — markdown → DOCX via docx-rs
│   │   └── feedback/
│   │       ├── mod.rs            # Module declarations
│   │       └── collector.rs      # FeedbackEntry struct, JSON/CSV export helpers
│   ├── migrations/
│   │   └── 001_init.sql          # Initial SQLite schema (6 tables + indexes)
│   ├── capabilities/             # Tauri capability permission files
│   ├── icons/                    # App icons (png, ico, icns)
│   ├── tests/                    # Rust integration tests
│   ├── gen/                      # Generated code
│   └── target/                   # Rust build artifacts (gitignored)
│
├── .mcp.json                     # MCP server definitions (auto-started on app launch)
├── vite.config.ts                # Vite config — port 1420, Solid plugin, Tauri optimizations
├── tsconfig.json                 # TypeScript config — strict, ESNext, Solid JSX
├── tsconfig.node.json            # TS config for node (vite config)
├── package.json                  # Node dependencies — solid-js, @tauri-apps/*, solid-markdown
├── bun.lock / package-lock.json  # Lockfiles
├── .env.example                  # Environment variable template (STITCH_API_KEY)
├── .gitignore
├── AGENTS.md                     # Dev agent instructions — architecture, pitfalls, commands
├── README.md
├── index.html                    # Vite HTML entry
├── public/                       # Static public assets
└── docs/                         # Additional documentation
```

## Directory Purposes

**`src/`** — Frontend application code (SolidJS + TypeScript):
- Purpose: All UI components, state management, IPC service layer, mock data, and theme definitions
- Contains: `.tsx` (components), `.ts` (stores, services, data), `.css` (component styles + themes)
- Key files: `index.tsx` (entry), `App.tsx` (root)

**`src/components/`** — UI Components:
- Purpose: Organized by feature domain — home (landing), layout (persistent chrome), settings (modal), workspace (main work area)
- Contains: One component per file, plus co-located CSS
- Convention: Component name matches filename. Named exports are the component function. Default export at bottom.

**`src/stores/`** — Application State:
- Purpose: Module-level `createSignal` state containers
- Contains: Three store modules — `conversation.ts` (chat state), `settings.ts` (provider config), `theme.ts` (theme selection)
- Convention: All use `createSignal` (not `createStore`). Exported via `useX()` hook returning `{ signalGetters, actionFunctions }`.

**`src/services/`** — IPC Bridge:
- Purpose: Single file wrapping all Tauri IPC calls
- Contains: Typed async functions for every `#[tauri::command]`, plus `onChatStream()` event listener factory
- Convention: All function names match their Tauri command counterparts. Snake_case arguments for Rust parameter mapping.

**`src/data/`** — Mock Data:
- Purpose: Prototype data for UI development before real backend integration
- Contains: `mockData.ts` (home page data), `docData.ts` (document model with articles, citations)

**`src-tauri/src/commands/`** — Tauri Command Handlers:
- Purpose: One file per domain, each exposing public `#[tauri::command]` async functions
- Contains: 5 modules — chat (core), settings (provider + skills config), files (file system ops), documents (DOCX gen), feedback (user ratings)
- Convention: Each command function uses `tauri::State<'_, T>` for managed state injection. Returns `Result<T, String>`.

**`src-tauri/src/llm/`** — LLM Integration:
- Purpose: Provider abstraction, HTTP transport, shared message types
- Contains: `LlmEngine` (state holder), `LlmProvider` trait (interface), `OpenAiCompatProvider` (HTTP impl), types (all shared data structures)
- Convention: Provider trait in `provider.rs`, concrete impl in `openai_compat.rs`, types in `types.rs`

**`src-tauri/src/skills/`** — Skill System:
- Purpose: Filesystem-based skill loading, caching, and runtime retrieval
- Contains: `SkillRegistry` (managed state, config persistence), `loader.rs` (directory scanning + frontmatter parsing), `router.rs` (prompt building + tool definitions)
- Convention: Skills stored at `skills_root/plugin/skill-name/SKILL.md` or `skills_root/shared/skill-name/SKILL.md`

**`src-tauri/src/mcp/`** — MCP Client:
- Purpose: JSON-RPC 2.0 client for external MCP servers (spawned as child processes)
- Contains: `McpClient` (async stdio transport with writer/reader tasks), `McpManager` (multi-server registry), types (JSON-RPC, tool, server config)

**`src-tauri/src/db/`** — Database:
- Purpose: SQLite schema definition and data model structs
- Contains: Migration list (embedded SQL), model structs with `Serialize`/`Deserialize`
- Note: DB operations are handled by `tauri-plugin-sql` from the frontend side; backend models are used for type definitions in commands

## Key File Locations

**Entry Points:**
- `src/index.tsx`: Frontend entry — mounts SolidJS `<App />` to `#root`
- `src-tauri/src/main.rs`: Backend binary entry — calls `lib::run()`
- `src-tauri/src/lib.rs`: App setup — plugin registration, state management, invoke handler, setup hook

**Configuration:**
- `vite.config.ts`: Vite build config — port 1420, Solid plugin, Tauri HMR settings
- `tsconfig.json`: TypeScript strict config — ES2020 target, `jsx: "preserve"`, `jsxImportSource: "solid-js"`
- `package.json`: Node dependencies — SolidJS 1.9, Tauri API v2, solid-markdown
- `src-tauri/Cargo.toml`: Rust dependencies — Tauri 2, reqwest (stream, json), tokio, docx-rs, pdf-extract
- `src-tauri/tauri.conf.json`: Tauri config — window 1280x860, build command, CSP null, global Tauri

**Core Logic:**
- `src/App.tsx`: Root component — screen routing, toast system, theme init
- `src/stores/conversation.ts`: Chat state management — messages, streaming, conversation CRUD
- `src/services/api.ts`: All IPC bridge functions — invoke wrappers + event listeners
- `src/components/workspace/ChatPanel.tsx`: Chat UI — message thread, streaming display, skill selector
- `src-tauri/src/commands/chat.rs`: Core chat command — multi-turn LLM + tool execution loop
- `src-tauri/src/llm/mod.rs`: LLM engine — provider lifecycle
- `src-tauri/src/skills/mod.rs`: Skill registry — scanning, caching, config persistence
- `src-tauri/src/mcp/client.rs`: MCP client — async stdio JSON-RPC transport

**Testing:**
- `src-tauri/tests/`: Rust integration tests
- No frontend test files detected (no `*.test.ts` or `*.spec.ts` files)

## Naming Conventions

**Files:**
- Frontend components: PascalCase — `ChatPanel.tsx`, `HomePage.tsx`, `SettingsPanel.tsx`
- Frontend styles: Same name as component — `ChatPanel.css`, `HomePage.css`
- Frontend stores: camelCase — `conversation.ts`, `settings.ts`, `theme.ts`
- Frontend services: lowercase — `api.ts`
- Frontend mock data: camelCase — `mockData.ts`, `docData.ts`
- Rust modules (files): snake_case — `chat.rs`, `openai_compat.rs`, `docx_gen.rs`
- Rust modules (mod.rs): `mod.rs` per directory
- CSS themes: kebab-case with prefixes — `molv-tokens.css`, `molv-base.css`

**Directories:**
- Frontend components: lowercase plural category — `home/`, `layout/`, `settings/`, `workspace/`
- Backend modules: lowercase singular — `commands/`, `llm/`, `skills/`, `mcp/`, `db/`, `documents/`, `feedback/`

**Functions:**
- Frontend: camelCase — `handleSend()`, `startStreaming()`, `finishStreaming()`, `appendStreamChunk()`
- Rust: snake_case — `send_message()`, `create_conversation()`, `set_skills_root()`, `get_all_tools()`

**Types/Interfaces:**
- Frontend interfaces: PascalCase — `SendMessageRequest`, `StreamChunk`, `FileAttachment`, `Conversation`
- Rust structs: PascalCase — `LlmEngine`, `SkillRegistry`, `McpManager`, `ToolCallAccumulator`, `StreamResult`

## Where to Add New Code

**New Feature (Frontend):**
- New component: `src/components/<feature-domain>/ComponentName.tsx` + co-located `ComponentName.css`
- Component props interface defined at top of file
- If new state needed: add store to `src/stores/<name>.ts` using `createSignal` + `useX()` pattern
- If new command needed: add wrapper in `src/services/api.ts`
- Register in `App.tsx` if it's a new screen or global overlay

**New Feature (Backend — Rust command):**
1. Create function in `src-tauri/src/commands/<module>.rs` with `#[tauri::command]`
2. Add `pub mod <module>;` to `src-tauri/src/commands/mod.rs`
3. Register function in `src-tauri/src/lib.rs` inside `generate_handler![]`
4. Create typed wrapper in `src/services/api.ts` using `invoke("command_name", { args })`

**New LLM Provider:**
- Add variant to `LlmEngine::set_provider()` match in `src-tauri/src/llm/mod.rs`
- Or implement `LlmProvider` trait in a new file (e.g., `anthropic.rs`) alongside `openai_compat.rs`

**New Built-in Tool:**
1. Add `ToolDefinition` in `src-tauri/src/skills/router.rs::build_tool_definitions()`
2. Add handler match arm in `src-tauri/src/commands/chat.rs::execute_tool()`

**New MCP Server:**
- Add entry to `.mcp.json` with `command`, `args`, and optional `env`
- Auto-started by `lib.rs` setup hook on app launch

**New Database Migration:**
1. Create `src-tauri/migrations/002_<description>.sql`
2. Add `Migration { version: 2, ... }` to `src-tauri/src/db/mod.rs::get_migrations()`
3. Update `src-tauri/src/db/models.rs` with new struct if needed

**New Theme:**
- Add `[data-theme="d"] { ... }` block to `src/themes/molv-tokens.css`
- Add `"d"` to theme type and themes array in `src/stores/theme.ts`

**Tests:**
- Frontend: create `src/**/*.test.tsx` files (co-located with components) — no test framework detected yet
- Backend: add tests to `src-tauri/tests/` or inline `#[cfg(test)]` modules

## Special Directories

**`node_modules/`** — NPM dependencies (gitignored)
- Generated: Yes
- Committed: No

**`src-tauri/target/`** — Rust build artifacts (gitignored)
- Generated: Yes
- Committed: No

**`dist/`** — Vite build output (gitignored)
- Generated: Yes
- Committed: No

**`src-tauri/gen/`** — Tauri generated code (schemas, bindings)
- Generated: Yes (by Tauri build)
- Committed: Yes (tracked in git)

**`public/`** — Static assets served by Vite
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-10*
