/**
 * Smoke test for tauri-plugin-mcp-bridge (default ws://127.0.0.1:9223).
 * Run while `bun run tauri dev` is active.
 */
const WebSocket = require("ws");

const PORT = Number(process.env.TAURI_MCP_PORT || 9223);
const url = `ws://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendCommand(ws, command, args = {}, timeoutMs = 8000) {
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

async function connectWithRetry(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ws = await new Promise((resolve, reject) => {
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
      console.log(`OK: connected to MCP bridge at ${url}`);
      return ws;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      process.stdout.write(`waiting for bridge (${attempt}/${maxAttempts})...\r`);
      await wait(1000);
    }
  }
  throw new Error("unreachable");
}

async function main() {
  const ws = await connectWithRetry();

  const windowInfo = await sendCommand(ws, "get_window_info", { windowLabel: "main" });
  if (!windowInfo.success) {
    throw new Error(`get_window_info failed: ${windowInfo.error || "unknown"}`);
  }
  console.log("OK: window info", JSON.stringify(windowInfo.data, null, 2));

  const backend = await sendCommand(ws, "invoke_tauri", {
    command: "plugin:mcp-bridge|get_backend_state",
    args: {},
  });
  if (!backend.success) {
    throw new Error(`get_backend_state failed: ${backend.error || "unknown"}`);
  }
  console.log("OK: backend state", JSON.stringify(backend.data, null, 2));

  const windows = await sendCommand(ws, "list_windows", {});
  if (!windows.success) {
    throw new Error(`list_windows failed: ${windows.error || "unknown"}`);
  }
  console.log("OK: windows", JSON.stringify(windows.data, null, 2));

  ws.close();
  console.log("tauri-mcp bridge smoke test passed");
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
