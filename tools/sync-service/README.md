# 墨律同步服务

本机/内网运行的轻量同步服务：**C 反馈入库** → **C.5 反馈运营** → **D/E 包分发**。

## 启动

```bash
cd tools/sync-service
bun install
bun run dev
# 默认 http://127.0.0.1:8787
# 管理台 http://127.0.0.1:8787/admin
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `SYNC_PORT` | 端口，默认 8787 |
| `SYNC_HOST` | 绑定地址，默认 127.0.0.1 |
| `SYNC_API_KEY` | 若设置，客户端需 `Authorization: Bearer <key>` |
| `SYNC_DATA_DIR` | 数据目录，默认 `./data` |

## 管理 Web 页

启动服务后打开 **http://127.0.0.1:8787/admin**（`/` 同页）：

- 汇总统计（好评/差评、open/handled）
- 筛选、列表、详情抽屉
- 单条 / 批量 triage（状态、目标仓库、备注）
- 导出 Markdown / JSON（与 API 相同筛选参数）

若设置了 `SYNC_API_KEY`，页面会提示输入 Bearer token（保存在 sessionStorage，仅当前标签页）。

## API

### 健康与采集 (C)

- `GET /health`
- `POST /api/feedback/batch` — 客户端 outbox 批量上报

### 反馈运营 (C.5)

- `GET /api/feedback?rating=down&status=open&skill=litigation` — 列表 + 汇总
- `GET /api/feedback/summary` — 仅汇总统计
- `GET /api/feedback/export.md` — **供本地 AI 助手使用的 Markdown 导出**
- `GET /api/feedback/export.json` — JSON 导出
- `POST /api/feedback/triage` — 标记单条 `{ remote_id, status, target_repo, notes }`
- `POST /api/feedback/triage/batch` — 批量 `{ remote_ids, status }`

Triage 状态文件：`data/feedback-triage.json`

### 本地 CLI（无需 HTTP）

```bash
bun run feedback:summary -- --rating=down
bun run feedback:export -- --rating=down --status=open -o feedback-export.md
bun run feedback:triage -- --remote-id=<uuid> --status=handled
```

### Skill / App 分发 (D/E)

- `GET /api/skills/latest?channel=stable&current=<version>` — 无更新返回 204
- `GET /api/skills/download/<version>`
- `GET /api/app/latest/{target}/{arch}/{current_version}`
- `POST /api/client/heartbeat`（可选）

## 发布 skill 包

在 **lawyer-desktop 根目录**：

```bash
node tools/publish-skill.mjs --root ../ai-for-china-legal --version 2026.06.15.1 --notes "反馈驱动更新"
```

或 PowerShell：

```powershell
.\tools\publish-skill.ps1 -Version "2026.06.15.1" -Root "..\ai-for-china-legal"
```

产物：

- `data/skills/<version>.zip`
- `data/skills/manifest-stable.json`

## 完整工作流

见 [docs/FEEDBACK_OPS.md](../../docs/FEEDBACK_OPS.md) 与 [tools/feedback-refinement/SKILL.md](../feedback-refinement/SKILL.md)。

## 发布 App 更新

将 Tauri `latest.json` 放入 `data/app/latest.json`（见 [Tauri updater](https://v2.tauri.app/plugin/updater/)）。

生产环境请运行 `tauri signer generate` 并更新 `src-tauri/tauri.conf.json` 中的 updater 配置。
