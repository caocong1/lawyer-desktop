# 墨律 Inkstatute

墨律是面向中国大陆律师的 AI 桌面助手。它把法律检索、案情分析、文书起草、引用核验、DOCX 导出、反馈闭环和 skill 更新放在一个本地优先的桌面应用里。

> 所有 AI 输出均为律师审查草稿，不构成法律意见，不能替代执业律师判断。

## 当前版本

| 项 | 值 |
|----|----|
| App 版本 | `0.1.0` |
| 产品名 | `墨律` |
| 窗口标题 | `墨律 Inkstatute` |
| Bundle ID | `com.sorawatcher.inkstatute` |
| 前端 | SolidJS + TypeScript + Vite |
| 桌面后端 | Tauri 2 + Rust |
| 数据库 | SQLite + `sqlx` migrations |
| 法律技能库 | `vendor/ai-for-china-legal` |

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 功能概览

### 律师工作流

- 首页提供常见文书入口，包括股权转让、借款合同、民事起诉状、法律意见书等。
- 支持自由提问、附件/目录上下文、`@` 引用工作区材料。
- 工作区采用三栏结构：流式对话、结构化文书预览、引用/法条侧栏。
- 支持会话持久化、切换、删除、自动创建新会话和标题栏同步。
- 支持三类任务模式：法律咨询、文书起草、证据/案情分析，并由后端自动路由 skill。

### 文书与引用

- LLM 输出可解析为结构化法律文书 JSON，并在预览区按章节展示。
- 引用面板区分法规与案例，支持 verified / retrieved / unverified 状态。
- 内置 citation audit，用于检查法条引用是否能被本地法库或检索结果支持。
- 支持导出 DOCX。
- 文书预览中保留风险提示和“根据风险提示补充条款”等快捷操作。

### 检索、材料和法库

- 文件访问走 Tauri 沙箱命令，不使用 shell 插件。
- 设置页可配置允许访问的本地目录。
- 支持绑定工作区目录并建立 FTS 索引，覆盖 PDF、DOCX、纯文本等材料。
- 随安装包内置法律法规库资源，包含民法典、公司法、刑法、民事诉讼法、劳动合同法、担保制度解释、独立保函规定、招投标法及实施条例等。
- 支持法规状态监控和状态变更提示。

### 设置、反馈和更新

- LLM Provider：支持 Qwen、DeepSeek、Kimi、OpenAI、Ollama 及自定义 OpenAI-compatible 接口。
- Fast Model：可选更快模型用于轻量任务，未配置时回退到主模型。
- Skills：配置、扫描、重载 `ai-for-china-legal`。
- MCP：读取 `.mcp.json` 并检查已配置 MCP 服务健康状态。
- Sync：配置同步服务地址、API Key、反馈上传、回答全文上传、stable/beta skill 通道。
- Feedback：每条助手消息支持点赞/点踩、维度标签和说明，进入本地 outbox 后异步同步。
- App 更新：集成 Tauri updater，生产发布前需替换 updater endpoint 和签名公钥。

### 开发专用

- `Ctrl+Shift+O`：SkillOpt 管理面板，仅在 dev 构建可见。
- `Ctrl+Shift+D`：Agent 执行轨迹面板。
- Debug 构建包含 MCP bridge 相关能力。

## 架构

```text
src/ SolidJS UI
  -> src/services/api.ts
  -> Tauri invoke / events
  -> src-tauri/src/
       commands/      Tauri 命令入口
       llm/           OpenAI-compatible 流式模型调用
       skills/        skill 扫描、router、research-gate 注入
       mcp/           stdio JSON-RPC MCP 客户端
       law_library/   内置法库、FTS、法规状态监控
       citations/     引用抽取与核验
       db/            SQLite、migrations、设置和会话持久化
       security/      路径沙箱、AES-GCM API key 存储
       sync/          反馈 outbox、skill zip 更新、App 更新辅助
       skill_opt/     dev-only skill 评测与提案机制
```

