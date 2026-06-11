# 本地目录分析 Agent 架构参考

> 来源：GPT 研究整理（2026-06-10），供墨律 Inkstatute 实施计划引用。  
> **注意**：文中 Python 示例说明**控制平面职责**；墨律落地语言为 **Rust（Tauri 后端）**，原则相同、实现不同。

## 核心思想（禁止 vs 推荐）

**禁止：**

```text
递归读取目录所有文件 → 拼接成巨大 prompt → 发给 LLM
```

问题：上下文爆炸、成本高、幻觉高、证据不可追踪、大目录无法更新。

**推荐：**

```text
用户选择目录
  ↓
扫描 / 文件清单 / hash（增量）
  ↓
按类型解析 → 统一 Markdown + 元数据
  ↓
切块 chunk + 摘要 + embedding
  ↓
本地索引：向量 + 关键词 + SQLite 元数据
  ↓
用户需求 → Agent 规划 → 受控工具调用
  ↓
证据驱动写作 → Markdown / DOCX + evidence.json
```

**分工：**

```text
确定性程序：扫描、解析、索引、检索、写文件、安全控制
LLM：理解需求、规划检索、综合分析、生成文档、校验遗漏
```

## 参考框架

| 来源 | 借鉴点 |
|------|--------|
| [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents) | 规划、工具调用、状态维护 |
| [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling) | 模型请求工具 → 程序执行 → 结果回传 → 继续 |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | agent loop、文件工具、上下文管理 |
| [Codex CLI](https://developers.openai.com/codex/cli) | 工作区边界、审批模式 |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | 长运行、human-in-the-loop、状态持久化 |
| [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) | 工具可被多客户端复用（墨律已有 MCP 模块） |
| [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | BM25 + 向量融合、chunk 上下文前缀 |
| [Docling](https://docling-project.github.io/docling/) | PDF/DOCX/XLSX/PPT/HTML/图片 → Markdown |
| [Unstructured](https://docs.unstructured.io/open-source/core-functionality/partitioning) | 按元素类型 partition |

## 墨律 Rust 模块映射（建议）

```text
src-tauri/src/workspace/
  mod.rs              # WorkspaceManager 入口
  scanner.rs            # 扫描、忽略规则、sha256、增量
  parser.rs             # 文本/PDF/docx 解析 → Markdown
  chunker.rs            # 结构化切块 + 元数据
  index_store.rs        # SQLite files/chunks + FTS5 + 向量表
  embedder.rs           # 本地 embedding（V1 可延后，先用 FTS）
  retriever.rs          # BM25 + vector + RRF 融合
  tools.rs              # search_workspace / read_chunk / read_file ...
  verifier.rs           # 结论 ↔ 来源校验
  writer.rs             # Markdown/DOCX 输出 + evidence.json
```

与现有代码关系：

- `security/path_sandbox.rs` — root 边界
- `commands/chat_tools.rs` — agent loop 注册 workspace 工具
- `db/` — 可复用 SQLite 连接；索引表独立 migration

## 扫描规则（摘要）

- 仅允许用户授权的 `root` 目录
- 忽略：`.git`, `node_modules`, `venv`, `dist`, `build`, `__pycache__` 等
- 记录：`path`, `relative_path`, `size`, `mtime`, `sha256`
- 增量：hash/mtime 变更才重新解析
- `MAX_FILE_SIZE` 可配置（默认 50MB）

## 解析策略

| 类型 | 方式 |
|------|------|
| `.md/.txt/.json/.yaml/代码` | 直接读文本（utf-8 / gb18030 fallback） |
| `.pdf` | 现有 `pdf_extract` → V2 Docling |
| `.docx/.xlsx/.pptx` | V1 stub → V2 Docling/Unstructured |
| 图片 | V3 OCR |

中间格式统一 **Markdown + 元数据**（标题、页码、sheet 名、heading_path）。

## Chunk 规则

- 优先按结构：标题 → 小节 → 段落 → 表格 → 代码块
- 过长再按 token/字符切：512–1000 tokens，15–25% overlap
- 每个 chunk 必带：`relative_path`, `chunk_id`, `heading_path`, `page`, `sha256`
- chunk 前加 contextual prefix（文件名、章节、摘要）

## 索引层（V1 → V3）

**V1 最小可用：**

```text
SQLite: files 表 + chunks 表 + FTS5 全文索引
Agent 工具: search_workspace (FTS), read_file, read_chunk, list_files
```

**V2 可靠：**

```text
+ 向量索引（sqlite-vec / fastembed-rs）
+ BM25 + vector RRF 融合
+ reranker（可选本地小模型）
+ 增量索引 + 任务状态持久化
+ evidence.json 随输出保存
```

**V3 高级：**

```text
RAPTOR 层级摘要 / GraphRAG / 表格 agent / MCP server 暴露 workspace 工具
```

## Agent 工具清单（受控）

| 工具 | 说明 | 风险 |
|------|------|------|
| `search_workspace(query, k)` | 索引检索 chunk | 低 |
| `read_file(relative_path)` | root 内读文件，限大小 | 低 |
| `read_chunk(chunk_id)` | 读 chunk 全文 + 上下文 | 低 |
| `list_files(pattern)` | 列文件 | 低 |
| `analyze_table(path, sheet, question)` | CSV/XLSX 分析 | 中 |
| `write_markdown(filename, content)` | 写输出目录 | **需用户确认** |
| `write_docx(...)` | Markdown → DOCX | **需用户确认** |
| `verify_claims(draft)` | 引用校验 | 低 |
| `run_shell` / `delete_file` | **默认禁止** | 高 |

## Agent Loop（与现有 chat.rs 一致）

```text
while 未完成 && step < max:
  LLM(messages, tools) → 文本 | tool_calls
  if tool_calls:
    校验参数 + sandbox
    执行工具
    append tool result
  else:
    return 最终答案
```

Evidence 模式系统提示要点：

1. 不得臆测，先 `search_workspace` 再 `read_*`
2. 关键结论必须带 `relative_path` / `chunk_id`
3. 先大纲 → 逐章检索 → 写作
4. 信息不足标注「不足以判断」

## 文档生成三阶段

```text
Plan:   文档类型 + 章节大纲 + 每章 search_queries
Evidence: 逐节 search / read / 抽取事实
Write:  生成 Markdown + verifier + evidence.json
```

## 场景与算法选型

| 场景 | 策略 |
|------|------|
| A. 小目录（< ~200k tokens） | 目录摘要 + 关键原文直读 |
| B. 中等（几百–几千文件） | **标准 RAG（V1/V2 目标）** |
| C. 全局主题/风险 | GraphRAG（V3） |
| D. 长文档多跳 | RAPTOR（V3） |
| E. chunk 丢上下文 | Contextual prefix / Late Chunking |

## 版本路线（与墨律计划对齐）

### V1 — 可用

目录选择 → 扫描 → 文本/PDF 解析 → chunk → SQLite+FTS → search/read 工具 → agent loop → Markdown 输出

### V2 — 可靠

混合检索 + rerank + 来源引用 + 增量索引 + DOCX + 写文件审批 + evidence.json

### V3 — 高级

GraphRAG / RAPTOR / 多 agent（Planner/Researcher/Writer/Verifier）/ workspace MCP

## 工程铁律

1. LLM 不遍历全目录，只通过工具搜索/读取
2. 每个 chunk 可追溯来源
3. 生成物先 Markdown，再转 DOCX/PDF
4. 增量索引，避免每次全量解析
5. 写文件/删文件/跑命令需人工确认或禁止
6. 输出旁保存 `evidence.json`
7. 第一版不做 GraphRAG/多 Agent，先「解析准、检索准、引用准、输出稳」

## 与先前「manifest 延迟读取」的关系

manifest 仅作为 **索引未完成时的降级**：向 agent 提供文件清单统计，并提示「请先触发索引或调用 search_workspace」。  
正式路径：**选目录 → 后台索引 → search_workspace 驱动证据包**。
