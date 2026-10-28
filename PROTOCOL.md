# 薄壳 ↔ App 协议 v1（ADR 0007：分布式通知）

**请求** `com.aivmelna.speaklna.ai.request`，userInfo（App 外发，沙盒 App 收得到）：
`{v:1, id:<uuid>, op:"ping"|"speak"|"save"|"stop"|"status"|"voices", …}`
- speak：`text`（主动念 ≤20000 字，报告句 App 截 500）、`kind:"report"|"active"`、`client:"claude-code"|"codex"|"antigravity"|"grok"|"opencode"|"openclaw"|"other"`、
  `project?`（cwd 末级目录名，念来源用）、`session?`（同一会话只留最新一句报告句）、`voice?`（音色 id 或名字；不给就用用户在“接入 AI”页配的接入方音色，再不行用 ⌥T 那个）
- save（1.1 (4) 起）：`text`（≤20000 字）、`client`、`voice?`（同 speak）、`name?`（文件名，App 去掉路径和怪字符，不给就“Speaklna 2026-10-28 15.02.11”，重名加“ 2”）。
  念法同 ⌥T，不出声、不管 AI 静音；写进 `~/Music/Speaklna/`（App 带 `assets.music.read-write`，10-28 实测终端 / ssh 读它不弹授权框）
- stop：`client?`，只停 AI 发起的（⌥T 念的不动）；带 `save:<那次 save 的请求 id>` = 只取消那次存（命令行 Ctrl-C）

**回话** `com.aivmelna.speaklna.ai.reply`，object = JSON 字符串 `{v:1, id, ok, error?, …}`（沙盒发通知不许带 userInfo）：
- ping → `{app:"1.1", build}`；status → `{state:"sleeping|preparing|ready|reading", speaking:"user"|"ai"|null, muted:bool, muteReason:"mic"|null, queued:n}`
- voices → `{voices:[{id,name,kind:"fixed"|"user"}], default:<这个接入方实际会用的 id>}`；stop → `{stopped:n}`
- speak → `{result:"speaking"|"queued"|"muted"}`；错误 `empty` / `too_long` / `unknown_voice` / `bad_request`
- save → `{result:"saving", path:<打算存到哪>}`；错误另有 `busy`（主道在念 / 已经在存一个）。之后 App 发 `com.aivmelna.speaklna.ai.save`（object JSON）：
  每段 `{v:1, id, state:"progress", segments, seconds}`，最后 `{v:1, id, state:"done", ok:true, path, seconds}` 或 `{… ok:false, error:"interrupted"|"canceled"|"engine"|"write"|"empty"}`（失败不留文件）
- status 另带 `saving:<路径>|null`
**就绪** App 启动发 `com.aivmelna.speaklna.ai.ready`（object `{v:1, app}`）。

**薄壳这头**：`osascript -l JavaScript` 发 / 收（spikes/m6-ipc/client.js 是能跑通的样子：object 传 nil 要写 `$()`，不能写 null）。
1.5 s 没回话 → App 没开：`open -g -b com.aivmelna.speaklna --args --background`（不弹窗），等 ready（≤15 s）再发；装都没装 → 提示去 Mac App Store，退出码 0。
钩子里永远：不打印、不阻塞（自己再起一个脱离的子进程去发，stdio 全接 /dev/null）、退出码 0。
`speaklna save`：等结果，进度打到 stderr（终端里），路径打到 stdout；`-o` 给了就把文件从 `~/Music/Speaklna/` 挪过去；收下后 120 s 没动静算 App 没了；存不成退出码 1。
MCP 的 `save` 最多等 50 s（Codex 工具调用 60 s 超时）就先回“还在存，存好在 <路径>”。

**App 这头怎么排**（ADR 0006 分层让位，`Reader` 里做）：
- ⌥T：清空 AI 排队、停旁道，从头念剪贴板；⌥S：全停、清空排队。
- 报告句走引擎旁道（speak 带 `lane:"side"`，引擎在主道两段之间先生成）。主道正在出声 → 整句攒齐后 `Player.insertNext`（等当前块播完插到最前、全部重排）；没在出声 → 来一段排一段。
  一次只念一句，念完（Player `onTagDone`）才发下一句；同一 client+session 排着的只留最新；排了 120 s 没念的扔掉。
- 主动念走主道：⌥T 念着 → 排着等（一个位置，新的替旧的，也 120 s 过期）；AI 主动念着 → 新的顶掉旧的（连带停掉旁道那句）；报告句念着 → 等它念完。
- 来源：报告句前加“Codex，speaklna：”（英文报告句用 “Codex, speaklna: ”），“接入 AI”页可关；另一档“只念‘Codex 在 speaklna 干完了’”。主动念不加来源。
- AI 静音：有别的进程在录音（CoreAudio 进程对象 `kAudioProcessPropertyIsRunningInput`，读属性不用麦克风权限）→ AI 的一律不出声、计数，正在念的 AI 也停；
  除掉一直在听的系统进程 `com.apple.CoreSpeech`（“嘿 Siri”：10-27 实测任何程序一出声它就开始录）、`com.apple.accessibility.heard`（声音识别）。
  读不到进程列表才退到看默认输入设备在不在跑。1.1 只看麦克风，不看专注模式。
- “接入 AI”页（新窗口，面板加一行入口）：一句话说明 + 打开教程（`speak.aivmelna.com/ai/`、`/zh/ai/`）+ 静音状态“开会中，已静音 N 句” + 来源开关 + 报告句 / 只念“干完了”
  + 已接入列表（UserDefaults `aiClients`：client → 上次时间、次数、接入方音色）。**不放安装命令**（审核 2.4.5(iii)）。
- 存成 wav：也走引擎主道（speak 带 `paced:false`：不跟着播放限速，生成完就算用完、闲置照常计时），段不进播放器，按引擎给的停顿补静音写进 App 沙盒 tmp，
  存完挪进 `~/Music/Speaklna/`。主道空着才开（不排队，回 busy）；⌥T 顶掉它（interrupted）；AI 主动念排着等它存完（照旧 120 s 过期）；报告句照常插着念；⌥S、AI 喊停都不动它。
- `--background` 启动不弹窗口。
