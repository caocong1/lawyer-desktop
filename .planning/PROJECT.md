# 墨律 Inkstatute (lawyer-desktop)

## What This Is

面向中国大陆律师的本地桌面 AI 助手。律师通过自然语言对话获得法律辅助，系统经研究闸门检索法条与类案后起草法律文书，支持实时预览、条款修订与 DOCX 导出。底层 Agent 能力来自 [ai-for-china-legal](https://github.com/caocong1/ai-for-china-legal) 技能套件（Git Submodule）。

**当前状态：绿场重建。** 旧 brownfield 代码已归档至 `archive/pre-rebuild-2026/`，按 6 阶段路线图从零实现。

## Core Value

律师通过对话获得经研究闸门校验的法律文书草稿，可预览、修订并导出 DOCX。

## Requirements

### Validated

（绿场重建后逐项验证）

### Active

- [ ] Phase 0: 可启动空壳 + GSD 工件 + submodule
- [ ] Phase 1: 墨律 UI 壳层（三主题、Home、Workspace 静态流程）
- [ ] Phase 2: LLM 流式对话 + Skills + research-gate
- [ ] Phase 3: 文书结构化输出、预览、引用、DOCX 导出
- [ ] Phase 4: SQLite 持久化会话/消息/配置
- [ ] Phase 5: law-database MCP 连接器
- [ ] Phase 6: 安全加固与发布就绪

### Out of Scope

- 多用户/账户体系 — 桌面单机应用
- 技能社区市场 — 需专业审查，MVP 仅智能路由
- 移动端 — 另行规划
- 离线本地 LLM — 依赖云端 API
- 定时 Agent 后台任务 — managed-agent-cookbooks 后续版本
- Stitch MCP 等非法律实验集成

## Context

- **设计原型**：`C:\Users\sorawatcher\Downloads\lawyer-desktop`（Claude Design，墨律三主题）
- **技能套件**：`vendor/ai-for-china-legal`（submodule），含 67 SKILL.md、research-gate、MCP 连接器规格
- **技术栈**：Bun + Tauri 2.11 + SolidJS 1.9 + Vite 6 + Rust 2021
- **旧代码**：`archive/pre-rebuild-2026/` 仅供参考，禁止整段复制

## Constraints

- **Tech Stack**: SolidJS + Tauri 2 + Bun — 不可更换
- **UI Text**: 界面文字必须为中文
- **Dev Port**: Vite 固定 1420
- **Platform**: Windows 优先，跨平台兼容
- **GSD**: 每 phase 原子提交 + VERIFICATION

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 绿场重置 | 旧代码 mock 泛滥、DB 未接通、实验文件污染 | — Pending |
| ai-for-china-legal 作 submodule | 技能独立维护、版本可控 | — Pending |
| research-gate 强制前置 | 法律文书生成前必须检索 | — Pending |
| 不用 shell:default 权限 | 旧项目安全漏洞 | — Pending |
| createSignal 非 createStore | Solid 约定，getter 须 `()` 调用 | — Pending |

---
*Last updated: 2026-06-10 after greenfield rebuild init*
