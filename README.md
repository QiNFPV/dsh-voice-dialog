# DSH Voice Dialog

[English](README.md) · [简体中文](README.zh-CN.md)

A **continuous voice conversation** plugin for DeepSeek Harness: click the microphone once, then
just talk. Your speech is segmented automatically, sent after a short confirmation window, and the
assistant's reply is spoken back. Start talking while it is speaking and it stops to listen.

> Click the mic → speak → a pause ends the sentence → auto-send after 2 seconds → reply is spoken →
> speak again to interrupt.

## Features

- **Continuous conversation** — one click to enter, no per-sentence button presses
- **Automatic segmentation** — 1.2 s of silence ends the current sentence
- **2-second confirmation window** — text appears in the composer first; press any key or click to
  pause sending, edit, then press Enter
- **Recognition cleanup** — obvious speech-recognition errors are fixed (sentences with long digit
  strings are skipped so phone numbers / amounts are not altered)
- **Spoken replies** — a voice is chosen for the reply language; Japanese kana annotations are
  stripped before speaking
- **Barge-in** — start speaking while the reply is playing and playback stops immediately
- **Idle exit** — leaves voice mode after 10 s without speech, so the microphone is not held open
- **Only voice-triggered replies are spoken** — messages you type stay silent
- **Stutter collapse** — repeated syllables from speaking hesitantly (来来来来) are collapsed before sending
- **Robust short utterances** — very short replies (嗯 / 对 / 好的) are recognised in the right language instead of being dropped or turned into English
- **UI language follows DSH** — the plugin's buttons and settings text switch between Chinese and English together with the host UI language
- **Local Whisper update check** — optional; watches `faster-whisper` and the local model for new
  versions and lets you update them from the settings page

## Requirements

- DeepSeek Harness 0.2.x (desktop/web)
- No Python, no ffmpeg and no separate service are required for the default setup
- Speech output uses Microsoft Edge TTS, so `speech.platform.bing.com` must be reachable
- Optional: a local Whisper bridge (`faster-whisper`) for better recognition accuracy

## Security

