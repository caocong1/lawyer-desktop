# Coding Conventions

**Analysis Date:** 2026-06-10

## Languages & Runtimes

**TypeScript (Frontend):**
- Target: ES2020, strict mode in `tsconfig.json`
- JSX: `preserve` with `jsxImportSource: "solid-js"`
- No ESLint, Prettier, or Biome configurations exist — only TypeScript compiler checks (`tsc --noEmit`)

**Rust (Backend):**
- Edition 2021 via Tauri 2
- No `rustfmt.toml` or `clippy.toml` — uses defaults

## Naming Patterns

**Files:**
- TypeScript: PascalCase for components (`ChatPanel.tsx`, `SettingsPanel.tsx`), camelCase for stores/services/data (`conversation.ts`, `api.ts`, `mockData.ts`)
- CSS: Exact-match filename as component, co-located (`ChatPanel.tsx` + `ChatPanel.css`)
- Rust: snake_case for files (`chat.rs`, `settings.rs`, `docx_gen.rs`)

**Functions/Methods:**
- TypeScript: camelCase (`handleSend`, `startWorkspace`, `showToast`, `startStreaming`)
- Rust: snake_case (`send_message`, `create_conversation`, `set_active_skill`)
- Tauri command functions use `snake_case` (Rust convention) that Tauri auto-maps to the TypeScript `invoke()` call

**Variables:**
- TypeScript: camelCase (`inputText`, `activeConversationId`, `docReady`)
- Rust: snake_case (`conversation_id`, `message_id`, `tool_call_id`)
- SolidJS signals: `[value, setValue]` naming convention (`[messages, setMessages]`, `[inputText, setInputText]`)

**Types/Interfaces:**
- TypeScript: PascalCase interfaces with `Props` suffix for component prop types (`ChatPanelProps`, `WorkspaceProps`, `HomePageProps`)
- TypeScript: Plain interfaces for data models (`Message`, `Conversation`, `FileAttachment`, `StreamChunk`)
- Rust: PascalCase structs with `Debug, Clone, Serialize, Deserialize` derives (`SendMessageRequest`, `StreamChunk`, `FileInfo`)
- Rust: Shared types in dedicated modules (`src/llm/types.rs`, `src/mcp/types.rs`, `src/db/models.rs`)

## Code Style

**Formatting:** No formatter configured. Code appears manually formatted with:
- 2-space indentation (TypeScript/JSX)
- 4-space indentation (Rust, standard)
- Single quotes for strings in TypeScript
- Semicolons in TypeScript (explicit)

**TypeScript Linting:** Only `tsconfig.json` compiler checks:
- `"strict": true`
- `"noUnusedLocals": true`
- `"noUnusedParameters": true`
- `"noFallthroughCasesInSwitch": true`

## File Organization

**Frontend Component Pattern:**
```
src/components/<domain>/
├── ComponentName.tsx    # Single component, named export + default export
├── ComponentName.css    # Co-located styles
```
Used across: `src/components/chat/`, `src/components/layout/`, `src/components/settings/`

**Store Pattern:**
```
src/stores/domain.ts     # Module-level createSignal(), export use*() hook
```
Example: `src/stores/conversation.ts`, `src/stores/theme.ts`, `src/stores/settings.ts`

**Service Pattern:**
```
src/services/api.ts      # All Tauri invoke() wrappers in single file
```

**Backend Module Pattern:**
```
src-tauri/src/commands/<domain>.rs    # One file per domain with #[tauri::command]
src-tauri/src/<domain>/               # Domain modules (llm/, skills/, mcp/, db/, documents/)
src-tauri/src/<domain>/mod.rs         # Module re-exports
```

## Import Organization

**TypeScript (observed order):**
1. SolidJS primitives (`import { Component, createSignal, ... } from "solid-js"`)
2. Third-party libraries (`solid-markdown`, `remark-gfm`, `@tauri-apps/*`)
3. Local stores (`../../stores/conversation`)
4. Local services (`../../services/api`)
5. Relative path imports only (no path aliases configured)
6. CSS imports at the end (`./ComponentName.css`)

**Rust (observed order):**
1. Standard library (`use std::*`)
2. Third-party crates (`serde`, `tauri`, `uuid`, `chrono`)
3. Internal crate modules (`use crate::*`)

## Component Design

