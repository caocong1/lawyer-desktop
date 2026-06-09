---
name: stitch-mcp-direct-api
description: How to call Google Stitch MCP API directly via curl. Covers correct auth header (X-Goog-Api-Key), endpoint, tool invocation, downloading generated HTML, and Windows Tauri build fixes.
source: auto-skill
extracted_at: '2026-06-09T02:08:50.532Z'
updated_at: '2026-06-09T06:30:00.000Z'
---

# Stitch MCP Direct API Invocation

## Problem
Node.js `fetch` (undici) does NOT respect `HTTP_PROXY`/`HTTPS_PROXY` environment variables. The `@_davideast/stitch-mcp` CLI tool and `@google/stitch-sdk` both use Node.js fetch internally, so they fail with `ConnectTimeoutError` when behind a proxy (e.g., Clash on `localhost:7897`).

## Solution: Direct curl to Stitch API

The Stitch MCP server exposes a standard MCP-over-HTTP endpoint that can be called directly via curl with proxy.

### API Endpoint
```
POST https://stitch.googleapis.com/mcp
```

### Authentication — CRITICAL
- **API Key**: Use header `X-Goog-Api-Key: <your-key>` (NOT `X-Api-Key` — that header does NOT work)
- **OAuth 2 Access Token**: Use header `Authorization: Bearer <token>` + `X-Goog-User-Project: <project-id>`
- **API Key CAN do everything** — including `create_project`, `generate_screen_from_text`, etc. No OAuth needed for basic usage.
- The Stitch SDK source code (`@google/stitch-sdk` on npm, `github.com/google-labs-code/stitch-sdk`) confirms the correct header is `X-Goog-Api-Key`.

### Curl Template (with proxy)
```bash
curl -x http://localhost:7897 -sL -X POST "https://stitch.googleapis.com/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Goog-Api-Key: YOUR_API_KEY" \
  --max-time 180 \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{...}}}'
```

**Important**: Use `Accept: application/json, text/event-stream` for `generate_screen_from_text` (it streams SSE). Use `Accept: application/json` for simpler calls.

### MCP JSON-RPC Methods

#### Initialize session
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-app","version":"0.1.0"}}}
```

#### List available tools
```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

