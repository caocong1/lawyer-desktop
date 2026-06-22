# 会话标题、列表入口与首次预览修复计划

## Summary

- 去掉顶部中间的“新会话 / 墨律”面包屑，顶部只保留品牌、品牌右侧会话列表图标、主题/设置/窗口控制。
- 会话标题支持自动生成和会话列表内手动编辑；自动标题会持续更新，直到用户手动编辑该会话标题。
- 修复首次新会话自动发送后，产出型任务右侧预览不出现的问题。

## Key Changes

- `TitleBar`：删除 `tb-crumbs` 中的会话/文档标题显示，保留空白拖拽区域；在品牌标题右侧增加会话列表图标按钮，使用现有 `Icon name="grid"` 或 `clock`；移除右侧旧的搜索式会话入口。
- `HomePage`：移除现有页面内“会话列表”文字按钮，避免和顶部品牌旁入口重复。
- `ConversationDrawer`：每条会话增加编辑按钮；编辑时显示单行输入框，`Enter` 保存、`Esc` 取消、失焦保存；标题 trim 后限制 1-30 字符，空值不保存并提示。
- `conversation` store/API：新增 `renameConversation(id, title)`，调用现有 `updateConversationTitle` 后同步本地 `conversations()`，避免必须重新打开抽屉才看到结果。
- 后端自动标题：复用现有 `settings_json` 记录 `title_source`：
  - 自动生成写入 `{ "title_source": "auto" }`。
  - 手动编辑写入 `{ "title_source": "manual" }`。
  - `maybe_auto_title` 不再只在标题为“新会话”时运行，而是在每轮完成后更新非 manual 会话标题。
  - 标题生成提示改为“8-24 字为宜，最多 30 字”，`clean_title` 硬截断 30 字符。

## Preview Fix

- 不再让 `AgentTracePanel` 独占运行时 `agent-trace` 监听；把 trace/stream 监听前置到稳定的工作区运行时，确保首次自动发送前监听已注册。
- `dispatchTurn` 在有 `forcedMode` 时先同步设置本地 `workspaceMode / activeDraftResponse / activeEvidenceResponse / draftWorkflowActive`，右侧预览生成态不依赖后续 trace 事件是否先到。
- `finishStreaming` 判断本轮是否为 draft/evidence 时，以 `activeDraftResponse/activeEvidenceResponse`、当前 workflow mode、`workspaceMode` 共同兜底；产出型内容解析失败时保留右侧预览区域并显示现有错误文案，不再静默回到纯聊天布局。
- 纯法律问答仍保持隐藏右侧预览。

## Test Plan

- 前端：补 `ConversationDrawer` 标题编辑交互测试，覆盖保存、取消、空标题、删除按钮不被编辑态影响。
- 前端：补 `chatLayout` 或 store 测试，覆盖首次 draft/evidence 在 trace 迟到或缺失时仍显示右侧预览。
- 后端 Rust：补 `clean_title` 截断/前缀清理测试；补 `settings_json.title_source=manual` 时自动标题不覆盖的单元测试。
- 手工验收：启动 `bun run dev`，验证首页/会话页顶部品牌旁图标均可打开会话列表；新建起草任务首轮结束后右侧预览出现；手动改名后继续对话不被自动标题覆盖。

## Assumptions

- 手动编辑过的标题优先级最高，后续自动标题不覆盖。
- 自动标题最大 30 个字符；超过会被截断。
- 会话列表入口统一放在顶部品牌标题右侧，不再保留首页页面内重复入口。
