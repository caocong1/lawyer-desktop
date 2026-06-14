# 墨律反馈运营（Phase C.5）

连接 **C 反馈入库** 与 **D Skill 自动下发** 的服务端工作流：管理、分析、消费律师反馈，改 skill 或 App，再发布。

## 架构位置

```
律师 App
  → feedback_outbox
  → 同步服务 POST /api/feedback/batch     [Phase C]
  → feedback.jsonl + triage
  → 导出 / 本地 AI 助手 + feedback-refinement SKILL   [Phase C.5 ← 本文]
  → 改 ai-for-china-legal 或 lawyer-desktop
  → publish-skill → manifest + zip
  → 客户端自动拉取                               [Phase D]
```

## 快速开始

### 1. 启动同步服务

```bash
cd tools/sync-service && bun run dev
```

### 2. 查看反馈汇总

```bash
# HTTP
curl -s "http://127.0.0.1:8787/api/feedback/summary?rating=down"

# 本地 CLI（无需 HTTP）
cd tools/sync-service
bun run feedback:summary -- --rating=down
```

### 3. 导出给本地 AI 助手

```bash
# 导出 Markdown（含汇总 + 明细 + 指令模板）
curl -s "http://127.0.0.1:8787/api/feedback/export.md?rating=down&status=open" -o feedback-export.md

# 或 CLI
bun run feedback:export -- --rating=down --status=open -o feedback-export.md
```

### 4. 在本地 AI 助手中执行

适用 Cursor、Codex、Claude Code 等任意能读仓库 + SKILL.md 的工具，无厂商绑定。

1. 打开 `ai-for-china-legal` 仓库（法律 skill 改动）和/或 `lawyer-desktop`（App 改动）
2. 将 `tools/feedback-refinement/SKILL.md` 复制到 skill 仓库 `shared/feedback-refinement/SKILL.md`（或在助手会话中 @ 引用 lawyer-desktop 内路径）
3. 附加 `feedback-export.md`，说明任务，例如：

   > 执行 feedback-refinement：处理 export 中 open 的 down 反馈，优先 litigation-legal / 文书质量相关

### 5. 发布后标记已处理

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"remote_id":"<uuid>","status":"handled","target_repo":"ai-for-china-legal","notes":"已发布 2026.06.15.1"}' \
  http://127.0.0.1:8787/api/feedback/triage
```

### 6. 发布 skill 包

```bash
# 在 lawyer-desktop 根目录
node tools/publish-skill.mjs --root ../ai-for-china-legal --version 2026.06.15.1 --notes "反馈：保函路径"
```

律师 App 下次启动或 6 小时轮询会自动更新。

---

## API 参考（Feedback Ops）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/feedback` | 列表 + 汇总（query 筛选） |
| GET | `/api/feedback/summary` | 仅汇总 |
| GET | `/api/feedback/export.md` | 供本地 AI 助手使用的 Markdown |
| GET | `/api/feedback/export.json` | 机器可读导出 |
| POST | `/api/feedback/triage` | 单条标记状态 |
| POST | `/api/feedback/triage/batch` | 批量标记 handled |

### Query 参数

| 参数 | 示例 | 说明 |
|------|------|------|
| `skill` | `litigation` | skill_name 或 plugin_name 模糊匹配 |
| `plugin` | `commercial-legal` | plugin 名 |
| `rating` | `down` | up / down |
| `status` | `open` | open / triaged / handled / wontfix |
| `target_repo` | `ai-for-china-legal` | 分流标记 |
| `since` | `2026-06-01` | ISO 时间下限 |
| `until` | `2026-06-15` | ISO 时间上限 |
| `limit` | `50` | 默认 100 |

Triage 状态保存在 `tools/sync-service/data/feedback-triage.json`。

---

## 改哪个仓库？

| 类型 | 仓库 | 示例 |
|------|------|------|
| 法条引用、文书结构、检索、案由 | `ai-for-china-legal` | 改 `plugins/.../SKILL.md` |
| 同步、隐私、UI、崩溃 | `lawyer-desktop` | 改 `src/` / `src-tauri/` |
| 评测基准 | `lawyer-desktop` skill_opt + skill 仓库 gold 文件 | rubric、律师审定样稿 |

---

## 与 SkillOpt 的关系

| | 律师 App（生产） | Dev `Ctrl+Shift+O` | 服务端 C.5 |
|--|------------------|---------------------|------------|
| 采集反馈 | ✅ MessageFeedback | ✅ | — |
| 分析/优化 | ❌ | ✅ 本地 DB | ✅ sync 导出 + SKILL |
| 发布 | ❌ | 手动 reload | publish-skill → D |

生产路径：**律师只点反馈 → 你在服务端跑 feedback-refinement → 发布 skill 包**。

---

## 发布前验证

改动涉及诉讼方案、文书结构或法律推理时，在 dev 环境跑 eval：

1. 准备评测材料、rubric 和律师审定样稿
2. `judge.rs` 对照 rubric + 律师审定样稿 + AI 输出
3. val 分数必须 **严格高于** 改动前基线才发布

---

## 文件索引

| 路径 | 用途 |
|------|------|
| `tools/sync-service/src/feedback-*.ts` | 存储、查询、导出 |
| `tools/sync-service/scripts/feedback-cli.ts` | 本地 CLI |
| `tools/feedback-refinement/SKILL.md` | 反馈精炼工作流（可复制到 skill 仓库） |
| `tools/publish-skill.mjs` | 打 zip + manifest |
| `docs/CLIENT_SYNC.md` | 客户端同步总览 |
