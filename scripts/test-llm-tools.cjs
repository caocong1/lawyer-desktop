/**
 * Probe whether saved LLM provider(s) support native OpenAI tool_calls vs DSML-in-content.
 * Requires `bun run tauri dev` (MCP bridge on ws://127.0.0.1:9223).
 */
const WebSocket = require("ws");

const PORT = Number(process.env.TAURI_MCP_PORT || 9223);
const url = `ws://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendCommand(ws, command, args = {}, timeoutMs = 120000) {
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${command}`)), timeoutMs);
    const onMessage = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, command, args }));
  });
}

async function connectWithRetry(maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("connect timeout"));
        }, 3000);
        socket.on("open", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await wait(1000);
    }
  }
  throw new Error("unreachable");
}

async function invokeTauri(ws, command, args = {}) {
  const res = await sendCommand(ws, "invoke_tauri", { command, args });
  if (!res.success) {
    throw new Error(res.error || `invoke ${command} failed`);
  }
  return res.data;
}

function containsToolLeakage(text) {
  if (!text) return false;
  return /dsml|tool_calls|<\/?invoke|invoke\s+name\s*=|parameter\s+name\s*=|function_call|<\|[^|]+\|>/i.test(
    text,
  );
}

function parseEmbeddedInvokes(content) {
  const names = [];
  const re = /invoke\s+name\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(content))) {
    names.push(m[1]);
  }
  return names;
}

async function probeProvider(label, provider) {
  const base = provider.api_base_url.replace(/\/$/, "");
  const endpoint = `${base}/chat/completions`;
  const body = {
    model: provider.model_name,
    messages: [
      {
        role: "system",
        content:
          "你是连通性测试助手。当用户要求工具测试时，必须通过 tools API 调用 ping_test，不要在正文输出 XML、DSML 或 invoke 标记。",
      },
      {
        role: "user",
        content: "请调用 ping_test 工具，参数 message 固定为 hello。只调用工具，不要写其它正文。",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "ping_test",
          description: "连通性测试工具，收到请求后必须调用，参数 message=hello",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "固定填 hello" },
            },
            required: ["message"],
          },
        },
      },
    ],
    temperature: 0,
    max_tokens: 300,
    stream: false,
  };

  const headers = { "Content-Type": "application/json" };
  if (provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  const started = Date.now();
  let httpStatus = 0;
  let raw = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    httpStatus = res.status;
    raw = await res.text();
  } catch (e) {
    return {
      slot: label,
      model: provider.model_name,
      api_base_url: provider.api_base_url,
      ok: false,
      latency_ms: Date.now() - started,
      verdict: "❌ 网络/API 请求失败",
      detail: String(e),
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      slot: label,
      model: provider.model_name,
      api_base_url: provider.api_base_url,
      ok: false,
      latency_ms: Date.now() - started,
      http_status: httpStatus,
      verdict: "❌ API 返回错误",
      detail: raw.slice(0, 800),
    };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      slot: label,
      model: provider.model_name,
      api_base_url: provider.api_base_url,
      ok: false,
      latency_ms: Date.now() - started,
      verdict: "❌ 响应不是 JSON",
      detail: raw.slice(0, 800),
    };
  }

  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const content = msg.content ?? "";
  const toolCalls = msg.tool_calls ?? [];
  const finishReason = choice?.finish_reason ?? null;
  const embedded = parseEmbeddedInvokes(content);
  const dsml = containsToolLeakage(content);

  let verdict;
  if (toolCalls.length > 0) {
    verdict = "✅ 支持标准 OpenAI tool_calls（Evidence/案卷检索可用）";
  } else if (embedded.length > 0) {
    verdict = "⚠️ 仅在正文嵌入 invoke/DSML（后端已做兼容，可能不稳定）";
  } else if (dsml) {
    verdict = "❌ 工具调用泄漏为 DSML/乱码，不适合案卷检索";
  } else {
    verdict = "❌ 未返回 tool_calls（模型可能忽略 tools 参数）";
  }

  return {
    slot: label,
    model: provider.model_name,
    api_base_url: provider.api_base_url,
    ok: toolCalls.length > 0,
    latency_ms: Date.now() - started,
    http_status: httpStatus,
    finish_reason: finishReason,
    native_tool_calls: toolCalls.length,
    tool_names: toolCalls.map((t) => t.function?.name).filter(Boolean),
    dsml_in_content: dsml,
    embedded_invoke_names: embedded,
    content_preview: String(content).slice(0, 240),
    verdict,
  };
}

async function main() {
  console.log(`Connecting MCP bridge ${url} ...`);
  const ws = await connectWithRetry();
  console.log("OK: connected\n");

  const primary = await invokeTauri(ws, "get_active_provider", {});
  if (!primary) {
    throw new Error("未配置主模型，请先在设置中保存 LLM");
  }

  console.log("=== 主模型 ===");
  console.log(`  ${primary.display_name || primary.name} / ${primary.model_name}`);
  console.log(`  ${primary.api_base_url}\n`);

  const primaryReport = await probeProvider("primary", primary);
  printReport(primaryReport);

  const fastMeta = await invokeTauri(ws, "get_fast_provider", {});
  if (fastMeta?.enabled && fastMeta.model_name) {
    console.log("\n=== 快速模型 ===");
    console.log(`  ${fastMeta.display_name || fastMeta.name} / ${fastMeta.model_name}`);
    console.log(`  ${fastMeta.api_base_url}\n`);
    const fastProbe = {
      ...primary,
      model_name: fastMeta.model_name,
      api_base_url: fastMeta.api_base_url,
      name: fastMeta.name,
      display_name: fastMeta.display_name,
    };
    const fastReport = await probeProvider("fast", fastProbe);
    printReport(fastReport);
  } else {
    console.log("\n(未启用快速模型，跳过)\n");
  }

  ws.close();
  process.exit(primaryReport.ok ? 0 : 1);
}

function printReport(r) {
  console.log(`Verdict: ${r.verdict}`);
  console.log(`Latency: ${r.latency_ms}ms`);
  if (r.http_status) console.log(`HTTP: ${r.http_status}`);
  if (r.finish_reason) console.log(`finish_reason: ${r.finish_reason}`);
  console.log(`native tool_calls: ${r.native_tool_calls ?? 0}`);
  if (r.tool_names?.length) console.log(`tool names: ${r.tool_names.join(", ")}`);
  if (r.embedded_invoke_names?.length) {
    console.log(`embedded invoke: ${r.embedded_invoke_names.join(", ")}`);
  }
  if (r.dsml_in_content) console.log("DSML/leakage in content: yes");
  if (r.content_preview) console.log(`content preview: ${JSON.stringify(r.content_preview)}`);
  if (r.detail && !r.ok) console.log(`detail: ${r.detail}`);
}

main().catch((err) => {
  console.error("\nFAIL:", err.message || err);
  console.error("提示: 请先运行 bun run tauri dev 并保持窗口打开");
  process.exit(1);
});
