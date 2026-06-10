use serde::{Deserialize, Serialize};

use crate::llm::provider::LlmProvider;
use crate::llm::types::{ChatMessage, ChatRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Chat,
    Draft,
    Evidence,
}

impl AgentMode {
    pub fn ui_label(self) -> &'static str {
        match self {
            AgentMode::Chat => "法律咨询",
            AgentMode::Draft => "文书起草",
            AgentMode::Evidence => "案情分析",
        }
    }

    pub fn is_evidence(self) -> bool {
        matches!(self, AgentMode::Evidence)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyContext {
    pub user_message: String,
    pub has_directory_ref: bool,
    pub has_file_ref: bool,
    pub directory_aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResult {
    pub mode: AgentMode,
    pub label: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct ClassifierJson {
    mode: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

const CLASSIFIER_SYSTEM: &str = r#"你是墨律 Inkstatute 的任务路由器。根据用户消息和上下文，判断应使用的 Agent 模式。

模式定义（只能选一个）：
- draft：用户需要生成正式法律文书（合同、起诉状、答辩状、法律意见书等），输出将进入右侧结构化文书预览。
- evidence：用户需要基于本地案卷/案件资料做案情分析、诉讼方案、证据梳理、尽调报告等；应通过索引检索工具取证，输出 Markdown 分析报告（非 JSON 文书）。
- chat：一般法律咨询、法条解释、流程问答，无需生成完整文书或诉讼方案。

规则：
1. 仅输出一行 JSON，无 markdown 代码块，无其它文字。
2. 格式：{"mode":"draft|evidence|chat","label":"简短中文标签","reason":"一句话理由"}
3. 用户要求「读取目录/案件资料 + 诉讼方案/案情分析」→ evidence，不是 draft。
4. 附加了案卷目录时，若用户在分析材料或写诉讼方案 → evidence；若明确要求起草某类格式文书 → draft。
5. 不确定时选 chat，不要默认 draft。
"#;

pub async fn classify_agent_mode(
    provider: &dyn LlmProvider,
    ctx: &ClassifyContext,
) -> ClassifyResult {
    let user_prompt = format!(
        "用户消息：{}\n\
         附加目录：{}\n\
         附加文件：{}\n\
         目录别名：{}",
        ctx.user_message,
        if ctx.has_directory_ref { "是" } else { "否" },
        if ctx.has_file_ref { "是" } else { "否" },
        if ctx.directory_aliases.is_empty() {
            "无".into()
        } else {
            ctx.directory_aliases.join("、")
        }
    );

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![
            ChatMessage {
                reasoning_content: None,
                role: "system".into(),
                content: CLASSIFIER_SYSTEM.into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                reasoning_content: None,
                role: "user".into(),
                content: user_prompt,
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        tools: None,
        temperature: Some(0.0),
        max_tokens: Some(120),
        stream: false,
    };

    match provider.chat(&request).await {
        Ok(response) => {
            let text = response
                .choices
                .first()
                .and_then(|c| c.message.as_ref())
                .map(|m| m.content.as_str())
                .unwrap_or("");
            parse_classifier_response(text, ctx)
        }
        Err(e) => {
            log::warn!("agent classify LLM failed: {}, using fallback", e);
            fallback_classify(ctx)
        }
    }
}

fn parse_classifier_response(raw: &str, ctx: &ClassifyContext) -> ClassifyResult {
    let trimmed = raw.trim();
    let json_str = extract_json_object(trimmed).unwrap_or(trimmed);

    if let Ok(parsed) = serde_json::from_str::<ClassifierJson>(json_str) {
        if let Some(mode) = parse_mode_str(&parsed.mode) {
            return ClassifyResult {
                mode,
                label: parsed
                    .label
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| mode.ui_label().to_string()),
                reason: parsed.reason.unwrap_or_default(),
            };
        }
    }

    log::warn!("agent classify parse failed, raw={}", trimmed);
    fallback_classify(ctx)
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0;
    for (i, ch) in text[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=start + i]);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_mode_str(s: &str) -> Option<AgentMode> {
    match s.trim().to_lowercase().as_str() {
        "draft" | "文书" | "起草" => Some(AgentMode::Draft),
        "evidence" | "案情" | "诉讼" | "分析" => Some(AgentMode::Evidence),
        "chat" | "咨询" => Some(AgentMode::Chat),
        _ => None,
    }
}

/// When the fast model is unavailable or returns garbage — structural fallback only (no regex on user text).
fn fallback_classify(ctx: &ClassifyContext) -> ClassifyResult {
    let mode = if ctx.has_directory_ref {
        AgentMode::Evidence
    } else {
        AgentMode::Chat
    };
    ClassifyResult {
        label: mode.ui_label().to_string(),
        reason: "分类模型不可用，已使用结构回退".into(),
        mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_classifier_json() {
        let ctx = ClassifyContext {
            user_message: "生成诉讼方案".into(),
            has_directory_ref: true,
            has_file_ref: false,
            directory_aliases: vec!["案件资料".into()],
        };
        let r = parse_classifier_response(
            r#"{"mode":"evidence","label":"诉讼方案","reason":"需检索案卷"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Evidence);
    }

    #[test]
    fn fallback_uses_directory_not_regex() {
        let ctx = ClassifyContext {
            user_message: "生成诉讼方案".into(),
            has_directory_ref: true,
            has_file_ref: false,
            directory_aliases: vec![],
        };
        let r = fallback_classify(&ctx);
        assert_eq!(r.mode, AgentMode::Evidence);
    }
}
