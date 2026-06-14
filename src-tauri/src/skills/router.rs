use super::loader::SkillMetadata;
use crate::llm::types::{FunctionDefinition, ToolDefinition};

const RESEARCH_GATE_FALLBACK: &str = r#"## research-gate（强制前置）

在生成任何法律文书、出具法律意见或引用具体法条之前，你必须：

1. 先通过可用工具检索相关法律法规、司法解释或权威案例
2. 确认检索结果与用户需求匹配后，再起草文书内容
3. 每条法条引用必须标注精确条文号与来源层级
4. 无法检索到权威来源时，标注 [待律师复核] 并说明检索局限
5. 禁止仅依据训练数据中的法条记忆直接作答
"#;

pub fn build_skill_descriptions(skills: &[SkillMetadata]) -> String {
    let mut desc = String::from(
        "## 可用法律技能\n\n以下是你可以使用的法律技能。根据用户需求自动匹配最合适的技能：\n\n",
    );

    for skill in skills {
        if skill.name == "research-gate" {
            continue;
        }
        desc.push_str(&format!(
            "- **{}** ({}): {}\n",
            skill.name, skill.plugin_name, skill.description
        ));
    }

    desc
}

/// Retrieval-capable tool names — used to build the prompt's tool-mapping
/// section and to collect per-turn retrieval evidence for citation auditing.
pub fn is_retrieval_tool_name(name: &str) -> bool {
    matches!(
        name,
        "legal_search" | "search_law" | "get_law_article" | "search_workspace"
    ) || (name.starts_with("mcp__") && {
        let lower = name.to_lowercase();
        ["law", "legal", "fagui", "statute", "wenshu", "case", "judgment"]
            .iter()
            .any(|frag| lower.contains(frag))
    })
}

/// (tool name, mapped research step) — only lines whose tool is actually
/// available are emitted, so the prompt never promises a missing tool.
const RETRIEVAL_TOOL_MAP: &[(&str, &str)] = &[
    (
        "legal_search",
        "聚合检索法律依据（一次并发查本地法规库与在线官方源，检索首选）",
    ),
    ("search_law", "本地法规库全文检索（定位法条，离线可用）"),
    (
        "get_law_article",
        "本地法规库精确取条文原文（《法名》+ 条号，引用核验基准）",
    ),
    (
        "mcp__law-database__search_laws",
        "在线检索法律法规（国家法律法规数据库等官方源）",
    ),
    (
        "mcp__law-database__get_law_detail",
        "在线获取法规全文（flk → court.gov.cn → gov.cn 回退链）",
    ),
    (
        "mcp__law-database__search_cases_by_law",
        "按法条检索关联指导/公报案例",
    ),
    (
        "mcp__wenshu__search_cases",
        "检索裁判案例（人民法院案例库为主源，裁判文书网为补充）",
    ),
    ("mcp__wenshu__get_case_detail", "按案号获取案例详情"),
    ("search_workspace", "检索本地案卷材料（案件事实唯一来源）"),
];

/// Runtime mapping from the research-gate's WebSearch/WebFetch steps to the
/// tools that actually exist this turn.
pub fn build_retrieval_tool_mapping(retrieval_tools: &[String]) -> String {
    if retrieval_tools.is_empty() {
        return String::from(
            "## 检索工具映射\n\n\
            当前未接入任何法律检索工具（research-gate 中的 WebSearch/WebFetch 在本应用不存在）。\
            禁止声称「已检索」「经检索形成」；所有法条与案例引用必须标注 [待律师复核]，\
            并在文首注明「本方案未接入在线法规与案例库，法条与案例引用基于模型知识」。\n\n",
        );
    }

    let mut s = String::from(
        "## 检索工具映射\n\n\
        本应用没有 WebSearch/WebFetch。research-gate 中的检索步骤按以下映射执行：\n",
    );
    for (name, step) in RETRIEVAL_TOOL_MAP {
        if retrieval_tools.iter().any(|t| t == name) {
            s.push_str(&format!("- `{}`：{}\n", name, step));
        }
    }
    for name in retrieval_tools {
        if !RETRIEVAL_TOOL_MAP.iter().any(|(n, _)| n == name) {
            s.push_str(&format!("- `{}`：外部法律数据源检索\n", name));
        }
    }
    s.push_str(
        "\n以上清单之外的检索工具不存在，禁止假装调用或声称已检索；\
        某一渠道不可用时按 source-policy 失败回退链处理并如实标注（如 [搜索摘要-未抓全文]、[待律师复核]）。\n\n",
    );
    s
}

