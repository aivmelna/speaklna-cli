// 命令分发。钩子分支要最快、最静：不加载别的，出任何事都吞掉。
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from './hook.js';

const USAGE = `speaklna <command>

  mcp                         stdio MCP server (speak / save / stop / status / voices)
  say [opts] <text|->         speak one request
        --report --client X --session S --project P --voice V
  save [opts] <text|->        save the speech as a WAV file instead of playing it
        -o FILE|DIR --voice V --name N --json   (default: ~/Music/Speaklna/)
  stop | status | voices      [--json]
  setup [family...]           wire MCP + turn-end hook + rules into AI tools  [--yes] [--dry-run]
  uninstall [family...]       remove exactly what setup added                 [--yes]
  hook <family>               (called by the AI tool) families: claude codex opencode grok openclaw

families: claude codex opencode grok openclaw`;

function readStdin(limitMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = ''; let done = false;
    const end = () => { if (!done) { done = true; clearTimeout(t); resolve(s); } };
    const t = setTimeout(end, limitMs); // 宿主不关管道也不能把我们卡住
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', end);
    process.stdin.on('error', end);
  });
}

export function parseArgs(argv, valueFlags = []) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (valueFlags.includes(k)) flags[k] = v ?? argv[++i]; else flags[k] = v ?? true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const CLIENTS = ['claude-code', 'codex', 'opencode', 'antigravity', 'grok', 'openclaw', 'other'];

