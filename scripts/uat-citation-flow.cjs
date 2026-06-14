/**
 * UAT: citation-research core loop through the real app. Asserts that an
 * evidence-mode litigation plan (a) actually used legal-retrieval tools,
 * (b) produced a citation_audit (trace + persisted metadata), and (c) the
 * saved assistant metadata carries verification stats.
 *
 * Run while `bun run tauri dev` is active:
 *   node scripts/uat-citation-flow.cjs
 */
const WebSocket = require("ws");

const PORT = Number(process.env.TAURI_MCP_PORT || 9223);
const url = `ws://127.0.0.1:${PORT}`;
const CASE_DIR =
  process.env.UAT_CASE_DIR ||
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
  if (!res.success) throw new Error(res.error || "execute_js failed");
  return res.data;
}

async function main() {
  console.log(`connecting ${url} ...`);
  const ws = await connectWithRetry();
  console.log("connected");

  const caseDirJs = JSON.stringify(CASE_DIR);

  // Start the turn and record agent-trace events we care about.
  const startScript = `
    (async () => {
      const inv = (window.__TAURI__ ? window.__TAURI__.core.invoke : window.__TAURI_INTERNALS__.invoke);
      const ev = (window.__TAURI__ ? window.__TAURI__.event.listen : window.__TAURI_INTERNALS__ && null);
      const conv = await inv('create_conversation');
      window.__UAT = {
        status: 'running', convId: conv.id, startedAt: Date.now(),
        retrievalCalls: [], citationAudit: null,
      };
      if (window.__TAURI__) {
        await window.__TAURI__.event.listen('agent-trace', (e) => {
          const p = e.payload;
          if (!p || p.conversation_id !== conv.id) return;
          if (p.kind === 'tool_call') {
            const n = (p.payload && p.payload.name) || '';
            if (/legal_search|search_law|get_law_article|mcp__law|mcp__wenshu/.test(n)) {
              window.__UAT.retrievalCalls.push(n);
            }
          }
          if (p.kind === 'citation_audit') {
            window.__UAT.citationAudit = p.payload;
          }
        });
      }
      inv('send_message', {
        req: {
          conversation_id: conv.id,
          content: '读取目录下全部材料，生成诉讼方案，所有法律依据须给出法条引用',
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
    console.log(
      `  [${elapsed}s] status=${state.status} retrievalCalls=${(state.retrievalCalls || []).length}`,
    );
    if (state.status === "done" || state.status === "error") break;
    if (Date.now() - t0 > 10 * 60 * 1000) {
      console.log("FAIL: timed out waiting for send_message");
      process.exit(1);
    }
  }

  if (state.status === "error") {
    console.log("FAIL: send_message error:", state.error);
    process.exit(1);
  }

  // Allow the post-turn citation_audit event + metadata persistence to land.
  await wait(5000);
  state = JSON.parse(await execJs(ws, "JSON.stringify(window.__UAT || {})"));

  const result = JSON.parse(
    await execJs(
      ws,
      `
      (async () => {
        const inv = (window.__TAURI__ ? window.__TAURI__.core.invoke : window.__TAURI_INTERNALS__.invoke);
        const msgs = await inv('get_messages', { conversationId: window.__UAT.convId });
        const assistant = msgs.filter((m) => m.role === 'assistant').pop();
        let audit = null;
        try {
          const meta = assistant && assistant.metadata_json ? JSON.parse(assistant.metadata_json) : null;
          audit = meta ? meta.citation_audit : null;
        } catch {}
        return JSON.stringify({
          len: assistant ? assistant.content.length : 0,
          metaAudit: audit,
        });
      })()
    `,
    ),
  );

  const retrievalCalls = state.retrievalCalls || [];
  const traceAudit = state.citationAudit;
  const metaAudit = result.metaAudit;

  console.log("\n=== RESULTS ===");
  console.log(`answer length: ${result.len}`);
  console.log(`retrieval tool calls: ${retrievalCalls.length}`, [...new Set(retrievalCalls)]);
  console.log(`trace citation_audit:`, traceAudit ? `total=${traceAudit.total} verified=${traceAudit.verified} retrieved=${traceAudit.retrieved} unverified=${traceAudit.unverified}` : "MISSING");
  console.log(`metadata citation_audit:`, metaAudit ? `total=${metaAudit.total}` : "missing (ok if total=0)");

  const usedRetrieval = retrievalCalls.length > 0;
  const hasAuditEvent = !!traceAudit;
  const hasCitations = !!traceAudit && traceAudit.total > 0;
  const metadataConsistent = !hasCitations || (metaAudit && metaAudit.total === traceAudit.total);

  console.log("\n=== VERDICT ===");
  console.log(`used legal retrieval tools: ${usedRetrieval ? "yes" : "NO (FAIL)"}`);
  console.log(`citation_audit trace event: ${hasAuditEvent ? "yes" : "NO (FAIL)"}`);
  console.log(`document contains citations: ${hasCitations ? "yes" : "NO (FAIL)"}`);
  console.log(`metadata persisted consistently: ${metadataConsistent ? "yes" : "NO (FAIL)"}`);

  ws.close();
  process.exit(usedRetrieval && hasAuditEvent && hasCitations && metadataConsistent ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  console.error("提示: 请先运行 bun run tauri dev 并保持窗口打开");
  process.exit(1);
});
