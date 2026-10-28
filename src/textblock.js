// 给 Markdown / TOML 追加一段带标记的块，卸载时按标记整段切掉。
// TOML 不用 parse 重写：没有零依赖又保注释的库，而“文件末尾追加一张新表”总是合法 TOML。
// 追加规则保证可逆：原文以换行结尾 → 加 "\n"+块+"\n"；原文没有结尾换行 → 加 "\n\n"+块（块末尾也不加换行，
// 卸载时靠“结束标记后是不是 EOF”区分两种情况）；原文为空 → 只有块+"\n"。

export function addBlock(text, begin, end, body) {
  const block = `${begin}\n${body}\n${end}`;
  if (!text) return block + '\n';
  if (text.endsWith('\n')) return text + '\n' + block + '\n';
  return text + '\n\n' + block;
}

export const hasBlock = (text, begin) => text.includes(begin + '\n');

export function removeBlock(text, begin, end) {
  const b = text.indexOf(begin + '\n');
  if (b < 0) return null;
  const ei = text.indexOf(end, b);
  if (ei < 0) return null;
  const e = ei + end.length;
  if (text[e] === '\n') {
    const s = b > 0 && text[b - 1] === '\n' ? b - 1 : b;
    return text.slice(0, s) + text.slice(e + 1);
  }
  const s = text.slice(b - 2, b) === '\n\n' ? b - 2 : b;
  return text.slice(0, s) + text.slice(e);
}
