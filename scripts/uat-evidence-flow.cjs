/**
 * UAT: full evidence-mode flow through the real app (send_message with a
 * directory ref → litigation plan). Run while `bun run tauri dev` is active.
 * Drives the app via mcp-bridge execute_js + (window.__TAURI__ ? window.__TAURI__.core.invoke : window.__TAURI_INTERNALS__.invoke).
 */
const WebSocket = require("ws");

const PORT = Number(process.env.TAURI_MCP_PORT || 9223);
const url = `ws://127.0.0.1:${PORT}`;
const CASE_DIR =
  "C:\\Users\\sorawatcher\\workspace\\cn-lawyer-docs-skill\\learning-materials\\guohang-chongqing-shuangye\\case-materials\\案件资料";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendCommand(ws, command, args = {}, timeoutMs = 60000) {
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

async function connectWithRetry(maxAttempts = 60) {
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
      await wait(2000);
    }
  }
  throw new Error("unreachable");
}

async function execJs(ws, script, timeoutMs = 60000) {
  const res = await sendCommand(ws, "execute_js", { script }, timeoutMs);
  if (!res.success) {
    throw new Error(res.error || "execute_js failed");
  }
  return res.data;
}

function containsToolLeakage(text) {
  if (!text) return false;
  const normalized = text.replace(/｜/g, "|");
  return /dsml|tool_calls?|<\/?invoke|invoke\s+name\s*=|parameter\s+name\s*=|function_call|<\|/i.test(
    normalized,
  );
}

async function main() {
  console.log(`connecting ${url} ...`);
  const ws = await connectWithRetry();
  console.log("connected");

  const caseDirJs = JSON.stringify(CASE_DIR);

  const startScript = `
    (async () => {
      const inv = (window.__TAURI__ ? window.__TAURI__.core.invoke : window.__TAURI_INTERNALS__.invoke);
      const conv = await inv('create_conversation');
      window.__UAT = { status: 'running', convId: conv.id, startedAt: Date.now() };
      inv('send_message', {
        req: {
          conversation_id: conv.id,
          content: '读取目录下全部材料，生成诉讼方案',
          attachments: null,
          context_refs: [{ alias: '案件资料', path: ${caseDirJs}, kind: 'directory' }],
        },
      })
        .then((id) => { window.__UAT.status = 'done'; window.__UAT.messageId = id; })
        .catch((e) => { window.__UAT.status = 'error'; window.__UAT.error = String(e); });
      return JSON.stringify({ convId: conv.id });
    })()
  `;

  const started = JSON.parse(await execJs(ws, startScript));
  console.log("conversation:", started.convId, "— send_message running...");

  const t0 = Date.now();
  let state;
  for (;;) {
    await wait(10000);
    state = JSON.parse(await execJs(ws, "JSON.stringify(window.__UAT || {})"));
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${elapsed}s] status=${state.status}`);
    if (state.status === "done" || state.status === "error") break;
    if (Date.now() - t0 > 8 * 60 * 1000) {
      console.log("FAIL: timed out waiting for send_message");
      process.exit(1);
    }
  }

  if (state.status === "error") {
    console.log("FAIL: send_message error:", state.error);
    process.exit(1);
  }

  const result = JSON.parse(
    await execJs(
      ws,
      `
      (async () => {
        const inv = (window.__TAURI__ ? window.__TAURI__.core.invoke : window.__TAURI_INTERNALS__.invoke);
        const msgs = await inv('get_messages', { conversationId: window.__UAT.convId });
        const assistant = msgs.filter((m) => m.role === 'assistant').pop();
        const c = assistant ? assistant.content : '';
        return JSON.stringify({
          count: msgs.length,
          len: c.length,
          head: c.slice(0, 400),
          tail: c.slice(-400),
        });
      })()
    `,
    ),
  );

  console.log(`assistant message: ${result.len} chars (messages=${result.count})`);
  console.log("--- head ---\n" + result.head);
  console.log("--- tail ---\n" + result.tail);

  const full = result.head + "\n" + result.tail;
  const leak = containsToolLeakage(full);
  const longEnough = result.len > 1500;
  const isErrorMsg = full.includes("分析未完成") || full.includes("发送失败");

  console.log("\n=== VERDICT ===");
  console.log(`leakage in saved message: ${leak ? "YES (FAIL)" : "no"}`);
  console.log(`length > 1500: ${longEnough ? "yes" : "NO (FAIL)"}`);
  console.log(`error placeholder: ${isErrorMsg ? "YES (FAIL)" : "no"}`);

  ws.close();
  process.exit(!leak && longEnough && !isErrorMsg ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  console.error("提示: 请先运行 bun run tauri dev 并保持窗口打开");
  process.exit(1);
});