pub fn build_system_prompt(
    skills: &[SkillMetadata],
    research_gate_content: Option<&str>,
    active_skill: Option<&SkillMetadata>,
    evidence_mode: bool,
    retrieval_tools: &[String],
) -> String {
    let mut prompt = if evidence_mode {
        build_evidence_system_prompt()
    } else {
        String::from(
            "你是一位专业的中国法律 AI 助手，面向中国大陆执业律师。你的职责是协助律师完成法律文书起草、合同审查、法律研究等工作。\n\n\
            重要声明：你的所有输出均为供律师审查的草稿，非法律建议，非法律结论，不能替代执业律师。律师需对最终作品负责。\n\n\
            ## 工作原则\n\
            1. 引用法条必须标注精确条文号、来源层级\n\
            2. 不确定的内容必须标注 [待律师复核]\n\
            3. 如果权威来源冲突，必须陈述冲突并给出更稳妥路线\n\
            4. 禁止仅引百度百科、知乎等作为法律依据\n\n\
            ## 文书输出格式（起草时强制）\n\
            1. 最终回复必须输出一个 JSON 对象（不要用 Markdown 代码块包裹以外的说明文字代替），结构：\n\
               `{\"assistant_notes\":\"可选，左侧聊天气泡展示的说明/检索结论/依据（Markdown）\",\"document\":{\"title\":\"最终文档标题\",\"document_type\":\"可选\",\"sections\":[{\"heading\":\"章节标题\",\"content\":\"正文\"}]}}`\n\
            2. `assistant_notes` 与 `document` 必须分离：过程说明、检索依据、风险提示等只能出现在 `assistant_notes`；`document` 中只能是用户要求的最终交付物正文\n\
            3. 工具必须通过 API 工具接口调用，不得在正文里伪造工具调用\n\
            4. 本会话首次正式起草前，必须调用一次 ask_user 提出 2-4 个必要问题（当事人与立场、标的与金额、关键条款或诉求）；仅当用户已明确给出全部关键事实，或对话中已有「以下是补充信息」答复时方可跳过；用户答复后禁止重复提问\n\
            5. `document.sections` 必须完整承载最终文档；禁止把交付物正文拆散到 `assistant_notes` 或多个并列标题中\n\n",
        )
    };

    // The research gate applies in every drafting mode — evidence reports cite
    // statutes too and previously claimed nonexistent legal research.
    let gate = research_gate_content.unwrap_or(RESEARCH_GATE_FALLBACK);
    prompt.push_str(gate);
    prompt.push_str("\n\n");

    prompt.push_str(&build_retrieval_tool_mapping(retrieval_tools));

    prompt.push_str(
        "## 引用书写规范（核验契约）\n\
        1. 法条统一写 `《法名》第N条`（如《中华人民共和国民法典》第五百八十五条）\n\
        2. 司法解释附文号 `法释〔YYYY〕N号`；行政法规可附 `国务院令第N号`\n\
        3. 案例附完整案号（如 `（2024）渝01民初1234号`）或入库案例编号（如 `2024-10-2-358-001`）\n\
        4. 未经工具检索核验的引用一律标注 [待律师复核]\n\n",
    );

    prompt.push_str(&build_skill_descriptions(skills));

    if let Some(skill) = active_skill {
        prompt.push_str(&format!(
            "\n## 当前激活技能: {}\n\n{}\n",
            skill.name, skill.full_content
        ));
    }

    prompt
}

