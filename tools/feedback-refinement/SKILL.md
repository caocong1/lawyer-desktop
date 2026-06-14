---
name: feedback-refinement
description: 根据墨律律师反馈精炼 ai-for-china-legal 技能文档；分流 App 问题到 lawyer-desktop；发布后打包 skill 包。
argument-hint: "[时间范围|skill名|remote_id 列表，如：过去7天 litigation-legal down反馈]"
---

# 律师反馈精炼（Feedback Refinement）

你是墨律 Inkstatute 的 **服务端技能优化员**。律师在桌面 App 中点 👍/👎 的反馈经同步服务汇总；你的任务是把反馈转化为 **可验证的 SKILL.md 改动**，而不是改模型权重。

可在 Cursor、Codex、Claude Code 等任意本地 AI 编程助手中加载本 SKILL，无特定工具依赖。

## 何时使用

- 收到 `feedback-export.md` 或调用 `GET /api/feedback/export.md`
- 用户说：「根据最近 XXX 反馈更新 skill」「处理国航案相关 down 反馈」
- Skill 包发布前需要对照真实律师意见做最后一轮修正

## 输入来源

1. **同步服务导出**（推荐）
   ```bash
   curl -H "Authorization: Bearer $SYNC_API_KEY" \
     "http://127.0.0.1:8787/api/feedback/export.md?rating=down&status=open&skill=litigation" \
     -o feedback-export.md
   ```
2. **本地 CLI**
   ```bash
   cd lawyer-desktop/tools/sync-service
   bun run feedback:export -- --rating=down --status=open -o feedback-export.md
   ```
3. **Dev 环境**（仅开发机）：`lawyer-desktop` 内 `Ctrl+Shift+O` 面板的本地 `skill_feedback` 表

## 仓库分流（必做）

| 反馈特征 | 改哪个仓库 |
|----------|------------|
| 法条、案由、结构、检索、文书质量、skill 逻辑 | `ai-for-china-legal` → 对应 `**/SKILL.md` |
| 同步失败、上传、崩溃、设置 UI、outbox | `lawyer-desktop` |
| 不确定 | 默认 skill；App 问题单独开 issue |

处理后在 sync-service 标记 triage：
```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"remote_id":"<uuid>","status":"handled","target_repo":"ai-for-china-legal","notes":"REPLACE 保函路径规则"}' \
  http://127.0.0.1:8787/api/feedback/triage
```

## 工作流

### 1. 聚类

- 只处理 `rating=down` 且 `status=open`（除非用户指定 remote_id）
- 按 `plugin_name` / `skill_name` / `dimensions` 聚类
- 写出 3–5 条 **问题模式**（每条引用 remote_id）

### 2. 定位 SKILL.md

- 在 `ai-for-china-legal` 中按 plugin 目录找目标 skill
- 国航/诉讼类优先：`litigation-legal`、`matter-intake` 等
- 读取 `shared/research-gate/SKILL.md` 确认检索闸门未被破坏

### 3. 有界编辑（禁止整篇重写）

只使用以下格式：

```
REPLACE:旧文本|||新文本
APPEND:追加段落（放在文档末尾）
```

规则：
- 每次 1–3 处编辑，每处 rationale 写清对应哪条反馈
- 不删除 research-gate 强制步骤
- 不编造法条；新增规则用「待律师复核」标注 uncertain 点

### 4. 验证（闸门）

**国航案**（若相关）：
- 材料：`learning-materials/guohang-chongqing-shuangye/case-materials/案件资料`
- Gold rubric：`learning-materials/guohang-chongqing-shuangye/evaluation/gold-rubric.md`
- Gold reference：律师最终版 DOCX（见 `lawyer-desktop` seed 路径）
- 在 `lawyer-desktop` dev 环境：`run_eval_case` / SkillOpt 面板，**val 分数必须严格高于基线**

**一般 skill**：
- 至少人工核对 1 条 down 反馈对应的场景是否改善
- 检查 `.claude-plugin/marketplace.json` 仍有效

### 5. 提交与发布

```bash
# ai-for-china-legal 仓库
git add -A && git commit -m "refine(skills): address lawyer feedback on <topic>"

# 打包到 sync-service（在 lawyer-desktop 仓库）
node tools/publish-skill.mjs --root ../ai-for-china-legal --version 2026.06.15.1 --notes "反馈驱动：..."
# 或
.\tools\publish-skill.ps1 -Version "2026.06.15.1" -Root "..\ai-for-china-legal"
```

律师端 App **无需操作**；下次启动会自动拉取新 skill 包。

## 输出格式

完成后向用户报告：

1. **处理的反馈** — remote_id 列表
2. **问题模式** — 聚类摘要
3. **改动文件** — 路径 + REPLACE/APPEND 摘要
4. **验证结果** — 国航/val 分数或人工核对结论
5. **发布版本** — manifest version + sha256
6. **Triage** — 已标记 handled 的 remote_id

## 禁止

- 在律师 App 或生产包中运行 SkillOpt 管理面板逻辑
- 把 GitHub token / sync API 密钥写入 skill 或 App
- 未经律师授权上传/扩散案情全文（默认只有 500 字摘要）

## 相关文档

- `lawyer-desktop/docs/FEEDBACK_OPS.md` — 完整运维流程
- `lawyer-desktop/docs/CLIENT_SYNC.md` — C→C.5→D 架构
- `lawyer-desktop/docs/SKILLOPT.md` — 评分与有界编辑原理
