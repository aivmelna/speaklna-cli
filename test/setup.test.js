import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSetup, runUninstall, makeCtx } from '../src/setup.js';
import { FAMILY_IDS } from '../src/families.js';
import { tmp, snapshot, put, parseLoose, silentIo } from './helpers.js';

// 现有用户配置：带无关键、注释、尾逗号、没有结尾换行等刁钻形状
const EXISTING = (h) => ({
  '.claude.json': JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }, null, 2) + '\n',
  '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/true' }] }], PreToolUse: [] } }, null, 4) + '\n',
  '.claude/rules/mine.md': '# my rule\n',
  '.codex/config.toml': '# my codex config\nmodel = "gpt-x"\n\n[projects."/a"]\ntrust_level = "trusted"', // 无结尾换行
  '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2) + '\n',
  '.codex/AGENTS.md': '# Codex notes\n\nBe nice.\n',
  '.config/opencode/opencode.json': `{
  // my opencode config
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark", /* inline */
  "mcp": {
    // keep me
    "other": { "type": "remote", "url": "https://x" },
  },
  "instructions": ["~/notes.md"],
}
`,
  '.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { foo: { command: 'foo', args: [] } } }, null, 2) + '\n',
  '.gemini/config/hooks.json': JSON.stringify({ other: { Stop: [{ type: 'command', command: '/x/other', timeout: 5 }] } }, null, 2) + '\n',
  '.grok/config.toml': '[model]\nname = "grok-4"\n\n# end\n',
  '.openclaw/openclaw.json': `{
  // JSON5 config
  gateway: { port: 18789, },
  mcp: {
    servers: {
      keep: { command: 'keep', args: [], },
    },
  },
}
`,
  '.openclaw/workspace/AGENTS.md': 'Existing agents file',
});

const OVERRIDES = (h) => ({
  CLAUDE_CONFIG_DIR: path.join(h, 'alt', 'claude'), CODEX_HOME: path.join(h, 'alt', 'codex'),
  OPENCODE_CONFIG_DIR: path.join(h, 'alt', 'opencode'), GROK_HOME: path.join(h, 'alt', 'grok'),
  OPENCLAW_STATE_DIR: path.join(h, 'alt', 'openclaw'),
});

