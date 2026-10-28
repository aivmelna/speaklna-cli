// 和 App 之间的分布式通知（PROTOCOL.md）。所有 JXA 都关在这个文件里；
// 上层只认 { supported, request, save, launch, waitReady } 这五个口，测试换成假的就行。
import { spawn } from 'node:child_process';

export const BUNDLE_ID = 'com.aivmelna.speaklna';
const N_REQ = 'com.aivmelna.speaklna.ai.request';
const N_REPLY = 'com.aivmelna.speaklna.ai.reply';
const N_READY = 'com.aivmelna.speaklna.ai.ready';
const N_SAVE = 'com.aivmelna.speaklna.ai.save';
const SENTINEL = 'SPEAKLNA:';
const PROGRESS = 'SPKLNA-PROGRESS:'; // 存 wav 的进度：JXA 的 console.log 落 stderr，一行一条，边收边报

// 参数直接拼进脚本文本，走 stdin 喂给 osascript：2 万字的 argv 在 macOS 上也行，但 stdin 没有长度顾虑。
// 注意（spike 踩过）：object 要传 $()，不能传 null；观察者要 registerSubclass；轮询 runloop。
const JXA = `
ObjC.import('Foundation');
const P = __PARAMS__;
function run() {
  const c = $.NSDistributedNotificationCenter.defaultCenter;
  let reply = null, ready = false, done = null, lastEvent = 0;
  ObjC.registerSubclass({ name: 'SpeaklnaObs', methods: {
    'reply:': { types: ['void', ['id']], implementation: function (n) { try { const r = JSON.parse(ObjC.unwrap(n.object)); if (P.mode === 'ready' || r.id === P.id) { reply = r; lastEvent = Date.now(); } } catch (e) {} } },
    'ready:': { types: ['void', ['id']], implementation: function (n) { ready = true; } },
    'saved:': { types: ['void', ['id']], implementation: function (n) { try { const r = JSON.parse(ObjC.unwrap(n.object)); if (r.id !== P.id) return; lastEvent = Date.now(); if (r.state === 'done') done = r; else console.log('${PROGRESS}' + JSON.stringify(r)); } catch (e) {} } },
  } });
  const o = $.SpeaklnaObs.alloc.init;
  c.addObserverSelectorNameObjectSuspensionBehavior(o, 'reply:', '${N_REPLY}', $(), $.NSNotificationSuspensionBehaviorDeliverImmediately);
  c.addObserverSelectorNameObjectSuspensionBehavior(o, 'ready:', '${N_READY}', $(), $.NSNotificationSuspensionBehaviorDeliverImmediately);
  if (P.mode === 'save') c.addObserverSelectorNameObjectSuspensionBehavior(o, 'saved:', '${N_SAVE}', $(), $.NSNotificationSuspensionBehaviorDeliverImmediately);
  const post = (req) => c.postNotificationNameObjectUserInfoDeliverImmediately('${N_REQ}', $(), $(req), true);
  const t0 = Date.now();
  let lastPing = 0;
  if (P.mode === 'request' || P.mode === 'save') post(P.req);
  while (Date.now() - t0 < P.timeoutMs) {
    if (P.mode === 'request' && reply) break;
    if (P.mode === 'save') {
      // 先等收下的回话；收下了再等结果：一直没动静（进度 / 结果）超过 idleMs 就当 App 没了
      if (done || (reply && (!reply.ok || reply.result !== 'saving'))) break;
      if (!reply && Date.now() - t0 > P.replyMs) break;
      if (reply && Date.now() - lastEvent > P.idleMs) break;
    }
    if (P.mode === 'ready') {
      if (ready || reply) break;
      // ready 通知可能在我们开始听之前就发了，所以同时每 0.5 s 敲一下 ping
      if (Date.now() - lastPing > 500) { post(P.req); lastPing = Date.now(); }
    }
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  return '${SENTINEL}' + JSON.stringify({ reply: reply, ready: ready, done: done });
}
`;

function runJxa(params, { spawnFn = spawn, killMs, onProgress }) {
  return new Promise((resolve) => {
    let out = '';
    let line = '';
    const progress = (d) => {
      if (!onProgress) return;
      const parts = (line + d).split('\n'); line = parts.pop();
      for (const l of parts) if (l.startsWith(PROGRESS)) { try { onProgress(JSON.parse(l.slice(PROGRESS.length))); } catch {} }
    };
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawnFn('osascript', ['-l', 'JavaScript'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, killMs);
    // run() 的返回值落 stdout（macOS 27.0.1 实测，10-28）；stderr 也收着，防别的系统版本
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => { out += d; progress(String(d)); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const i = out.lastIndexOf(SENTINEL);
      if (i < 0) return finish(null);
      try { finish(JSON.parse(out.slice(i + SENTINEL.length).split('\n')[0])); } catch { finish(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JXA.replace('__PARAMS__', JSON.stringify(params)));
  });
}

export function createTransport({ platform = process.platform, spawnFn = spawn } = {}) {
  return {
    supported: platform === 'darwin',
    /** 发一条请求，等同 id 的回话；超时返回 null */
    async request(req, timeoutMs) {
      const r = await runJxa({ mode: 'request', id: req.id, req, timeoutMs }, { spawnFn, killMs: timeoutMs + 4000 });
      return r?.reply ?? null;
    },
    /**
     * 存成 wav：发 save，等收下（≤ replyMs），再等结果。一直没动静 idleMs 就放弃；waitMs 到了也先回（App 那头接着存）。
     * 返回 { reply, done }：reply = 收下的回话（null = 没回），done = 结果（null = 还没存完 / 没动静了）
     */
    async save(req, { replyMs = 5000, idleMs = 120000, waitMs = 6 * 3600 * 1000, onProgress } = {}) {
      const r = await runJxa({ mode: 'save', id: req.id, req, timeoutMs: waitMs, replyMs, idleMs },
        { spawnFn, killMs: waitMs + 4000, onProgress });
      return { reply: r?.reply ?? null, done: r?.done ?? null };
    },
    /** 把 App 在后台拉起来（不弹窗）；`open` 失败 = 没装 */
    launch() {
      return new Promise((resolve) => {
        let child;
        try { child = spawnFn('open', ['-g', '-b', BUNDLE_ID, '--args', '--background'], { stdio: 'ignore' }); }
        catch { return resolve(false); }
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    },
    /** 等 ready 通知（或 ping 有回话）≤ timeoutMs */
    async waitReady(timeoutMs, pingReq) {
      const r = await runJxa({ mode: 'ready', req: pingReq, timeoutMs }, { spawnFn, killMs: timeoutMs + 4000 });
      return !!(r && (r.ready || r.reply));
    },
  };
}