#### Call a tool
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{...}}}
```

### Available Stitch Tools (as of 2026-06)
All tools work with API Key authentication:

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects |
| `create_project` | Create new project (only `title` param) |
| `get_project` | Get project details (requires `name`: `"projects/<id>"`) |
| `list_screens` | List screens in a project (requires `projectId`) |
| `get_screen` | Get screen details (requires `name`: `"projects/<id>/screens/<screenId>"`) |
| `generate_screen_from_text` | Generate UI from text prompt (requires `projectId` + `prompt`, optional `deviceType`) |
| `edit_screens` | Edit existing screens |
| `generate_variants` | Generate screen variants |
| `create_design_system` | Create design system |
| `list_design_systems` | List design systems |
| `apply_design_system` | Apply design system to screens |

### Full Workflow: Generate and Download UI

#### Step 1: Create project
```bash
curl -x http://localhost:7897 -sL -X POST "https://stitch.googleapis.com/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -H "X-Goog-Api-Key: YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_project","arguments":{"title":"My App"}}}'
```
Response contains `structuredContent.name` like `"projects/1234567890"`.

#### Step 2: Generate screen
```bash
curl -x http://localhost:7897 -sL -X POST "https://stitch.googleapis.com/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "X-Goog-Api-Key: YOUR_KEY" --max-time 180 \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_screen_from_text","arguments":{"projectId":"PROJECT_ID","prompt":"Describe your UI...","deviceType":"DESKTOP"}}}'
```
This takes 1-2 minutes. Response contains `structuredContent.outputComponents[].design.screens[].htmlCode.downloadUrl`.

#### Step 3: Download HTML
```bash
curl -x http://localhost:7897 -sL "DOWNLOAD_URL_FROM_STEP_2" -o output.html
```

#### Step 4: Extract download URL with Node
```bash
# Save response to file, then extract URL:
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('response.json','utf8'));const comps=j.result?.structuredContent?.outputComponents||[];comps.forEach((c,i)=>{if(c.design?.screens){c.design.screens.forEach((s,si)=>{if(s.htmlCode?.downloadUrl)console.log(s.htmlCode.downloadUrl)})}})}"
```

### Parsing responses
The response structure for tool calls is:
```json
{
  "result": {
    "structuredContent": { ... },  // Parsed structured data
    "content": [{ "text": "...", "type": "text" }]  // Raw text fallback
  }
}
```
Always check `structuredContent` first. For `generate_screen_from_text`, the structure is:
```
result.structuredContent.outputComponents[].design.screens[] — array of screen objects
result.structuredContent.outputComponents[].text — description text
result.structuredContent.sessionId — session ID
```

### Extracting tool names from response
```bash
curl ... | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);j.result.tools.forEach(t=>console.log(t.name+': '+(t.description||'').substring(0,120)))})"
```

## Prompt Engineering for Native Desktop Apps

Stitch tends to generate web-looking UI (Tailwind cards, nav bars, breadcrumbs) by default. To get native desktop app designs, use explicit prompts like:

```
Native desktop application UI. NOT a website — this is a native app like VS Code, Slack Desktop, or Raycast.
Design requirements:
1) Custom title bar with traffic light window controls (red/yellow/green dots) on left.
2) Ultra-compact sidebar with icon-only navigation that expands on hover.
3) Main area with glassmorphism effects, subtle gradients, and depth.
4) Floating input bar at bottom with blur backdrop, rounded corners.
5) Color scheme: deep navy/charcoal background with electric blue and cyan accents.
6) Status bar at very bottom showing connection status.
7) Make it feel premium. Avoid web-like elements: no navigation bars, breadcrumbs, or card grids.
```

Key phrases that help: "NOT a website", "native app like VS Code/Slack/Raycast", "Avoid web-like elements", "glassmorphism", "floating input bar".

## Key Gotchas
1. **Auth header**: MUST be `X-Goog-Api-Key` — NOT `X-Api-Key` (which returns "missing authentication credential")
2. **API Key works for everything**: Both read and write operations work with API Key. No OAuth needed.
3. **Node.js proxy**: `HTTP_PROXY` env var does NOT work with Node.js native fetch/undici. Must use direct curl or configure undici's `ProxyAgent` programmatically
4. **create_project params**: Only accepts `title` (string), not `description`
5. **generate_screen_from_text**: Requires `projectId` (bare ID, not `projects/xxx` format) + `prompt`. Takes 1-2 minutes. Use `--max-time 180` with curl.
6. **Stitch is a SPA**: The website `stitch.withgoogle.com` is a single-page app, so curl/web_fetch cannot extract rendered content
7. **Download URLs**: HTML download URLs are from `contribution.usercontent.google.com` — also need proxy to download
8. **Official SDK**: `@google/stitch-sdk` on npm (`github.com/google-labs-code/stitch-sdk`) provides a cleaner API but has the same Node.js proxy limitation
9. **MinGW linker error**: On Windows, if rustc host is `x86_64-pc-windows-gnu` (e.g., from Chocolatey), Tauri builds fail with `export ordinal too large`. Fix: create `src-tauri/.cargo/config.toml` with `[build]\ntarget = "x86_64-pc-windows-msvc"` and ensure MSVC toolchain is installed via `rustup target add x86_64-pc-windows-msvc`
10. **Port conflicts**: If port 1420 is busy from a previous `tauri dev`, kill the process: `for /f "tokens=5" %a in ('netstat -aon ^| findstr :1420 ^| findstr LISTENING') do taskkill /f /pid %a`
