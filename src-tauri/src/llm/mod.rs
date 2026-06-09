pub mod openai_compat;
pub mod provider;
pub mod types;

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;

use self::provider::LlmProvider;
use self::types::ProviderConfig;

pub struct LlmEngine {
    active_provider: Arc<RwLock<Option<Arc<dyn LlmProvider>>>>,
}

impl LlmEngine {
    pub fn new() -> Self {
        Self {
            active_provider: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_provider(&self, config: ProviderConfig) -> Result<()> {
        let provider: Arc<dyn LlmProvider> = match config.name.as_str() {
            "ollama" => {
                Arc::new(openai_compat::OpenAiCompatProvider::new(config))
            }
            _ => {
                Arc::new(openai_compat::OpenAiCompatProvider::new(config))
            }
        };

        let mut active = self.active_provider.write().await;
        *active = Some(provider);
        Ok(())
    }

    pub async fn get_provider(&self) -> Result<Arc<dyn LlmProvider>> {
        let active = self.active_provider.read().await;
        active
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active LLM provider configured. Please set up a provider in Settings."))
    }
}

pub fn default_providers() -> Vec<ProviderPreset> {
    vec![
        ProviderPreset {
            name: "qwen".into(),
            display_name: "通义千问 (Qwen)".into(),
            api_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            default_model: "qwen-plus".into(),
        },
        ProviderPreset {
            name: "deepseek".into(),
            display_name: "DeepSeek".into(),
            api_base_url: "https://api.deepseek.com/v1".into(),
            default_model: "deepseek-chat".into(),
        },
        ProviderPreset {
            name: "kimi".into(),
            display_name: "Kimi (月之暗面)".into(),
            api_base_url: "https://api.moonshot.cn/v1".into(),
            default_model: "moonshot-v1-8k".into(),
        },
        ProviderPreset {
            name: "openai".into(),
            display_name: "OpenAI".into(),
            api_base_url: "https://api.openai.com/v1".into(),
            default_model: "gpt-4o".into(),
        },
        ProviderPreset {
            name: "ollama".into(),
            display_name: "Ollama (本地)".into(),
            api_base_url: "http://localhost:11434/v1".into(),
            default_model: "qwen2.5:7b".into(),
        },
    ]
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderPreset {
    pub name: String,
    pub display_name: String,
    pub api_base_url: String,
    pub default_model: String,
}
