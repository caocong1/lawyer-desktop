# Testing Patterns

**Analysis Date:** 2026-06-10

## Current State: No Automated Test Suite

This project has **zero automated test infrastructure**. There is:
- No test runner installed (no Jest, Vitest, Mocha, or similar in `package.json`)
- No test framework configured (no `jest.config.*`, `vitest.config.*`, or similar)
- No test files found anywhere in `src/` or `src-tauri/` (no `*.test.*`, `*.spec.*`)
- No Rust test modules (`#[cfg(test)]`) in any backend source files
- No code coverage tooling or configuration
- No CI pipeline for automated test execution

## Verification Approach

**Manual verification only** as documented in `AGENTS.md`:

```bash
# 1. Start the app
bun run tauri dev

# 2. Verify UI renders without console errors
# 3. Test LLM chat with a configured provider
# 4. Test document export (DOCX generation)
```

## E2E Bridge Test Scripts

The project has **experimental e2e test scripts** in `scripts/` that test the Tauri MCP bridge via WebSocket. These are NOT automated tests — they are manual probe scripts:

| Script | Purpose |
|--------|---------|
| `scripts/test-e2e.cjs` | End-to-end test via WebSocket bridge — connects to `ws://127.0.0.1:9223`, tests `list_windows`, `capture_native_screenshot`, `execute_js` → Tauri `invoke()` chain |
| `scripts/test-probe-e2e.cjs` | Similar probe-based testing |
| `scripts/test-full-e2e.cjs` | Fuller e2e scenario testing |
| `scripts/test-js-bridge.cjs` | JS bridge connectivity test |
| `scripts/test-bridge-commands.cjs` | Bridge command execution test |
| `scripts/test-mcp-bridge.cjs` | MCP bridge-specific test |
| `scripts/test-tauri-mcp.cjs` | Tauri → MCP integration test |

These scripts use raw `ws` WebSocket connections and expect a running Tauri app with the `mcp-bridge` plugin enabled (debug builds only: `#[cfg(debug_assertions)]`).

**Example pattern** from `scripts/test-e2e.cjs`:
```javascript
const WebSocket = require('ws');
const WS_URL = 'ws://127.0.0.1:9223';

function sendCommand(command, args = {}) {
  return new Promise((resolve, reject) => {
    const id = `req-${++requestId}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      resolve({ id, success: false, error: 'timeout 15s' });
    }, 15000);
    pendingCalls.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, command, args }));
  });
}
```

## Test Framework

**Runner:** Not installed. No test runner configured.
**Assertion Library:** Not installed.
**Run Commands:** None defined in `package.json` (no `test` script).

## Test File Organization

**No test files exist.** Based on codebase conventions, if tests were to be added:
- Unit tests would likely go in: `src/__tests__/` or co-located as `*.test.tsx`
- Rust tests would go in inline `#[cfg(test)] mod tests { }` blocks within each module file, or in `src-tauri/tests/`

## What Should Be Tested

Based on codebase analysis, the following untested areas need coverage:

**Frontend (`src/`):**
- Store logic: `src/stores/conversation.ts` — state mutation functions (`addMessage`, `removeConversation`, `finishStreaming`)
- Store logic: `src/stores/theme.ts` — theme application + localStorage persistence
- Store logic: `src/stores/settings.ts` — provider configuration state
- Service layer: `src/services/api.ts` — all `invoke()` wrapper functions
- Data logic: `src/data/mockData.ts` — `getTodayLabel()`, `getGreeting()` utility functions

**Backend (`src-tauri/`):**
- Command handlers: `src-tauri/src/commands/chat.rs` — `send_message`, `process_stream_round`, `execute_tool`
- Document generation: `src-tauri/src/documents/docx_gen.rs` — `generate_docx`
- File utilities: `src-tauri/src/commands/files.rs` — `read_file_content`, `list_directory`, `prepare_attachment`
- LLM provider: `src-tauri/src/llm/openai_compat.rs` — streaming response parsing
- Feedback: `src-tauri/src/feedback/collector.rs` — `export_feedback_json`, `export_feedback_csv`
- Skill registry: `src-tauri/src/skills/` — registration, resolution, persistence

## Recommended Test Setup

When adding tests, follow these recommendations based on the tech stack:

**Frontend (SolidJS + TypeScript):**
```bash
# Install Vitest (SolidJS-compatible test runner)
bun add -d vitest @testing-library/solid jsdom

# Add to package.json scripts
# "test": "vitest run"
# "test:watch": "vitest"
```

**Backend (Rust):**
```rust
// Existing Cargo.toml already has: no test dependencies
// Add inline test modules:
#[cfg(test)]
mod tests {
    use super::*;
    // test functions
}
```

**Component Testing Pattern (for future):**
```tsx
// Co-located test: ChatPanel.test.tsx
import { render, screen } from "@solidjs/testing-library";
import ChatPanel from "./ChatPanel";

describe("ChatPanel", () => {
  it("renders chat interface", () => {
    // render(<ChatPanel ... />);
    // assertions
  });
});
```

## Type Checking (Current Quality Gate)

The only quality gate before committing is TypeScript compilation:

```bash
bunx tsc --noEmit
```

This must pass before any commit. There is no corresponding Rust compile check command in the project configuration.

---

*Testing analysis: 2026-06-10*
