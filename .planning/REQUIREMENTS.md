# Requirements: lawyer-desktop

**Defined:** 2026-06-10
**Core Value:** 律师能通过对话获得 AI 法律辅助，并生成可用的法律文书

## v1 Requirements

### 数据基础 (DATA)

- [ ] **DATA-01**: 应用能将 conversation 持久化到 SQLite，重启不丢失
- [ ] **DATA-02**: 应用能将 message 持久化到 SQLite，支持历史消息加载
- [ ] **DATA-03**: 应用能自动为新会话生成有意义的标题（基于首条消息）

### 会话管理 (SESSION)

- [ ] **SESSION-01**: 启动时从数据库加载所有历史会话到左侧列表
- [ ] **SESSION-02**: 用户能删除会话（数据库行删除 + UI 同步）
- [ ] **SESSION-03**: 切换会话时自动加载该会话的历史消息
- [ ] **SESSION-04**: 会话标题在用户发送第一条消息后自动更新

### Provider 配置 (PROVIDER)

- [ ] **PROVIDER-01**: LLM 提供商配置（API key、base URL、model 名称）持久化到 SQLite
- [ ] **PROVIDER-02**: 应用启动时自动从数据库恢复上次使用过的 provider 配置
- [ ] **PROVIDER-03**: 用户切换 provider 后，旧配置在数据库中有记录（可回溯）

### 文件与文档 (DOC)

- [ ] **DOC-01**: 用户能通过 UI 上传 .docx 文件，系统提取文本内容供 AI 分析
- [ ] **DOC-02**: Workspace 文档预览从实际对话内容生成（非 mock 数据）
- [ ] **DOC-03**: CitationPanel 显示真实引用来源（来自 LLM 回复，非 hardcoded）
- [ ] **DOC-04**: 从对话内容一键生成 DOCX 文档（markdown → docx 完整链路）

### 用户界面 (UI)

- [ ] **UI-01**: HomePage 显示真实的项目/会话状态信息（非 mock project history）
- [ ] **UI-02**: HomePage 显示快速操作入口（"新建会话"、"最近会话"、"文档库"）

### 安全 (SEC)

- [ ] **SEC-01**: API key 在 SQLite 中使用对称加密存储（非明文）
- [ ] **SEC-02**: 文件读取命令限制在用户可配置的目录白名单内（路径沙箱）
- [ ] **SEC-03**: 启用 Tauri CSP 策略（Content-Security-Policy 非 null）

### 测试 (TEST)

- [ ] **TEST-01**: 建立 TypeScript 测试框架（Vitest），覆盖 stores 和 api.ts
- [ ] **TEST-02**: 建立 Rust 测试模块（cargo test），覆盖关键命令和 LLM provider
- [ ] **TEST-03**: LLM streaming 逻辑有单元测试（至少覆盖 SSE 解析）
- [ ] **TEST-04**: 数据库迁移有回归测试（确保 migration 可重复运行）

## v2 Requirements

（Deferred to future release）

### Skill 版本管理

- **SKILL-V-01**: SKILL.md frontmatter 支持 `version` 字段（SemVer）
- **SKILL-V-02**: 数据库记录本地 skill 版本和 content hash
- **SKILL-V-03**: 支持检查远端 skill 仓库更新（Git-based manifest）
- **SKILL-V-04**: 支持一键更新 skill 并显示 changelog

### 高级功能

- **ADV-01**: MCP server 真实健康检查（替换 stub）
- **ADV-02**: 系统 prompt 缓存（避免每轮重建）
- **ADV-03**: 对话导出（Markdown / PDF / 完整记录）
- **ADV-04**: 多语言支持（English + 中文）

## Out of Scope

| Feature | Reason |
|---------|--------|
| 社区技能市场 | 法律技能需专业审查，暂不开放公共市场 |
| 多用户/登录系统 | 单机桌面应用，不需要账户体系 |
| 移动端 App | 桌面专用，移动端另外规划 |
| 离线 LLM 推理 | 依赖云端 API，离线场景暂不覆盖 |
| 实时协作 | 单机应用，不支持多用户在线协作 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 1 | Pending |
| DATA-02 | Phase 1 | Pending |
| DATA-03 | Phase 1 | Pending |
| SESSION-01 | Phase 1 | Pending |
| SESSION-02 | Phase 1 | Pending |
| SESSION-03 | Phase 1 | Pending |
| SESSION-04 | Phase 1 | Pending |
| PROVIDER-01 | Phase 1 | Pending |
| PROVIDER-02 | Phase 1 | Pending |
| PROVIDER-03 | Phase 1 | Pending |
| TEST-01 | Phase 2 | Pending |
| TEST-02 | Phase 2 | Pending |
| TEST-03 | Phase 2 | Pending |
| TEST-04 | Phase 2 | Pending |
| DOC-01 | Phase 3 | Pending |
| DOC-02 | Phase 3 | Pending |
| DOC-03 | Phase 3 | Pending |
| DOC-04 | Phase 3 | Pending |
| UI-01 | Phase 4 | Pending |
| UI-02 | Phase 4 | Pending |
| SEC-01 | Phase 5 | Pending |
| SEC-02 | Phase 5 | Pending |
| SEC-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-10*
*Last updated: 2026-06-10 after initial definition*
