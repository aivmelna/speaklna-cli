import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmp(prefix = 'speaklna-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 文件树快照：相对路径 → 内容（忽略空目录） */
export function snapshot(root) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
    }
  })(root);
  return out;
}

export function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 宽松解析 JSONC / JSON5（够测试用）：去注释、去尾逗号、给裸键加引号 */
export function parseLoose(text) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, s) => s || '');
  const quoted = noComments.replace(/(^|[{,]\s*)([A-Za-z_]\w*)(\s*:)/gm, '$1"$2"$3');
  const dq = quoted.replace(/'([^'"\\]*)'/g, '"$1"');
  return JSON.parse(dq.replace(/,(\s*[}\]])/g, '$1'));
}

export function silentIo() {
  const lines = [];
  return { lines, out: (s) => lines.push(s), ask: async () => 'y' };
}
