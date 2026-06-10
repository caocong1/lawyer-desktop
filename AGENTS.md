# AGENTS.md — 墨律 Inkstatute

## Tech Stack
- **Frontend**: SolidJS 1.9+ (JSX, signals) + TypeScript 6 (strict) — scaffolded with `bun create vite --template solid-ts`
- **Backend**: Rust (edition 2021) via Tauri 2.11
- **Build**: Vite 8 + bun
- **Database**: SQLite via `sqlx` + embedded migrations
- **Skills**: `vendor/ai-for-china-legal` (git submodule / junction to sibling repo)
- **Styling**: CSS custom properties, `data-theme="a|b|c"` (墨律三主题)

## Critical Commands

```bash
# Development (Vite + Rust; prefers rustup MSVC over Chocolatey GNU rust)
bun run tauri dev

# Frontend only
bun run dev

# Production build
bun run tauri build

# Typecheck
bunx tsc -b

# Tests
bun run test
```

**Dev server port: 1420** (`vite.config.ts`)

## Architecture

### Frontend (`src/`)
- **Entry**: `src/index.tsx` → `<App />`
- **Components**: `src/components/{home,layout,workspace,settings}/`
- **Stores**: `src/stores/{conversation,settings,theme}.ts` — `createSignal`, getters need `()`
- **Services**: `src/services/api.ts` — all `invoke()` + `onChatStream`
- **Themes**: `src/themes/molv-{tokens,base}.css`
- **Types**: `src/types/legal.ts` — document/citation models aligned with backend
- **Utils**: `src/utils/legalDocument.ts` — extract/parse LLM JSON into preview state

### Backend (`src-tauri/`)
- **Entry**: `src/lib.rs`
- **Commands**: `commands/{chat,settings,files,documents}.rs`
- **LLM**: `llm/` — OpenAI-compatible streaming
- **Skills**: `skills/` — scans `**/SKILL.md`, injects `research-gate`
- **MCP**: `mcp/` — JSON-RPC stdio, real health check
- **DB**: `db/` — SQLite persistence, AES-GCM API keys
- **Security**: `security/` — path sandbox, key store

## SolidJS Convention

```tsx
const { messages } = useConversation();
<For each={messages()}>{...}</For>  // MUST call ()
```

## Adding a Tauri Command
1. Define in `src-tauri/src/commands/<module>.rs` with `#[tauri::command]`
2. Register in `src/lib.rs` `generate_handler![]`
3. Add wrapper in `src/services/api.ts`

## Pitfalls
- `bun run tauri` wraps CLI to put `%USERPROFILE%\.cargo\bin` first on PATH
- `solid-markdown` needs `debug` shim in `vite.config.ts` (see `src/shims/debug.ts`)
- `onChatStream` must register in `onMount` + cleanup in `onCleanup`
- No `tauri-plugin-shell` — file access via sandboxed commands only
- Skills root: `vendor/ai-for-china-legal` or `../ai-for-china-legal`

## Language
- UI text: Chinese
- Commit messages: English
