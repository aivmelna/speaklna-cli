// 从整段回复里取“报告句”：最后一行以 🔊 开头（拷问 03 第 6 题）
import { redact } from './redact.js';

const MAX = 500; // App 也会截 500，这里先截省得白传

export function lastReportLine(message) {
  if (typeof message !== 'string' || !message) return null;
  const lines = message.split(/\r?\n/);
  let fence = false;
  const hits = [];
  let last = '';
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue; // 代码块里的 🔊 是示例，不是报告
    if (raw.trim()) last = raw;
    // 允许行首有引用符 / 列表符 / 加粗
    const m = raw.match(/^[\s>*_\-•]*🔊️?\s*(.*)$/u);
    if (m) hits.push(m[1]);
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    const t = clean(hits[i]);
    if (t) return t;
  }
  // 小模型常把 🔊 挤在最后一行中间（“Done. 🔊 测试过了”，10-28 本地 gpt-oss 真跑）：只认最后一行，取最后一个 🔊 之后
  const k = last.lastIndexOf('🔊');
  if (k >= 0) return clean(last.slice(k + '🔊'.length).replace(/^️/, '')) || null;
  return null;
}

function clean(s) {
  let t = s.replace(/\*\*|__|`/g, '').replace(/^[:：\s]+/, '').trim();
  t = redact(t).trim();
  if (t.length > MAX) t = t.slice(0, MAX);
  return t;
}
