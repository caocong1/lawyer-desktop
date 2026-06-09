use anyhow::{Context, Result};
use serde_json::json;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::types::*;

pub struct McpClient {
    process: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    reader: Arc<Mutex<Option<BufReader<tokio::process::ChildStdout>>>>,
    request_id: Arc<Mutex<u64>>,
    config: McpServerConfig,
    tools: Arc<Mutex<Vec<McpTool>>>,
}

impl McpClient {
    pub fn new(config: McpServerConfig) -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            reader: Arc::new(Mutex::new(None)),
            request_id: Arc::new(Mutex::new(0)),
            config,
            tools: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn start(&self) -> Result<()> {
        let mut cmd = Command::new(&self.config.command);
        cmd.args(&self.config.args);

        if let Some(ref env) = self.config.env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().context("Failed to spawn MCP server process")?;

        let stdin = child.stdin.take().context("Failed to take stdin")?;
        let stdout = child.stdout.take().context("Failed to take stdout")?;

        *self.process.lock().await = Some(child);
        *self.stdin.lock().await = Some(stdin);
        *self.reader.lock().await = Some(BufReader::new(stdout));

        // Initialize MCP session
        self.initialize().await?;

        // List available tools
        let tools = self.list_tools().await?;
        *self.tools.lock().await = tools;

        Ok(())
    }

    async fn initialize(&self) -> Result<()> {
        let result = self
            .send_request("initialize", Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "lawyer-desktop",
                    "version": "0.1.0"
                }
            })))
            .await?;

        // Send initialized notification
        self.send_notification("notifications/initialized", None)
            .await?;

        log::info!("MCP initialized: {:?}", result);
        Ok(())
    }

    async fn list_tools(&self) -> Result<Vec<McpTool>> {
        let result = self
            .send_request("tools/list", None)
            .await?;

        if let Some(tools) = result.get("tools") {
            let tools: Vec<McpTool> = serde_json::from_value(tools.clone())
                .context("Failed to parse tools list")?;
            log::info!("MCP tools available: {}", tools.len());
            Ok(tools)
        } else {
            Ok(Vec::new())
        }
    }

    pub async fn call_tool(&self, name: &str, arguments: serde_json::Value) -> Result<McpToolResult> {
        let result = self
            .send_request("tools/call", Some(json!({
                "name": name,
                "arguments": arguments
            })))
            .await?;

        let tool_result: McpToolResult = serde_json::from_value(result)
            .context("Failed to parse tool result")?;

        Ok(tool_result)
    }

    pub async fn get_tools(&self) -> Vec<McpTool> {
        self.tools.lock().await.clone()
    }

    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let mut id_guard = self.request_id.lock().await;
        *id_guard += 1;
        let id = *id_guard;
        drop(id_guard);

        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };

        let request_json = serde_json::to_string(&request)?;
        log::debug!("MCP request: {}", request_json);

        // Write to stdin
        {
            let mut stdin_guard = self.stdin.lock().await;
            if let Some(ref mut stdin) = *stdin_guard {
                stdin.write_all(request_json.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
            } else {
                anyhow::bail!("MCP stdin not available");
            }
        }

        // Read response from stdout
        {
            let mut reader_guard = self.reader.lock().await;
            if let Some(ref mut reader) = *reader_guard {
                let mut line = String::new();
                loop {
                    line.clear();
                    let bytes_read = reader.read_line(&mut line).await?;
                    if bytes_read == 0 {
                        anyhow::bail!("MCP server closed stdout");
                    }

                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
                        if response.id == Some(id) {
                            if let Some(error) = response.error {
                                anyhow::bail!("MCP error ({}): {}", error.code, error.message);
                            }
                            return Ok(response.result.unwrap_or(serde_json::Value::Null));
                        }
                    }
                }
            } else {
                anyhow::bail!("MCP stdout not available");
            }
        }
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let json_str = serde_json::to_string(&notification)?;

        let mut stdin_guard = self.stdin.lock().await;
        if let Some(ref mut stdin) = *stdin_guard {
            stdin.write_all(json_str.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut process = self.process.lock().await;
        if let Some(ref mut child) = *process {
            child.kill().await.ok();
        }
        *process = None;
        *self.stdin.lock().await = None;
        *self.reader.lock().await = None;
        Ok(())
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let process = self.process.clone();
        let stdin = self.stdin.clone();
        let reader = self.reader.clone();
        tokio::spawn(async move {
            let mut p = process.lock().await;
            if let Some(ref mut child) = *p {
                child.kill().await.ok();
            }
            *p = None;
            *stdin.lock().await = None;
            *reader.lock().await = None;
        });
    }
}
