// 四种“改一个文件”的动作，setup / uninstall 都由它们组成。统一接口：
//   { file, desc, preview, status() → todo|done|external|conflict|error|skip, apply(), undo() → 是否改动了 }
// 选格式的理由（为什么有的 parse 重写、有的外科手术）：
//   纯 JSON（settings.json / hooks.json / mcp_config.json / .claude.json）没有注释可丢 → parse + 缩进探测 + 重写，
//     卸载时若结果与备份语义相同就直接放回备份字节；
//   JSONC / JSON5（opencode.json / openclaw.json）→ jsonc.js 标记块；  TOML / Markdown → textblock.js 标记块；
//   我们独占的文件（规矩、插件）→ 整文件写、卸载整文件删。
import { read, write, rm, pruneDirs, BAK } from './fsutil.js';
import * as jc from './jsonc.js';
import * as tb from './textblock.js';

const isEmptyDoc = (t) => t.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|^\s*#.*$/gm, '').replace(/\s+/g, '') .replace(/^\{\}$/, '') === '';

// 卸载收尾：改完与备份一致 → 备份用完删；我们新建的文件剩空壳 → 整个删
function settle(file, home) {
  const cur = read(file); const bak = read(file + BAK);
  if (cur !== null && bak !== null && cur === bak) rm(file + BAK);
  else if (cur !== null && bak !== null && !bak.trim() && isEmptyDoc(cur)) { write(file, bak); rm(file + BAK); } // 原来是个空文件
  else if (cur !== null && bak === null && isEmptyDoc(cur)) { rm(file); pruneDirs(file, home); }
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 纯 JSON：present/add/del 都拿解析后的对象 */
export function jsonAction({ file, home, desc, preview, present, add, del, conflict }) {
  const load = () => {
    const t = read(file);
    if (t === null) return { t: null, o: {} };
    try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return { t, o }; } catch {}
    return { t, o: null };
  };
  const ser = (o, t) => {
    const m = t && /\n([ \t]+)"/.exec(t);
    const out = JSON.stringify(o, null, m ? m[1] : 2);
    return out + (t === null || t.endsWith('\n') ? '\n' : '');
  };
  return {
    file, desc, preview,
    status() {
      const { o } = load();
      if (o === null) return 'error';
      if (present(o)) return 'done';
      return conflict?.(o) ? 'conflict' : 'todo';
    },
    apply() { const { t, o } = load(); add(o); write(file, ser(o, t)); },
    undo() {
      const { t, o } = load();
      if (o === null || !present(o)) return false;
      del(o);
      const bak = read(file + BAK);
      let bakObj = null; try { bakObj = bak === null ? null : JSON.parse(bak); } catch {}
      write(file, bakObj !== null && deepEq(bakObj, o) ? bak : ser(o, t));
      settle(file, home);
      return true;
    },
  };
}

/** JSONC / JSON5 外科手术 */
// owns(值原文)：标记被宿主删掉后（OpenClaw 改配置会删注释），凭内容认出“这条是我们写的”，照样算装好、照样能卸
export function jsoncAction({ file, home, desc, preview, path, value, id, asElement, externalPath, owns }) {
  const ours = (t) => {
    if (!owns || !externalPath) return false;
    const v = jc.valueText(t, externalPath);
    return v !== null && owns(v);
  };
  return {
    file, desc, preview,
    status() {
      const t = read(file);
      if (t !== null) {
        if (jc.hasMarker(t, id)) return 'done';
        if (externalPath && jc.hasPath(t, externalPath)) return ours(t) ? 'done' : 'external';
      }
      return 'todo';
    },
    apply() {
      const t = read(file);
      const next = jc.insertAtPath(t && t.trim() ? t : '{\n}\n', path, value, id, { asElement });
      write(file, next);
    },
    undo() {
      const t = read(file); if (t === null) return false;
      const next = jc.removeBlock(t, id) ?? (ours(t) ? jc.removeMember(t, externalPath) : null);
      if (next === null) return false;
      write(file, next); settle(file, home); return true;
    },
  };
}

/** Markdown / TOML 追加标记块 */
export function blockAction({ file, home, desc, preview, begin, end, body, externalRe, skipIf }) {
  return {
    file, desc, preview,
    status() {
      if (skipIf?.()) return 'skip';
      const t = read(file);
      if (t !== null) {
        if (tb.hasBlock(t, begin)) return 'done';
        if (externalRe?.test(t)) return 'external';
      }
      return 'todo';
    },
    apply() { const t = read(file); write(file, tb.addBlock(t ?? '', begin, end, body)); },
    undo() {
      const t = read(file); if (t === null) return false;
      const next = tb.removeBlock(t, begin, end); if (next === null) return false;
      write(file, next); settle(file, home); return true;
    },
  };
}

/** 我们独占的整文件。marker：内容里能证明“这是我们写的”的片段 */
export function ownedFile({ file, home, desc, preview, content, marker, skipIf }) {
  return {
    file, desc, preview,
    status() {
      if (skipIf?.()) return 'skip';
      const t = read(file);
      return t !== null && t.includes(marker) ? 'done' : 'todo';
    },
    apply() { write(file, content); }, // 别人的同名文件先备份再盖
    undo() {
      const t = read(file);
      if (t === null || !t.includes(marker)) return false;
      rm(file);
      const bak = read(file + BAK);
      if (bak !== null) { write(file, bak); rm(file + BAK); } else pruneDirs(file, home);
      return true;
    },
  };
}