- Every /voice-tutor/* route asks the DSH connection service for admission first (equestRejection, same fence as DSH's own routes): cross-site calls and DNS rebinding are rejected before any handler runs, and only the authenticated DSH session gets through.
- API keys are write-only: GET /voice-tutor/config only reports whether a key is set, never its value. Keys are cleared explicitly from the settings page.
- External endpoints must be http(s); saving a non-http URL is refused.
- Applying a Whisper / model update requires a one-time token issued to the same session (valid for 90 seconds, single use) on top of the confirmation dialog.
- Settings — including any API key — are stored in plain text at ~/.dsh/voice-tutor-config.json; file permissions are the only protection. Prefer a key you can revoke.
- Reply speech is synthesised through Microsoft Edge's online reading endpoint (speech.platform.bing.com), so reply text is sent to Microsoft. This is not a formal third-party API; if the endpoint or its token changes, speech output stops working.

## Install

### From the release package

1. Download `dsh-voice-dialog-0.1.4.tgz` from
   [Releases](https://github.com/QiNFPV/dsh-voice-dialog/releases).
2. Put the file somewhere permanent (not `/tmp` or `%TEMP%`), then install it with the DSH plugin
   manager (`Settings → Plugins → Install from file`).
3. Make sure `dsh-voice-dialog` is listed in the profile's bundle list and fully restart DSH.

Command line equivalent:

```bash
dsh plugin --profile desktop add /path/to/dsh-voice-dialog-0.1.4.tgz
```

Then add `dsh-voice-dialog` to `dsh.profile.bundles` in the profile and restart DSH.

### Manual copy

Unpack the tgz into `~/.dsh/profiles/<profile>/node_modules/dsh-voice-dialog/` and restart DSH.
Do not copy `node_modules` from another machine; install dependencies with `npm install --omit=dev`
inside the plugin directory if needed (`ws` is the only runtime dependency).

Bilingual install notes are included in the package: [`安装说明.txt`](安装说明.txt) (Chinese) and
[`install-notes.en.txt`](install-notes.en.txt) (English).

## Usage

1. Click the **microphone** button to the left of the composer; it turns red when voice mode is on.
2. Speak normally. A pause of about 1.2 s ends the sentence.
3. The recognized text is placed in the composer and sent automatically after 2 s. Press any key or
   click the composer to pause that timer, edit the text, then press Enter.
4. The reply is spoken. Speak while it is playing to interrupt it.
5. Click the microphone again, or stay silent for 10 s, to leave voice mode.

The language dropdown next to the microphone only selects the **voice used for speaking**.
Recognition always detects the language automatically.

## Settings

**Settings → Plugins → Voice Dialog**

- **Languages in the picker** — which languages appear in the dropdown (Auto / Chinese / English /
  Japanese by default)
- **Show all voices (advanced)** — expose every available Edge voice
- **Auto-correct recognition** — fix obvious errors; sentences with long digit strings are skipped
- **External APIs (optional)** — OpenAI-compatible speech-to-text / text-to-speech endpoints and
  keys; leave empty to use the built-in backends
- **Stutter collapse** — repeated syllables from speaking hesitantly (来来来来) are collapsed before sending
- **Robust short utterances** — very short replies (嗯 / 对 / 好的) are recognised in the right language instead of being dropped or turned into English
- **UI language follows DSH** — the plugin's buttons and settings text switch between Chinese and English together with the host UI language
- **Local Whisper update check** — see below

## Whisper auto-update check

The plugin can watch the local Whisper stack and tell you when something new is available. It is
enabled by default and never blocks voice input.

Settings:

| Item | Default | Meaning |
|---|---|---|
| Auto-check local Whisper updates | On | Turn the periodic check on/off |
| Check interval | 24 hours | 6 / 12 / 24 / 72 hours |
| Check now | — | Runs a check immediately and refreshes the status |

The status block shows the last check time, the installed and latest `faster-whisper` versions,
the local and remote model revisions, the model size, and whether an update exists. When an update
is found, a small badge appears next to the microphone button; click it to inspect details and run
the update (a second confirmation is required).

What is checked:

1. **`faster-whisper` package** — latest version from
   `https://pypi.org/pypi/faster-whisper/json` compared with the version actually installed in the
   bridge virtualenv. The installed version is read by running the venv Python
   (`import faster_whisper; print(faster_whisper.__version__)`); if that fails, the plugin falls
   back to `site-packages/faster_whisper/__init__.py` or the `*.dist-info` directory name, and
   finally reports "unknown".
2. **Model revision** — remote `sha` from
   `https://huggingface.co/api/models/<repo>` compared with the local `refs/main` under the
   HuggingFace hub cache. The cache root honours `HF_HOME`, `HF_HUB_CACHE`,
   `HUGGINGFACE_HUB_CACHE` and defaults to `~/.cache/huggingface/hub`. The repository defaults to
   `mobiuslabsgmbh/faster-whisper-large-v3-turbo` and can be overridden with `ASR_MODEL_REPO`; the
   mapping also follows `ASR_MODEL` (`large-v3-turbo`, `large-v3`, `small`, …).

All network calls time out within 8 seconds. Offline or failing checks are silent and only update
the status text; the voice pipeline is unaffected. The first automatic check runs about 40 seconds
after the host starts, then at the configured interval. Results are persisted in
`~/.dsh/voice-tutor-config.json` under `whisperUpdate`.

### Applying an update

Updates only run after you click the button **and** confirm the dialog.

- **`faster-whisper`**: runs `<venv python> -m pip install -U faster-whisper`, restarts the local
  ASR bridge, and waits for `/health` to become ready. If the new version cannot start, the plugin
  tries to reinstall the previous version and restart again.
- **Model**: asks for confirmation showing the approximate download size, downloads the new
  revision with `huggingface_hub.snapshot_download`, shows progress, then restarts the bridge. Old
  cache snapshots are never deleted; if the new model cannot start, `refs/main` is pointed back to
  the previous revision and the bridge is restarted again.

The bridge restart only targets the process actually listening on `127.0.0.1:8789`; the plugin
verifies that its command line contains `server.py` before killing anything. The new process is
started with the same command (`<venv python> <asr-bridge>/server.py`). The model is loaded lazily
by the bridge, so the plugin sends a short silent warm-up request to make `/health` report ready.

Relevant environment variables: `VOICE_TUTOR_PY`, `VOICE_TUTOR_ASR_SERVER`, `VOICE_TUTOR_ASR`,
`ASR_MODEL`, `ASR_MODEL_REPO`, `HF_HOME`, `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE`.

## Voice session behavior

In a **voice conversation session** — the recording session entered with the microphone button, or
a dedicated voice-call session — the assistant's replies are read aloud. To keep spoken turns
listenable, replies in that session are deliberately compressed into one or two very short
sentences; they do not contain bullet lists and do not repeat what has already been said.

This is **session-level behaviour, not a plugin bug**. If you are discussing something by typing
(in the same session as a voice call, or while a voice session is active), this short-reply mode is
not a good fit: start a new ordinary chat session, or turn voice mode off in the plugin before you
continue the discussion.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Clicking the mic does nothing | Check microphone permission; the button shows the reason |
| Empty transcription | Speak louder / a bit longer; check `stt-ok text=` in the log |
| No spoken reply | The message was typed (by design), voice mode is off, or TTS failed |
| Duplicate messages | Do not run voice mode in two DSH windows at the same time |
| "Whisper update" status says unknown | The venv path or the model cache is not where the plugin expects; set the env vars above |
| Update fails after installing `faster-whisper` | The bridge may not start; the log contains the pip/restart error and any rollback result |

Logs: `~/.dsh/voice-tutor.log` (rotated to `.log.1` at 2 MB). The last input mode is recorded in
`~/.dsh/voice-tutor-last-input.json`. Detailed notes are in
[`docs/detailed-guide.en.md`](docs/detailed-guide.en.md).

## Changelog

### 0.1.4

- **Security: every /voice-tutor/* route now checks admission first.** Each request asks the DSH
  connection service for a rejection (equestRejection): the Host/Origin fence and the logged-in
  session are enforced before any handler runs, and the plugin fails closed (503) if the service is
  unavailable. Cross-site calls and DNS rebinding no longer reach config, STT, TTS or the update job.
- **API keys are write-only.** GET /voice-tutor/config returns keySet flags instead of key values;
  saving with an empty key keeps the stored one, and the settings page has an explicit *Clear key*
  button. External endpoint URLs are restricted to http(s).
- **Update confirmation is single-use.** GET /voice-tutor/whisper-update issues a token valid for
  90 seconds and one pply call; POST /voice-tutor/whisper-update/apply requires it on top of
  confirm: true. A bare confirm can no longer run pip install and restart the bridge.
- A **Security** section above documents the trust model, the plaintext settings file, and the Edge
  TTS disclosure.

### 0.1.3

- **New: local Whisper auto-update check.** Settings → Plugins → Voice Dialog now has an
  "Auto-check local Whisper updates" switch (on by default), an interval (6/12/24/72 hours), a
  "Check now" button, and a status block showing the installed/latest `faster-whisper` version and
  the local/remote model revision. When an update exists, a small badge appears next to the
  microphone; updates require a second confirmation and restart the ASR bridge safely.
  New host routes: `GET /voice-tutor/whisper-update`, `POST /voice-tutor/whisper-update/check`,
  `POST /voice-tutor/whisper-update/apply`.
- **Includes all 0.1.1 startup fixes** (see below): client registration id matches the package name,
  `dsh.client.inject` is empty, and paths / ffmpeg candidates are cross-platform. This release does
  not regress any of them.
- Documentation is now bilingual (English `README.md`, Chinese `README.zh-CN.md`, plus English and
  Chinese detailed guides and install notes).

### 0.1.1

Startup fix. **0.1.0 could not start on any platform**: the whole web front-end failed to boot
(`web boot: 1 entry did not activate`), often together with `duplicate factory registration`.
Three packaging/boot problems were fixed:

1. **Client registration id did not match the package name** (`client.js`): 0.1.0 registered
   `@local/dsh-voice-chat` while the loader looked up `dsh-voice-dialog`, producing
   `loaded without registering`. 0.1.1 registers `dsh-voice-dialog`, matching the package name and
   `cordis.patch.yml`.
2. **A non-existent package was injected** (`package.json` → `dsh.client.inject`):
   `@deepseek-ai/dsh-client-runtime` does not exist in DSH 0.2.x, so the client entry import failed.
   The client only needs the loader's built-in `react`; `inject` is now `[]`.
3. **Windows absolute paths were hard-coded** (`index.js`): logs, last-input and config paths were
   written as `C:\Users\<user>\.dsh\...`, which produced malformed filenames and unreadable settings
   on macOS/Linux. 0.1.1 uses `os.homedir()` + `path.join()` (`DSH_HOME`, `VOICE_TUTOR_LOG`,
   `VOICE_TUTOR_INPUT`, `VOICE_TUTOR_CONFIG` can override), and selects ffmpeg candidates per
   platform (`%USERPROFILE%\tools\ffmpeg\bin\ffmpeg.exe` and PATH on Windows; Homebrew /
   `/usr/local/bin` / `/usr/bin` / PATH elsewhere).

Also: speech output switched from `msedge-tts` to a direct Edge TTS WebSocket implementation using
`ws` (pure JS, no install script), with identical behaviour.

### 0.1.0

First public release: continuous voice conversation, automatic segmentation, 2-second confirmation
window, external APIs, Edge TTS output and barge-in.

## Compatibility

- Requires DSH 0.2.x; validated on 0.2.2-rc.1 (Windows and macOS 26.1 arm64).
- The client only depends on the loader's built-in `react`; `dsh.client.inject` is `[]`.
- The host depends on `ws` (pure JS, no install script).
- Default recognition uses DSH's built-in SenseVoice; speech output uses in-process Edge TTS and
  needs no extra service.
- `ffmpeg` is only a fallback for non-WAV audio and is optional; override it with
  `VOICE_TUTOR_FFMPEG`.
- Config and logs live in `~/.dsh/`; delete `voice-tutor-config.json` there to reset settings.

The local Whisper update checker assumes the bridge layout described above
(`~/tools/fw/.venv` + `~/tools/asr-bridge/server.py`). Different layouts work by setting
`VOICE_TUTOR_PY` and `VOICE_TUTOR_ASR_SERVER`.

## License

MIT. See [LICENSE](LICENSE).

Upstream: <https://github.com/QiNFPV/dsh-voice-dialog>
