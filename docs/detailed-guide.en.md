# Detailed guide

The README explains how to use the plugin; this document covers implementation details, external
APIs, update checking and troubleshooting.

## Workflow

```
Microphone (VAD) → MediaRecorder → decodeAudioData → 16k WAV
        → POST /voice-tutor/stt
        → Whisper / external API / DSH built-in SenseVoice
        → text into the composer (2 s window) → auto-send or edit
        → host listens for assistant/message → speech is synthesized and queued
        → the client polls for audio and plays it → barge-in is allowed meanwhile
```

Host routes: `/voice-tutor/stt`, `/voice-tutor/correct`, `/voice-tutor/arm`,
`/voice-tutor/audio`, `/voice-tutor/voices`, `/voice-tutor/config`,
`/voice-tutor/whisper-update`, `/voice-tutor/whisper-update/check`,
`/voice-tutor/whisper-update/apply`, `/voice-tutor/open`, `/voice-tutor/debug`.

## Voice session behaviour

In a voice conversation session — the recording session entered with the microphone button, or a
dedicated voice-call session — the assistant's replies are read aloud. To keep a spoken turn
natural, replies in that session are compressed into one or two very short sentences: no bullet
lists, no restating what was already said, only the core information that is useful when heard.
Menus, long code blocks and tables are poor candidates for speech and are treated the same way.

This is **session-level behaviour, not a plugin bug**: the plugin only reads the reply that the
session produced. If you are discussing something by typing, those short replies feel too terse.
Start a new ordinary chat session, or leave voice mode in the plugin before continuing to type.
Switching from speech to typing inside the same session does not automatically return the session
to the normal, detailed reply style.

## Recognition backends

Tried in order; each failure falls back to the next:

1. **External API** (enabled only when a URL is configured) — OpenAI-compatible `POST {url}` with
   multipart fields `file` + `model`, returning `{"text": "..."}`.
   Works with OpenAI, Groq, SiliconFlow, Azure OpenAI and self-hosted gateways.
2. **Local Whisper bridge** — `http://127.0.0.1:8789/v1/audio/transcriptions` (optional)
3. **DSH built-in SenseVoice** — default, no configuration needed

## Speech backends

1. **External API** (enabled only when a URL is configured) — OpenAI-compatible `POST {url}` with
   JSON `{model, input, voice}`, returning audio bytes. Works with OpenAI, SiliconFlow, Azure
   OpenAI and similar services.
2. **Built-in Edge TTS** — the plugin connects to the Edge TTS WebSocket directly with `ws`, ships
   common voices (and can build the language/voice list from the voice catalog), and needs no
   external process.
3. An external TTS bridge if one is running on this machine.

External settings are stored in `~/.dsh/voice-tutor-config.json`. Providers with a different request
shape (ElevenLabs, Google Cloud TTS, …) require changing `ttsExternal()` in `index.js`.

## Correction

After transcription, the text is passed through a DSH-hosted model that only fixes recognition
mistakes: homophones, dropped characters, obvious casing/punctuation. It does not rephrase,
expand or translate. Sentences containing six or more consecutive digits are skipped entirely so
phone numbers, amounts and IDs are not altered. Correction runs in parallel with the 2-second
confirmation window and adds no extra waiting time.

## Audio format

The browser decodes the recording with `decodeAudioData`, resamples it to 16 kHz, converts it to
16-bit PCM WAV and uploads that — **ffmpeg is not required**. If an older client sends webm and
ffmpeg is available, the host converts it as a compatibility fallback.

## Voices

- 13 built-in Edge voices (Chinese / English / Japanese / Korean / French / German / Spanish /
  Italian / Portuguese / Russian)
- `voice: "auto"` picks a voice based on the reply's main language
- Japanese kanji annotations such as `写真（しゃしん）` are stripped before speaking so they are not
  read twice

## Local Whisper update check

The host-side logic lives in `whisper-update.mjs` and uses only Node built-ins; no new dependency
is added.

Two things are checked:

