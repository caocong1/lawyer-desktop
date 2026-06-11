use anyhow::Result;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use super::types::{ChatRequest, ChatResponse, ProviderConfig};

pub type ChatStream = Pin<Box<dyn Stream<Item = Result<String>> + Send>>;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse>;
    async fn chat_stream(&self, request: &ChatRequest) -> Result<ChatStream>;
    fn supports_tools(&self) -> bool;
    fn model_name(&self) -> &str;
    fn config(&self) -> &ProviderConfig;
}
