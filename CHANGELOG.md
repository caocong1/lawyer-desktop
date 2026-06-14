# Changelog

本文件记录墨律 Inkstatute 的主要变更。项目目前处于 `0.x` 阶段，版本语义以“可安装 App + 配套 skill 包”的实际发布为准。

## [0.1.0] - 2026-06-14

### Added

- 初始桌面应用：Tauri 2 + SolidJS + Rust 后端，产品名 `墨律`，Bundle ID `com.sorawatcher.inkstatute`。
- 法律对话工作区：流式 markdown 对话、结构化文书预览、引用侧栏、会话持久化和自定义标题栏。
- 首页文书入口：常见合同、诉讼文书、法律意见书等 starter cards。
- OpenAI-compatible LLM 接入：Qwen、DeepSeek、Kimi、OpenAI、Ollama 和自定义 provider。
- Fast model 配置：用于轻量任务，未配置时回退到主模型。
- `vendor/ai-for-china-legal` skill 扫描、路由和 `research-gate` 注入。
- MCP 集成：`.mcp.json` 配置、stdio JSON-RPC、法规数据库和裁判文书 connector 入口。
- 本地文件沙箱：允许目录配置、文件/目录上下文、工作区索引和 FTS 检索。
- 内置法律法规库：随安装包打包基础法规资源，并支持法规状态监控。
- 引用抽取与核验：法规/案例引用面板，verified / retrieved / unverified 状态。
- DOCX 导出：结构化文书可导出为 Word 文档。
- 反馈系统：每条助手消息支持 👍/👎、维度标签、评论、本地 outbox 和异步同步。
- 同步服务：`tools/sync-service` 支持反馈入库、查询、Markdown/JSON 导出、triage、skill 包 manifest 和 App updater manifest。
- Skill 更新：客户端可按 stable/beta 通道从同步服务拉取 skill zip。
- App 更新：集成 Tauri updater，生产发布前需配置真实 endpoint 和签名公钥。
- Dev-only SkillOpt：`Ctrl+Shift+O` 管理面板、评测用例、评分、提案和有界编辑机制。
- Agent trace：`Ctrl+Shift+D` 查看后端执行轨迹。
- 三套主题：通过 CSS custom properties 和 `data-theme="a|b|c"` 切换。

### Changed

- README 从 Tauri/Solid 模板改为产品级文档，覆盖功能、安装、部署、操作、skill 关系、同步与版本更新。
- 生产 feedback 路径明确为“律师端反馈 -> 同步服务 -> feedback-refinement -> skill 发布”，而不是让律师端直接运行 SkillOpt 管理面板。

### Security

- API key 存入 SQLite 前使用 AES-256-GCM 加密。
- 前端不读取 key 明文，只读取是否已配置。
- 文件访问限制在用户允许目录内，不启用 shell 插件。
- 反馈上传默认可关闭，回答全文上传默认关闭。

### Notes

- 生产构建前必须替换 `src-tauri/tauri.conf.json` 中 updater `pubkey` 和 endpoint。
- `vendor/ai-for-china-legal` 是独立 skill 项目；skill 改动应在子模块内单独提交，并通过 `tools/publish-skill.mjs` 发布 zip。