1. **`faster-whisper` package** — `GET https://pypi.org/pypi/faster-whisper/json` provides
   `info.version`, compared with what is actually installed in the bridge virtualenv. The installed
   version is detected by running the venv Python with
   `import faster_whisper;print(faster_whisper.__version__)`; on failure it falls back to reading
   `site-packages/faster_whisper/__init__.py`, then a `faster_whisper-*.dist-info` directory name,
   and finally reports "unknown" without failing the check.
2. **Model revision** — `GET https://huggingface.co/api/models/<repo>?blobs=true` provides the
   remote `sha` (and the summed `siblings.size` as the model size), compared with `refs/main` in
   the local HuggingFace cache. The cache root is resolved as `HF_HUB_CACHE` →
   `HUGGINGFACE_HUB_CACHE` → `HF_HOME/hub` → `~/.cache/huggingface/hub`. The repository can be set
   with `ASR_MODEL_REPO`; otherwise it is derived from `ASR_MODEL` (default `large-v3-turbo`),
   matching `server.py`.

All network requests time out after 8 seconds and a check completes in roughly 8 seconds or less.
When offline or when an endpoint fails, the error is only recorded in the `errors` array and voice
input is unaffected. Results are persisted in `~/.dsh/voice-tutor-config.json` under `whisperUpdate`:
`{ enabled, intervalHours, lastCheckAt, lastResult }`. The host runs the first check 40 seconds after
`apply()`, then schedules subsequent checks with a chained `setTimeout`; saving settings reschedules
the timer.

Update actions run only after the user clicks the button and confirms the dialog:

- **faster-whisper** — runs `<venv python> -m pip install -U faster-whisper`, then restarts the
  bridge and waits for `/health` to be ready. If it cannot start, the plugin tries
  `pip install faster-whisper==<previous>` and restarts again; the failure message includes the
  rollback result.
- **Model** — uses
  `huggingface_hub.snapshot_download(repo_id, revision, cache_dir)` to download into the existing
  cache (old snapshots are not deleted). `PROGRESS` lines on stdout are converted into a percentage.
  After download, `refs/main` is verified to point at the new revision, then the bridge is
  restarted. If it cannot start, `refs/main` is written back to the previous revision and the
  bridge is restarted again.

Restarting the bridge only touches the process listening on `127.0.0.1:8789`: the PID is found with
`Get-NetTCPConnection` (Windows) or `lsof` (macOS/Linux), then its command line is checked to
contain `server.py`; otherwise the plugin refuses to act and kills nothing. The listening process is
stopped and a new one is launched with the same command line. The plugin then sends a short silent
WAV as a warm-up: the bridge loads the model lazily, and `/health.ok` only becomes true after the
model is actually loaded, so the warm-up makes the post-update health check meaningful.

## Logs and troubleshooting

- Log: `~/.dsh/voice-tutor.log` (rotated to `.log.1` at 2 MB)
- Last input mode: `~/.dsh/voice-tutor-last-input.json`

| Symptom | Cause |
|---|---|
| Empty transcription | Too quiet / too short; `stt-ok text=` is empty in the log |
| A stray "You" appears | Whisper silence hallucination; filtered already |
| No spoken reply | Typed input (by design), voice mode off, or synthesis failure (`tts-local-fail`) |
| Playback stops midway | Barge-in decided you started speaking; threshold is `BARGE_MIN_RMS` in `client.js` |
| Duplicate sends | Two windows open; the host deduplicates by protocol version and session |

## Known limitations

- Japanese short kanji-only phrases (e.g. 「東京駅」) may be detected as Chinese in auto mode
- Only Edge TTS is built in; other vendors require changing the request shape
- Host code changes require a DSH restart (Node module cache); client code hot-reloads
- Accuracy depends on the backend: Whisper large-v3-turbo ≫ SenseVoice-Small
- A model update re-downloads about 1.5 GB (large-v3-turbo) and briefly interrupts recognition;
  failed downloads never delete the old cache
- Automatic bridge restart assumes the default port 8789 and `server.py` layout; use the environment
  variables for different layouts
- Updating `faster-whisper` may also upgrade `ctranslate2` and other dependencies; rollback only
  restores the package version, not the whole dependency tree
