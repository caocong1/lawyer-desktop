# Technology Stack

**Analysis Date:** 2026-06-10

## Languages

**Primary:**
- **TypeScript 5.6** (strict mode) — All frontend logic, components, stores, and API wrappers in `src/`
- **Rust edition 2021** (rustc 1.93.1) — All backend logic, commands, LLM engine, MCP client, DB, document generation in `src-tauri/src/`

**Secondary:**
- **CSS (vanilla)** — All styling via per-component `.css` files and global theme token files in `src/themes/`
- **SQL** — Database schema in `src-tauri/migrations/001_init.sql` (SQLite)
- **JSON** — Config files, persisted app config (`lawyer-desktop.json`), `.mcp.json`
- **YAML** — SKILL.md frontmatter parsing via `serde_yaml 0.9`

## Runtime

**Environment:**
- **Tauri 2** — Desktop application shell (bundles Vite frontend + Rust backend into native window)
- **Node.js 24.16.0** — Dev/build toolchain
- **Bun 1.3.10** — Package manager and dev server runner (`bun run dev`, `bun run tauri dev`)
- Configuration: `src-tauri/tauri.conf.json`

**Package Managers:**
- **bun** (v1.3.10) — Frontend dependency management; lockfile: `bun.lock`
- **Cargo** (v1.93.1) — Rust dependency management; lockfile: `src-tauri/Cargo.lock`

## Frameworks

**Core Frontend:**
- **SolidJS 1.9.3** — Reactive UI framework using `createSignal` (not `createStore`). All stores in `src/stores/` return getter functions that MUST be called with `()` in JSX
- **Vite 6** — Build tool and dev server via `vite.config.ts`; port **1420** (fixed, strict)

**Core Backend:**
- **Tauri 2** — Desktop framework via `src-tauri/src/main.rs` + `lib.rs`
  - Plugin system: opener, sql, dialog, fs, shell, mcp-bridge
  - `#[tauri::command]` handlers in `src-tauri/src/commands/`
  - Global state managed via `app.manage()`: `LlmEngine`, `SkillRegistry`, `McpManager`
  - Event system: `app.emit("chat-stream", chunk)` for streaming LLM output

**Testing:**
- Not detected — No test framework or test runner configured. Test scripts in `scripts/` are manual e2e probes (`.cjs` files)

**Build/Dev:**
- `vite-plugin-solid 2.11` — SolidJS JSX transform for Vite
- `@tauri-apps/cli ^2` — Tauri CLI for `bun run tauri dev` / `bun run tauri build`
- `tsc --noEmit` — Type checking (strict mode configured in `tsconfig.json`)
- `src-tauri/build.rs` — Standard `tauri_build::build()`

## Key Dependencies

### Frontend (package.json)

| Package | Version | Purpose |
|---|---|---|
| `solid-js` | ^1.9.3 | Reactive UI framework |
| `@tauri-apps/api` | ^2 | Frontend ↔ Rust IPC bridge (`invoke()`, `listen()`) |
| `@tauri-apps/plugin-opener` | ^2 | Open files/URLs in OS default app |
| `@tauri-apps/plugin-sql` | ^2 | Frontend-side SQLite access (if needed) |
| `@tauri-apps/plugin-dialog` | ^2 | Native file open/save dialogs |
| `@tauri-apps/plugin-fs` | ^2 | Native filesystem access |
| `solid-markdown` | ^2.0.12 | Markdown rendering in chat messages |
| `remark-gfm` | ^4.0.0 | GitHub Flavored Markdown (tables, strikethrough) |
| `highlight.js` | ^11.11.0 | Code syntax highlighting in markdown |

### Backend (Cargo.toml)

| Crate | Version | Purpose |
|---|---|---|
| `tauri` | 2 | Desktop app framework |
| `tauri-plugin-sql` | 2 (sqlite feature) | SQLite database with embedded migrations |
| `tauri-plugin-mcp-bridge` | 0.11 | MCP bridge for AI debugging (debug builds only) |
| `serde` / `serde_json` | 1 | Serialization across IPC boundary |
| `reqwest` | 0.12 (stream + json) | HTTP client for LLM provider API calls |
| `tokio` / `tokio-stream` | 1 (full) | Async runtime and streaming |
| `futures` | 0.3 | Stream combinators for SSE parsing |
| `uuid` | 1 (v4) | ID generation for conversations, messages |
| `chrono` | 0.4 (serde) | Timestamps |
| `docx-rs` | 0.4 | DOCX (Word) document generation |
| `pdf-extract` | 0.7 | PDF text extraction for file reading |
| `serde_yaml` | 0.9 | SKILL.md YAML frontmatter parsing |
| `sha2` | 0.10 | Content hash computation (SHA-256 for skill change detection) |
| `anyhow` / `thiserror` | 1 / 2 | Error handling |
| `log` / `env_logger` | 0.4 / 0.11 | Logging |

### Theme / Styling

**Approach:** Pure CSS custom properties with `data-theme` attribute on `<html>`.
- Token definitions: `src/themes/molv-tokens.css`
- Base component styles: `src/themes/molv-base.css`
- Theme switching via three presets `"a"`, `"b"`, `"c"` (stored in `localStorage` as `molv-theme`)
- Google Fonts: **Material Symbols Outlined** (loaded dynamically from Google Fonts CDN in `App.tsx:onMount`)
- Icons: Material Symbols (class `material-symbols-outlined`)

## Configuration

**Environment:**
- Managed via `.env` file (see `.env.example` for template)
- Required: `STITCH_API_KEY` for Stitch MCP integration
- Optional: `QWEN_API_KEY`, `DEEPSEEK_API_KEY`, `KIMI_API_KEY`, `OPENAI_API_KEY` for various LLM providers
- LLM provider API keys entered at runtime via Settings panel (not persisted in env vars)
- `TAURI_DEV_HOST` optional env var for remote dev debugging

**Build:**
- `vite.config.ts` — Vite configuration (port 1420, HMR on 1421, CJS deps optimization)
- `tsconfig.json` — TypeScript strict configuration (ES2020 target, bundler module resolution, `solid-js` JSX import source)
- `tsconfig.node.json` — Separate config for `vite.config.ts`
- `src-tauri/.cargo/config.toml` — Sets `x86_64-pc-windows-msvc` as build target
- `src-tauri/tauri.conf.json` — Window config (1280x860, min 960x640), security (CSP null), bundle targets (all), icons
- `src-tauri/capabilities/default.json` — Permissions: core, opener, dialog, fs, shell, mcp-bridge, sql

## Platform Requirements

**Development:**
- Node.js 24.x, Bun 1.x, Rust 1.93+, Cargo
- Windows x86_64 (build target: `x86_64-pc-windows-msvc`)
- Tauri 2 prerequisites (WebView2 on Windows)

**Production:**
- Windows desktop application (`.exe` or MSI installer via `bun run tauri build`)
- Self-contained SQLite database at app data directory (`lawyer-desktop.db`)
- Persisted config at `{app_data_dir}/lawyer-desktop.json`

---

*Stack analysis: 2026-06-10*
