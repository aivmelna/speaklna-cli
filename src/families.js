// 5 家接入方：认不认得出、要改哪些文件。路径与格式全部来自 thinking/04。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsonAction, jsoncAction, blockAction, ownedFile } from './actions.js';
import { rulesFile, MANAGED, BLOCK_BEGIN, BLOCK_END, TOML_BEGIN, TOML_END, RULES_BODY } from './rules.js';
import { exists, read } from './fsutil.js';

export const FAMILY_IDS = ['claude', 'codex', 'opencode', 'grok', 'openclaw'];
export const ALIASES = { 'claude-code': 'claude' };
export const LABEL = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  grok: 'Grok Build', openclaw: 'OpenClaw',
};

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/speaklna.js');
const NPX = { command: 'npx', args: ['-y', 'speaklna', 'mcp'] };

function whichBin(name, env) {
  for (const d of (env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const q = (s) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);

/** 钩子命令：绝对路径，永远不用 npx（每轮多一次注册表检查）。PATH 上有 speaklna 就用它，否则 node + 本脚本 */
export function hookCommand(ctx, sub) {
  const onPath = ctx.env.SPEAKLNA_BIN || whichBin('speaklna', ctx.env);
  return onPath ? `${q(onPath)} hook ${sub}` : `${q(process.execPath)} ${q(SCRIPT)} hook ${sub}`;
}
export const inNpxCache = () => SCRIPT.includes(`${path.sep}_npx${path.sep}`);

const oursCmd = (fam) => (c) => typeof c === 'string' && /speaklna/.test(c) && new RegExp(`\\bhook ${fam}\\b`).test(c);
const entryHasOurs = (fam) => (e) => Array.isArray(e?.hooks) && e.hooks.some((h) => oursCmd(fam)(h?.command));
const mcpIsOurs = (e) => !!e && Array.isArray(e.args) && e.args.includes('speaklna');

/** Claude 风格的 hooks.Stop（claude / codex / grok 同一结构） */
function stopHookJson(fam, c) {
  return {
    present: (o) => Array.isArray(o.hooks?.Stop) && o.hooks.Stop.some(entryHasOurs(fam)),
    add: (o) => {
      o.hooks = o.hooks && typeof o.hooks === 'object' ? o.hooks : {};
      o.hooks.Stop = Array.isArray(o.hooks.Stop) ? o.hooks.Stop : [];
      o.hooks.Stop.push(c);
    },
    del: (o) => {
      o.hooks.Stop = o.hooks.Stop.filter((e) => !entryHasOurs(fam)(e));
      if (!o.hooks.Stop.length) delete o.hooks.Stop;
      if (!Object.keys(o.hooks).length) delete o.hooks;
    },
  };
}

const tomlMcp = (table, extra = '') =>
  `[${table}]\ncommand = "npx"\nargs = ["-y", "speaklna", "mcp"]\n${extra}`.trimEnd();

export function getFamily(id, ctx) {
  const { env, home } = ctx;
  const j = (o) => JSON.stringify(o, null, 2);
  const common = { home };

  if (id === 'claude') {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    // CLAUDE_CONFIG_DIR 设了，.claude.json 也跟着搬进去
    const cj = env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
    const entry = { type: 'stdio', ...NPX, env: {} };
    const hookEntry = { hooks: [{ type: 'command', command: hookCommand(ctx, 'claude'), async: true }] };
    const sh = stopHookJson('claude', hookEntry);
    return {
      id, label: LABEL[id],
      detected: () => !!whichBin('claude', env) || exists(dir),
      actions: () => [
        jsonAction({ ...common, file: cj, desc: 'MCP server "speaklna" (mcpServers.speaklna)', preview: j({ mcpServers: { speaklna: entry } }),
          present: (o) => mcpIsOurs(o.mcpServers?.speaklna), conflict: (o) => !!o.mcpServers?.speaklna,
          add: (o) => { o.mcpServers = o.mcpServers && typeof o.mcpServers === 'object' ? o.mcpServers : {}; o.mcpServers.speaklna = entry; },
          del: (o) => { delete o.mcpServers.speaklna; if (!Object.keys(o.mcpServers).length) delete o.mcpServers; } }),
        jsonAction({ ...common, file: path.join(dir, 'settings.json'), desc: 'Stop hook (hooks.Stop)', preview: j({ hooks: { Stop: [hookEntry] } }), ...sh }),
        ownedFile({ ...common, file: path.join(dir, 'rules', 'speaklna.md'), desc: 'new rules file (end every reply with a 🔊 line)', preview: RULES_BODY, content: rulesFile(), marker: MANAGED }),
      ],
      notes: [],
    };
  }

  if (id === 'codex') {
    const dir = env.CODEX_HOME || path.join(home, '.codex');
    // 不写 async：异步钩子是挂在 Codex 进程里的后台任务，`codex exec` 一轮完就退、钩子根本没起（10-28 真跑）。
    // 我们的钩子自己脱离、约 0.12 s 就退，同步等它也不耽误。
    const hookEntry = { hooks: [{ type: 'command', command: hookCommand(ctx, 'codex'), timeout: 10 }] };
    const override = path.join(dir, 'AGENTS.override.md');
    const agents = exists(override) ? override : path.join(dir, 'AGENTS.md'); // override 存在时它优先
    return {
      id, label: LABEL[id],
      detected: () => !!whichBin('codex', env) || exists(dir),
      actions: () => [
        blockAction({ ...common, file: path.join(dir, 'config.toml'), desc: 'MCP server [mcp_servers.speaklna]', begin: TOML_BEGIN, end: TOML_END,
          body: tomlMcp('mcp_servers.speaklna', 'startup_timeout_sec = 30'), preview: tomlMcp('mcp_servers.speaklna', 'startup_timeout_sec = 30'),
          externalRe: /^\s*\[mcp_servers\.speaklna\]/m }),
        jsonAction({ ...common, file: path.join(dir, 'hooks.json'), desc: 'Stop hook (hooks.Stop)', preview: j({ hooks: { Stop: [hookEntry] } }), ...stopHookJson('codex', hookEntry) }),
        blockAction({ ...common, file: agents, desc: 'rules block (end every reply with a 🔊 line)', begin: BLOCK_BEGIN, end: BLOCK_END, body: RULES_BODY, preview: RULES_BODY }),
      ],
      notes: ['Codex: open /hooks once inside Codex and trust the speaklna hook, otherwise it will not run.'],
      // 卸载时两份 AGENTS 都要查
      extraUndo: () => [path.join(dir, 'AGENTS.md'), override].filter((f) => f !== agents).map((f) =>
        blockAction({ ...common, file: f, desc: 'rules block', begin: BLOCK_BEGIN, end: BLOCK_END, body: RULES_BODY })),
    };
  }

  if (id === 'opencode') {
    const dir = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
    const cfg = exists(path.join(dir, 'opencode.jsonc')) ? path.join(dir, 'opencode.jsonc') : path.join(dir, 'opencode.json');
    const rules = path.join(dir, 'speaklna.md');
    const mcp = { type: 'local', command: ['npx', '-y', 'speaklna', 'mcp'], enabled: true };
    const plugin = opencodePlugin(hookCommand(ctx, 'opencode'));
    return {
      id, label: LABEL[id],
      detected: () => !!whichBin('opencode', env) || exists(dir),
      actions: () => [
        jsoncAction({ ...common, file: cfg, desc: 'MCP server (mcp.speaklna), marked block', preview: j({ mcp: { speaklna: mcp } }), path: ['mcp', 'speaklna'], value: mcp, id: 'mcp', externalPath: ['mcp', 'speaklna'] }),
        // 不建 AGENTS.md（会顶掉它读的 ~/.claude/CLAUDE.md），走 instructions
        jsoncAction({ ...common, file: cfg, desc: 'instructions entry, marked block', preview: j({ instructions: [rules] }), path: ['instructions'], value: rules, id: 'instr', asElement: true }),
        ownedFile({ ...common, file: rules, desc: 'new rules file', preview: RULES_BODY, content: rulesFile(), marker: MANAGED }),
        ownedFile({ ...common, file: path.join(dir, 'plugins', 'speaklna.js'), desc: 'new plugin (session.idle → speaklna hook)', preview: '(plugin reading the last assistant message on session.idle)', content: plugin, marker: MANAGED }),
      ],
      notes: [],
    };
  }

  if (id === 'grok') {
    const dir = env.GROK_HOME || path.join(home, '.grok');
    const claudeRules = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'rules', 'speaklna.md');
    const hookFile = { hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(ctx, 'grok'), timeout: 10 }] }] } };
    return {
      id, label: LABEL[id],
      detected: () => !!whichBin('grok', env) || exists(dir),
      actions: () => [
        blockAction({ ...common, file: path.join(dir, 'config.toml'), desc: 'MCP server [mcp_servers.speaklna]', begin: TOML_BEGIN, end: TOML_END, body: tomlMcp('mcp_servers.speaklna'), preview: tomlMcp('mcp_servers.speaklna'), externalRe: /^\s*\[mcp_servers\.speaklna\]/m }),
        ownedFile({ ...common, file: path.join(dir, 'hooks', 'speaklna.json'), desc: 'new hook file (Stop)', preview: j(hookFile), content: JSON.stringify(hookFile, null, 2) + '\n', marker: 'hook grok' }),
        // grok 默认也读 ~/.claude/rules/，装过 Claude 那份就不再重复写
        ownedFile({ ...common, file: path.join(dir, 'rules', 'speaklna.md'), desc: 'new rules file', preview: RULES_BODY, content: rulesFile(), marker: MANAGED,
          skipIf: () => (read(claudeRules) ?? '').includes(MANAGED) }),
      ],
      notes: [],
    };
  }

  if (id === 'openclaw') {
    const dir = env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw');
    const cfg = path.join(dir, 'openclaw.json');
    const mcp = { command: 'npx', args: ['-y', 'speaklna', 'mcp'] };
    // 插件 agent_end（每轮都发，本地终端和聊天渠道都算）。内部钩子 message:sent 只在往渠道投递时才发，本地用不念（10-28 真跑）。
    // 放 extensions/ 下自动发现；agent_end 读对话要 allowConversationAccess。
    const entry = { enabled: true, hooks: { allowConversationAccess: true } };
    const pd = path.join(dir, 'extensions', 'speaklna');
    return {
      id, label: LABEL[id],
      detected: () => !!whichBin('openclaw', env) || exists(dir),
      actions: () => [
        jsoncAction({ ...common, file: cfg, desc: 'MCP server (mcp.servers.speaklna), marked block', preview: j({ mcp: { servers: { speaklna: mcp } } }), path: ['mcp', 'servers', 'speaklna'], value: mcp, id: 'mcp', externalPath: ['mcp', 'servers', 'speaklna'],
          owns: (v) => /"speaklna"/.test(v) && /"mcp"/.test(v) }),
        jsoncAction({ ...common, file: cfg, desc: 'plugin entry (plugins.entries.speaklna), marked block', preview: j({ plugins: { entries: { speaklna: entry } } }), path: ['plugins', 'entries', 'speaklna'], value: entry, id: 'plugin', externalPath: ['plugins', 'entries', 'speaklna'],
          owns: (v) => /allowConversationAccess/.test(v) }),
        blockAction({ ...common, file: path.join(dir, 'workspace', 'AGENTS.md'), desc: 'rules block', begin: BLOCK_BEGIN, end: BLOCK_END, body: RULES_BODY, preview: RULES_BODY }),
        ownedFile({ ...common, file: path.join(pd, 'openclaw.plugin.json'), desc: 'new plugin manifest', preview: '(openclaw.plugin.json)', content: OPENCLAW_MANIFEST, marker: '"id": "speaklna"' }),
        ownedFile({ ...common, file: path.join(pd, 'package.json'), desc: 'new plugin package.json', preview: '(package.json)', content: OPENCLAW_PACKAGE, marker: '"name": "speaklna-openclaw"' }),
        ownedFile({ ...common, file: path.join(pd, 'index.js'), desc: 'new plugin (agent_end → speaklna hook)', preview: '(index.js → speaklna hook openclaw)', content: openclawPlugin(hookCommand(ctx, 'openclaw')), marker: MANAGED }),
      ],
      notes: ['OpenClaw: restart the Gateway if it is running. OpenClaw warns that it "can\'t verify where this plugin came from"; that is expected for a local plugin.',
        'Only useful when OpenClaw runs on this same Mac.'],
    };
  }
  throw new Error(`unknown family: ${id}`);
}

