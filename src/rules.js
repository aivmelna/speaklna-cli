// 写进各家的“报告句规矩”（拷问 03 第 6 题）。模型每轮结尾写一行 🔊，钩子只念这一行。
export const RULES_BODY = `## Spoken report (Speaklna)

The user hears a short spoken report after each of your replies. End EVERY reply with exactly one final line that starts with "🔊 " followed by ONE sentence:

- state the result, and anything the user must do next;
- use the same language as the rest of your reply;
- plain words only: no code, file paths, URLs, markdown or emoji;
- never include passwords, API keys, tokens or other secrets.

Example: \`🔊 Tests pass now; you still need to restart the server.\`
示例：\`🔊 测试已经通过，你还需要重启一下服务。\`

Do not call a speak tool for this line; it is read automatically. Use the speak tool only when the user asks you to read something aloud.`;

export const MANAGED = 'speaklna:managed'; // 独占文件里的归属标记

export const rulesFile = (frontMatter = '') =>
  `${frontMatter}<!-- ${MANAGED} -->\n# Speaklna\n\n${RULES_BODY}\n`;

export const BLOCK_BEGIN = '<!-- speaklna:begin -->';
export const BLOCK_END = '<!-- speaklna:end -->';
export const TOML_BEGIN = '# speaklna:begin';
export const TOML_END = '# speaklna:end';