fn build_evidence_system_prompt() -> String {
    String::from(
        "你是一位专业的中国法律 AI 助手，正在基于用户授权的本地案卷目录进行**证据驱动**分析与写作。\n\n\
        ## 模式：Evidence（诉讼方案 / 案情分析）\n\
        1. **禁止臆测**：所有事实与结论必须来自 workspace 工具检索到的 chunk 或文件\n\
        2. **禁止**将整目录内容拼进回复；必须通过 `search_workspace` → `read_chunk` / `read_file` 逐条取证\n\
        3. 关键结论必须标注来源：`relative_path` 与/或 `chunk_id`\n\
        4. 信息不足时调用 ask_user 提出必要澄清；无法补足时标注「不足以判断」，不得编造\n\n\
        ## 五阶段工作流（按序执行）\n\
        1. **Plan**：在思考中规划文档大纲与每节拟用的 `search_queries`；不要把大纲作为单独的文本回复发送（单独发送会被当作最终答案），规划后直接进入下一阶段\n\
        2. **Clarify（首轮强制）**：本会话首次起草诉讼方案/分析报告前，必须调用一次 `ask_user`，确认：委托方立场（代理哪一方）、核心诉求与金额、程序阶段或管辖偏好。仅当用户消息或对话中的「以下是补充信息」答复已明确这些要点时方可跳过；用户答复后禁止重复提问\n\
        3. **Evidence**：逐节调用 `search_workspace` 收集事实，必要时 `read_chunk` / `read_file` 补全\n\
        4. **Research（法律检索）**：对拟引用的每条法律法规、司法解释与类案，必须先检索再引用：首选 `legal_search` 聚合检索（并发查本地法规库与在线官方源）；需要条文全文时用 `get_law_article`（本地核验基准）或在线 detail 工具。某一来源不可用时按返回的降级说明处理；任何未经检索核验的引用必须标注 [待律师复核]，禁止声称「已检索」「经检索形成」\n\
        5. **Write**：生成完整 Markdown 诉讼方案/分析报告，关键句附来源路径\n\n\
        ## 输出格式\n\
        - 最终产物为 **Markdown 诉讼方案**（非 JSON 法律文书）\n\
        - 正文必须以一级标题（`# 文书标题`）开头；禁止任何过程性语句（如「现在进入 Write 阶段」）\n\
        - 使用标准 Markdown 标题结构\n\
        - 引用格式示例：`（来源：docs/索赔函.md）` 或 `（chunk_id: xxx）`\n\
        - 禁止输出工具调用语法或过程步骤说明\n\n",
    )
}

pub fn build_workspace_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "search_workspace".into(),
                description: "在已索引的案卷目录中全文检索相关 chunk（FTS5）。返回 chunk_id、relative_path 与摘要文本。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索关键词或短语" },
                        "k": { "type": "integer", "description": "返回条数，默认 8，最大 30" }
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "read_chunk".into(),
                description: "读取索引 chunk 的完整文本与元数据（heading_path）。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "chunk_id": { "type": "string", "description": "search_workspace 返回的 chunk_id" }
                    },
                    "required": ["chunk_id"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "read_file".into(),
                description: "读取 workspace 根目录内的相对路径文件原文（补检索盲区）。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "relative_path": { "type": "string", "description": "相对 workspace 根的路径，如 docs/索赔函.md" },
                        "max_chars": { "type": "integer", "description": "最大字符数，默认 50000" }
                    },
                    "required": ["relative_path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "list_files".into(),
                description: "列出 workspace 内已索引的文件相对路径，可选 glob 式 pattern 过滤。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "可选，子串匹配 relative_path" }
                    }
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "get_index_status".into(),
                description: "查询当前 workspace 索引状态：文件数、chunk 数、是否索引中。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        },
    ]
}

/// Law-library tools — available in every mode (drafts cite statutes too).
pub fn build_law_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "legal_search".into(),
                description: "聚合检索法律依据（检索首选）：一次调用并发查询本地法规库与在线官方源（法规+案例），返回分源结果与来源层级。深挖单条用 get_law_article / mcp__law-database__get_law_detail / mcp__wenshu__get_case_detail。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索关键词，如 独立保函 主体资格" },
                        "scope": { "type": "string", "enum": ["law", "case", "all"], "description": "检索范围：law=仅法规 case=仅案例 all=全部（默认）" },
                        "k": { "type": "integer", "description": "每源返回条数，默认 8" }
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "search_law".into(),
                description: "在本地法规库（内置中国核心法律法规与司法解释全文）中全文检索条文，离线可用。返回条文摘要、chunk_id 与来源信息。精确取某一条用 get_law_article。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索关键词，如 违约金 司法解释" },
                        "k": { "type": "integer", "description": "返回条数，默认 8，最大 20" }
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "get_law_article".into(),
                description: "从本地法规库精确获取某部法律/司法解释的指定条文全文（引用核验基准）。支持中文或阿拉伯数字条号。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "law_name": { "type": "string", "description": "法规名称或简称，如 民法典、担保制度解释" },
                        "article": { "type": "string", "description": "条文号，如 第五百八十五条 或 第585条" }
                    },
                    "required": ["law_name", "article"]
                }),
            },
        },
    ]
}

