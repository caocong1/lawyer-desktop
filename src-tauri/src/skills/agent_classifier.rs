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
    #[serde(default = "default_classify_source")]
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

fn default_classify_source() -> String {
    "llm".into()
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
            let (reason, diagnostic) = classify_error_diagnostic(&e);
            fallback_classify(ctx, reason, Some(diagnostic))
        }
    }
}

fn parse_classifier_response(raw: &str, ctx: &ClassifyContext) -> ClassifyResult {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        log::warn!("agent classify returned empty content");
        return fallback_classify(ctx, "empty_response", Some("分类模型返回空内容".into()));
    }

    let Some(json_str) = extract_json_object(trimmed) else {
        log::warn!("agent classify parse failed, raw={}", trimmed);
        return fallback_classify(
            ctx,
            "invalid_json",
            Some("分类返回格式异常：未找到 JSON 对象".into()),
        );
    };

    match serde_json::from_str::<ClassifierJson>(json_str) {
        Ok(parsed) => {
            if let Some(mode) = parse_mode_str(&parsed.mode) {
                return ClassifyResult {
                    mode,
                    label: parsed
                        .label
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| mode.ui_label().to_string()),
                    reason: parsed.reason.unwrap_or_default(),
                    source: "llm".into(),
                    fallback_reason: None,
                    diagnostic: None,
                };
            }
            log::warn!("agent classify invalid mode: {}", parsed.mode);
            fallback_classify(
                ctx,
                "invalid_mode",
                Some(format!("分类返回了无法识别的模式：{}", parsed.mode)),
            )
        }
        Err(e) => {
            log::warn!("agent classify JSON parse failed: {}", e);
            fallback_classify(
                ctx,
                "invalid_json",
                Some(format!("分类返回格式异常：{}", e)),
            )
        }
    }
}

pub fn validate_classifier_response(raw: &str, ctx: &ClassifyContext) -> ClassifyResult {
    parse_classifier_response(raw, ctx)
}

fn classify_error_diagnostic(error: &anyhow::Error) -> (&'static str, String) {
    let msg = error.to_string();
    let lower = msg.to_lowercase();
    let reason = if lower.contains("401") || lower.contains("403") {
        "auth_failed"
    } else if lower.contains("404") {
        "model_not_found"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("failed to parse llm response") {
        "response_parse_failed"
    } else if lower.contains("failed to send") || lower.contains("dns") || lower.contains("connect")
    {
        "network_error"
    } else {
        "request_failed"
    };
    (reason, compact_diagnostic(&msg, 180))
}

fn compact_diagnostic(text: &str, max_chars: usize) -> String {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let head = cleaned.chars().take(max_chars).collect::<String>();
    format!("{}…", head)
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

/// Structural fallback only (no regex on user text).
fn fallback_classify(
    ctx: &ClassifyContext,
    fallback_reason: &str,
    diagnostic: Option<String>,
) -> ClassifyResult {
    let mode = if ctx.has_directory_ref {
        AgentMode::Evidence
    } else {
        AgentMode::Chat
    };
    ClassifyResult {
        label: mode.ui_label().to_string(),
        reason: "已用本地规则判断事项类型".into(),
        mode,
        source: "fallback".into(),
        fallback_reason: Some(fallback_reason.into()),
        diagnostic,
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
        assert_eq!(r.source, "llm");
    }

    #[test]
    fn fallback_uses_directory_not_regex() {
        let ctx = ClassifyContext {
            user_message: "生成诉讼方案".into(),
            has_directory_ref: true,
            has_file_ref: false,
            directory_aliases: vec![],
        };
        let r = fallback_classify(&ctx, "request_failed", Some("boom".into()));
        assert_eq!(r.mode, AgentMode::Evidence);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("request_failed"));
    }

    #[test]
    fn fallback_keeps_invalid_json_diagnostic() {
        let ctx = ClassifyContext {
            user_message: "请解释合同解除".into(),
            has_directory_ref: false,
            has_file_ref: false,
            directory_aliases: vec![],
        };
        let r = parse_classifier_response("不是 JSON", &ctx);
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("invalid_json"));
        assert!(r.diagnostic.unwrap_or_default().contains("JSON"));
    }

    #[test]
    fn fallback_keeps_invalid_mode_diagnostic() {
        let ctx = ClassifyContext {
            user_message: "请起草合同".into(),
            has_directory_ref: false,
            has_file_ref: false,
            directory_aliases: vec![],
        };
        let r = parse_classifier_response(r#"{"mode":"other"}"#, &ctx);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("invalid_mode"));
    }
}
