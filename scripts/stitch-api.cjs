/**
 * Stitch MCP helper — X-Goog-Api-Key + curl (proxy-friendly).
 * Key: STITCH_API_KEY env, or .cursor/mcp.json headers.
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
  if (!key) throw new Error("Set STITCH_API_KEY or X-Goog-Api-Key in .cursor/mcp.json");
  return key.trim();
}

let requestId = 0;
let initialized = false;

function mcpCall(apiKey, payload) {
  requestId++;
  const bodyPath = path.join(__dirname, "_stitch-body.json");
  fs.writeFileSync(bodyPath, JSON.stringify(payload), "utf8");

  const args = [
    "-sL", "-X", "POST", MCP_URL,
    "-x", PROXY,
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json, text/event-stream",
    "-H", `X-Goog-Api-Key: ${apiKey}`,
    "--max-time", process.env.STITCH_TIMEOUT || "300",
    "-d", `@${bodyPath}`,
  ];

  const result = spawnSync("curl.exe", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`curl ${result.status}: ${result.stderr || result.stdout}`);
  }
  const text = (result.stdout || "").trim();
  if (!text) return null;
  return JSON.parse(text);
}

function ensureInit(apiKey) {
  if (initialized) return;
  mcpCall(apiKey, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lawyer-desktop", version: "0.1.0" },
    },
  });
  mcpCall(apiKey, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  initialized = true;
}

function callTool(name, args) {
  const apiKey = loadApiKey();
  ensureInit(apiKey);
  const res = mcpCall(apiKey, {
    jsonrpc: "2.0", id: ++requestId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = res?.result?.content?.[0]?.text;
  if (res?.result?.isError) {
    throw new Error(text || JSON.stringify(res));
  }
  if (res?.result?.structuredContent) return res.result.structuredContent;
  if (text) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return res?.result;
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action || action === "help") {
    console.log("Usage: node stitch-api.cjs <list|create|generate|screens|get> [args]");
    process.exit(0);
  }
  if (action === "list") {
    console.log(JSON.stringify(callTool("list_projects", {}), null, 2));
  } else if (action === "create") {
    const title = rest[0] || "墨律 Inkstatute";
    console.log(JSON.stringify(callTool("create_project", { title }), null, 2));
  } else if (action === "generate") {
    const [projectId, prompt, deviceType = "DESKTOP"] = rest;
    if (!projectId || !prompt) {
      console.error("Usage: node stitch-api.cjs generate <projectId> <prompt> [DESKTOP]");
      process.exit(1);
    }
    console.log("Generating… (may take 1-3 min)");
    console.log(JSON.stringify(callTool("generate_screen_from_text", { projectId, prompt, deviceType }), null, 2));
  } else if (action === "screens") {
    const projectId = rest[0];
    if (!projectId) { console.error("Usage: node stitch-api.cjs screens <projectId>"); process.exit(1); }
    console.log(JSON.stringify(callTool("list_screens", { projectId }), null, 2));
  } else if (action === "get") {
    const name = rest[0];
    if (!name) { console.error("Usage: node stitch-api.cjs get <projects/xxx/screens/yyy>"); process.exit(1); }
    console.log(JSON.stringify(callTool("get_screen", { name }), null, 2));
  } else {
    console.error(`Unknown action: ${action}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
