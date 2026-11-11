# DSH 语音对话

[English](README.md) · [简体中文](README.zh-CN.md)

DeepSeek Harness 的**连续语音对话**插件：点一下麦克风，之后正常聊天就行。说话停顿会自动断句，
文字先进入输入框、2 秒后自动发送，助手的回复会被朗读；朗读时开口说话，它立刻停下来听你说。

> 点麦克风 → 说话 → 停顿自动断句 → 2 秒后自动发送 → 回复朗读出来 → 开口即打断。

## 主要功能

- **连续对话**：点一次进入，不用每句都按按钮
- **自动断句**：停顿约 1.2 秒就算说完
- **2 秒确认窗口**：文字先进输入框，不动自动发；按任意键或点一下即暂停，改完回车
- **识别纠错**：自动修正明显的识别错误（含长数字的句子跳过，避免改错号码、金额）
- **语音朗读**：按回复语言选音色；日语回复的假名注音在朗读前自动去掉，不念两遍
- **可打断**：朗读时开口说话，立刻停止播放并听你说
- **空闲退出**：10 秒没说话自动退出，不会一直占着麦克风
- **只念语音的回复**：打字发来的消息不会出声
- **口吃折叠**：说话打结时重复的字（来来来来）发送前自动收掉
- **短句更稳**：嗯 / 对 / 好的 这类很短的回答会按正确语言识别，不再被丢掉或识别成英文
- **界面跟随 DSH 语言**：插件自己的按钮和设置文案随宿主界面语言在中文 / English 之间切换
- **本地 Whisper 更新检查**：可选；自动检查 `faster-whisper` 包和本地模型是否有新版，并可在
  设置页里直接更新

## 要求

- DeepSeek Harness 0.2.x（桌面端 / Web）
- 默认配置不需要 Python、不需要 ffmpeg、不需要额外服务
- 朗读使用微软 Edge TTS，需要能访问 `speech.platform.bing.com`
- 可选：本机跑一个 Whisper 桥（`faster-whisper`），识别更准

## 安全说明

