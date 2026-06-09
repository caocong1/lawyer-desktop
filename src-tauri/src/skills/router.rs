use super::loader::SkillMetadata;
use crate::llm::types::{FunctionDefinition, ToolDefinition};

pub fn build_skill_descriptions(skills: &[SkillMetadata]) -> String {
    let mut desc = String::from("## 可用法律技能\n\n以下是你可以使用的法律技能。根据用户需求自动匹配最合适的技能：\n\n");

    for skill in skills {
        desc.push_str(&format!(
            "- **{}** ({}): {}\n",
            skill.name, skill.plugin_name, skill.description
        ));
    }

    desc
}

pub fn build_system_prompt(skills: &[SkillMetadata], active_skill: Option<&SkillMetadata>) -> String {
    let mut prompt = String::from(
        "你是一位专业的中国法律 AI 助手，面向中国大陆执业律师。你的职责是协助律师完成法律文书起草、合同审查、法律研究等工作。\n\n\
        重要声明：你的所有输出均为供律师审查的草稿，非法律建议，非法律结论，不能替代执业律师。律师需对最终作品负责。\n\n\
        ## 工作原则\n\
        1. 引用法条必须标注精确条文号、来源层级\n\
        2. 不确定的内容必须标注 [待律师复核]\n\
        3. 如果权威来源冲突，必须陈述冲突并给出更稳妥路线\n\
        4. 禁止仅引百度百科、知乎等作为法律依据\n\n"
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

pub fn build_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "read_user_file".into(),
                description: "读取用户指定的本地文件内容。支持文本文件、PDF、DOCX。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件的绝对路径"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "list_user_directory".into(),
                description: "列出用户指定目录下的文件和子目录。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录的绝对路径"
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": "是否递归列出子目录",
                            "default": false
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
                description: "生成 Word (.docx) 格式的法律文书。支持合同审查备忘录、律师函、法律意见书等。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "文档标题"
                        },
                        "content_markdown": {
                            "type": "string",
                            "description": "文档内容（Markdown 格式）"
                        },
                        "template": {
                            "type": "string",
                            "enum": ["memo", "lawyer_letter", "legal_opinion", "contract_review"],
                            "description": "文档模板类型"
                        }
                    },
                    "required": ["title", "content_markdown"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "select_skill".into(),
                description: "激活一个法律技能。当判断用户需求匹配某个技能时调用此工具。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "skill_name": {
                            "type": "string",
                            "description": "技能名称"
                        },
                        "reason": {
                            "type": "string",
                            "description": "选择此技能的原因"
                        }
                    },
                    "required": ["skill_name"]
                }),
            },
        },
    ]
}

pub fn route_skill<'a>(skills: &'a [SkillMetadata], skill_name: &str) -> Option<&'a SkillMetadata> {
    skills.iter().find(|s| s.name == skill_name)
}
