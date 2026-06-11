use crate::llm::openai_compat::OpenAiCompatProvider;
use crate::llm::provider::LlmProvider;
use crate::llm::tool_leak::{contains_tool_leakage, parse_embedded_tool_calls};
use crate::llm::types::{
    ChatMessage, ChatRequest, FunctionDefinition, ProviderConfig, ToolDefinition,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ToolSupportReport {
    pub slot: String,
    pub model: String,
    pub api_base_url: String,
    pub connectivity_ok: bool,
    pub native_tool_calls: u32,
    pub tool_names: Vec<String>,
    pub dsml_in_content: bool,
    pub embedded_invoke_names: Vec<String>,
    pub finish_reason: Option<String>,
    pub content_preview: String,
    pub latency_ms: u128,
    pub verdict: String,
    pub error: Option<String>,
}

pub async fn probe_provider(slot: &str, config: ProviderConfig) -> ToolSupportReport {
    let started = std::time::Instant::now();
    let base = ToolSupportReport {
        slot: slot.into(),
        model: config.model_name.clone(),
        api_base_url: config.api_base_url.clone(),
        connectivity_ok: false,
        native_tool_calls: 0,
        tool_names: Vec::new(),
        dsml_in_content: false,
        embedded_invoke_names: Vec::new(),
        finish_reason: None,
        content_preview: String::new(),
        latency_ms: 0,
        verdict: String::new(),
        error: None,
    };

    let provider = OpenAiCompatProvider::new(config.clone());
    let tools = vec![ToolDefinition {
        tool_type: "function".into(),
        function: FunctionDefinition {
            name: "ping_test".into(),
            description: "连通性测试：收到请求后必须调用本工具，参数 message 固定为 hello".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "固定填 hello" }
                },
                "required": ["message"]
            }),
        },
    }];

    let request = ChatRequest {
        model: config.model_name.clone(),
        messages: vec![
            ChatMessage {
                reasoning_content: None,
                role: "system".into(),
                content:
                    "你是连通性测试助手。用户要求工具测试时，必须通过 tools API 调用 ping_test，\
                    不要在正文输出 XML、DSML 或 invoke 标记。"
                        .into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                reasoning_content: None,
                role: "user".into(),
                content: "请调用 ping_test 工具，参数 message=hello。只调用工具，不要写其它正文。"
                    .into(),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        tools: Some(tools),
        temperature: Some(0.0),
        max_tokens: Some(300),
        stream: false,
    };

    let response = match provider.chat(&request).await {
        Ok(r) => r,
        Err(e) => {
            return ToolSupportReport {
                latency_ms: started.elapsed().as_millis(),
                verdict: "❌ API 请求失败".into(),
                error: Some(e.to_string()),
                ..base
            };
        }
    };

    let choice = match response.choices.first() {
        Some(c) => c,
        None => {
            return ToolSupportReport {
                connectivity_ok: true,
                latency_ms: started.elapsed().as_millis(),
                verdict: "❌ 响应无 choices".into(),
                ..base
            };
        }
    };

    let msg = choice.message.as_ref();
    let content = msg.map(|m| m.content.as_str()).unwrap_or("");
    let tool_calls = msg.and_then(|m| m.tool_calls.as_ref());
    let native_count = tool_calls.map(|t| t.len() as u32).unwrap_or(0);
    let tool_names: Vec<String> = tool_calls
        .map(|t| t.iter().map(|c| c.function.name.clone()).collect())
        .unwrap_or_default();
    let embedded: Vec<String> = parse_embedded_tool_calls(content)
        .into_iter()
        .map(|c| c.function.name)
        .collect();
    let dsml = contains_tool_leakage(content);

    let verdict = if native_count > 0 {
        "✅ 支持标准 OpenAI tool_calls（Evidence/案卷检索可用）".into()
    } else if !embedded.is_empty() {
        "⚠️ 仅在正文嵌入 invoke/DSML（后端已做兼容，可能不稳定）".into()
    } else if dsml {
        "❌ 工具调用泄漏为 DSML/乱码，不适合案卷检索".into()
    } else {
        "❌ 未返回 tool_calls（模型可能忽略 tools 参数）".into()
    };

    ToolSupportReport {
        connectivity_ok: true,
        native_tool_calls: native_count,
        tool_names,
        dsml_in_content: dsml,
        embedded_invoke_names: embedded,
        finish_reason: choice.finish_reason.clone(),
        content_preview: content.chars().take(240).collect(),
        latency_ms: started.elapsed().as_millis(),
        verdict,
        ..base
    }
}