// ---- 生成的脚本 ----
// 插件只许导出函数（thinking/04），所以只有一个 export；全包 try/catch，出错绝不影响 OpenCode。
function opencodePlugin(cmd) {
  return `// ${MANAGED}: generated by \`speaklna setup\`, removed by \`speaklna uninstall\`
import { spawn } from "node:child_process";

export const SpeaklnaPlugin = async ({ client, directory }) => ({
  event: async ({ event }) => {
    try {
      if (event.type !== "session.idle") return;
      const id = event.properties?.sessionID;
      if (!id) return;
      const s = await client.session.get({ path: { id } });
      if (s?.data?.parentID) return; // 子会话不念
      const r = await client.session.messages({ path: { id } });
      const msgs = r?.data ?? [];
      let last;
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.info?.role === "assistant") { last = msgs[i]; break; }
      if (!last) return;
      const text = (last.parts ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text).join("\\n");
      if (!text) return;
      const child = spawn(${JSON.stringify(cmd)}, { shell: true, detached: true, stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ text, sessionId: id, cwd: directory }));
      child.unref();
    } catch {}
  },
});
`;
}

const OPENCLAW_MANIFEST = `${JSON.stringify({
  id: 'speaklna', name: 'Speaklna', description: "Read the agent's 🔊 report line aloud through the Speaklna Mac app",
  activation: { onStartup: true }, configSchema: { type: 'object', additionalProperties: false },
}, null, 2)}\n`;
const OPENCLAW_PACKAGE = `${JSON.stringify({ name: 'speaklna-openclaw', private: true, type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2)}\n`;

// agent_end 的 event.messages / ctx.trigger / ctx.sessionKey 字段 10-28 真跑核过。只念用户发起的轮（不念 cron / heartbeat）。
function openclawPlugin(cmd) {
  return `// ${MANAGED}: generated by \`speaklna setup\`, removed by \`speaklna uninstall\`
import { spawn } from "node:child_process";

export default {
  id: "speaklna",
  name: "Speaklna",
  description: "Read the agent's 🔊 report line aloud through the Speaklna Mac app",
  register(api) {
    api.on("agent_end", (event, ctx) => {
      try {
        if (!event?.success || (ctx?.trigger && ctx.trigger !== "user")) return;
        const msgs = Array.isArray(event.messages) ? event.messages : [];
        let last;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "assistant") { last = msgs[i]; break; }
        if (!last) return;
        const child = spawn(${JSON.stringify(cmd)}, { shell: true, detached: true, stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => {});
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ messages: [last], sessionId: ctx?.sessionKey }));
        child.unref();
      } catch {}
    });
  },
};
`;
}
