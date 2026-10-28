// 和 App 之间的分布式通知（PROTOCOL.md）。所有 JXA 都关在这个文件里；
// 上层只认 { supported, request, launch, waitReady } 这四个口，测试换成假的就行。
import { spawn } from 'node:child_process';

export const BUNDLE_ID = 'com.aivmelna.speaklna';
const N_REQ = 'com.aivmelna.speaklna.ai.request';
const N_REPLY = 'com.aivmelna.speaklna.ai.reply';
const N_READY = 'com.aivmelna.speaklna.ai.ready';
const SENTINEL = 'SPEAKLNA:';

// 参数直接拼进脚本文本，走 stdin 喂给 osascript：2 万字的 argv 在 macOS 上也行，但 stdin 没有长度顾虑。
// 注意（spike 踩过）：object 要传 $()，不能传 null；观察者要 registerSubclass；轮询 runloop。
const JXA = `
ObjC.import('Foundation');
const P = __PARAMS__;
function run() {
  const c = $.NSDistributedNotificationCenter.defaultCenter;
  let reply = null, ready = false;
  ObjC.registerSubclass({ name: 'SpeaklnaObs', methods: {
    'reply:': { types: ['void', ['id']], implementation: function (n) { try { const r = JSON.parse(ObjC.unwrap(n.object)); if (P.mode === 'ready' || r.id === P.id) reply = r; } catch (e) {} } },
    'ready:': { types: ['void', ['id']], implementation: function (n) { ready = true; } },
  } });
  const o = $.SpeaklnaObs.alloc.init;
  c.addObserverSelectorNameObjectSuspensionBehavior(o, 'reply:', '${N_REPLY}', $(), $.NSNotificationSuspensionBehaviorDeliverImmediately);
  c.addObserverSelectorNameObjectSuspensionBehavior(o, 'ready:', '${N_READY}', $(), $.NSNotificationSuspensionBehaviorDeliverImmediately);
  const post = (req) => c.postNotificationNameObjectUserInfoDeliverImmediately('${N_REQ}', $(), $(req), true);
  const t0 = Date.now();
  let lastPing = 0;
  if (P.mode === 'request') post(P.req);
  while (Date.now() - t0 < P.timeoutMs) {
    if (P.mode === 'request' && reply) break;
    if (P.mode === 'ready') {
      if (ready || reply) break;
      // ready 通知可能在我们开始听之前就发了，所以同时每 0.5 s 敲一下 ping
      if (Date.now() - lastPing > 500) { post(P.req); lastPing = Date.now(); }
    }
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  return '${SENTINEL}' + JSON.stringify({ reply: reply, ready: ready });
}
`;

function runJxa(params, { spawnFn = spawn, killMs }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawnFn('osascript', ['-l', 'JavaScript'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, killMs);
    // run() 的返回值落 stdout（macOS 27.0.1 实测，10-28）；stderr 也收着，防别的系统版本
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
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