**SolidJS Component Signature:**
```tsx
// Proper pattern from the codebase:
const ComponentName: Component<PropsType> = (props) => {
  const [localState, setLocalState] = createSignal(initialValue);

  // Store hooks
  const { signal } = useStore();

  // Event handlers as inner functions
  async function handleAction() { /* ... */ }

  return ( /* JSX */ );
};

export default ComponentName;
```

**Critical Signal Convention:**
All stores use `createSignal` (NOT `createStore`). Signals are getter functions that **MUST** be called with `()`:

```tsx
// CORRECT — access signal value
<For each={messages()}>{(msg) => ...}</For>
const convId = activeConversationId();

// WRONG — will silently crash or fail to react
<For each={messages}>{(msg) => ...}</For>
```

This is documented as a critical pitfall in `AGENTS.md`.

## JSX Conventions

- Use `class=` instead of `className=` for HTML class attribute
- Use `style={{ key: "value" }}` for inline styles (object syntax)
- Use `onClick`, `onInput`, `onKeyDown` for event handlers (SolidJS camelCase)
- Use `classList={{ className: condition }}` for conditional classes
- Use `Show` and `For` control flow components instead of ternary/`.map()`
- Use `ref={variable}` for DOM element references

## CSS Conventions

**Theming:**
- CSS custom properties (variables) defined in `src/themes/molv-tokens.css`
- Theme switching via `data-theme` attribute on `<html>`: values `"a"`, `"b"`, `"c"`
- Three themes defined: Theme A (warm parchment), Theme B (dark blue), Theme C (clean white)
- All component colors reference CSS variables (`var(--accent)`, `var(--surface)`, `var(--ink)`, etc.)

**Naming:**
- BEM-like short class names: `.chat`, `.thread`, `.msg`, `.msg-user`, `.bubble-user`
- Non-namespaced, but scoped by component CSS file
- Animations use `@keyframes` with short names: `msg-in`, `ml-pulse`, `sk`, `add-glow`

**Layout:**
- `flexbox` primary layout mechanism
- `position: fixed/absolute` for overlays and panels
- `scroll` utility class for scrollable containers with custom scrollbar styling

## Error Handling

**TypeScript Pattern:**
```tsx
try {
  const result = await someFunction();
  // success path
} catch (e) {
  console.error("Descriptive message:", e);
  // user-facing error message in Chinese
  props.onToast("发送失败");
}
```

- All async operations wrapped in try/catch
- `console.error` for logging (no structured logging library)
- User-facing errors always in Chinese strings
- Errors cascade via `props.onToast(msg)` for UI feedback

**Rust Pattern:**
- Tauri commands return `Result<T, String>` (String error for frontend consumption)
- Internal functions use `anyhow::Result<T>` with `.context()` for error wrapping
- `map_err(|e| e.to_string())` to convert anyhow errors to String for Tauri
- `log::error!` / `log::info!` for structured logging
- `eprintln!` for debug output in selected areas

## Logging

**Frontend:** `console.error`, `console.log` — no structured logger
**Backend:** `log::info!`, `log::error!` with `env_logger` initialization in `src-tauri/src/lib.rs`
**Debug-only:** `eprintln!` in MCP section, gated with `#[cfg(debug_assertions)]` for `mcp_bridge` plugin

## Comments

**TypeScript:**
- Chinese comments for code logic explanations (e.g., `// 全部使用 signal，确保 () 调用正确`)
- English for structural comments (e.g., `// Chat`, `// Settings`, `// Files`)
- `/* @refresh reload */` directive in `src/index.tsx`

**Rust:**
- English comments with Chinese for domain-specific concepts
- Doc comments (`///`) on public structs and functions
- Inline comments (`//`) for complex logic
- `// ----` section dividers for logical grouping

## Module Design

**TypeScript:**
- Named function exports + default export for components
- Named constant + `export function useX()` hook pattern for stores
- Named interface exports for types
- Single barrel file: `src/services/api.ts` — all Tauri invoke wrappers
- No barrel index files in component directories (CSS imported directly)

**Rust:**
- `mod.rs` re-exports submodules
- Public items only as needed (`pub`, `pub(crate)`)
- Structs with `pub` fields
- `#[tauri::command]` functions are `pub async fn`

## Configuration

**TypeScript config:** `tsconfig.json` with strict mode
**Vite config:** `vite.config.ts` — port 1420, HMR on 1421, ignores `src-tauri/`
**Rust config:** `Cargo.toml` — edition 2021, standard dependencies
**Environment:** `.env` file (gitignored), `.env.example` for reference

---

*Convention analysis: 2026-06-10*