export async function main(argv, deps = {}) {
  const cmd = argv[0];

  if (cmd === 'hook') {
    // 铁律：不打印、退出码 0
    try { runHook(argv[1], await readStdin(), deps.hook); } catch {}
    return 0;
  }

  const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = deps.err ?? ((s) => process.stderr.write(s + '\n'));
  const getTx = async () => deps.transport ?? (await import('./transport.js')).createTransport();

  switch (cmd) {
    case 'mcp': {
      const { serve } = await import('./mcp.js');
      await serve(await getTx(), deps.mcpIo);
      return 0;
    }
    case 'say': {
      const { flags, rest } = parseArgs(argv.slice(1), ['client', 'session', 'project', 'voice']);
      let text = rest.join(' ');
      if (text === '-' ) text = deps.stdin ?? (await readStdin(30000));
      text = text.replace(/\s+$/, '');
      if (!text.trim()) { err('Nothing to say.'); return 1; }
      const fields = { text, kind: flags.report ? 'report' : 'active', client: CLIENTS.includes(flags.client) ? flags.client : 'other' };
      for (const k of ['session', 'project', 'voice']) if (typeof flags[k] === 'string' && flags[k]) fields[k] = flags[k];
      return await transportCommand('speak', fields, flags, getTx, out, err, !!flags.report);
    }
    case 'save': {
      const args = argv.slice(1).map((a) => (a === '-o' ? '--out' : a));
      const { flags, rest } = parseArgs(args, ['voice', 'name', 'out', 'client']);
      let text = rest.join(' ');
      if (text === '-') text = deps.stdin ?? (await readStdin(30000));
      text = text.replace(/\s+$/, '');
      if (!text.trim()) { err('Nothing to save.'); return 1; }
      return await saveCommand(text, flags, deps, getTx, out, err);
    }
    case 'stop': case 'status': case 'voices': {
      const { flags } = parseArgs(argv.slice(1));
      return await transportCommand(cmd, cmd === 'stop' ? { client: 'other' } : {}, flags, getTx, out, err);
    }
    case 'setup': case 'uninstall': {
      const { flags, rest } = parseArgs(argv.slice(1));
      const s = await import('./setup.js');
      try {
        const opts = { yes: !!flags.yes, dryRun: !!flags['dry-run'], ...(deps.setup ?? {}) };
        if (cmd === 'setup') await s.runSetup(rest, opts); else await s.runUninstall(rest, opts);
        return 0;
      } catch (e) { err(e.message); return 1; }
    }
    case '--version': case '-v': {
      out(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      return 0;
    }
    default:
      (cmd && cmd !== '--help' && cmd !== '-h' ? err : out)(USAGE);
      return cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
}

// -o 指到哪：已有目录 → 放进去、用 App 起的名字；以 / 结尾 → 建目录；否则就是文件名（补 .wav）
function outTarget(o, appPath) {
  const p = path.resolve(o);
  let isDir = o.endsWith('/') || o.endsWith(path.sep);
  try { isDir = isDir || fs.statSync(p).isDirectory(); } catch {}
  if (isDir) { fs.mkdirSync(p, { recursive: true }); return path.join(p, path.basename(appPath)); }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return /\.wav$/i.test(p) ? p : p + '.wav';
}

function moveFile(src, dst) {
  try { fs.renameSync(src, dst); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dst); fs.unlinkSync(src);
  }
}

async function saveCommand(text, flags, deps, getTx, out, err) {
  const { saveApp, cancelSave } = await import('./client.js');
  const { describe } = await import('./format.js');
  const tx = await getTx();
  const fields = { text, client: CLIENTS.includes(flags.client) ? flags.client : 'other' };
  if (typeof flags.voice === 'string' && flags.voice) fields.voice = flags.voice;
  const outArg = typeof flags.out === 'string' && flags.out ? flags.out : null;
  // App 里的文件名：--name，不给就跟 -o 的文件名走（App 只认名字，不认路径）
  const name = typeof flags.name === 'string' && flags.name ? flags.name
    : outArg && !outArg.endsWith('/') ? path.basename(outArg).replace(/\.wav$/i, '') : null;
  if (name) fields.name = name;
  const tty = !flags.json && (deps.isTTY ?? process.stderr.isTTY);
  const progress = tty ? (p) => process.stderr.write(`\rSaving… ${Math.round(p.seconds ?? 0)} s of audio`) : undefined;
  let id = null; let interrupted = false;
  const onSigint = async () => { interrupted = true; if (id) await cancelSave(tx, id); if (tty) process.stderr.write('\n'); process.exit(130); };
  if (!deps.transport) process.once('SIGINT', onSigint);
  const res = await saveApp(tx, fields, { onProgress: progress, onStart: (i) => (id = i) });
  if (interrupted) await new Promise(() => {}); // 取消的结果可能先回来：等 onSigint 发完取消、以 130 退出
  if (!deps.transport) process.off('SIGINT', onSigint);
  if (tty) process.stderr.write('\r\x1b[K');
  if (res.status === 'ok' && outArg) {
    try {
      const dst = outTarget(outArg, res.reply.path);
      moveFile(res.reply.path, dst);
      res.reply.path = dst;
    } catch (e) { err(`Saved to ${res.reply.path}, but could not move it to ${outArg}: ${e.message}`); return 1; }
  }
  if (flags.json) out(JSON.stringify(res.status === 'ok' ? { ok: true, path: res.reply.path, seconds: res.reply.seconds } : { ok: false, status: res.status, error: res.error }));
  else if (res.status === 'ok') out(res.reply.path);
  else err(describe('save', res));
  if (res.status === 'ok' && tty) err(describe('save', res).replace(/ to .*$/, '.'));
  return res.status === 'ok' ? 0 : 1; // 存不成就是失败（脚本要靠退出码）
}

async function transportCommand(op, fields, flags, getTx, out, err, quiet = false) {
  const { callApp } = await import('./client.js');
  const { describe } = await import('./format.js');
  const res = await callApp(await getTx(), op, fields);
  if (flags.json) out(JSON.stringify(res.status === 'ok' ? res.reply : { ok: false, status: res.status, error: res.error }));
  else if (!quiet || res.status === 'error') (res.status === 'error' ? err : out)(describe(op, res));
  return res.status === 'error' ? 1 : 0; // 没装 / 非 mac / 没回话都算正常结束
}
