use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use std::time::Duration;

use super::provider::{ChatStream, LlmProvider};
use super::types::{ChatRequest, ChatResponse, ProviderConfig};

pub struct OpenAiCompatProvider {
    config: ProviderConfig,
    client: Arc<Client>,
}

impl OpenAiCompatProvider {
    pub fn new(config: ProviderConfig) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            config,
            client: Arc::new(client),
        }
    }

    fn build_request(&self, chat_request: &ChatRequest) -> Result<reqwest::RequestBuilder> {
        let url = format!(
            "{}/chat/completions",
            self.config.api_base_url.trim_end_matches('/')
        );

        let mut builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json");

        if let Some(ref api_key) = self.config.api_key {
            if !api_key.is_empty() {
                builder = builder.bearer_auth(api_key);
            }
        }

        let body = serde_json::to_string(chat_request).context("Failed to serialize chat request")?;

        Ok(builder.body(body))
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse> {
        let mut req = request.clone();
        req.model = self.config.model_name.clone();
        req.stream = false;

        let response = self
            .build_request(&req)?
            .send()
            .await
            .context("Failed to send request to LLM provider")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("LLM API error ({}): {}", status, body);
        }

        let chat_response: ChatResponse = response
            .json()
            .await
            .context("Failed to parse LLM response")?;

        Ok(chat_response)
    }

    async fn chat_stream(&self, request: &ChatRequest) -> Result<ChatStream> {
        let mut req = request.clone();
        req.model = self.config.model_name.clone();
        req.stream = true;

        let response = self
            .build_request(&req)?
            .send()
            .await
            .context("Failed to send streaming request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("LLM API error ({}): {}", status, body);
        }

        let stream = response.bytes_stream().map(|result| {
            result
                .map_err(|e| anyhow::anyhow!("Stream error: {}", e))
                .and_then(|bytes| {
                    String::from_utf8(bytes.to_vec())
                        .map_err(|e| anyhow::anyhow!("UTF-8 error: {}", e))
                })
        });

        Ok(Box::pin(stream))
    }

    fn supports_tools(&self) -> bool {
        true
    }

    fn model_name(&self) -> &str {
        &self.config.model_name
    }

    fn config(&self) -> &ProviderConfig {
        &self.config
    }
}