- 每个 /voice-tutor/* 路由都会先向 DSH 的 connection 服务要一次准入（equestRejection，与 DSH 自带路由同一道围栏）：跨站调用和 DNS 重绑定在任何处理逻辑之前就被拒掉，只有已登录的 DSH 会话能访问。
- API Key 只写不读：GET /voice-tutor/config 只回「是否已设置」，不回原文；设置页里可以显式清除。
- 外接接口只接受 http(s) 地址，保存非 http 的 URL 会被拒绝。
- 执行 Whisper / 模型更新，除了界面二次确认，还要求同会话下发的一次性 token（90 秒有效、只能用一次）。
- 设置（含 API Key）以明文存放在 ~/.dsh/voice-tutor-config.json，只有文件权限这一层保护；建议用可随时吊销的 key。
- 回复朗读走微软 Edge 浏览器的在线朗读端点（speech.platform.bing.com），回复文字会发给微软；它不是面向第三方的正式 API，端点和令牌变动时会失效。

## 安装

### 用发布包安装

1. 从 [Releases](https://github.com/QiNFPV/dsh-voice-dialog/releases) 下载
   `dsh-voice-dialog-0.1.3.tgz`。
2. 把文件放到一个固定位置（不要放 `/tmp` 或 `%TEMP%`），然后用 DSH 的插件管理器安装
   （设置 → 插件 → 从文件安装）。
3. 确认 profile 的 bundle 列表里有 `dsh-voice-dialog`，然后完全退出 DSH 再打开。

等价的命令行方式：

```bash
dsh plugin --profile desktop add /path/to/dsh-voice-dialog-0.1.3.tgz
```

然后把 `dsh-voice-dialog` 加入 profile 的 `dsh.profile.bundles`，重启 DSH。

### 手动复制

把 tgz 解压到 `~/.dsh/profiles/<profile>/node_modules/dsh-voice-dialog/`，重启 DSH。
不要把别的机器上的 `node_modules` 直接复制过来；需要时在插件目录里执行
`npm install --omit=dev`（运行时只依赖 `ws`）。

安装包里附带中英双语安装说明：[`安装说明.txt`](安装说明.txt)（中文）与
[`install-notes.en.txt`](install-notes.en.txt)（English）。

## 怎么用

1. 点输入框左侧的**麦克风**按钮，图标变红即进入语音模式。
2. 正常说话；停顿约 1.2 秒自动断句。
3. 识别文字进入输入框，2 秒后自动发送；这 2 秒内按任意键或点一下输入框即可暂停，
   改完按回车。
4. 回复会被朗读；朗读时开口说话可以打断。
5. 再点一次麦克风，或 10 秒不说话，退出语音模式。

输入框旁边的语言下拉只决定**朗读用哪种声音**；识别语言始终自动判定。

## 设置

**设置 → 插件 → 语音对话**

- **语言勾选**：决定下拉里出现哪些语言（默认 自动 / 中文 / English / 日本語）
- **显示全部音色（高级）**：可选更多 Edge 音色
- **识别结果自动纠错**：修正明显的错字；含长数字的句子跳过
- **外接接口（可选）**：填写 OpenAI 兼容的识别 / 合成地址与密钥，留空即用内置
- **口吃折叠**：说话打结时重复的字（来来来来）发送前自动收掉
- **短句更稳**：嗯 / 对 / 好的 这类很短的回答会按正确语言识别，不再被丢掉或识别成英文
- **界面跟随 DSH 语言**：插件自己的按钮和设置文案随宿主界面语言在中文 / English 之间切换
- **本地 Whisper 更新检查**：见下一节

## Whisper 自动更新检查

插件可以盯着本机的 Whisper 环境，有新版时提醒你。默认开启，且不会阻塞语音输入。

设置项：

| 项目 | 默认 | 说明 |
|---|---|---|
| 自动检查本地 Whisper 更新 | 开 | 打开 / 关闭定时检查 |
| 检查间隔 | 24 小时 | 可选 6 / 12 / 24 / 72 小时 |
| 立即检查 | — | 马上检查一次并刷新状态 |

状态区会显示上次检查时间、当前与最新的 `faster-whisper` 版本、模型本地与远程 revision、
模型体积、是否有更新。发现更新时，麦克风按钮旁边会出现一个小提示；点它可查看详情并执行更新
（需要二次确认）。

检查内容：

1. **`faster-whisper` 包**：从 `https://pypi.org/pypi/faster-whisper/json` 取最新版本，
   与桥 venv 里实际安装的版本比较。安装版本的检测顺序是：用 venv 里的 python 执行
   `import faster_whisper; print(faster_whisper.__version__)` → 读
   `site-packages/faster_whisper/__init__.py` → 读 `*.dist-info` 目录名 → 都失败则显示「未知」。
2. **模型 revision**：从 `https://huggingface.co/api/models/<repo>` 取远程 `sha`，与本地
   HuggingFace 缓存里的 `refs/main` 比较。缓存根目录遵循 `HF_HOME`、`HF_HUB_CACHE`、
   `HUGGINGFACE_HUB_CACHE`，默认 `~/.cache/huggingface/hub`。仓库默认
   `mobiuslabsgmbh/faster-whisper-large-v3-turbo`，可用 `ASR_MODEL_REPO` 覆盖；也会跟随
   `ASR_MODEL`（`large-v3-turbo`、`large-v3`、`small` 等）映射。

所有网络请求都在 8 秒内超时。离线或出错只更新状态文字，静默降级，不影响语音主流程。宿主启动
约 40 秒后做首次检查，之后按设定间隔检查。结果持久化在
`~/.dsh/voice-tutor-config.json` 的 `whisperUpdate` 字段里。

### 执行更新

只有你点了按钮**并且**在确认框里确认后才会执行。

- **`faster-whisper`**：执行 `<venv python> -m pip install -U faster-whisper`，重启本地 ASR
  桥，并等 `/health` 就绪。新版本起不来时，会尝试装回旧版本并再次重启。
- **模型**：确认框里显示大致下载体积，用 `huggingface_hub.snapshot_download` 下载新 revision，
  显示下载进度，完成后重启桥。旧缓存不会删除；新模型起不来时，会把 `refs/main` 指回旧 revision
  再重启一次。

重启桥时只针对真正监听 `127.0.0.1:8789` 的进程，并且会先确认它的命令行包含 `server.py` 才动
手。新进程用同样的命令行拉起（`<venv python> <asr-bridge>/server.py`）。桥是懒加载模型的，
所以插件会发一小段静音音频做热身，让 `/health` 变成就绪。

相关环境变量：`VOICE_TUTOR_PY`、`VOICE_TUTOR_ASR_SERVER`、`VOICE_TUTOR_ASR`、`ASR_MODEL`、
`ASR_MODEL_REPO`、`HF_HOME`、`HF_HUB_CACHE`、`HUGGINGFACE_HUB_CACHE`。

## 语音会话模式（注意事项）

用**语音对话**时（点麦克风进入的录音会话，或语音通话专属会话），助手的回复会被朗读，
因此那一轮回复会被压成极短的一两句：不列清单、不复述前文，只保留能听懂的核心信息。

这是**会话级**行为，不是插件 bug。如果你是在打字讨论（比如在语音会话里继续打字），这套简短
规则并不合适——建议新开一个普通会话，或在插件里关掉语音模式再继续聊。

## 常见问题

| 现象 | 处理 |
|---|---|
| 点了麦克风没反应 | 检查麦克风权限；按钮上会显示原因 |
| 识别为空 | 声音太小或太短；日志里看 `stt-ok text=` |
| 没念出来 | 这条是打字发的（设计如此）、语音模式已关，或合成失败 |
| 重复发送 | 不要同时开两个 DSH 窗口的语音模式 |
| Whisper 更新状态显示「未知」 | venv 路径或模型缓存不在插件预期的位置，用上面的环境变量指定 |
| 更新 `faster-whisper` 后启动失败 | 日志里会有 pip / 重启错误和回滚结果，按提示处理 |

日志：`~/.dsh/voice-tutor.log`（超过 2 MB 自动轮转为 `.log.1`）。最近一条消息的输入方式记录在
`~/.dsh/voice-tutor-last-input.json`。更细的说明见
[`docs/详细说明.md`](docs/详细说明.md)。

## 更新记录

### 0.1.3

- **新增：本地 Whisper 自动更新检查。** 设置 → 插件 → 语音对话里新增「自动检查本地 Whisper
  更新」开关（默认开启）、检查间隔（6/12/24/72 小时）、「立即检查」按钮，以及显示当前/最新
  `faster-whisper` 版本和模型本地/远程 revision 的状态区。有更新时麦克风旁边会出现小提示，
  更新需要二次确认，并会安全地重启 ASR 桥。
  新增宿主路由：`GET /voice-tutor/whisper-update`、`POST /voice-tutor/whisper-update/check`、
  `POST /voice-tutor/whisper-update/apply`。
- **完整包含 0.1.1 的全部启动修复**（见下）：客户端注册 id 与包名一致、`dsh.client.inject`
  为空、路径与 ffmpeg 候选跨平台。本版不会回退这些修复。
- 文档改为中英双语（英文 `README.md`、中文 `README.zh-CN.md`，另有中英详细说明与安装说明）。

### 0.1.1

启动修复版。**0.1.0 在任何平台装上都起不来**：整个 Web 前端 boot 失败
（`web boot: 1 entry did not activate`），并常伴随 `duplicate factory registration`。
原因是三处打包/启动问题：

1. **客户端注册 id 与包名不一致**（`client.js`）：0.1.0 用 `@local/dsh-voice-chat` 注册，
   而加载器按包名 `dsh-voice-dialog` 查找，于是报 `loaded without registering`。
   0.1.1 把注册 id 改为 `dsh-voice-dialog`，与包名、`cordis.patch.yml` 三处保持一致。
2. **注入了一个不存在的包**（`package.json` 的 `dsh.client.inject`）：
   `@deepseek-ai/dsh-client-runtime` 在 DSH 0.2.x 里没有对应包，客户端入口 import 直接失败。
   客户端实际只依赖加载器内建的 `react`，0.1.1 改为 `"inject": []`。
3. **Windows 绝对路径写死**（`index.js`）：日志、上次输入、配置文件路径写成
   `C:\Users\<用户名>\.dsh\...`，在 macOS/Linux 上会生成名字带反斜杠的怪文件、设置也写不进
   `~/.dsh`。0.1.1 统一用 `os.homedir()` + `path.join()` 得到 `~/.dsh/...`
   （可用 `DSH_HOME` 或 `VOICE_TUTOR_LOG` / `VOICE_TUTOR_INPUT` / `VOICE_TUTOR_CONFIG` 覆盖）；
   ffmpeg 候选改为按平台给：Windows 用 `%USERPROFILE%\tools\ffmpeg\bin\ffmpeg.exe` 和 PATH，
   macOS/Linux 用 Homebrew / `/usr/local/bin` / `/usr/bin` / PATH，仍可用 `VOICE_TUTOR_FFMPEG`
   指定。

顺带：朗读实现由 `msedge-tts` 改为用 `ws` 直连 Edge TTS（纯 JS 依赖，安装时不触发构建授权），
功能不变。

### 0.1.0

首个公开版本：连续语音对话、自动断句、2 秒确认窗口、外接 API、Edge TTS 朗读与打断。

## 兼容性说明

- 需要 DSH 0.2.x；已在 0.2.2-rc.1 上验证（Windows 与 macOS 26.1 arm64）。
- 客户端只依赖加载器内建的 `react`，不需要注入任何运行时包（`dsh.client.inject` 为 `[]`）。
- 宿主侧依赖 `ws`（纯 JS，无安装脚本）。
- 识别默认用 DSH 自带 SenseVoice；朗读走进程内 Edge TTS WebSocket，不需要额外服务。
- `ffmpeg` 只在收到非 WAV 音频时作为兜底转码，可以不装；可用 `VOICE_TUTOR_FFMPEG` 覆盖。
- 配置与日志都落在 `~/.dsh/`，多平台一致；删除该目录下的 `voice-tutor-config.json`
  即可恢复默认设置。

本地 Whisper 更新检查假定桥的目录结构是 `~/tools/fw/.venv` + `~/tools/asr-bridge/server.py`；
其它结构可用 `VOICE_TUTOR_PY` 和 `VOICE_TUTOR_ASR_SERVER` 指定。

## 许可证

MIT，见 [LICENSE](LICENSE)。

上游：<https://github.com/QiNFPV/dsh-voice-dialog>
