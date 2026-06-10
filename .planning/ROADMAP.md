# Roadmap: 墨律 Inkstatute

## Overview

绿场重建 lawyer-desktop：Bun + Tauri 2.11 + SolidJS，集成 ai-for-china-legal submodule，6 阶段顺序交付。

## Phases

- [ ] **Phase 0: 地基与验证** — 干净仓库、可启动空壳、GSD 工件、submodule
- [ ] **Phase 1: UI 壳层** — 墨律视觉与交互（静态 seed 数据）
- [ ] **Phase 2: Agent 对话核心** — LLM 流式 + Skills + research-gate
- [ ] **Phase 3: 文书工作区真实化** — 结构化文书、预览、引用、DOCX
- [ ] **Phase 4: 数据持久化** — SQLite 会话/消息/配置/文书
- [ ] **Phase 5: MCP 连接器** — law-database + 健康检查
- [ ] **Phase 6: 安全与发布** — 加密、沙箱、CSP、测试、构建

## Phase Details

### Phase 0: 地基与验证
**Goal**: 干净仓库 + 可启动空壳 + GSD + submodule
**Success Criteria**:
1. `bun run tauri dev` 显示墨律标题栏
2. `bunx tsc --noEmit` 零错误
3. `cargo check` 零错误
4. ROADMAP 含 6 阶段
5. submodule 可 init

### Phase 1: UI 壳层
**Goal**: 100% 还原 Claude 原型视觉，静态 seed 数据
**Success Criteria**:
1. Home → Workspace 演示流程可走通
2. 主题 a/b/c 切换持久化
3. 无控制台 error
**UI hint**: yes

### Phase 2: Agent 对话核心
**Goal**: 真实 LLM 取代 mock，Skills 从 submodule 加载
**Success Criteria**:
1. 流式对话可用
2. 股权转让意图路由 commercial-legal
3. research-gate 在 system prompt
4. 设置面板 provider + 测试

### Phase 3: 文书工作区真实化
**Goal**: 预览/引用/修订来自 LLM 输出
**Success Criteria**:
1. 起草 → 风险 → 补条款 → 预览更新
2. DOCX 导出可用
3. 引用可定位条款
**UI hint**: yes

### Phase 4: 数据持久化
**Goal**: 重启不丢数据
**Success Criteria**:
1. 会话消息恢复
2. 自动标题
3. 删除会话
4. Provider 持久化

### Phase 5: MCP 连接器
**Goal**: law-database 接入
**Success Criteria**:
1. MCP 状态显示
2. LLM 可调用 law-database
3. 崩溃可检测

### Phase 6: 安全与发布
**Goal**: 内测安全基线
**Success Criteria**:
1. API key 加密
2. 路径白名单
3. 测试绿灯
4. 生产构建成功

## Progress

| Phase | Status | Completed |
|-------|--------|-----------|
| 0. 地基与验证 | In progress | - |
| 1. UI 壳层 | Not started | - |
| 2. Agent 对话 | Not started | - |
| 3. 文书工作区 | Not started | - |
| 4. 数据持久化 | Not started | - |
| 5. MCP | Not started | - |
| 6. 安全发布 | Not started | - |
