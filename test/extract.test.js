import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from '../src/hook.js';
import { tmp } from './helpers.js';

const run = (family, payload, opts = {}) => {
  const sent = [];
  const r = runHook(family, JSON.stringify(payload), { platform: 'darwin', env: {}, send: (a) => sent.push(a), ...opts });
  return { r, sent };
};
const flag = (args, k) => args[args.indexOf(k) + 1];

test('claude: last_assistant_message', () => {
  const { sent } = run('claude', { session_id: 's1', cwd: '/Users/x/proj/app', stop_hook_active: false, last_assistant_message: '改好了\n🔊 登录问题修好了。' });
  assert.equal(sent.length, 1);
  const a = sent[0];
  assert.equal(flag(a, '--client'), 'claude-code');
  assert.equal(flag(a, '--session'), 's1');
  assert.equal(flag(a, '--project'), 'app');
  assert.ok(a.includes('--report'));
  assert.equal(a.at(-1), '登录问题修好了。');
  assert.equal(a.at(-2), '--');
});
test('claude: 没 🔊 不发；GROK_HOOK_EVENT 设了不发', () => {
  assert.equal(run('claude', { last_assistant_message: 'plain' }).sent.length, 0);
  assert.equal(run('claude', { last_assistant_message: '🔊 hi' }, { env: { GROK_HOOK_EVENT: 'Stop' } }).sent.length, 0);
});
test('claude: 旧版退回 transcript（跳过 tool_result 与子代理）', () => {
  const d = tmp(); const f = path.join(d, 't.jsonl');
  const rows = [
    { type: 'user', message: { content: 'old' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '🔊 old report' }] } },
    { type: 'user', message: { content: 'do it' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '🔊 sidechain' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.\n🔊 Build passes.' }] } },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"type":"assis');
  const { sent } = run('claude', { session_id: 's', cwd: '/a/b', transcript_path: f });
  assert.equal(sent[0].at(-1), 'Build passes.');
});
test('codex', () => {
  const { sent } = run('codex', { session_id: 'c1', cwd: '/w/p/', last_assistant_message: '🔊 Done, review the diff.' });
  assert.equal(flag(sent[0], '--client'), 'codex');
  assert.equal(flag(sent[0], '--project'), 'p');
});
test('grok: 只有 end_turn 才念，驼峰字段', () => {
  const p = { lastAssistantMessage: 'x\n🔊 Grok finished.', sessionId: 'g1', cwd: '/h/proj', reason: 'end_turn' };
  const { sent } = run('grok', p);
  assert.equal(flag(sent[0], '--client'), 'grok');
  assert.equal(flag(sent[0], '--session'), 'g1');
  assert.equal(run('grok', { ...p, reason: 'max_tokens' }).sent.length, 0);
  assert.equal(run('grok', { ...p, reason: undefined }).sent.length, 0);
});
test('opencode: 插件交来整段文字', () => {
  const { sent } = run('opencode', { text: 'ok\n🔊 OpenCode is done.', sessionId: 'o1', cwd: '/r/oc' });
  assert.equal(flag(sent[0], '--client'), 'opencode');
  assert.equal(flag(sent[0], '--project'), 'oc');
});
test('openclaw: 插件交来的 messages / message:sent 的 context.content', () => {
  const a = run('openclaw', { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: '🔊 Claw says hi.' }] }] });
  assert.equal(a.sent[0].at(-1), 'Claw says hi.');
  const b = run('openclaw', { context: { content: 'x\n🔊 Sent hook works.', sessionKey: 'k' } });
  assert.equal(b.sent[0].at(-1), 'Sent hook works.');
  assert.equal(flag(b.sent[0], '--session'), 'k');
});
test('非 macOS / 坏 JSON / 未知家：静默不发，不抛', () => {
  assert.equal(run('claude', { last_assistant_message: '🔊 hi' }, { platform: 'linux' }).sent.length, 0);
  assert.equal(runHook('claude', 'not json', { platform: 'darwin', send: () => assert.fail() }), null);
  assert.equal(runHook('nope', '{}', { platform: 'darwin', send: () => assert.fail() }), null);
  assert.equal(runHook('claude', '{}', { platform: 'darwin', send: () => { throw new Error('boom'); } }), null);
});
