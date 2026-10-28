// 一次完整调用：ping → 没回话就拉起 App → 等就绪 → 发正事（PROTOCOL.md 「薄壳这头」）
import { randomUUID } from 'node:crypto';

export const mkReq = (op, fields = {}) => ({ v: 1, id: randomUUID(), op, ...fields });

/** App 在不在：null = 在（或已拉起），否则是 unsupported | not_installed | no_reply */
async function ensureApp(tx, { pingMs = 1500, readyMs = 15000 } = {}) {
  if (!tx.supported) return 'unsupported';
  const ping = await tx.request(mkReq('ping'), pingMs);
  if (!ping) {
    if (!(await tx.launch())) return 'not_installed';
    if (!(await tx.waitReady(readyMs, mkReq('ping')))) return 'no_reply';
  }
  return null;
}

/** status: ok | unsupported | not_installed | no_reply | error */
export async function callApp(tx, op, fields = {}, { pingMs = 1500, readyMs = 15000, opMs = 5000 } = {}) {
  const down = await ensureApp(tx, { pingMs, readyMs });
  if (down) return { status: down };
  const rep = await tx.request(mkReq(op, fields), opMs);
  if (!rep) return { status: 'no_reply' };
  if (rep.ok === false) return { status: 'error', error: rep.error, reply: rep };
  return { status: 'ok', reply: rep };
}

/**
 * 存成 wav：App 生成完写进 ~/Music/Speaklna，回话只带路径。
 * status: ok（reply.path 是存好的文件）| pending（waitMs 到了还在存，reply.path 是存好后的位置）| error | 同 callApp
 * onStart(id)：收下了（命令行拿它在 Ctrl-C 时取消）
 */
export async function saveApp(tx, fields, { waitMs, idleMs, onProgress, onStart, ...o } = {}) {
  const down = await ensureApp(tx, o);
  if (down) return { status: down };
  const req = mkReq('save', fields);
  onStart?.(req.id);
  const { reply, done } = await tx.save(req, { waitMs, idleMs, onProgress });
  if (!reply) return { status: 'no_reply' };
  if (reply.ok === false) return { status: 'error', error: reply.error, reply };
  if (done?.ok) return { status: 'ok', reply: { ...reply, ...done } };
  if (done) return { status: 'error', error: done.error, reply: done };
  if (waitMs) return { status: 'pending', reply };
  return { status: 'no_reply' }; // 收下以后一直没动静：App 没了
}

/** 取消正在存的那次（Ctrl-C） */
export async function cancelSave(tx, id) {
  return tx.request(mkReq('stop', { save: id }), 1500);
}
