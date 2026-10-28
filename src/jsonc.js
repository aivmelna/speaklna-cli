// JSONC / JSON5 的“外科手术”：不解析重写，只在对象/数组开头插入一段带标记的注释块。
// 为什么：opencode.json 是 JSONC、openclaw.json 是 JSON5，用户会写注释；
// parse 再 stringify 会把注释全丢掉。插入段两头夹 `// speaklna:begin <id>` / `end <id>`，
// 卸载时按标记整段切掉，字节级还原。
// 插在开头而不是结尾：这样逗号永远写在块里面，卸载不用回头去改上一个成员。

const BEGIN = (id) => `// speaklna:begin ${id}`;
const END = (id) => `// speaklna:end ${id}`;

export const hasMarker = (text, id) => text.includes(BEGIN(id) + '\n');

function skipWs(t, i) {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith('//', i)) { while (i < t.length && t[i] !== '\n') i++; }
    else if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; }
    else return i;
  }
}

function skipString(t, i) {
  const q = t[i++];
  while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++; }
  return i + 1;
}

function skipValue(t, i) {
  const c = t[i];
  if (c === '"' || c === "'") return skipString(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"' || ch === "'") { i = skipString(t, i); continue; }
      if (t.startsWith('//', i) || t.startsWith('/*', i)) { i = skipWs(t, i); continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new Error('unterminated JSON value');
  }
  while (i < t.length && !/[\s,}\]]/.test(t[i]) && !t.startsWith('//', i) && !t.startsWith('/*', i)) i++;
  return i;
}

/** 对象成员：[{key, vs, ve}]，外加第一个成员起点 */
function members(t, open) {
  const out = [];
  let i = skipWs(t, open + 1);
  while (t[i] !== '}') {
    if (i >= t.length) throw new Error('unterminated object');
    let key; const ks = i;
    if (t[i] === '"' || t[i] === "'") { const e = skipString(t, i); key = t.slice(i + 1, e - 1); i = e; }
    else { const m = /^[\w$-]+/.exec(t.slice(i)); if (!m) throw new Error('bad key'); key = m[0]; i += key.length; }
    i = skipWs(t, i);
    if (t[i] !== ':') throw new Error('expected colon');
    i = skipWs(t, i + 1);
    const vs = i; const ve = skipValue(t, i);
    out.push({ key, vs, ve, ks });
    i = skipWs(t, ve);
    if (t[i] === ',') i = skipWs(t, i + 1);
  }
  return { list: out, first: skipWs(t, open + 1) };
}

function elements(t, open) {
  let i = skipWs(t, open + 1);
  const first = i;
  let n = 0;
  while (t[i] !== ']') {
    if (i >= t.length) throw new Error('unterminated array');
    i = skipWs(t, skipValue(t, i)); n++;
    if (t[i] === ',') i = skipWs(t, i + 1);
  }
  return { count: n, first };
}

function lineIndent(t, idx) {
  const ls = t.lastIndexOf('\n', idx - 1) + 1;
  const m = /^[ \t]*/.exec(t.slice(ls));
  return m[0];
}

function inject(t, open, lines, nonEmpty, firstChild, id) {
  let indent;
  if (nonEmpty) {
    const ls = t.lastIndexOf('\n', firstChild - 1) + 1;
    const pre = t.slice(ls, firstChild);
    indent = /^[ \t]*$/.test(pre) ? pre : lineIndent(t, open) + '  ';
  } else indent = lineIndent(t, open) + '  ';
  // 行注释会吞掉同一行后面的内容（`["a"]`、`{}`、`{"a":1}` 这种单行写法）：
  // 后面不是换行就补一个，并在结束标记后加 " nl" 让卸载知道要连这个换行一起切
  const sameLine = !/^\r?\n/.test(t.slice(open + 1));
  const block = `\n${indent}${BEGIN(id)}\n` + lines.map((l) => indent + l).join('\n') + (nonEmpty ? ',' : '') + `\n${indent}${END(id)}` + (sameLine ? ' nl\n' : '');
  return t.slice(0, open + 1) + block + t.slice(open + 1);
}

const render = (key, val) => (key === null ? JSON.stringify(val, null, 2) : `${JSON.stringify(key)}: ${JSON.stringify(val, null, 2)}`).split('\n');

