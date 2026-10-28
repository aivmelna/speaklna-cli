// setup / uninstall：先列出要改什么，问过才写。
import os from 'node:os';
import readline from 'node:readline';
import { backupOnce } from './fsutil.js';
import { getFamily, FAMILY_IDS, ALIASES, LABEL, inNpxCache } from './families.js';

export function makeCtx(env = process.env) {
  // 家目录只认 env.HOME：测试把 HOME 指到临时目录，这里绝不回落去读真实家目录
  return { env, home: env.HOME || os.homedir() };
}

export function normalizeFamilies(names) {
  const out = [];
  for (const n of names) {
    const id = ALIASES[n.toLowerCase()] ?? n.toLowerCase();
    if (!FAMILY_IDS.includes(id)) throw new Error(`Unknown family "${n}". Choose from: ${FAMILY_IDS.join(', ')}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function defaultIo() {
  return {
    out: (s) => process.stdout.write(s + '\n'),
    ask(q) {
      return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve(''); // 非交互：当没回答（= 否）
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
      });
    },
  };
}

const yes = (a) => /^y(es)?$/i.test(a);

function show(io, ctx, fam, acts, verb) {
  io.out(`\n== ${fam.label} ==`);
  for (const a of acts) {
    const st = a.status();
    const tag = { todo: verb, done: 'already done', external: 'already configured by you, left alone', conflict: 'CONFLICT: a different "speaklna" entry exists, left alone', error: 'ERROR: file is not valid JSON, left alone', skip: 'not needed' }[st] ?? st;
    io.out(`  ${a.file.replace(ctx.home, '~')}\n    ${a.desc} -> ${tag}`);
    if (verb === 'will add' && st === 'todo' && a.preview) io.out(a.preview.split('\n').map((l) => '      + ' + l).join('\n'));
  }
}

/** 返回 { changed: [id], notes: [] } */
export async function runSetup(names, { ctx = makeCtx(), io = defaultIo(), yes: auto = false, dryRun = false } = {}) {
  let ids;
  if (names.length) ids = normalizeFamilies(names);
  else {
    const found = FAMILY_IDS.filter((id) => getFamily(id, ctx).detected());
    if (!found.length) { io.out('No supported AI tool detected. Pass names explicitly: ' + FAMILY_IDS.join(', ')); return { changed: [], notes: [] }; }
    io.out('Detected: ' + found.map((i) => LABEL[i]).join(', '));
    if (auto) ids = found;
    else {
      found.forEach((id, i) => io.out(`  ${i + 1}. ${LABEL[id]}`));
      const a = await io.ask('Set up which? (numbers separated by comma, Enter = all, q = none): ');
      if (/^q/i.test(a)) return { changed: [], notes: [] };
      ids = a ? a.split(/[,\s]+/).map((n) => found[Number(n) - 1]).filter(Boolean) : found;
    }
  }
  const changed = []; const notes = [];
  for (const id of ids) {
    const fam = getFamily(id, ctx);
    const acts = fam.actions();
    show(io, ctx, fam, acts, 'will add');
    const todo = acts.filter((a) => a.status() === 'todo');
    if (!todo.length) continue;
    if (dryRun) { io.out('  (dry run, nothing written)'); continue; }
    if (!auto && !yes(await io.ask(`Apply these changes for ${fam.label}? [y/N] `))) { io.out('  skipped'); continue; }
    // 备份在动手前一次做完：只备份“setup 之前就存在”的文件（同一文件有多个动作时，后一个不会把我们刚建的当原件备份）
    for (const f of new Set(todo.map((a) => a.file))) backupOnce(f);
    for (const a of todo) {
      try { a.apply(); } catch (e) { io.out(`  failed: ${a.file}: ${e.message}`); }
    }
    changed.push(id); notes.push(...(fam.notes ?? []));
    io.out('  done (originals backed up as <file>.speaklna-bak)');
  }
  if (changed.length && inNpxCache()) notes.push('speaklna is running from the npx cache, which can be cleaned up. Run `npm i -g speaklna` and set up again so hooks point at a stable path.');
  for (const n of notes) io.out('\nNOTE: ' + n);
  return { changed, notes };
}

export async function runUninstall(names, { ctx = makeCtx(), io = defaultIo(), yes: auto = false } = {}) {
  const ids = names.length ? normalizeFamilies(names) : FAMILY_IDS;
  const removed = [];
  for (const id of ids) {
    const fam = getFamily(id, ctx);
    const acts = [...fam.actions(), ...(fam.extraUndo?.() ?? [])];
    const mine = acts.filter((a) => a.status() === 'done');
    if (!mine.length) { if (names.length) io.out(`${fam.label}: nothing to remove`); continue; }
    io.out(`\n== ${fam.label} ==`);
    for (const a of mine) io.out(`  ${a.file.replace(ctx.home, '~')}\n    remove: ${a.desc}`);
    if (!auto && !yes(await io.ask(`Remove these for ${fam.label}? [y/N] `))) { io.out('  skipped'); continue; }
    for (const a of mine) a.undo();
    removed.push(id);
    io.out('  removed');
  }
  if (!removed.length) io.out('Nothing to uninstall.');
  return { removed };
}
