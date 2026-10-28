// 钩子：读 stdin → 取 🔊 行 → 脱离的子进程去发。永远不打印、不阻塞、退出码 0。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extract, CLIENT_NAME } from './extract.js';
import { lastReportLine } from './report.js';

export const HOOK_FAMILIES = Object.keys(CLIENT_NAME);

// 默认发送方式：自己再起一个 `say --report`，stdio 全丢，host 不用等
export function detachedSay(args, { execPath = process.execPath, script = process.argv[1] } = {}) {
  const child = spawn(execPath, [script, 'say', ...args], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function sayArgs({ client, sessionId, project, text }) {
  const a = ['--report', '--client', client];
  if (sessionId) a.push('--session', sessionId);
  if (project) a.push('--project', project);
  a.push('--', text); // 文字可能以 - 开头
  return a;
}

/** 返回实际发出的参数（测试用）；任何异常都吞掉 */
export function runHook(family, raw, { env = process.env, platform = process.platform, send = detachedSay, readers } = {}) {
  try {
    if (platform !== 'darwin' || !HOOK_FAMILIES.includes(family)) return null;
    let payload;
    try { payload = JSON.parse(raw); } catch { return null; }
    if (!payload || typeof payload !== 'object') return null;
    const r = extract(family, payload, { env, readers });
    if (r.skip) return null;
    const text = lastReportLine(r.text);
    if (!text) return null;
    const args = sayArgs({
      client: CLIENT_NAME[family], sessionId: r.sessionId,
      project: r.cwd ? path.basename(r.cwd.replace(/[\\/]+$/, '')) : undefined, text,
    });
    send(args);
    return args;
  } catch { return null; }
}
