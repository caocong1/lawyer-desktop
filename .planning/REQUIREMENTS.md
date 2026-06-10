# Requirements: 墨律 Inkstatute

**Defined:** 2026-06-10
**Core Value:** 律师通过对话获得经研究闸门校验的法律文书草稿，可预览、修订并导出 DOCX。

## v1 Requirements

### Foundation (Phase 0)

- [ ] **FOUND-01**: `bun run tauri dev` 启动成功，显示墨律标题栏空壳
- [ ] **FOUND-02**: `bunx tsc --noEmit` 零错误
- [ ] **FOUND-03**: `cargo check` 零错误
- [ ] **FOUND-04**: `vendor/ai-for-china-legal` submodule 可初始化

### UI (Phase 1)

- [ ] **UI-01**: 三套主题 a/b/c 可切换并持久化
- [ ] **UI-02**: Home 页：打字机 prompt、文书类型、最近项目
- [ ] **UI-03**: Workspace 三栏：对话 | 文书预览 | 引用抽屉
- [ ] **UI-04**: Agent 起草计划步骤条可展示
- [ ] **UI-05**: Home → Workspace 静态演示流程可走通

### Chat & Agent (Phase 2)

- [ ] **CHAT-01**: 配置 OpenAI-compatible 提供商后可流式对话
- [ ] **CHAT-02**: System prompt 包含 research-gate 前置指令
- [ ] **CHAT-03**: 意图路由到领域 skill（如 commercial-legal）
- [ ] **CHAT-04**: 设置面板：provider 配置 + 连接测试
- [ ] **SKILL-01**: 启动时扫描 vendor 下 SKILL.md 元数据

### Documents (Phase 3)

- [ ] **DOC-01**: LLM 输出解析为结构化文书模型
- [ ] **DOC-02**: DocPreview 渲染真实文书（非 mock）
- [ ] **DOC-03**: CitationPanel 展示法条/判例并可定位条款
- [ ] **DOC-04**: 导出 DOCX 可在 Word 打开
- [ ] **DOC-05**: 条款修订后预览同步更新

### Persistence (Phase 4)

- [ ] **DATA-01**: 会话与消息重启后恢复
- [ ] **DATA-02**: 首条消息自动生成会话标题
- [ ] **DATA-03**: 可删除会话（UI + DB）
- [ ] **DATA-04**: Provider 配置持久化并自动恢复
- [ ] **DATA-05**: 文书版本存入 documents 表

### MCP (Phase 5)

- [ ] **MCP-01**: 设置页显示 MCP 服务器在线/离线状态
- [ ] **MCP-02**: LLM 可调用 law-database 工具
- [ ] **MCP-03**: MCP 崩溃可检测并提示

### Security (Phase 6)

- [ ] **SEC-01**: API key 不以明文存 DB
- [ ] **SEC-02**: 文件读取路径白名单
- [ ] **SEC-03**: 启用 restrictive CSP
- [ ] **TEST-01**: `bun run test` 运行 vitest + cargo test
- [ ] **BUILD-01**: `bun run tauri build` 成功

## Out of Scope

| Feature | Reason |
|---------|--------|
| 多用户登录 | 桌面单机 |
| 技能市场 | MVP 仅路由 |
| 移动端 | 另行规划 |
| 离线 LLM | 云端 API |
| 全部 14 插件 UI | 智能路由即可 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-* | Phase 0 | Pending |
| UI-* | Phase 1 | Pending |
| CHAT-*, SKILL-* | Phase 2 | Pending |
| DOC-* | Phase 3 | Pending |
| DATA-* | Phase 4 | Pending |
| MCP-* | Phase 5 | Pending |
| SEC-*, TEST-*, BUILD-* | Phase 6 | Pending |

**Coverage:** v1 requirements: 28 total — all mapped

---
*Requirements defined: 2026-06-10*
