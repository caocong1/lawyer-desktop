use crate::sync::outbox::FeedbackOutboxRow;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackBatchItem {
    pub outbox_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackBatchRequest {
    pub device_id: String,
    pub app_version: String,
    pub skills_version: Option<String>,
    pub items: Vec<FeedbackBatchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackBatchResponse {
    pub accepted: Vec<AcceptedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptedItem {
    pub outbox_id: String,
    pub remote_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifest {
    pub name: String,
    pub version: String,
    pub channel: String,
    pub sha256: String,
    pub download_url: String,
    pub notes: Option<String>,
}

pub struct SyncClient {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

impl SyncClient {
    pub fn new(base_url: &str, api_key: Option<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }

    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(ref key) = self.api_key {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", key)) {
                h.insert(AUTHORIZATION, v);
            }
        }
        h
    }

    pub async fn health(&self) -> anyhow::Result<()> {
        let url = format!("{}/health", self.base_url);
        let resp = self.http.get(&url).send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            anyhow::bail!("health check failed: {}", resp.status())
        }
    }

    pub async fn send_feedback_batch(
        &self,
        req: &FeedbackBatchRequest,
    ) -> anyhow::Result<FeedbackBatchResponse> {
        let url = format!("{}/api/feedback/batch", self.base_url);
        let resp = self
            .http
            .post(&url)
            .headers(self.headers())
            .json(req)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("feedback batch failed {}: {}", status, body);
        }
        Ok(resp.json().await?)
    }

    pub async fn fetch_skill_manifest(
        &self,
        channel: &str,
        current: Option<&str>,
    ) -> anyhow::Result<Option<SkillManifest>> {
        let mut req = self.http.get(format!("{}/api/skills/latest", self.base_url));
        req = req.query(&[("channel", channel)]);
        if let Some(c) = current {
            req = req.query(&[("current", c)]);
        }
        let resp = req.headers(self.headers()).send().await?;
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !resp.status().is_success() {
            anyhow::bail!("skills latest failed: {}", resp.status());
        }
        Ok(Some(resp.json().await?))
    }

    pub async fn download_bytes(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        let full = if url.starts_with("http") {
            url.to_string()
        } else {
            format!("{}{}", self.base_url, url)
        };
        let resp = self.http.get(&full).headers(self.headers()).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("download failed: {}", resp.status());
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub fn build_batch(
        device_id: &str,
        app_version: &str,
        skills_version: Option<String>,
        rows: &[FeedbackOutboxRow],
    ) -> FeedbackBatchRequest {
        FeedbackBatchRequest {
            device_id: device_id.to_string(),
            app_version: app_version.to_string(),
            skills_version,
            items: rows
                .iter()
                .filter_map(|r| {
                    serde_json::from_str::<serde_json::Value>(&r.payload_json)
                        .ok()
                        .map(|payload| FeedbackBatchItem {
                            outbox_id: r.id.clone(),
                            payload,
                        })
                })
                .collect(),
        }
    }
}