关键目录：

| 路径 | 说明 |
|------|------|
| `src/` | SolidJS 前端入口、组件、stores、API wrapper |
| `src-tauri/` | Rust/Tauri 后端、命令、数据库、LLM、MCP、法库 |
| `src-tauri/resources/law-library/` | 打包进安装包的法律法规资源 |
| `vendor/ai-for-china-legal/` | 中国法律 skill 套件，主项目以子模块/本地目录方式使用 |
| `tools/sync-service/` | 本地/内网同步服务，处理反馈运营、skill 包和 App manifest |
| `docs/` | 客户端同步、反馈运营、SkillOpt 等专题文档 |

## 和 `ai-for-china-legal` 的关系

墨律本体负责桌面 App、数据安全、LLM 调用、MCP、文书预览、反馈和更新；法律领域能力主要来自 `vendor/ai-for-china-legal`。

运行时大致流程：

1. 后端扫描 `vendor/ai-for-china-legal/*/skills/*/SKILL.md`。
2. `shared/research-gate/SKILL.md` 被注入为法律研究前置闸门。
3. 对话时模型通过 `select_skill` 选择适用 skill。
4. skill 需要检索时，经墨律 MCP / 本地法库 / 文件索引取数。
5. 律师反馈进入 outbox，经同步服务导出后，用 `feedback-refinement` 工作流改 skill。
6. 发布 skill zip 后，客户端按 stable/beta 通道自动拉取更新。

子模块更新和 skill 发布是两个概念：

- 开发时：更新 `vendor/ai-for-china-legal` 子模块提交，再在主仓库记录新的 submodule pointer。
- 生产时：通过 `tools/publish-skill.mjs` 生成 zip 和 manifest，客户端从同步服务下载。

## 环境要求

- Windows 10/11。
- Bun，用于前端依赖、脚本和 Vite dev server。
- Rust 2021 工具链。Windows 建议使用 rustup MSVC 工具链。
- Node.js 18+，用于 MCP connector 和部分工具脚本。
- Git submodule：`vendor/ai-for-china-legal`。

## 安装与启动

```bash
git clone <repo-url>
cd lawyer-desktop
git submodule update --init --recursive

bun install
bun run tauri dev
```

首次启动后，到“设置 -> Provider”配置模型。也可以在开发环境创建 `.env`：

```bash
QWEN_API_KEY=
DEEPSEEK_API_KEY=
KIMI_API_KEY=
OPENAI_API_KEY=

LAW_DB_API_URL=https://flk.npc.gov.cn/api
LAW_DB_API_KEY=
WENSHU_API_URL=
WENSHU_API_KEY=
```

API key 在 App 设置中保存时会写入 SQLite，并用 AES-256-GCM 加密；前端只拿到 `has_api_key` 这类标记，不拿明文。

## 常用命令

```bash
bun run dev
bun run dev:stop
bun run tauri dev
bun run tauri:dev
bun run build
bun run tauri build
bunx tsc -b
bun run test
bun run test:rust
bun run test:mcp
bun run test:llm-tools
```

Vite/Tauri dev 端口固定为 `1420`，配置见 `vite.config.ts` 和 `src-tauri/tauri.conf.json`。

## 基本操作

1. 启动 App。
2. 在设置页配置主模型，必要时配置 fast model、skills root、MCP 和允许访问目录。
3. 回到首页，选择文书卡片或直接输入任务。
4. 如需结合材料，先在设置页允许目录，再在会话中附加文件/目录或用 `@` 引用上下文。
5. 在工作区查看流式回答、文书预览和引用面板。
6. 对结果点 👍/👎，必要时填写问题维度和说明。
7. 对结构化文书使用 DOCX 导出。

## 同步服务、反馈运营和更新

同步服务不是律师端必需项，但用于团队内测、反馈运营、skill 分发和 App updater manifest。

