# speaklna

A thin command-line shell that lets AI coding tools on a Mac talk through the **Speaklna** app (local text-to-speech).
Supported: Claude Code, Codex, OpenCode, Grok Build (`grok`), OpenClaw.

It does three things:

- `speaklna mcp` — a stdio MCP server with five tools: `speak`, `save`, `stop`, `status`, `voices`.
- `speaklna hook <tool>` — a turn-end hook. The model ends each reply with one line starting with `🔊`; the hook reads that line and sends it to the app. Secrets are redacted, the hook never prints and always exits 0.
- `speaklna setup` / `speaklna uninstall` — write (and cleanly remove) the MCP entry, the hook and a short rules file for each tool.

AI tools can only speak, save speech as a WAV file, stop, check status and list voices. They cannot import voices or change settings.

## Usage

```sh
npx -y speaklna setup            # detect installed tools, show every change, ask before writing
npx -y speaklna setup claude codex --yes
npx -y speaklna uninstall
speaklna say "Hello"             # also: stop, status, voices (add --json)
speaklna save "Hello" -o hello.wav   # speech to a WAV file, nothing is played
```

`save` reads the text the same way as ⌥T (24 kHz mono 16-bit WAV). Without `-o` the file stays in `~/Music/Speaklna/` and its path is printed. Text can come from stdin with `-`. It needs Speaklna 1.1 (4) or later, runs only when the app is not already reading, and stops if you press ⌥T meanwhile; Ctrl-C cancels it. Exit code 1 when nothing was saved.

Notes:

- `setup` shows exactly which files and keys it will change and asks y/N. Originals are saved once as `<file>.speaklna-bak`.
- Hooks call the installed `speaklna` by absolute path. For a stable path run `npm i -g speaklna` first.
- Codex: after setup, open `/hooks` once inside Codex and trust the hook.
- OpenClaw: restart the Gateway if it is running. Its "can't verify where this plugin came from" warning is expected.
- Needs macOS with the Speaklna app. On other systems the commands print a message and exit 0.

Protocol between this CLI and the app: [PROTOCOL.md](PROTOCOL.md). Tests: `npm test` (Node 18+, no dependencies).

License: MIT. Author: Aivmelna LLC.

## 中文

给 Mac 上的 AI 编程工具用的 Speaklna（本地朗读）命令行薄壳，支持 Claude Code、Codex、OpenCode、Grok Build、OpenClaw。

- `speaklna mcp`：MCP 服务，工具 `speak` / `save` / `stop` / `status` / `voices`。
- `speaklna save "文字" -o 文件.wav`：念法和 ⌥T 一样，存成 wav、不出声；不给 `-o` 就留在 `~/Music/Speaklna/`，打印路径。
- `speaklna hook <工具>`：每轮结束的钩子，只念回复最后一行以 `🔊` 开头的报告句；密钥类内容会先抹掉；钩子不打印、不阻塞、退出码恒为 0。
- `speaklna setup` / `uninstall`：把 MCP、钩子和“每轮结尾写一行 🔊”的规矩写进各家配置，卸载时删干净。

AI 只能念、存成 wav、停、看状态、列音色，改不了设置，也不能导入音色。

```sh
npx -y speaklna setup          # 自动发现已装的工具，先列出要改的文件，同意才写
npx -y speaklna uninstall
```

写入前会备份为 `<文件>.speaklna-bak`。Codex 装完要在 Codex 里打开 `/hooks` 点一次信任；OpenClaw 的 Gateway 开着就重启一次（会提示无法确认插件来源，正常）。
