# 标记后可修改重新提交（端到端「最新覆盖」）— 设计文档

- 日期：2026-06-18
- 分支：`feat/legal-qa-mode`
- 范围：桌面端前端、本地 Rust 后端、远程同步服务 `tools/sync-service`

## 1. 背景与问题

消息反馈组件 [`src/components/workspace/MessageFeedback.tsx`](../../../src/components/workspace/MessageFeedback.tsx) 当前有两套互斥界面：

- **未标记**：👍 / 👎 / 补充说明，外加可展开的备注 + 维度表单。
- **已标记**：一行静态文字 `已标记：有帮助`（或 `需改进`）+ 维度，**无法再编辑**。

数据流现状：
- 气泡内的 `metadata.feedback` 已经是单对象、**最新覆盖**（[`persistMessageFeedback`](../../../src/stores/conversation.ts)）。
- 但 [`insert_skill_feedback`](../../../src-tauri/src/db/queries.rs#L678) 每次都用新 UUID 做 **纯 INSERT**，且 [`submit_message_feedback`](../../../src-tauri/src/commands/skillopt.rs#L67) 每次都向同步 outbox **再排一次上传**。
- 远程 [`tools/sync-service`](../../../tools/sync-service) 的反馈存储是 **只追加的 JSONL**（[`appendFeedback`](../../../tools/sync-service/src/feedback-store.ts#L47)），每次上传分配新 `remote_id`，triage 按 `remote_id` 存；所有后台视图/统计读取整份合并日志（[`loadMergedFeedback`](../../../tools/sync-service/src/server.ts#L136)）。

后果：一旦「修改重新提交」，本地多一行 `skill_feedback`、上传多一条、后台多一条并**重复计数**，污染 SkillOpt 训练信号。

## 2. 目标

1. 点过赞/踩后，反馈控件**常驻可点**，可改评分 / 备注 / 维度并重新提交。
2. 每条消息**始终只保留最新一条**反馈——本地表、上传队列、远程后台三层都不留重复（端到端「最新覆盖」）。
3. 远程 JSONL 日志保持只追加（保留审计），去重只在**读取时**做，无需数据迁移、无数据丢失。

### 非目标
- 不做反馈修订历史（revision history）。明确选择「最新覆盖」。
- 不改 triage 写入协议、不改上传批次接口形状。
- 不做「撤回反馈」（取消标记）这一独立功能；本期只做改与重提。

## 3. 三层设计

### 3.1 前端 — `MessageFeedback.tsx` + `MessageFeedback.css`

把「两套界面」合并成**一套常驻界面**：

- 👍 / 👎 / 补充说明 **始终渲染**，无论是否已标记。
- 已标记时：
  - 当前评分按钮加高亮态（新增 CSS class，如 `.msg-feedback-btn.active`）。
  - 控件下方保留一行淡色状态小字：`✓ 已标记：有帮助 · 法条`（dimensions 存在时拼接），一眼可见。
- 信号初始化自 `existing()`：`comment` ← `existing()?.comment ?? ""`，`dims` ← `existing()?.dimensions ?? []`，使展开补充说明时**预填**现有内容，可直接改。
- 当前激活评分由 `existing()?.rating` 驱动（提交期间用 `submitting()` 做乐观禁用）。
- 交互原则（具体微交互在实现计划中定死）：
  - 点**另一个**评分 → 切换评分并重新提交；切到 👎 时先展开备注框，鼓励填原因，由表单按钮提交。
  - 点**当前**评分或「补充说明」→ 展开/收起预填的备注表单。
  - 所有重新提交都复用同一个 `submit(rating)` 路径（已有），不新增提交分支。
- `props.disabled`（回复流式进行中）时禁用全部按钮，逻辑不变。提交成功后 `persistMessageFeedback` 刷新 `existing()`，高亮与状态字自动更新、表单收起。

> 气泡显示本就最新覆盖，本层只是「打开入口 + 预填 + 高亮」，不改提交契约。

### 3.2 本地后端 — Rust

目标：`skill_feedback` 每条消息只一行、`feedback_id` 稳定；未发送的旧版本不上传。

1. **`skill_feedback` 改为按 `message_id` upsert**
   - 新增幂等迁移 `migrations/006_feedback_dedup.sql`，沿用现有 `ensure_*_schema` 风格（`include_str!` + `sqlx::raw_sql`，幂等）：
     - 先**去重历史数据**：每个 `message_id` 仅保留 `created_at` 最新的一行（`created_at` 相同时用 `rowid` 兜底），删除其余。
     - 再 `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_feedback_message ON skill_feedback(message_id)`。
   - 在 [`ensure_skill_opt_schema`](../../../src-tauri/src/db/queries.rs#L497) 之后调用该迁移（启动时执行链已有，确认其调用点并接入）。
   - [`insert_skill_feedback`](../../../src-tauri/src/db/queries.rs#L678) 改为 `INSERT … ON CONFLICT(message_id) DO UPDATE SET rating=…, comment=…, dimensions_json=…, skill_name=…, plugin_name=…, created_at=…`，**复用既有行的 `id`**（保持 `feedback_id` 稳定），并返回该行（`RETURNING` 或回查）。

2. **上传队列去陈旧** — [`outbox.rs`](../../../src-tauri/src/sync/outbox.rs) / [`skillopt.rs`](../../../src-tauri/src/commands/skillopt.rs#L67)
   - `feedback_outbox` 加一列 `feedback_id TEXT`：运行时 `pragma_table_info('feedback_outbox')` 检查 + `ALTER TABLE … ADD COLUMN`（沿用 [`ensure_sync_schema`](../../../src-tauri/src/db/queries.rs#L506) 中已有的列检查写法），加索引 `idx_feedback_outbox_feedback_id`。
   - `enqueue_feedback` 增参 `feedback_id`，写入该列。
   - 新增 `supersede_pending_feedback(pool, feedback_id)`：删除**同 `feedback_id` 且 `status = 'pending'`（尚未发送）**的排队项。
   - `submit_message_feedback` 提交顺序：upsert 行 → `supersede_pending_feedback(row.id)` → `enqueue_feedback(payload, feedback_id = row.id)`。
   - payload 已含 `feedback_id`（即 `row.id`）；新增 `updated_at`（= 刷新后的 `row.created_at`）供远程排序。

### 3.3 远程 — `tools/sync-service`

目标：上传后再改导致的「追加一行」在后台视图折叠成最新一条；JSONL 日志保持只追加。

- 在 [`feedback-store.ts`](../../../tools/sync-service/src/feedback-store.ts) 新增 `dedupeByFeedbackId(records): { kept: FeedbackRecord; groupRemoteIds: string[] }[]` 或等价结构：
  - 按 `payload.feedback_id` 分组；**无 `feedback_id` 的旧记录按 `remote_id` 独立成组，永不折叠**。
  - 每组保留 `received_at` 最新者（次级排序用 `payload.updated_at` / `payload.created_at`）。
- [`loadMergedFeedback`](../../../tools/sync-service/src/server.ts#L136) 改为：load all → dedupe → 附加 **继承式 triage**：
  - triage 仍按 `remote_id` 存；折叠时，若该组任一旧 `remote_id` 上存在**非默认** triage，则保留记录继承该组内 `triage.updated_at` 最近的一条（避免「改一次反馈丢了处理状态」）。
- 下游 `filterFeedback` / `summarizeFeedback` / `export.md` / `export.json` 全部基于去重后的列表 → **统计不再重复计数**。
- triage 写入接口（`POST /api/feedback/triage`）仍按当前展示（保留）记录的 `remote_id` 写入，**协议不变、无需数据迁移**。

## 4. 关键数据流（改完后）

```
点赞/改 → submit() → submit_message_feedback
  → upsert skill_feedback（按 message_id，id 稳定）
  → supersede 未发送的同 feedback_id 排队项 → enqueue 新 payload(feedback_id=row.id, updated_at)
  → persistMessageFeedback 更新气泡（最新覆盖）
[异步] outbox flush → POST /api/feedback/batch → 追加 JSONL（带稳定 feedback_id）
后台读取 → loadAllFeedback → dedupeByFeedbackId（留最新, triage 继承）→ 视图 / 统计
```

## 5. 边界情况

- 旧记录无 `feedback_id` → 不折叠，安全。
- 多设备：`feedback_id` 客户端生成、按消息稳定；不同设备消息 id 不同 → 不会误折叠。
- 历史重复行：本地一次性迁移去重；远程历史重复：读取时折叠（JSONL 保留审计）。
- 上传前连续多次修改：`supersede_pending_feedback` 保证只发最终版。
- 上传后修改：远程追加一行，靠 `dedupeByFeedbackId` 在读取层折叠。
- 切换评分保留已填的 `comment`/`dims`（除非用户改动），避免误清空。

## 6. 测试

- **Rust（`cargo test`）**：
  - upsert：同 `message_id` 先 insert 后 update → 仍一行、`id` 不变、字段为最新值。
  - 历史去重迁移：构造多行同 message_id → 迁移后仅留最新 + 唯一索引生效。
  - `supersede_pending_feedback`：pending 项被删、`sending`/`sent` 不受影响。
- **sync-service（`*.test.ts`）**：
  - `dedupeByFeedbackId`：同 feedback_id 多条 → 留 `received_at` 最新；无 feedback_id 不折叠。
  - triage 继承：旧 remote_id 有 triage → 折叠后保留记录带该 triage。
  - `summarizeFeedback` 在去重后计数正确（不重复）。
- **前端**：组件行为（预填、切换评分、改备注重提交、激活高亮）——按现有前端测试约定（无则手动 UAT 步骤记录）。

## 7. 涉及文件清单

- `src/components/workspace/MessageFeedback.tsx`、`MessageFeedback.css`
- `src-tauri/migrations/006_feedback_dedup.sql`（新增）
- `src-tauri/src/db/queries.rs`（`insert_skill_feedback` upsert、`ensure_*` 接入 006、outbox 列检查）
- `src-tauri/src/sync/outbox.rs`（`feedback_id` 列、`enqueue_feedback` 增参、`supersede_pending_feedback`）
- `src-tauri/src/commands/skillopt.rs`（提交顺序：upsert → supersede → enqueue；payload 加 `updated_at`）
- `tools/sync-service/src/feedback-store.ts`（`dedupeByFeedbackId` + triage 继承）
- `tools/sync-service/src/server.ts`（`loadMergedFeedback` 接入去重）
- 对应测试文件
