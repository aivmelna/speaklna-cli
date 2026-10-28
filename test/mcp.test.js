import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { serve } from '../src/mcp.js';
import { callApp } from '../src/client.js';
import { main } from '../src/cli.js';

// 假传输：按 op 回固定内容，记录收到的请求
function fakeTx({ pingOk = true, installed = true, replies = {} } = {}) {
  const log = [];
  let up = pingOk;
  return {
    supported: true, log,
    async request(req) {
      log.push(req);
      if (!up) return null;
      const body = req.op === 'ping' ? { app: '1.1', build: '1' } : (replies[req.op] ?? {});
      return { v: 1, id: req.id, ok: true, ...body };
    },
    async launch() { log.push({ op: '__launch' }); return installed; },
    async waitReady() { log.push({ op: '__wait' }); up = true; return true; },
  };
}

async function session(tx, lines) {
  const input = new PassThrough(); const output = new PassThrough();
  const chunks = []; output.on('data', (d) => chunks.push(d));
  const done = serve(tx, { input, output });
  for (const l of lines) input.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
  input.end();
  await done;
  return Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('MCP 往返：initialize / tools/list / speak / stop / status / voices / ping', async () => {
  const tx = fakeTx({ replies: {
    speak: { result: 'speaking' }, stop: { stopped: 1 },
    status: { state: 'ready', speaking: null, muted: false, queued: 0 },
    voices: { voices: [{ id: 'v1', name: 'Ava', kind: 'fixed' }], default: 'v1' },
  } });
  const out = await session(tx, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-mcp-client' }, capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'speak', arguments: { text: '你好', voice: 'Ava' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'status', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'voices', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
    { jsonrpc: '2.0', id: 8, method: 'nope' },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'import_voice', arguments: {} } },
    'garbage',
  ]);
  const by = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.equal(by[1].result.protocolVersion, '2025-03-26');
  assert.equal(by[1].result.serverInfo.name, 'speaklna');
  assert.deepEqual(by[2].result.tools.map((t) => t.name), ['speak', 'stop', 'status', 'voices']);
  assert.ok(by[2].result.tools[0].description.includes('🔊'));
  assert.match(by[3].result.content[0].text, /Speaking/);
  assert.match(by[4].result.content[0].text, /Stopped 1/);
  assert.match(by[5].result.content[0].text, /state: ready/);
  assert.match(by[6].result.content[0].text, /Ava/);
  assert.deepEqual(by[7].result, {});
  assert.equal(by[8].error.code, -32601);
  assert.equal(by[9].error.code, -32602); // AI 没有导入音色之类的工具
  assert.equal(out.find((m) => m.id === null).error.code, -32700);
  const sp = tx.log.find((r) => r.op === 'speak');
  assert.equal(sp.kind, 'active'); assert.equal(sp.client, 'codex'); assert.equal(sp.voice, 'Ava'); assert.equal(sp.text, '你好'); assert.equal(sp.v, 1);
});

test('MCP: 空文本、App 报错都变成 isError 而不是协议错误', async () => {
  const tx = fakeTx();
  tx.request = async (req) => (req.op === 'ping' ? { ok: true, id: req.id } : { ok: false, id: req.id, error: 'unknown_voice' });
  const out = await session(tx, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speak', arguments: { text: '  ' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'speak', arguments: { text: 'hi', voice: 'zzz' } } },
  ]);
  assert.equal(out[0].result.isError, true);
  assert.equal(out[1].result.isError, true);
  assert.match(out[1].result.content[0].text, /Unknown voice/);
});

test('callApp: 没开 App → open 拉起 → 等就绪 → 再发', async () => {
  const tx = fakeTx({ pingOk: false, replies: { speak: { result: 'speaking' } } });
  const res = await callApp(tx, 'speak', { text: 'x', kind: 'active', client: 'other' });
  assert.equal(res.status, 'ok');
  assert.deepEqual(tx.log.map((r) => r.op), ['ping', '__launch', '__wait', 'speak']);
});
test('callApp: 没装（open 失败）→ not_installed，CLI 退出码 0 并指向 App Store', async () => {
  const tx = fakeTx({ pingOk: false, installed: false });
  assert.equal((await callApp(tx, 'status')).status, 'not_installed');
  const lines = [];
  const code = await main(['status'], { transport: tx, out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /App Store/);
});
test('callApp: 非 macOS', async () => {
  assert.equal((await callApp({ supported: false }, 'status')).status, 'unsupported');
});

test('CLI say / stop / status / voices（--json、stdin、--report）', async () => {
  const tx = fakeTx({ replies: { speak: { result: 'queued' }, stop: { stopped: 0 }, status: { state: 'sleeping', speaking: null, muted: true, muteReason: 'mic', queued: 2 }, voices: { voices: [], default: null } } });
  const out = []; const deps = { transport: tx, out: (s) => out.push(s), err: (s) => out.push(s), stdin: 'from stdin\n' };
  assert.equal(await main(['say', '--client', 'codex', '--session', 'S', '--project', 'P', '--voice', 'Ava', 'hello', 'world'], deps), 0);
  let sp = tx.log.filter((r) => r.op === 'speak').at(-1);
  assert.deepEqual([sp.text, sp.kind, sp.client, sp.session, sp.project, sp.voice], ['hello world', 'active', 'codex', 'S', 'P', 'Ava']);
  await main(['say', '--report', '-'], deps);
  sp = tx.log.filter((r) => r.op === 'speak').at(-1);
  assert.deepEqual([sp.text, sp.kind], ['from stdin', 'report']);
  await main(['say', '--', '--starts-with-dash'], deps);
  assert.equal(tx.log.filter((r) => r.op === 'speak').at(-1).text, '--starts-with-dash');
  out.length = 0;
  await main(['status', '--json'], deps);
  assert.equal(JSON.parse(out[0]).muteReason, 'mic');
  await main(['status'], deps);
  assert.match(out.at(-1), /muted: yes \(mic\)/);
  assert.equal(await main(['say'], deps), 1);
});

test('真进程：hook 不打印、退出码 0（Linux 上也静默）；say 在非 mac 上提示后退出 0', () => {
  const bin = new URL('../bin/speaklna.js', import.meta.url).pathname;
  for (const stdin of ['{"last_assistant_message":"🔊 hi"}', 'not json', '']) {
    const r = spawnSync(process.execPath, [bin, 'hook', 'claude'], { input: stdin, encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  const r = spawnSync(process.execPath, [bin, 'hook', 'bogus'], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, '');
  const s = spawnSync(process.execPath, [bin, 'status'], { encoding: 'utf8' });
  assert.equal(s.status, 0); assert.match(s.stdout, /macOS/);
});
