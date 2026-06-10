/**
 * Smoke test for Google Stitch MCP (HTTP transport).
 * Uses proxy http://127.0.0.1:7897 when STITCH_PROXY is unset (common Clash port).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MCP_URL = "https://stitch.googleapis.com/mcp";
const PROXY = process.env.STITCH_PROXY || "http://127.0.0.1:7897";

function loadApiKey() {
  if (process.env.STITCH_API_KEY) return process.env.STITCH_API_KEY.trim();
  const mcpPath = path.join(__dirname, "..", ".cursor", "mcp.json");
  const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  const key = cfg?.mcpServers?.stitch?.headers?.["X-Goog-Api-Key"];
  if (!key || key.includes("${env:")) {
    throw new Error("Set STITCH_API_KEY or X-Goog-Api-Key in .cursor/mcp.json");
  }
  return key.trim();
}

function mcpCall(apiKey, payload) {
  const bodyPath = path.join(__dirname, "_stitch-body.json");
  fs.writeFileSync(bodyPath, JSON.stringify(payload), "utf8");

  const args = [
    "-sL",
    "-X",
    "POST",
    MCP_URL,
    "-x",
    PROXY,
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: application/json",
    "-H",
    `X-Goog-Api-Key: ${apiKey}`,
    "--max-time",
    "90",
    "-d",
    `@${bodyPath}`,
  ];

  const result = spawnSync("curl.exe", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`curl exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  const text = (result.stdout || "").trim();
  if (!text) throw new Error("empty response from Stitch MCP");
  return JSON.parse(text);
}

async function main() {
  const apiKey = loadApiKey();
  console.log(`Using proxy: ${PROXY}`);
  console.log(`API key prefix: ${apiKey.slice(0, 6)}...`);

  const init = mcpCall(apiKey, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lawyer-desktop-test", version: "0.1.0" },
    },
  });
  console.log("OK: initialize", JSON.stringify(init, null, 2));

  try {
    mcpCall(apiKey, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    console.log("OK: notifications/initialized (no response body expected)");
  } catch {
    console.log("OK: notifications/initialized sent");
  }

  const tools = mcpCall(apiKey, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const names = tools?.result?.tools?.map((t) => t.name) ?? [];
  console.log("OK: tools", names.join(", "));

  const projects = mcpCall(apiKey, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  });
  console.log("OK: list_projects", JSON.stringify(projects, null, 2));

  const title = `墨律 Inkstatute Test ${new Date().toISOString().slice(0, 10)}`;
  const created = mcpCall(apiKey, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "create_project", arguments: { title } },
  });
  console.log("OK: create_project", JSON.stringify(created, null, 2));
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
