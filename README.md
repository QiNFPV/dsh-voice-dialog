# DSH语音对话

在 DeepSeek Harness 里**一直说话**的语音对话：点一下麦克风，之后正常聊天就行。

> 点麦克风 → 说话 → 停顿自动断句 → 2 秒后自动发送 → 回复朗读出来 → 开口即打断。

## 主要功能

- **连续对话**：点一次进入，不用每句都按
- **自动断句**：停顿 1.2 秒就算说完
- **2 秒确认窗口**：文字先进输入框，不动自动发；按任意键或点一下即暂停，改完回车
- **自动纠错**：识别错字自动修正（数字句跳过，避免改错号码）
- **语音朗读**：按你选的语言选音色；日语回复带假名注音（朗读时自动去掉，不念两遍）
- **可打断**：朗读时开口说话，它立刻停下听你说
- **10 秒空闲自动退出**，不会一直占着麦克风
- **只念语音的回复**：打字发来的消息不会出声

## 怎么用

1. 点输入框左侧的**麦克风**按钮，图标变红即进入
2. 说话；停顿后文字出现在输入框
3. 2 秒内不动就自动发送；想改就点一下输入框或按任意键
4. 想结束：再点一次麦克风，或等 10 秒不说话自动退出

输入框旁边的语言下拉只决定**朗读用哪种声音**；识别永远自动判定语言。

## 设置

**设置 → 插件 → 语音对话**

- **语言勾选** —— 决定下拉里出现哪些语言（自动 / 中文 / English / 日本語 默认）
- **显示全部音色** —— 可选更多 Edge 音色
- **自动纠错** —— 可关闭
- **外接接口** —— 可选，填 OpenAI 兼容的识别/合成地址与密钥

## 依赖

- 需要 DSH（桌面端）；识别默认用 DSH 自带的 SenseVoice
- 朗读用内置 Edge TTS，**不需要额外安装任何服务**
- 想更准的识别：可选装本地 Whisper（`faster-whisper`）

## 常见问题

| 现象 | 处理 |
|---|---|
| 点了没反应 | 检查麦克风权限，按钮上会显示原因 |
| 识别为空 | 声音太小或太短；说话稍大声、多说几个字 |
| 没念出来 | 这条是打字发的（设计如此），或语音模式已退出 |
| 重复发言 | 别同时开两个 DSH 窗口的语音模式 |

更细的原理、日志位置、已知限制见 [`docs/详细说明.md`](docs/详细说明.md)。

## 更新记录

### 0.1.1

启动修复版。**0.1.0 在任何平台装上都起不来**：整个 Web 前端的 boot 会失败
（`web boot: 1 entry did not activate`），并常伴随 `duplicate factory registration`。
原因是三处打包/启动问题：

1. **客户端注册 id 与包名不一致**（`client.js`）：0.1.0 用 `@local/dsh-voice-chat` 注册，
   而加载器按包名 `dsh-voice-dialog` 查找，于是报 `loaded without registering`。
   0.1.1 把注册 id 改为 `dsh-voice-dialog`，与包名、`cordis.patch.yml` 三处保持一致。
2. **注入了一个不存在的包**（`package.json` 的 `dsh.client.inject`）：
   `@deepseek-ai/dsh-client-runtime` 在 DSH 0.2.x 里没有对应包，客户端入口 import 直接失败。
   客户端实际只依赖加载器内建的 `react`，0.1.1 改为 `"inject": []`。
3. **Windows 绝对路径写死**（`index.js`）：日志、上次输入、配置文件路径写成
   `C:\Users\<用户名>\.dsh\...`，在 macOS/Linux 上会生成名字带反斜杠的怪文件、设置也写不进 `~/.dsh`。
   0.1.1 统一用 `os.homedir()` + `path.join()` 得到 `~/.dsh/...`
   （可用 `DSH_HOME` 或 `VOICE_TUTOR_LOG` / `VOICE_TUTOR_INPUT` / `VOICE_TUTOR_CONFIG` 覆盖）；
   ffmpeg 候选改为按平台给：Windows 用 `%USERPROFILE%\tools\ffmpeg\bin\ffmpeg.exe` 和 PATH，
   macOS/Linux 用 Homebrew / `/usr/local/bin` / `/usr/bin` / PATH，仍可用 `VOICE_TUTOR_FFMPEG` 指定。

顺带：朗读实现由 `msedge-tts` 改为用 `ws` 直连 Edge TTS（纯 JS 依赖，安装时不触发构建授权），
功能不变；README 里新增本节与下方的兼容性说明。

### 0.1.0

首个公开版本：连续语音对话、自动断句、2 秒确认窗口、外接 API、Edge TTS 朗读与打断。

## 兼容性说明

- 需要 DSH 0.2.x；已在 0.2.2-rc.1 上验证（Windows 与 macOS 26.1 arm64）：启动无报错、麦克风按钮正常渲染。
- 客户端只依赖加载器内建的 `react`，不需要注入任何运行时包（`dsh.client.inject` 为 `[]`）。
- 宿主侧依赖 `ws`（纯 JS，无安装脚本）。
- 识别默认用 DSH 自带 SenseVoice；朗读走进程内 Edge TTS WebSocket，不需要额外服务。
- `ffmpeg` 只在收到非 WAV 音频时作为兜底转码，可以不装；路径与品牌无关，可用 `VOICE_TUTOR_FFMPEG` 覆盖。
- 配置与日志都落在 `~/.dsh/`，多平台一致；删除该目录下的 `voice-tutor-config.json` 即可恢复默认设置。

