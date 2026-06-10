# Roadmap: lawyer-desktop

## Overview

Transform a brownfield SolidJS + Tauri lawyer-assistant skeleton into a working application by wiring real SQLite persistence, establishing test infrastructure, replacing mock data with live content, and hardening security. Four coarse phases delivered sequentially.

## Phases

- [ ] **Phase 1: 数据持久化** — Conversations, messages, and provider configurations survive app restarts via SQLite
- [ ] **Phase 2: 测试基建** — Vitest + cargo test frameworks cover critical paths (LLM streaming, skill routing, DB migrations)
- [ ] **Phase 3: 文档与界面真实化** — Real DOCX processing, Workspace/HomePage display live data instead of mocks
- [ ] **Phase 4: 安全加固** — API keys encrypted at rest, file access sandboxed, CSP enabled

## Phase Details

### Phase 1: 数据持久化
**Goal**: Conversations, messages, and provider configurations survive app restarts. Users never lose their work or settings.
**Depends on**: Nothing (foundation phase)
**Requirements**: DATA-01, DATA-02, DATA-03, SESSION-01, SESSION-02, SESSION-03, SESSION-04, PROVIDER-01, PROVIDER-02, PROVIDER-03
**Success Criteria** (what must be TRUE):
  1. User can send messages in a conversation, close and reopen the app — all messages and the conversation are restored exactly as they were
  2. User's LLM provider configuration (API key, base URL, model name) persists across app restarts — the app resumes with the last active provider
  3. On startup, the sidebar lists all historical conversations loaded from SQLite, not from any in-memory default
  4. User can delete a conversation from the sidebar — it disappears from both the UI and the database
  5. A new conversation automatically gets a meaningful title generated from its first message, visible in the conversation list
**Plans**: TBD
**UI hint**: yes

### Phase 2: 测试基建
**Goal**: TypeScript and Rust test frameworks are established with coverage of critical execution paths, enabling safe refactoring in later phases.
**Depends on**: Phase 1 (DB migration must exist and be finalized before regression tests)
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04
**Success Criteria** (what must be TRUE):
  1. `bunx vitest run` passes with TypeScript tests covering stores (conversation, settings, theme) and api.ts invoke wrappers
  2. `cargo test` passes with Rust tests covering LLM streaming (SSE chunk parsing), skill routing, and DB model serialization
  3. A single `bun run test` command (or equivalent) runs both TypeScript and Rust test suites and reports results
  4. Database migration tests verify that `001_init.sql` runs cleanly on a fresh database and is idempotent
**Plans**: TBD

### Phase 3: 文档与界面真实化
**Goal**: Document processing works end-to-end and all UI surfaces display real data from the database instead of hardcoded mocks.
**Depends on**: Phase 1 (real data must be stored before UI can display it)
**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04, UI-01, UI-02
**Success Criteria** (what must be TRUE):
  1. User can upload a .docx file and see its extracted text content displayed in the chat as context for the AI
  2. Workspace document preview shows content generated from real conversation data (not hardcoded mock documents)
  3. CitationPanel displays actual citations extracted from LLM responses during the active conversation
  4. User can click "生成文书" from a conversation and receive a real DOCX file containing that conversation's content
  5. HomePage displays the user's real conversation history and quick-action buttons ("新建会话", "最近会话", "文档库")
**Plans**: TBD
**UI hint**: yes

### Phase 4: 安全加固
**Goal**: Sensitive data is protected at rest, file system access is constrained, and the app window enforces a content security policy.
**Depends on**: Phase 1 (API keys must be persisted in SQLite before they can be encrypted)
**Requirements**: SEC-01, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. API keys stored in SQLite are encrypted with a symmetric cipher (not stored as plaintext)
  2. File read/upload commands respect a configurable directory whitelist — paths outside the whitelist are rejected
  3. Tauri `security.csp` configuration is set to a restrictive value (not null/open), preventing XSS through the webview
**Plans**: TBD

## Progress

**Execution Order:** 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 数据持久化 | 0/TBD | Not started | - |
| 2. 测试基建 | 0/TBD | Not started | - |
| 3. 文档与界面真实化 | 0/TBD | Not started | - |
| 4. 安全加固 | 0/TBD | Not started | - |