pub fn build_builtin_tool_definitions(include_workspace: bool) -> Vec<ToolDefinition> {
    let mut tools = vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "read_user_file".into(),
                description: "读取用户上传或本地的文件（绝对路径）。不要用于读取技能目录；激活技能请用 select_skill。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件的绝对路径（用户文档目录内的文件）"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "generate_docx".into(),
                description: "生成 Word (.docx) 格式的法律文书。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "文档标题" },
                        "content_markdown": { "type": "string", "description": "文档内容（Markdown）" },
                        "output_path": { "type": "string", "description": "输出文件绝对路径" },
                        "template": {
                            "type": "string",
                            "enum": ["memo", "lawyer_letter", "legal_opinion", "contract_review"],
                            "description": "文档模板类型"
                        }
                    },
                    "required": ["title", "content_markdown", "output_path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "select_skill".into(),
                description: "激活法律技能。传入可用技能列表中的 skill_name（如 contract-drafting），或插件名（如 commercial-legal）。不要用 read_user_file 读取 SKILL.md。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "skill_name": {
                            "type": "string",
                            "description": "技能名称（如 contract-drafting）或插件名（如 commercial-legal）"
                        },
                        "reason": { "type": "string", "description": "选择此技能的原因" }
                    },
                    "required": ["skill_name"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "ask_user".into(),
                description: "当正式起草或分析前缺少关键事实时，向用户提出 2-4 个必要澄清问题；每题给出可点击选项，并允许用户自由输入。调用后本轮会暂停等待用户回答。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "intro": {
                            "type": "string",
                            "description": "给用户的一句简短说明，说明为什么需要补充信息"
                        },
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": { "type": "string", "description": "稳定问题 id，如 q1" },
                                    "question": { "type": "string", "description": "必要问题，中文一句话" },
                                    "options": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "label": { "type": "string", "description": "选项显示文案" },
                                                "value": { "type": "string", "description": "提交给模型的答案值" },
                                                "description": { "type": "string", "description": "可选，补充说明" }
                                            },
                                            "required": ["label"]
                                        }
                                    },
                                    "allow_free_text": { "type": "boolean", "description": "是否允许自由输入，默认 true" }
                                },
                                "required": ["question", "options"]
                            }
                        }
                    },
                    "required": ["questions"]
                }),
            },
        },
    ];

    tools.extend(build_law_tool_definitions());

    if include_workspace {
        tools.extend(build_workspace_tool_definitions());
    }

    tools
}

pub fn route_skill<'a>(skills: &'a [SkillMetadata], skill_name: &str) -> Option<&'a SkillMetadata> {
    skills.iter().find(|s| s.name == skill_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_prompt_mandates_clarify_research_and_review_markers() {
        let prompt = build_system_prompt(&[], None, None, true, &[]);
        assert!(prompt.contains("Clarify（首轮强制）"));
        assert!(prompt.contains("ask_user"));
        assert!(prompt.contains("Research（法律检索）"));
        assert!(prompt.contains("[待律师复核]"));
        assert!(
            prompt.contains("research-gate"),
            "evidence mode must include the research gate"
        );
    }

    #[test]
    fn draft_prompt_mandates_first_turn_clarification_and_gate() {
        let prompt = build_system_prompt(&[], None, None, false, &[]);
        assert!(prompt.contains("必须调用一次 ask_user"));
        assert!(prompt.contains("research-gate"));
        assert!(prompt.contains("引用书写规范"));
    }

    #[test]
    fn tool_mapping_lists_only_available_tools() {
        let tools = vec![
            "search_law".to_string(),
            "mcp__law-database__search_laws".to_string(),
        ];
        let mapping = build_retrieval_tool_mapping(&tools);
        assert!(mapping.contains("`search_law`"));
        assert!(mapping.contains("`mcp__law-database__search_laws`"));
        assert!(!mapping.contains("`mcp__wenshu__search_cases`"));
        assert!(mapping.contains("清单之外的检索工具不存在"));

        let prompt = build_system_prompt(&[], None, None, true, &tools);
        assert!(prompt.contains("`mcp__law-database__search_laws`"));
    }

    #[test]
    fn empty_tool_list_degrades_honestly() {
        let mapping = build_retrieval_tool_mapping(&[]);
        assert!(mapping.contains("未接入任何法律检索工具"));
        assert!(mapping.contains("[待律师复核]"));
    }

    #[test]
    fn retrieval_tool_name_detection() {
        assert!(is_retrieval_tool_name("legal_search"));
        assert!(is_retrieval_tool_name("search_law"));
        assert!(is_retrieval_tool_name("get_law_article"));
        assert!(is_retrieval_tool_name("search_workspace"));
        assert!(is_retrieval_tool_name("mcp__law-database__search_laws"));
        assert!(is_retrieval_tool_name("mcp__wenshu__get_case_detail"));
        assert!(!is_retrieval_tool_name("generate_docx"));
        assert!(!is_retrieval_tool_name("ask_user"));
        assert!(!is_retrieval_tool_name("mcp__gsxt__query_company"));
    }
}
