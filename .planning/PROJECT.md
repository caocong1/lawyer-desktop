# lawyer-desktop

## What This Is

一款面向律师的桌面客户端 AI 助手，基于 SolidJS + Tauri 2（Rust 后端）构建。律师可以通过自然语言对话获得法律辅助，支持技能注入（SKILL.md）、外部工具调用（MCP）、生成法律文书（DOCX）。应用运行在本地，通过 OpenAI-compatible API 调用云端 LLM。

**当前状态：骨架完成，功能半成品。** 前后端通信、LLM 调用链路、流式响应已打通，但数据库持久化未接通、多处 UI 使用 mock 数据、无测试套件。

## Core Value

**律师能通过对话获得 AI 法律辅助，并生成可用的法律文书（合同审查、起诉状等）。** 这是唯一必须可靠工作的功能——其余都可以失败，这个不能。

## Requirements

### Validated

（以下功能已在代码中实现，基本能用）

- ✓ **对话-01**: 用户能与 LLM 进行对话（流式响应） — existing
- ✓ **对话-02**: 系统支持多种 LLM 提供商（Qwen/DeepSeek/Kimi/OpenAI/Ollama） — existing
- ✓ **对话-03**: 用户能配置 LLM 提供商（API key、base URL、model） — existing
- ✓ **工具-01**: 系统能调用 MCP 外部工具（JSON-RPC over stdio） — existing
- ✓ **工具-02**: 系统能加载 SKILL.md 技能文件并注入 prompt — existing
- ✓ **文件-01**: 用户能浏览本地文件并上传为附件 — existing
- ✓ **文件-02**: 系统能从 PDF 提取文本内容 — existing
- ✓ **文档-01**: 系统能将 Markdown 内容转换为 DOCX 文件 — existing
- ✓ **反馈-01**: 系统能收集用户反馈数据 — existing
- ✓ **界面-01**: 界面支持暗色/亮色主题切换 — existing
- ✓ **界面-02**: 界面文字为中文 — existing
- ✓ **会话-01**: 用户能创建新会话并切换会话 — existing

### Active

（需要完成的工作——将在 REQUIREMENTS.md 中详细定义）

- [ ] 数据库持久化：将 conversation、message、provider 配置持久化到 SQLite
- [ ] 真实数据驱动：用 API 替换所有 mock 数据（HomePage、Workspace、CitationPanel）
- [ ] 历史会话管理：启动时加载历史会话，支持删除会话
- [ ] LLM 提供商持久化：配置保存到 DB，启动时自动恢复
- [ ] 文档生成真实化：从对话内容生成 DOCX（不依赖 mock）
- [ ] DOCX 文本提取：支持分析上传的 .docx 文件内容
- [ ] 安全加固：API key 加密存储、文件路径沙箱、启用 CSP
- [ ] MCP 真实健康检查：替换 stub health check
- [ ] 测试套件：为关键路径补充测试（LLM streaming、skill routing、DB persistence）

### Out of Scope

- 社区市场/技能共享平台 — 法律技能需要专业审查，暂不开放
- 多用户/登录系统 — 桌面单机应用，暂不需要账户体系
- 移动端支持 — 桌面客户端，Mobile 版本另行规划
- 离线 LLM 推理 — 依赖云端 API，离线场景暂不覆盖

## Context

**Brownfield 项目。** 现有代码在一次 11,762 行的 mega-commit 中完成（`4f880c2`），架构骨架完整但功能状态混乱：

- 前端组件齐全（HomePage、ChatPanel、Workspace、Settings 等），但 HomePage 和 Workspace 文档预览使用 hardcode mock 数据
- 后端模块完备（commands/chat/llm/mcp/skills/db/documents/feedback），但 SQLite 数据库 schema 存在，代码却不真正写入
- LLM 流式响应链路完整（SSE chunk by chunk），支持最多 10 轮 tool call
- MCP 客户端实现了 JSON-RPC over stdio，但 health_check 总是返回 true
- DOCX 文本提取功能 stubbed（"功能待实现"）
- 无测试套件、无 lint 配置、无 CI

**已有设计文档：** `docs/SKILL-UPDATE-DESIGN.md`（Skill 更新机制，5 Phase 规划，尚未开始实现）

## Constraints

- **Tech Stack**: SolidJS 1.9 + TypeScript 5.6（strict）+ Tauri 2（Rust edition 2021），不可更换
- **Database**: SQLite via `tauri-plugin-sql`，迁移文件在 `src-tauri/migrations/`
- **UI Text**: 界面文字必须为中文
- **Build**: Vite dev server 固定端口 1420
- **Platform**: Windows 优先（当前开发环境），跨平台兼容

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 使用 `createSignal` 而非 `createStore` | 项目约定，stores 导出 getter 函数需要 `()` 调用 | ✓ Good（已稳定） |
| CSS custom properties 主题系统 | 支持多主题切换，`data-theme` 属性控制 | ✓ Good |
| OpenAI-compatible provider 抽象 | 一套接口适配多家 LLM 厂商 | ✓ Good |
| 技能注入 via SKILL.md | 法律技能可独立维护、热更新 | ⚠️ Revisit（版本追踪未做） |
| MCP JSON-RPC over stdio | 外部工具集成标准协议 | ✓ Good |
| 单文件 API wrapper（api.ts） | 简单直接，所有 invoke 调用集中一处 | ⚠️ Revisit（功能增加后可能变大） |

---
*Last updated: 2026-06-10 after initialization (brownfield)*

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. "What This Is" still accurate? Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
