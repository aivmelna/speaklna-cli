// 手写的 stdio MCP（换行分隔的 JSON-RPC）。只有 4 个工具，不值得为它带 SDK：npx 冷启动要快。
import readline from 'node:readline';
import { callApp } from './client.js';
import { describe } from './format.js';
import { CLIENT_NAME } from './extract.js';

const VERSION = '1.1.0';

export const TOOLS = [
  {
    name: 'speak',
    description: 'Read text aloud through the Speaklna Mac app. Use this ONLY when the user asks to have something read aloud ("read this to me", "念给我听"). Do NOT call it for your end-of-reply summary: that spoken report is handled automatically by a hook from the line starting with 🔊. Never pass passwords, keys or tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to read aloud (up to 20000 characters).' },
        voice: { type: 'string', description: 'Optional voice id or name from the `voices` tool. Omit to use the user\'s configured voice.' },
      },
      required: ['text'],
    },
  },
  { name: 'stop', description: 'Stop the reading that an AI started. Does not touch what the user started themselves.', inputSchema: { type: 'object', properties: {} } },
  { name: 'status', description: 'Show whether Speaklna is ready, speaking, or muted (for example because the user is in a call).', inputSchema: { type: 'object', properties: {} } },
  { name: 'voices', description: 'List available voices. Voices can only be imported or changed by the user inside the Speaklna app; if asked to change settings or add a voice, tell the user to do it in Speaklna\'s "AI" settings page.', inputSchema: { type: 'object', properties: {} } },
];

// MCP 的 clientInfo.name → 协议里的 client 枚举
export function clientFromName(name = '') {
  const n = String(name).toLowerCase();
  if (n.includes('claude')) return CLIENT_NAME.claude;
  if (n.includes('codex')) return 'codex';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('antigravity') || n.includes('gemini') || n.includes('agy')) return 'antigravity';
  if (n.includes('grok')) return 'grok';
  if (n.includes('openclaw')) return 'openclaw';
  return 'other';
}

export function createMcpHandler(tx) {
  let client = 'other';
  const result = (id, r) => ({ jsonrpc: '2.0', id, result: r });
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object') return error(null, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    if (id === undefined) return null; // 通知（initialized 等）不回
    switch (method) {
      case 'initialize':
        client = clientFromName(params?.clientInfo?.name);
        return result(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'speaklna', version: VERSION },
        });
      case 'ping': return result(id, {});
      case 'tools/list': return result(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const a = params?.arguments ?? {};
        if (!TOOLS.some((t) => t.name === name)) return error(id, -32602, `Unknown tool: ${name}`);
        let fields = {};
        if (name === 'speak') {
          if (typeof a.text !== 'string' || !a.text.trim()) return result(id, { content: [{ type: 'text', text: 'Nothing to read (empty text).' }], isError: true });
          fields = { text: a.text, kind: 'active', client };
          if (typeof a.voice === 'string' && a.voice) fields.voice = a.voice;
        } else if (name === 'stop') fields = { client };
        const res = await callApp(tx, name, fields);
        const text = describe(name, res);
        return result(id, { content: [{ type: 'text', text }], isError: res.status === 'error' });
      }
      default: return error(id, -32601, `Method not found: ${method}`);
    }
  };
}

export function serve(tx, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler(tx);
  const rl = readline.createInterface({ input });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const p = (async () => {
      let msg;
      try { msg = JSON.parse(line); }
      catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
      const out = await handle(msg).catch((e) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }));
      if (out) output.write(JSON.stringify(out) + '\n');
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  return new Promise((resolve) => rl.on('close', () => Promise.all(pending).then(resolve)));
}