/**
 * 在 path 指向的对象里插入 value（最后一段是成员名）。
 * asElement=true：最后一段是数组，value 作为元素插进去（数组不存在就整个建出来）。
 * 路径中间缺哪层就从哪层起整段建出来。
 */
export function insertAtPath(text, path, value, id, { asElement = false } = {}) {
  let open = skipWs(text, 0);
  if (text[open] !== '{') throw new Error('top level is not an object');
  for (let k = 0; k < path.length; k++) {
    const { list, first } = members(text, open);
    const m = list.find((x) => x.key === path[k]);
    const last = k === path.length - 1;
    if (!m) {
      let v = value;
      if (asElement) v = [value];
      for (let j = path.length - 1; j > k; j--) v = { [path[j]]: v };
      return inject(text, open, render(path[k], v), list.length > 0, first, id);
    }
    if (last && asElement) {
      if (text[m.vs] !== '[') throw new Error(`${path.join('.')} is not an array`);
      const { count, first: f } = elements(text, m.vs);
      return inject(text, m.vs, render(null, value), count > 0, f, id);
    }
    if (text[m.vs] !== '{') throw new Error(`${path.slice(0, k + 1).join('.')} is not an object`);
    if (last) throw new Error(`${path.join('.')} already exists`);
    open = m.vs;
  }
  throw new Error('empty path');
}

/** 切掉标记块；没有则返回 null */
export function removeBlock(text, id) {
  const b = text.indexOf(BEGIN(id) + '\n');
  if (b < 0) return null;
  const em = END(id);
  const e = text.indexOf(em, b);
  if (e < 0) return null;
  let s = b;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (text[s - 1] === '\n') s--;
  let tail = e + em.length;
  if (text.startsWith(' nl\n', tail)) tail += 4;
  return text.slice(0, s) + text.slice(tail);
}

/** 读某条路径上的对象成员原文是否存在（冲突检测：用户自己已经配过） */
export function hasPath(text, path) {
  try {
    let open = skipWs(text, 0);
    if (text[open] !== '{') return false;
    for (let k = 0; k < path.length; k++) {
      const m = members(text, open).list.find((x) => x.key === path[k]);
      if (!m) return false;
      if (k === path.length - 1) return true;
      if (text[m.vs] !== '{') return false;
      open = m.vs;
    }
  } catch { return false; }
  return false;
}

// 宿主自己改配置时会把注释（我们的标记）删掉：OpenClaw `hooks enable` / `config set` 实测如此（10-28）。
// 标记没了就按路径找回那个成员，调用方确认内容是我们写的再整条删。
function find(text, path) {
  let open = skipWs(text, 0);
  if (text[open] !== '{') return null;
  for (let k = 0; k < path.length; k++) {
    const { list } = members(text, open);
    const i = list.findIndex((x) => x.key === path[k]);
    if (i < 0) return null;
    if (k === path.length - 1) return { list, i };
    if (text[list[i].vs] !== '{') return null;
    open = list[i].vs;
  }
  return null;
}

/** path 上成员值的原文；没有就 null */
export function valueText(text, path) {
  try { const f = find(text, path); return f ? text.slice(f.list[f.i].vs, f.list[f.i].ve) : null; } catch { return null; }
}

/** 删掉 path 上的成员（连同它的逗号；独占一行就整行删）；没有就 null */
export function removeMember(text, path) {
  let f; try { f = find(text, path); } catch { return null; }
  if (!f) return null;
  const { list, i } = f; const m = list[i];
  let s = m.ks; let e = m.ve;
  let j = e; while (j < text.length && /[ \t]/.test(text[j])) j++;
  if (text[j] === ',') e = j + 1;                       // 后面跟着逗号：连逗号删
  else if (i > 0) {                                      // 最后一个且没逗号：删前一个成员后面的逗号
    const c = text.lastIndexOf(',', m.ks);
    if (c >= list[i - 1].ve) s = c;
  }
  const ls = text.lastIndexOf('\n', s - 1) + 1;
  const le = text.indexOf('\n', e);
  if (/^[ \t]*$/.test(text.slice(ls, s)) && /^[ \t]*$/.test(text.slice(e, le < 0 ? text.length : le)) && le >= 0) { s = ls; e = le + 1; }
  return text.slice(0, s) + text.slice(e);
}