```bash
cd tools/sync-service
bun install
bun run dev
# 默认 http://127.0.0.1:8787
```

常用运营命令：

```bash
bun run sync:feedback:export -- --rating=down --status=open -o feedback-export.md
node tools/publish-skill.mjs --root ../ai-for-china-legal --version 2026.06.15.1 --notes "反馈驱动更新"
```

详细流程见：

- [docs/CLIENT_SYNC.md](docs/CLIENT_SYNC.md)：客户端同步、隐私和生产构建注意事项。
- [docs/FEEDBACK_OPS.md](docs/FEEDBACK_OPS.md)：反馈查看、导出、分流、处理、发布。
- [tools/sync-service/README.md](tools/sync-service/README.md)：同步服务 API 和 CLI。
- [docs/SKILLOPT.md](docs/SKILLOPT.md)：dev-only SkillOpt 面板和评分/闸门机制。

生产发布前必须完成：

- 替换 `src-tauri/tauri.conf.json` 中 updater endpoint 和 `pubkey`。
- 运行 Tauri signer 生成真实签名配置。
- 不把服务端 API key、GitHub token、法律数据库密钥打包进 exe。
- 明确 stable/beta skill 通道和回滚策略。

## MCP

MCP 配置在 `.mcp.json`：

- `law-database`：法规检索，默认使用 `vendor/ai-for-china-legal/connectors/law-database/index.js`。
- `wenshu`：裁判文书检索 connector，使用 `vendor/ai-for-china-legal/connectors/wenshu/index.js`。

环境变量可来自 `.env` 或系统环境变量。未配置或健康检查失败时，App/skill 应降级为要求用户提供材料或标注“需律师核验”。

## 数据位置与隐私

| 数据 | 位置/说明 |
|------|-----------|
| SQLite | Tauri app data dir 下的 `lawyer-desktop.db` |
| API key | SQLite 加密存储，密钥文件在 app data dir |
| 会话/消息/文书 | SQLite |
| 反馈 outbox | SQLite，失败后指数退避重试 |
| skills | 开发时来自 `vendor/ai-for-china-legal`，生产可下载到 app data dir |
| 法库资源 | `src-tauri/resources/law-library/`，打包进安装包 |
| 同步服务数据 | `tools/sync-service/data/` |

默认隐私策略：

- 反馈上传可关闭。
- 回答全文上传默认关闭，只上传摘要。
- 设备 ID 是首次启动生成的匿名 UUID。
- 文件访问必须通过允许目录和沙箱命令。

## 文档索引

| 文档 | 内容 |
|------|------|
| [AGENTS.md](AGENTS.md) | 开发者快速参考：技术栈、命令、架构、坑点 |
| [docs/CLIENT_SYNC.md](docs/CLIENT_SYNC.md) | 客户端反馈同步、隐私、生产构建 |
| [docs/FEEDBACK_OPS.md](docs/FEEDBACK_OPS.md) | 反馈运营到 skill 发布的闭环 |
| [docs/SKILLOPT.md](docs/SKILLOPT.md) | dev-only SkillOpt 面板说明 |
| [tools/sync-service/README.md](tools/sync-service/README.md) | 同步服务 API、CLI、发布说明 |
| [vendor/ai-for-china-legal/README.md](vendor/ai-for-china-legal/README.md) | 法律 skill 项目说明 |

## 开发约定

- UI 文案使用中文。
- SolidJS store getter 必须调用，例如 `messages()`。
- 新增 Tauri command 时同步修改 Rust command、`src/lib.rs` handler 和 `src/services/api.ts` wrapper。
- 不引入 `tauri-plugin-shell`；文件访问走沙箱命令。
- skill 项目是子模块，修改后需要在子模块内单独提交，再更新主仓库 submodule pointer。

## 许可证

当前许可证尚未正式确定。使用、分发和商用前请先确认法律文本和第三方依赖许可。
