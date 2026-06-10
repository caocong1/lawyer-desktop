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
    let mut desc =
        String::from("## 可用法律技能\n\n以下是你可以使用的法律技能。根据用户需求自动匹配最合适的技能：\n\n");

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

pub fn build_system_prompt(
    skills: &[SkillMetadata],
    research_gate_content: Option<&str>,
    active_skill: Option<&SkillMetadata>,
    evidence_mode: bool,
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
            1. 最终回复只输出完整法律文书正文，禁止输出工具调用语法（如 tool_calls、invoke、DSML、XML 标签）或「第一步/第二步」过程说明\n\
            2. 工具必须通过 API 工具接口调用，不得在正文里伪造工具调用\n\
            3. 优先输出 JSON（含 title、sections）；若用 Markdown，须含文书标题、当事人信息与条款正文\n\n",
        )
    };

    if !evidence_mode {
        let gate = research_gate_content.unwrap_or(RESEARCH_GATE_FALLBACK);
        prompt.push_str(gate);
        prompt.push_str("\n\n");
    }

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
        4. 信息不足时标注「不足以判断」，不得编造\n\n\
        ## 三阶段工作流\n\
        1. **Plan**：先输出文档大纲（Markdown 标题），每节列出拟用的 `search_queries`\n\
        2. **Evidence**：逐节调用 `search_workspace` 收集事实，必要时 `read_chunk` / `read_file` 补全\n\
        3. **Write**：生成完整 Markdown 诉讼方案/分析报告，关键句附来源路径\n\n\
        ## 输出格式\n\
        - 最终产物为 **Markdown 诉讼方案**（非 JSON 法律文书）\n\
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
    ];

    if include_workspace {
        tools.extend(build_workspace_tool_definitions());
    }

    tools
}

pub fn route_skill<'a>(skills: &'a [SkillMetadata], skill_name: &str) -> Option<&'a SkillMetadata> {
    skills.iter().find(|s| s.name == skill_name)
}
