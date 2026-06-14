'use strict';
// test-law-database-connector.cjs — protocol + behavior tests for the
// law-database MCP connector.
//
//   node scripts/test-law-database-connector.cjs            # real network
//   LAW_DB_FIXTURES=1 node scripts/test-law-database-connector.cjs  # canned fixtures
//
// Always: full handshake + tools/list shape + unknown-method error.
// With LAW_DB_FIXTURES: search_laws served from fixtures (民法典 + degraded path).
// Without: real flk search, real get_law_detail (民法典, prints first 800 chars),
// real search_cases_by_law.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONNECTOR = path.join(ROOT, 'vendor', 'ai-for-china-legal', 'connectors', 'law-database', 'index.js');
const FIXTURES_MODE = !!process.env.LAW_DB_FIXTURES;
const CALL_TIMEOUT_MS = 55000;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function startConnector() {
  // Fresh cache dir per run so cached results never mask live behavior.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-db-test-cache-'));
  const child = spawn(process.execPath, [CONNECTOR], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { LAW_DB_CACHE_DIR: cacheDir }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[connector] ' + d));

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.log(`  FAIL  stdout line is not JSON: ${line.slice(0, 120)}`);
        failed++;
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  let nextId = 0;
  function rpc(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = ++nextId;
    const req = { jsonrpc: '2.0', id, method };
    if (params !== undefined) req.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }
  return { child, rpc, notify };
}

function toolText(resp) {
  const c = resp.result && resp.result.content;
  return (Array.isArray(c) && c[0] && c[0].text) || '';
}

async function main() {
  console.log(`law-database connector test — mode: ${FIXTURES_MODE ? 'fixtures' : 'real network'}`);
  const { child, rpc, notify } = startConnector();

  try {
    // --- 1. handshake ---
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lawyer-desktop-test', version: '0.1.0' },
    });
    check('initialize: protocolVersion 2024-11-05', init.result && init.result.protocolVersion === '2024-11-05');
    check('initialize: serverInfo.name law-database', init.result && init.result.serverInfo && init.result.serverInfo.name === 'law-database');
    notify('notifications/initialized');

    const list = await rpc('tools/list');
    const tools = (list.result && list.result.tools) || [];
    check('tools/list: 3 tools', tools.length === 3, `got ${tools.length}`);
    const names = tools.map((t) => t.name).sort();
    check(
      'tools/list: names',
      JSON.stringify(names) === JSON.stringify(['get_law_detail', 'search_cases_by_law', 'search_laws']),
      names.join(',')
    );
    check(
      'tools/list: every tool has inputSchema object (camelCase)',
      tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object')
    );

    const unknown = await rpc('definitely/not-a-method');
    check('unknown method -> -32601', unknown.error && unknown.error.code === -32601, JSON.stringify(unknown.error));

    if (FIXTURES_MODE) {
      // --- 2. fixtures branch ---
      const search = await rpc('tools/call', { name: 'search_laws', arguments: { keyword: '民法典', pageSize: 5 } });
      const sText = toolText(search);
      check('fixtures search_laws: isError false', search.result && search.result.isError === false);
      check('fixtures search_laws: contains 来源层级:', sText.includes('来源层级:'));
      check('fixtures search_laws: contains 链接:', sText.includes('链接:'));
      check('fixtures search_laws: contains 民法典', sText.includes('民法典'));
      console.log('\n--- fixtures search_laws (first 600 chars) ---\n' + sText.slice(0, 600) + '\n---\n');

      const degraded = await rpc('tools/call', { name: 'search_laws', arguments: { keyword: '触发降级' } });
      const dText = toolText(degraded);
      check('fixtures degraded: isError stays false', degraded.result && degraded.result.isError === false);
      check('fixtures degraded: explains degradation', /降级|不可达|受限|验证码/.test(dText), dText.slice(0, 120));
      check('fixtures degraded: suggests search_law', dText.includes('search_law'));
      console.log('\n--- fixtures degraded path (first 400 chars) ---\n' + dText.slice(0, 400) + '\n---\n');
    } else {
      // --- 3. real network branch ---
      const search = await rpc('tools/call', { name: 'search_laws', arguments: { keyword: '民法典' } });
      const sText = toolText(search);
      check('search_laws(民法典): isError false', search.result && search.result.isError === false);
      check('search_laws(民法典): contains 来源层级:', sText.includes('来源层级:'), sText.slice(0, 200));
      check('search_laws(民法典): contains 链接:', sText.includes('链接:'));
      console.log('\n--- search_laws 民法典 (first 800 chars) ---\n' + sText.slice(0, 800) + '\n---\n');

      const detail = await rpc('tools/call', { name: 'get_law_detail', arguments: { lawName: '中华人民共和国民法典' } });
      const dText = toolText(detail);
      check('get_law_detail: isError false', detail.result && detail.result.isError === false);
      check('get_law_detail: contains 来源层级:', dText.includes('来源层级:'), dText.slice(0, 200));
      check('get_law_detail: substantial text (>2000 chars)', dText.length > 2000, `len ${dText.length}`);
      console.log('\n--- get_law_detail 中华人民共和国民法典 (first 800 chars) ---\n' + dText.slice(0, 800) + '\n---\n');

      const casesResp = await rpc('tools/call', { name: 'search_cases_by_law', arguments: { lawName: '民法典' } });
      const cText = toolText(casesResp);
      check('search_cases_by_law: isError false', casesResp.result && casesResp.result.isError === false);
      check('search_cases_by_law: wenshu pointer present', cText.includes('mcp__wenshu__search_cases'));
      console.log('\n--- search_cases_by_law 民法典 (first 600 chars) ---\n' + cText.slice(0, 600) + '\n---\n');
    }
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test runner crashed:', e);
  process.exit(1);
});
