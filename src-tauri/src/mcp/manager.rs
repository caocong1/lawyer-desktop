use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::llm::types::{FunctionDefinition, ToolDefinition};

use super::client::McpClient;
use super::types::{McpServerConfig, McpServerHealth, McpToolResult};

#[derive(Clone)]
pub struct McpManager {
    clients: Arc<RwLock<HashMap<String, Arc<McpClient>>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn register(&self, config: McpServerConfig) -> Result<()> {
        let name = config.name.clone();
        let client = Arc::new(McpClient::new(config));
        client.start().await?;
        self.clients.write().await.insert(name, client);
        Ok(())
    }

    /// Real health check: ping each server via tools/list.
    pub async fn check_health(&self) -> Vec<McpServerHealth> {
        let clients = self.clients.read().await;
        let mut results = Vec::new();

        for (name, client) in clients.iter() {
            match client.ping().await {
                Ok(count) => results.push(McpServerHealth {
                    name: name.clone(),
                    online: true,
                    tool_count: count,
                    error: None,
                }),
                Err(e) => results.push(McpServerHealth {
                    name: name.clone(),
                    online: false,
                    tool_count: 0,
                    error: Some(e.to_string()),
                }),
            }
        }

        results
    }

    pub async fn build_tool_definitions(&self) -> Vec<ToolDefinition> {
        let clients = self.clients.read().await;
        let mut tools = Vec::new();

        for (server_name, client) in clients.iter() {
            for mcp_tool in client.get_tools().await {
                let fn_name = format!("mcp__{}__{}", server_name, mcp_tool.name);
                let description = mcp_tool.description.unwrap_or_else(|| {
                    format!("MCP tool {} from server {}", mcp_tool.name, server_name)
                });
                let parameters = mcp_tool.input_schema.unwrap_or_else(|| {
                    serde_json::json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": true
                    })
                });

                tools.push(ToolDefinition {
                    tool_type: "function".into(),
                    function: FunctionDefinition {
                        name: fn_name,
                        description,
                        parameters,
                    },
                });
            }
        }

        tools
    }

    pub async fn call_tool_by_name(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult> {
        let (server, mcp_tool) = parse_mcp_tool_name(tool_name)?;
        let clients = self.clients.read().await;
        let client = clients
            .get(&server)
            .ok_or_else(|| anyhow::anyhow!("MCP server not found: {}", server))?;
        client.call_tool(&mcp_tool, arguments).await
    }

    pub fn is_mcp_tool(tool_name: &str) -> bool {
        tool_name.starts_with("mcp__")
    }
}

fn parse_mcp_tool_name(tool_name: &str) -> Result<(String, String)> {
    let rest = tool_name
        .strip_prefix("mcp__")
        .ok_or_else(|| anyhow::anyhow!("not an MCP tool: {}", tool_name))?;

    let (server, tool) = rest
        .split_once("__")
        .ok_or_else(|| anyhow::anyhow!("invalid MCP tool name: {}", tool_name))?;

    Ok((server.to_string(), tool.to_string()))
}

pub fn mcp_result_to_text(result: &McpToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|c| c.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
}