function scenario(name, { existing, overrides }) {
  test(`setup → 幂等 → uninstall：${name}`, async () => {
    const home = fs.realpathSync(tmp());
    const env = { HOME: home, PATH: '/usr/bin:/bin', ...(overrides ? OVERRIDES(home) : {}) };
    const ctx = makeCtx(env);
    assert.equal(ctx.home, home);
    if (existing) {
      // 带 override 时，把现有内容放到 override 目录
      const map = (rel) => {
        if (!overrides) return rel;
        const a = OVERRIDES(home);
        return rel.replace(/^\.claude\.json$/, path.relative(home, path.join(a.CLAUDE_CONFIG_DIR, '.claude.json')))
          .replace(/^\.claude\//, path.relative(home, a.CLAUDE_CONFIG_DIR) + '/')
          .replace(/^\.codex\//, path.relative(home, a.CODEX_HOME) + '/')
          .replace(/^\.config\/opencode\//, path.relative(home, a.OPENCODE_CONFIG_DIR) + '/')
          .replace(/^\.grok\//, path.relative(home, a.GROK_HOME) + '/')
          .replace(/^\.openclaw\//, path.relative(home, a.OPENCLAW_STATE_DIR) + '/');
      };
      for (const [rel, c] of Object.entries(EXISTING(home))) put(home, map(rel), c);
    }
    const before = snapshot(home);

    const io = silentIo();
    const r1 = await runSetup(FAMILY_IDS, { ctx, io, yes: true });
    assert.deepEqual(r1.changed.sort(), [...FAMILY_IDS].sort());
    const after1 = snapshot(home);
    assert.notDeepEqual(after1, before);
    checkShapes(home, env, overrides, existing);

    // 备份：只对原本存在的文件，内容是用户原样
    for (const [rel, c] of Object.entries(after1)) {
      if (!rel.endsWith('.speaklna-bak')) continue;
      assert.equal(c, before[rel.replace(/\.speaklna-bak$/, '')]);
    }
    assert.equal(Object.keys(after1).filter((k) => k.endsWith('.speaklna-bak')).length, existing ? Object.keys(before).filter((k) => !/rules\/mine\.md$|\.gemini\//.test(k)).length : 0); // .gemini 是 agy 的，1.1 不碰

    // 再来一次：什么都不变
    const r2 = await runSetup(FAMILY_IDS, { ctx, io, yes: true });
    assert.deepEqual(r2.changed, []);
    assert.deepEqual(snapshot(home), after1);

    // 卸载：回到原样
    const u = await runUninstall([], { ctx, io, yes: true });
    assert.deepEqual(u.removed.sort(), [...FAMILY_IDS].sort());
    assert.deepEqual(snapshot(home), before);
    // 再卸一次无事发生
    assert.deepEqual((await runUninstall([], { ctx, io, yes: true })).removed, []);
    assert.deepEqual(snapshot(home), before);
  });
}
scenario('全新（默认目录）', { existing: false, overrides: false });
scenario('全新（环境变量改目录）', { existing: false, overrides: true });
scenario('已有配置（默认目录）', { existing: true, overrides: false });
scenario('已有配置（环境变量改目录）', { existing: true, overrides: true });

function checkShapes(home, env, overrides, existing) {
  const d = (rel) => path.join(home, rel);
  const a = overrides ? OVERRIDES(home) : null;
  const claudeDir = a ? a.CLAUDE_CONFIG_DIR : d('.claude');
  const codexDir = a ? a.CODEX_HOME : d('.codex');
  const ocDir = a ? a.OPENCODE_CONFIG_DIR : d('.config/opencode');
  const grokDir = a ? a.GROK_HOME : d('.grok');
  const clawDir = a ? a.OPENCLAW_STATE_DIR : d('.openclaw');
  const rd = (f) => fs.readFileSync(f, 'utf8');
  const npx = ['-y', 'speaklna', 'mcp'];

  // Claude Code
  const cj = JSON.parse(rd(a ? path.join(claudeDir, '.claude.json') : d('.claude.json')));
  assert.deepEqual(cj.mcpServers.speaklna, { type: 'stdio', command: 'npx', args: npx, env: {} });
  const st = JSON.parse(rd(path.join(claudeDir, 'settings.json')));
  const mine = st.hooks.Stop.find((e) => e.hooks[0].command.includes('hook claude'));
  assert.equal(mine.hooks[0].type, 'command'); assert.equal(mine.hooks[0].async, true);
  assert.ok(!mine.hooks[0].command.includes('npx'));
  assert.ok(path.isAbsolute(mine.hooks[0].command.replace(/^"/, '').split(/"? /)[0]));
  assert.match(rd(path.join(claudeDir, 'rules/speaklna.md')), /🔊/);
  assert.ok(!rd(path.join(claudeDir, 'rules/speaklna.md')).startsWith('---')); // 无 paths 头 = 每次加载

  // Codex
  const toml = rd(path.join(codexDir, 'config.toml'));
  assert.match(toml, /\[mcp_servers\.speaklna\]\ncommand = "npx"\nargs = \["-y", "speaklna", "mcp"\]\nstartup_timeout_sec = 30/);
  const ch = JSON.parse(rd(path.join(codexDir, 'hooks.json')));
  const cs = ch.hooks.Stop.find((e) => e.hooks[0].command.includes('hook codex'));
  assert.equal(cs.hooks[0].async, undefined); assert.equal(cs.hooks[0].timeout, 10);
  assert.match(rd(path.join(codexDir, 'AGENTS.md')), /speaklna:begin[\s\S]*🔊[\s\S]*speaklna:end/);

  // OpenCode（JSONC，带注释也要能读）
  const oc = parseLoose(rd(path.join(ocDir, 'opencode.json')));
  assert.deepEqual(oc.mcp.speaklna, { type: 'local', command: ['npx', ...npx], enabled: true });
  assert.ok(oc.instructions.includes(path.join(ocDir, 'speaklna.md')));
  assert.match(rd(path.join(ocDir, 'plugins/speaklna.js')), /session\.idle/);
  assert.ok(!fs.existsSync(path.join(ocDir, 'AGENTS.md')));
  if (existing && !a) {
    const raw = rd(path.join(ocDir, 'opencode.json'));
    assert.ok(oc.mcp.other && oc.theme === 'dark' && oc.instructions.includes('~/notes.md'));
    assert.ok(raw.includes('// my opencode config') && raw.includes('/* inline */') && raw.includes('// keep me')); // 注释都还在
  }

  // agy 1.1 不接：有它的配置也不碰
  const agyHooks = path.join(home, '.gemini/config/hooks.json');
  assert.ok(!fs.existsSync(agyHooks) || !rd(agyHooks).includes('speaklna'));
  assert.ok(!fs.existsSync(path.join(home, '.gemini/config/rules/speaklna.md')));

  // Grok
  assert.match(rd(path.join(grokDir, 'config.toml')), /\[mcp_servers\.speaklna\]/);
  const gh = JSON.parse(rd(path.join(grokDir, 'hooks/speaklna.json')));
  assert.ok(gh.hooks.Stop[0].hooks[0].command.includes('hook grok'));
  assert.ok(!fs.existsSync(path.join(grokDir, 'rules/speaklna.md')), 'Claude 那份已有，grok 不重复写');

  // OpenClaw（JSON5）
  const cl = parseLoose(rd(path.join(clawDir, 'openclaw.json')));
  assert.deepEqual(cl.mcp.servers.speaklna, { command: 'npx', args: npx });
  assert.match(rd(path.join(clawDir, 'workspace/AGENTS.md')), /🔊/);
  assert.deepEqual(cl.plugins.entries.speaklna, { enabled: true, hooks: { allowConversationAccess: true } });
  assert.equal(JSON.parse(rd(path.join(clawDir, 'extensions/speaklna/openclaw.plugin.json'))).id, 'speaklna');
  assert.deepEqual(JSON.parse(rd(path.join(clawDir, 'extensions/speaklna/package.json'))).openclaw.extensions, ['./index.js']);
  const plug = rd(path.join(clawDir, 'extensions/speaklna/index.js'));
  assert.match(plug, /hook openclaw/); assert.match(plug, /agent_end/);
}

test('OpenClaw 改配置删光注释（标记没了）：仍算装好，卸载按内容删掉我们那两条', async () => {
  const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
  put(home, '.openclaw/openclaw.json', '{\n  // mine\n  "gateway": { "port": 18789 }\n}\n');
  await runSetup(['openclaw'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  const f = path.join(home, '.openclaw/openclaw.json');
  // 模拟 `openclaw hooks enable` / `config set`：解析后按严格 JSON 重写
  fs.writeFileSync(f, JSON.stringify(parseLoose(fs.readFileSync(f, 'utf8')), null, 2) + '\n');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('speaklna:begin'));
  const again = silentIo();
  await runSetup(['openclaw'], { ctx: makeCtx(env), io: again, yes: true });
  assert.ok(!/external|already configured/i.test(again.lines.join('\n')), again.lines.join('\n'));
  await runUninstall(['openclaw'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  const left = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(left.mcp?.servers?.speaklna, undefined);
  assert.equal(left.plugins?.entries?.speaklna, undefined);
  assert.equal(left.gateway.port, 18789);
  assert.ok(!fs.existsSync(path.join(home, '.openclaw/extensions')));
});

test('Codex：AGENTS.override.md 存在时写它，卸载还原', async () => {
  const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
  put(home, '.codex/AGENTS.override.md', 'override rules\n');
  put(home, '.codex/AGENTS.md', 'plain\n');
  const before = snapshot(home);
  await runSetup(['codex'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  const s = snapshot(home);
  assert.match(s['.codex/AGENTS.override.md'], /speaklna:begin/);
  assert.equal(s['.codex/AGENTS.md'], 'plain\n');
  await runUninstall(['codex'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  assert.deepEqual(snapshot(home), before);
});

test('Grok：没装 Claude 规矩时 grok 自己写一份；卸载干净', async () => {
  const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
  await runSetup(['grok'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  assert.ok(fs.existsSync(path.join(home, '.grok/rules/speaklna.md')));
  await runUninstall(['grok'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  assert.deepEqual(snapshot(home), {});
});

test('JSONC 刁钻形状：单行 {}、{"a":1}、开头注释、空文件，都能装能卸', async () => {
  for (const original of ['{}', '{"a":1}', '// top\n{\n}\n', '{"mcp":{}}', '{"mcp":{"speaklna":{"user":"own"}}}', '']) {
    const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
    put(home, '.config/opencode/opencode.json', original);
    await runSetup(['opencode'], { ctx: makeCtx(env), io: silentIo(), yes: true });
    const mid = fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8');
    if (original.includes('"user":"own"')) assert.ok(!mid.includes('speaklna:begin mcp'), '用户自己配的不覆盖');
    else assert.deepEqual(parseLoose(mid || '{}').mcp.speaklna.command, ['npx', '-y', 'speaklna', 'mcp']);
    await runUninstall(['opencode'], { ctx: makeCtx(env), io: silentIo(), yes: true });
    assert.equal(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'), original, JSON.stringify(original));
    assert.equal(fs.existsSync(path.join(home, '.config/opencode/speaklna.md')), false);
  }
});

test('不同意就不写；--dry-run 不写；坏 JSON 不碰', async () => {
  const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
  put(home, '.claude/settings.json', '{ broken');
  const before = snapshot(home);
  const no = { lines: [], out() {}, ask: async () => 'n' };
  await runSetup(['claude'], { ctx: makeCtx(env), io: no });
  assert.deepEqual(snapshot(home), before);
  await runSetup(['claude'], { ctx: makeCtx(env), io: silentIo(), dryRun: true });
  assert.deepEqual(snapshot(home), before);
  await runSetup(['claude'], { ctx: makeCtx(env), io: silentIo(), yes: true });
  assert.equal(snapshot(home)['.claude/settings.json'], '{ broken'); // 坏的那份原样
});

test('无参数：只勾选探测到的接入方；未知名字报错', async () => {
  const home = fs.realpathSync(tmp()); const env = { HOME: home, PATH: '/usr/bin' };
  put(home, '.grok/x', '');
  const io = silentIo();
  const r = await runSetup([], { ctx: makeCtx(env), io, yes: true });
  assert.deepEqual(r.changed, ['grok']);
  await assert.rejects(runSetup(['nope'], { ctx: makeCtx(env), io, yes: true }), /Unknown family/);
});

test('真进程 CLI：HOME 指向临时目录，setup --yes 再 uninstall --yes', () => {
  const home = fs.realpathSync(tmp());
  const bin = new URL('../bin/speaklna.js', import.meta.url).pathname;
  const env = { PATH: process.env.PATH, HOME: home };
  put(home, '.claude/settings.json', '{\n  "theme": "dark"\n}\n');
  const before = snapshot(home);
  const s = spawnSync(process.execPath, [bin, 'setup', 'claude', 'codex', '--yes'], { env, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /\/hooks/);
  assert.ok(snapshot(home)['.claude/rules/speaklna.md']);
  const u = spawnSync(process.execPath, [bin, 'uninstall', '--yes'], { env, encoding: 'utf8' });
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(snapshot(home), before);
});
