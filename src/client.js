// 一次完整调用：ping → 没回话就拉起 App → 等就绪 → 发正事（PROTOCOL.md 「薄壳这头」）
import { randomUUID } from 'node:crypto';

export const mkReq = (op, fields = {}) => ({ v: 1, id: randomUUID(), op, ...fields });

/** status: ok | unsupported | not_installed | no_reply | error */
export async function callApp(tx, op, fields = {}, { pingMs = 1500, readyMs = 15000, opMs = 5000 } = {}) {
  if (!tx.supported) return { status: 'unsupported' };
  const ping = await tx.request(mkReq('ping'), pingMs);
  if (!ping) {
    if (!(await tx.launch())) return { status: 'not_installed' };
    if (!(await tx.waitReady(readyMs, mkReq('ping')))) return { status: 'no_reply' };
  }
  const rep = await tx.request(mkReq(op, fields), opMs);
  if (!rep) return { status: 'no_reply' };
  if (rep.ok === false) return { status: 'error', error: rep.error, reply: rep };
  return { status: 'ok', reply: rep };
}
