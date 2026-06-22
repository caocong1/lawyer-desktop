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
            AgentMode::Chat => "法律问答",
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
    /// Mode of the task that currently owns the right-side artifact ("draft" /
    /// "evidence"), or None when no producing task is committed yet.
    #[serde(default)]
    pub current_mode: Option<String>,
    /// Human label of the committed task (e.g. "房屋租赁合同起草").
    #[serde(default)]
    pub current_task_label: Option<String>,
    /// True when a document/report already exists and a switch would replace it.
    #[serde(default)]
    pub has_active_document: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResult {
    pub mode: AgentMode,
    pub label: String,
    pub reason: String,
    /// Intent transition relative to the committed task: "continue" | "switch"
    /// | "aside". Drives the client-side switch-confirmation gate.
    #[serde(default = "default_classify_action")]
    pub action: String,
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

fn default_classify_action() -> String {
    "continue".into()
}

/// Normalize the model's action token to one of the three known values;
/// anything unrecognized degrades to the safe "continue".
fn normalize_action(raw: Option<&str>) -> String {
    match raw.map(|s| s.trim().to_lowercase()).as_deref() {
        Some("switch") | Some("切换") => "switch".into(),
        Some("aside") | Some("插问") | Some("提问") => "aside".into(),
        _ => "continue".into(),
    }
}

#[derive(Debug, Deserialize)]
struct ClassifierJson {
    mode: String,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

const CLASSIFIER_SYSTEM: &str = r#"你是墨律 Inkstatute 的任务路由器。根据用户消息、附加资料与「当前任务」上下文，判断本条消息应使用的 Agent 模式 mode 与意图动作 action。

模式 mode（只能选一个）：
- draft：用户要生成正式法律文书（合同、起诉状、答辩状、法律意见书等），输出进入右侧结构化文书预览。
- evidence：用户要基于本地案卷/案件资料做案情分析、诉讼方案、证据梳理、尽调报告等；通过索引检索工具取证，输出 Markdown 分析报告（非 JSON 文书）。
- chat：法律问答 / 咨询解惑——就具体法律问题、法条含义、可行性、风险、流程等寻求解答，不产出成稿文书、也不基于本地案卷写诉讼方案。

意图动作 action（只能选一个，结合「当前任务」判断）：
- continue：延续或细化当前任务（例如对当前正在起草的文书提出修改、补充要求）。
- switch：改做另一件产出型任务（换一种文书；从问答转为起草；从起草转为案情分析；起草 A 改为起草明显不同的 B）。
- aside：在当前产出型任务进行中插入一个法律问题/咨询，并不打算放弃当前产出物（此时 mode 通常为 chat）。

规则：
1. 仅输出一行 JSON，无 markdown 代码块，无其它文字。
2. 格式：{"mode":"draft|evidence|chat","action":"continue|switch|aside","label":"简短中文任务标签","reason":"一句话理由"}
3. 没有「当前任务」（首次消息，或此前只做问答、无产出文书）时，action 一律填 continue。
4. 「当前任务」是某类文书起草，且本条只是顺带问个法律问题、并未要求改文书 → mode=chat、action=aside。
5. 「当前任务」是某类文书，且本条要求改做另一类文书或另一种产出 → action=switch，mode 取新任务的模式。
6. 「当前任务」是某类文书，且本条是对它的修改/补充 → action=continue，mode 保持该产出型模式。
7. 读取目录/案件资料 + 诉讼方案/案情分析 → evidence，不是 draft。附了案卷目录时：分析材料或写诉讼方案→evidence；明确要起草某类格式文书→draft。
8. label 用最能描述「本条所指任务」的简短中文（如「房屋租赁合同起草」「股东知情权咨询」）。
9. 不确定 mode 时选 chat；不确定 action 时选 continue，不要轻易 switch。
10. 消息以「以下是补充信息」开头说明用户在回答此前任务的澄清问题：action=continue；附加目录为「是」时 evidence；提到起草/文书时 draft；不要选 chat。
"#;

const CLASSIFIER_POLICY_SUPPLEMENT: &str = r#"## 墨律当前路由边界（优先遵守）
1. chat 是默认底座：法律咨询、法规适用分析、法律研究、风险评估、流程说明、谈判建议、书面分析性答复，默认都走 chat。
2. 只有用户明确要求生成具体正式文书/文档产物（例如合同、起诉状、答辩状、正式法律意见书、正式报告并要求作为交付物）时才选 draft。
3. 只有用户要求基于本地案卷/目录资料生成独立诉讼方案、案情分析报告、证据梳理报告时才选 evidence。
4. 不要用单个词触发模式切换；必须结合整条消息、附件/目录、本轮上下文和当前任务判断。
5. 不确定时选 chat；分类失败时系统会结构性降级，模型不要为了“稳妥”把问答误判为 draft。
"#;

pub async fn classify_agent_mode(
    provider: &dyn LlmProvider,
    ctx: &ClassifyContext,
) -> ClassifyResult {
    let user_prompt = format!(
        "用户消息：{}\n\
         附加目录：{}\n\
         附加文件：{}\n\
         目录别名：{}\n\
         当前任务模式：{}\n\
         当前任务标签：{}\n\
         当前是否已有产出文书：{}",
        ctx.user_message,
        if ctx.has_directory_ref { "是" } else { "否" },
        if ctx.has_file_ref { "是" } else { "否" },
        if ctx.directory_aliases.is_empty() {
            "无".into()
        } else {
            ctx.directory_aliases.join("、")
        },
        ctx.current_mode.as_deref().unwrap_or("无"),
        ctx.current_task_label.as_deref().unwrap_or("无"),
        if ctx.has_active_document {
            "是"
        } else {
            "否"
        },
    );

    let request = ChatRequest {
        model: provider.model_name().to_string(),
        messages: vec![
            ChatMessage {
                reasoning_content: None,
                role: "system".into(),
                content: format!("{}\n\n{}", CLASSIFIER_SYSTEM, CLASSIFIER_POLICY_SUPPLEMENT),
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
        max_tokens: Some(160),
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

pub async fn classify_agent_mode_with_retry(
    fast_provider: &dyn LlmProvider,
    primary_provider: &dyn LlmProvider,
    ctx: &ClassifyContext,
) -> ClassifyResult {
    let fast = classify_agent_mode(fast_provider, ctx).await;
    if fast.source != "fallback" {
        return fast;
    }

    log::warn!(
        "fast agent classify fell back (reason={:?}); retrying with primary model",
        fast.fallback_reason
    );
    let primary = classify_agent_mode(primary_provider, ctx).await;
    if primary.source != "fallback" {
        return primary;
    }

    primary
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
                // Without a committed task there is nothing to switch away from,
                // so a switch/aside verdict is meaningless — pin to continue.
                let action = if ctx.current_mode.is_none() {
                    "continue".into()
                } else {
                    normalize_action(parsed.action.as_deref())
                };
                return ClassifyResult {
                    mode,
                    label: parsed
                        .label
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| mode.ui_label().to_string()),
                    reason: parsed.reason.unwrap_or_default(),
                    action,
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

pub fn parse_mode_str(s: &str) -> Option<AgentMode> {
    let compact: String = s
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '　'))
        .collect();
    match compact.as_str() {
        "draft" | "document" | "doc" | "文书" | "起草" | "文书起草" | "法律文书"
        | "法律文书起草" => Some(AgentMode::Draft),
        "evidence" | "caseanalysis" | "case" | "案情" | "案情分析" | "诉讼" | "诉讼方案"
        | "分析" | "证据" | "证据分析" => Some(AgentMode::Evidence),
        "chat" | "qa" | "q&a" | "咨询" | "问答" | "法律问答" | "法律咨询" => {
            Some(AgentMode::Chat)
        }
        _ => None,
    }
}

/// Failure fallback deliberately uses only structural context, never user-text
/// keyword matching. The actual matter type is decided by the AI classifier.
fn fallback_classify(
    ctx: &ClassifyContext,
    fallback_reason: &str,
    diagnostic: Option<String>,
) -> ClassifyResult {
    let mode = if ctx.has_active_document {
        ctx.current_mode
            .as_deref()
            .and_then(parse_mode_str)
            .unwrap_or(AgentMode::Chat)
    } else {
        AgentMode::Chat
    };
    ClassifyResult {
        label: ctx
            .current_task_label
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| mode.ui_label().to_string()),
        reason: "AI 分类失败，已使用结构性安全默认模式".into(),
        mode,
        // A fallback must never surprise-switch the user's committed task.
        action: "continue".into(),
        source: "fallback".into(),
        fallback_reason: Some(fallback_reason.into()),
        diagnostic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::{ChatStream, LlmProvider};
    use crate::llm::types::{ChatMessage, ChatResponse, Choice, ProviderConfig};
    use anyhow::Result;
    use async_trait::async_trait;
    use futures::stream;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct MockClassifierProvider {
        model: String,
        reply: Result<String, String>,
        calls: Arc<AtomicUsize>,
        config: ProviderConfig,
    }

    impl MockClassifierProvider {
        fn new(model: &str, reply: Result<&str, &str>) -> Self {
            Self {
                model: model.into(),
                reply: reply.map(str::to_string).map_err(str::to_string),
                calls: Arc::new(AtomicUsize::new(0)),
                config: ProviderConfig {
                    id: model.into(),
                    name: model.into(),
                    display_name: model.into(),
                    api_base_url: "http://example.invalid/v1".into(),
                    api_key: None,
                    model_name: model.into(),
                    temperature: None,
                    max_tokens: None,
                },
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl LlmProvider for MockClassifierProvider {
        async fn chat(&self, _request: &crate::llm::types::ChatRequest) -> Result<ChatResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &self.reply {
                Ok(content) => Ok(ChatResponse {
                    id: Some("mock".into()),
                    choices: vec![Choice {
                        index: 0,
                        message: Some(ChatMessage {
                            reasoning_content: None,
                            role: "assistant".into(),
                            content: content.clone(),
                            name: None,
                            tool_calls: None,
                            tool_call_id: None,
                        }),
                        delta: None,
                        finish_reason: Some("stop".into()),
                    }],
                    usage: None,
                }),
                Err(e) => anyhow::bail!(e.clone()),
            }
        }

        async fn chat_stream(
            &self,
            _request: &crate::llm::types::ChatRequest,
        ) -> Result<ChatStream> {
            Ok(Box::pin(stream::empty()))
        }

        fn supports_tools(&self) -> bool {
            false
        }

        fn model_name(&self) -> &str {
            &self.model
        }

        fn config(&self) -> &ProviderConfig {
            &self.config
        }
    }

    #[test]
    fn parses_classifier_json() {
        let ctx = ClassifyContext {
            user_message: "生成诉讼方案".into(),
            has_directory_ref: true,
            has_file_ref: false,
            directory_aliases: vec!["案件资料".into()],
            current_mode: None,
            current_task_label: None,
            has_active_document: false,
        };
        let r = parse_classifier_response(
            r#"{"mode":"evidence","label":"诉讼方案","reason":"需检索案卷"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Evidence);
        assert_eq!(r.source, "llm");
        // No committed task → action pinned to continue regardless of model.
        assert_eq!(r.action, "continue");
    }

    fn ctx_with(message: &str, current_mode: Option<&str>, has_doc: bool) -> ClassifyContext {
        ClassifyContext {
            user_message: message.into(),
            has_directory_ref: false,
            has_file_ref: false,
            directory_aliases: vec![],
            current_mode: current_mode.map(|s| s.to_string()),
            current_task_label: current_mode.map(|_| "股权转让协议起草".to_string()),
            has_active_document: has_doc,
        }
    }

    #[test]
    fn aviation_regulatory_risk_question_is_chat_when_llm_classifies_it() {
        let ctx = ctx_with(
            "ICAO technical instructions supplement applies to power bank carriage. Analyze enforcement legal risk.",
            None,
            false,
        );
        let r = parse_classifier_response(
            r#"{"mode":"chat","action":"continue","label":"aviation regulatory risk","reason":"risk analysis answer, not a formal document"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.action, "continue");
        assert_eq!(r.label, "aviation regulatory risk");
    }

    #[test]
    fn formal_legal_opinion_document_is_draft_when_llm_classifies_it() {
        let ctx = ctx_with(
            "Generate a formal legal opinion document for client submission.",
            None,
            false,
        );
        let r = parse_classifier_response(
            r#"{"mode":"draft","action":"continue","label":"legal opinion drafting","reason":"the user asks for a formal document artifact"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Draft);
        assert_eq!(r.label, "legal opinion drafting");
    }

    #[tokio::test]
    async fn retry_uses_primary_when_fast_classifier_falls_back() {
        let ctx = ctx_with(
            "Analyze this regulatory requirement and risks.",
            None,
            false,
        );
        let fast = MockClassifierProvider::new("fast", Ok(""));
        let primary = MockClassifierProvider::new(
            "primary",
            Ok(r#"{"mode":"chat","label":"regulatory risk answer","reason":"answer in chat"}"#),
        );

        let r = classify_agent_mode_with_retry(&fast, &primary, &ctx).await;

        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.source, "llm");
        assert_eq!(r.label, "regulatory risk answer");
        assert_eq!(fast.calls(), 1);
        assert_eq!(primary.calls(), 1);
    }

    #[tokio::test]
    async fn double_classifier_failure_degrades_to_current_committed_mode() {
        let ctx = ctx_with("Continue revising clause 3.", Some("draft"), true);
        let fast = MockClassifierProvider::new("fast", Err("fast down"));
        let primary = MockClassifierProvider::new("primary", Err("primary down"));

        let r = classify_agent_mode_with_retry(&fast, &primary, &ctx).await;

        assert_eq!(r.mode, AgentMode::Draft);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.action, "continue");
        assert!(!r.label.is_empty());
    }

    #[test]
    fn parses_switch_action_when_task_committed() {
        let ctx = ctx_with("改成起草一份房屋租赁合同", Some("draft"), true);
        let r = parse_classifier_response(
            r#"{"mode":"draft","action":"switch","label":"房屋租赁合同起草","reason":"换一种文书"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Draft);
        assert_eq!(r.action, "switch");
    }

    #[test]
    fn parses_aside_action_for_mid_draft_question() {
        let ctx = ctx_with("违约金一般怎么约定？", Some("draft"), true);
        let r = parse_classifier_response(
            r#"{"mode":"chat","action":"aside","label":"违约金咨询","reason":"顺带提问"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.action, "aside");
    }

    #[test]
    fn unknown_action_degrades_to_continue() {
        let ctx = ctx_with("继续完善第三条", Some("draft"), true);
        let r = parse_classifier_response(
            r#"{"mode":"draft","action":"bogus","label":"协议修改"}"#,
            &ctx,
        );
        assert_eq!(r.action, "continue");
    }

    #[test]
    fn parses_qa_mode_alias() {
        assert_eq!(parse_mode_str("问答"), Some(AgentMode::Chat));
        assert_eq!(parse_mode_str("法律问答"), Some(AgentMode::Chat));
        assert_eq!(parse_mode_str("文书起草"), Some(AgentMode::Draft));
        assert_eq!(parse_mode_str("案情分析"), Some(AgentMode::Evidence));
    }

    #[test]
    fn parses_llm_chinese_mode_label_for_draft() {
        let ctx = ctx_with("帮我起草一份劳动合同", None, false);
        let r = parse_classifier_response(
            r#"{"mode":"文书起草","action":"continue","label":"劳动合同起草","reason":"用户要生成正式文书"}"#,
            &ctx,
        );
        assert_eq!(r.mode, AgentMode::Draft);
        assert_eq!(r.label, "劳动合同起草");
        assert_eq!(r.source, "llm");
    }

    #[test]
    fn fallback_defaults_to_chat_without_current_artifact() {
        let ctx = ClassifyContext {
            user_message: "生成诉讼方案".into(),
            has_directory_ref: true,
            has_file_ref: false,
            directory_aliases: vec![],
            current_mode: None,
            current_task_label: None,
            has_active_document: false,
        };
        let r = fallback_classify(&ctx, "request_failed", Some("boom".into()));
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("request_failed"));
    }

    #[test]
    fn fallback_does_not_infer_draft_from_user_text() {
        let ctx = ClassifyContext {
            user_message:
                "帮我起草一份劳动合同：甲方杭州某科技有限公司招聘乙方王五担任高级软件工程师，月薪人民币25,000元，合同期限三年。"
                    .into(),
            has_directory_ref: false,
            has_file_ref: false,
            directory_aliases: vec![],
            current_mode: None,
            current_task_label: None,
            has_active_document: false,
        };
        let r = parse_classifier_response("不是 JSON", &ctx);
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.label, "法律问答");
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("invalid_json"));
    }

    #[test]
    fn fallback_keeps_invalid_json_diagnostic() {
        let ctx = ClassifyContext {
            user_message: "请解释合同解除".into(),
            has_directory_ref: false,
            has_file_ref: false,
            directory_aliases: vec![],
            current_mode: None,
            current_task_label: None,
            has_active_document: false,
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
            current_mode: None,
            current_task_label: None,
            has_active_document: false,
        };
        let r = parse_classifier_response(r#"{"mode":"other"}"#, &ctx);
        assert_eq!(r.mode, AgentMode::Chat);
        assert_eq!(r.source, "fallback");
        assert_eq!(r.fallback_reason.as_deref(), Some("invalid_mode"));
    }
}
