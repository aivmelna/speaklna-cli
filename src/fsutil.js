// 文件小工具：备份一次、原子写、清空目录
import fs from 'node:fs';
import path from 'node:path';

export const BAK = '.speaklna-bak';

export function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function exists(p) { return fs.existsSync(p); }

// 改之前备份，只备一次：备份永远是“用户原样”，不会被第二次 setup 盖掉
export function backupOnce(file) {
  if (!fs.existsSync(file) || fs.existsSync(file + BAK)) return;
  fs.copyFileSync(file, file + BAK);
}

export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* 新文件 */ }
  const tmp = `${file}.speaklna-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: mode ?? 0o644 }); // ~/.claude.json 是 0600，别放宽
  fs.renameSync(tmp, file);
}

export function rm(file) { try { fs.rmSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

// 删完文件把我们建出来的空目录也收掉，走到 stop（家目录）为止
export function pruneDirs(file, stop) {
  let d = path.dirname(file);
  const s = path.resolve(stop);
  while (path.resolve(d).startsWith(s + path.sep)) {
    try { fs.rmdirSync(d); } catch { return; } // 非空就停
    d = path.dirname(d);
  }
}
