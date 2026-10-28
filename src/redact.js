// 报告句念出去之前先抹掉像密钥的东西（拷问 03 第 13 题：不许写密码、密钥、token）
const MASK = '…';

const KV = /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\w*\s*(?:[:=：]|\bis\b)\s*)(["'`]?)[^\s"'`,，。;；)）]+\2/gi;
const KV_ZH = /((?:密码|密钥|秘钥|口令|令牌)\s*(?:是|为|[:：=])\s*)[^\s，。,;；]+/g;

const PLAIN = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[0-9a-f]{32,}\b/gi, // 长十六进制（哈希、密钥）念出来也没用
];

export function redact(s) {
  let out = String(s);
  for (const re of PLAIN) out = out.replace(re, MASK);
  out = out.replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${MASK}@`); // URL 里带的账号密码
  out = out.replace(KV, `$1${MASK}`).replace(KV_ZH, `$1${MASK}`);
  // 长随机串：字母数字混排且大小写都有才算，免得误伤 kebab-case 长标识
  out = out.replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (m) =>
    /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? MASK : m);
  return out;
}
