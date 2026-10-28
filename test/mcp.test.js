import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
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
    // 存 wav：saveDone(req) → 结果（null = 一直没存完）；进度报一条
    async save(req, opts = {}) {
      log.push(req);
      if (!up) return { reply: null, done: null };
      const reply = { v: 1, id: req.id, ok: true, result: 'saving', path: '/Users/x/Music/Speaklna/a.wav', ...(replies.save ?? {}) };
      if (reply.ok === false) return { reply, done: null };
      opts.onProgress?.({ id: req.id, state: 'progress', segments: 1, seconds: 2 });
      log.push({ op: '__saveOpts', waitMs: opts.waitMs });
      return { reply, done: replies.saveDone ? replies.saveDone(req) : null };
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
  assert.deepEqual(by[2].result.tools.map((t) => t.name), ['speak', 'save', 'stop', 'status', 'voices']);
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

test('MCP save：存完回路径；长文到点先回“还在存”；busy 变 isError', async () => {
  const ok = fakeTx({ replies: { saveDone: (q) => ({ id: q.id, state: 'done', ok: true, path: '/Users/x/Music/Speaklna/hi.wav', seconds: 3.24 }) } });
  let out = await session(ok, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save', arguments: { text: '你好', voice: 'Ava', name: 'hi' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'save', arguments: { text: ' ' } } },
  ]);
  const by = Object.fromEntries(out.map((m) => [m.id, m])); // 并发处理，回的顺序不定
  assert.match(by[2].result.content[0].text, /Saved 3.2 s of audio to \/Users\/x\/Music\/Speaklna\/hi\.wav/);
  assert.equal(by[2].result.isError, false);
  assert.equal(by[3].result.isError, true);
  const sv = ok.log.find((r) => r.op === 'save');
  assert.deepEqual([sv.text, sv.voice, sv.name, sv.client], ['你好', 'Ava', 'hi', 'claude-code']);
  assert.equal(ok.log.find((r) => r.op === '__saveOpts').waitMs, 50000); // Codex 工具 60 s 超时，先回

  out = await session(fakeTx(), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save', arguments: { text: 'long' } } }]);
  assert.match(out[0].result.content[0].text, /Still saving.*a\.wav/);
  assert.equal(out[0].result.isError, false);

  out = await session(fakeTx({ replies: { save: { ok: false, error: 'busy' } } }), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save', arguments: { text: 'x' } } }]);
  assert.equal(out[0].result.isError, true);
  assert.match(out[0].result.content[0].text, /busy|reading or saving/);
});

test('CLI save：路径打 stdout；-o 文件 / 目录挪过去；--json；存不成退出码 1', async () => {
  const dir = tmp();
  const music = path.join(dir, 'Music'); fs.mkdirSync(music);
  const saveDone = (q) => {
    const p = path.join(music, (q.name ?? 'Speaklna 1') + '.wav');
    fs.writeFileSync(p, 'RIFF');
    return { id: q.id, state: 'done', ok: true, path: p, seconds: 1.5 };
  };
  const tx = fakeTx({ replies: { saveDone } });
  const lines = []; const deps = { transport: tx, out: (s) => lines.push(s), err: (s) => lines.push('ERR ' + s), isTTY: false, stdin: '从标准输入\n' };

  assert.equal(await main(['save', '你好'], deps), 0);
  assert.equal(lines.at(-1), path.join(music, 'Speaklna 1.wav'));
  assert.equal(tx.log.filter((r) => r.op === 'save').at(-1).name, undefined);

  // -o 文件：App 里就用这个名字，存完挪过去（补 .wav）
  assert.equal(await main(['save', '-o', path.join(dir, 'out', 'clip'), '--voice', 'Ava', '-'], deps), 0);
  let sv = tx.log.filter((r) => r.op === 'save').at(-1);
  assert.deepEqual([sv.text, sv.name, sv.voice], ['从标准输入', 'clip', 'Ava']);
  assert.equal(lines.at(-1), path.join(dir, 'out', 'clip.wav'));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'clip.wav')) && !fs.existsSync(path.join(music, 'clip.wav')));

  // -o 已有目录：放进去，用 App 起的名字；--name 优先
  assert.equal(await main(['save', '--name', 'n1', '--json', '-o', dir, 'hi'], deps), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)), { ok: true, path: path.join(dir, 'n1.wav'), seconds: 1.5 });

  assert.equal(await main(['save'], deps), 1);
  const busy = fakeTx({ replies: { save: { ok: false, error: 'busy' } } });
  assert.equal(await main(['save', 'x'], { ...deps, transport: busy }), 1);
  assert.match(lines.at(-1), /^ERR .*reading or saving/);
  assert.equal(await main(['save', 'x'], { ...deps, transport: fakeTx({ pingOk: false, installed: false }) }), 1); // 没装：存不成就是失败
  assert.equal(await main(['save', 'x'], { ...deps, transport: fakeTx() }), 1); // 收下后一直没动静
  fs.rmSync(dir, { recursive: true, force: true });
});
