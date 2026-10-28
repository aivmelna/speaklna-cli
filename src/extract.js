// 各家钩子 stdin → { text, sessionId, cwd }（text 是整段回复，没有就 null；skip=true 表示这轮不念）
// 字段名全部来自 thinking/04，五家 10-28 都真跑核过。agy 1.1 先不接（没法真机验证）。
import fs from 'node:fs';

export const CLIENT_NAME = {
  claude: 'claude-code', codex: 'codex', opencode: 'opencode',
  grok: 'grok', openclaw: 'openclaw',
};

const str = (v) => (typeof v === 'string' && v ? v : undefined);

function readTail(file, max = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function jsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 尾部截断的半行，丢 */ }
  }
  return out;
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Claude Code 旧版（<2.1.47）没有 last_assistant_message：读 transcript，
// 取最后一条“真”用户消息（tool_result 也是 type:user，要跳过）之后的主线 assistant 文字
export function claudeTranscriptText(file) {
  const rows = jsonl(readTail(file));
  let start = -1;
  rows.forEach((r, i) => {
    if (r.type !== 'user' || r.isSidechain) return;
    const c = r.message?.content;
    const isToolResult = Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
    if (!isToolResult) start = i;
  });
  return rows.slice(start + 1)
    .filter((r) => r.type === 'assistant' && !r.isSidechain)
    .map((r) => blocksText(r.message?.content)).filter(Boolean).join('\n');
}

// OpenClaw：插件 agent_end 交来的 messages 最后一条 assistant（10-28 真跑核过）；context.content 是内部钩子 message:sent 的形状，留作兜底
function openclawText(p) {
  const msgs = p.messages ?? p.event?.messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'assistant') return blocksText(msgs[i].content) || undefined;
    }
  }
  return str(p.context?.content) ?? str(p.event?.context?.content) ?? str(p.content) ?? str(p.text);
}

export function extract(family, p, { env = process.env, readers = {} } = {}) {
  const claudeT = readers.claudeTranscript ?? claudeTranscriptText;
  switch (family) {
    case 'claude': {
      if (env.GROK_HOOK_EVENT) return { skip: true }; // grok 也会加载 Claude 的钩子，让 grok 那条念
      let text = str(p.last_assistant_message);
      if (!text && str(p.transcript_path)) { try { text = claudeT(p.transcript_path); } catch { /* 读不到就不念 */ } }
      return { text, sessionId: str(p.session_id), cwd: str(p.cwd) };
    }
    case 'codex':
      return { text: str(p.last_assistant_message), sessionId: str(p.session_id), cwd: str(p.cwd) };
    case 'grok':
      if (p.reason !== 'end_turn') return { skip: true };
      return { text: str(p.lastAssistantMessage), sessionId: str(p.sessionId), cwd: str(p.cwd) };
    case 'opencode': // 插件把整段文字塞进 text 交给我们统一抽
      return { text: str(p.text) ?? str(p.last_assistant_message), sessionId: str(p.sessionId) ?? str(p.session_id), cwd: str(p.cwd) };
    case 'openclaw':
      return { text: openclawText(p), sessionId: str(p.sessionId) ?? str(p.session_id) ?? str(p.context?.sessionKey), cwd: str(p.cwd) };
    default:
      return { skip: true };
  }
}
