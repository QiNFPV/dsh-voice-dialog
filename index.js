// Host half
//  - POST /voice-tutor/stt      浏览器录音 → ffmpeg → 16k 单声道 WAV → 本地 SenseVoice 转写
//  - POST /voice-tutor/arm      语音模式开关，记录当前要朗读的会话
//  - GET  /voice-tutor/audio    前端轮询取待播音频（拿到即清空）
import { promises as fs } from 'node:fs';
import { existsSync, statSync, renameSync } from 'node:fs';
import { synthesize as ttsLocal, catalog as ttsCatalog, available as ttsAvailable } from './tts.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ffmpeg 只作为兼容兜底：新版客户端直接送 16k WAV，不需要它。
function resolveFfmpeg() {
  if (process.env.VOICE_TUTOR_FFMPEG) return process.env.VOICE_TUTOR_FFMPEG;
  const cands = [
    'C:\\Users\\QiNPC\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg.exe', 'ffmpeg',
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
  ];
  for (const c of cands) {
    try {
      if (c.includes('/') || c.includes('\\')) {
        if (existsSync(c)) return c;
      } else return c;   // 交给 PATH
    } catch { /* ignore */ }
  }
  return '';
}
const FFMPEG = resolveFfmpeg();
const TTS_BRIDGE = process.env.VOICE_TUTOR_TTS || 'http://127.0.0.1:8788/v1/audio/speech';
const ASR_URL = process.env.VOICE_TUTOR_ASR || 'http://127.0.0.1:8789/v1/audio/transcriptions';
const ASR_HEALTH = ASR_URL.replace(/\/v1\/audio\/transcriptions$/, '/health');

const LOG = process.env.VOICE_TUTOR_LOG || 'C:\\Users\\QiNPC\\.dsh\\voice-tutor.log';
const INPUT_FILE = process.env.VOICE_TUTOR_INPUT || 'C:\\Users\\QiNPC\\.dsh\\voice-tutor-last-input.json';
const CONFIG_FILE = process.env.VOICE_TUTOR_CONFIG || 'C:\\Users\\QiNPC\\.dsh\\voice-tutor-config.json';

// 外接接口配置（OpenAI 兼容）。空 url 表示不用外接。
const defaultConfig = () => ({
  asr: { url: '', key: '', model: '' },      // POST {url}，multipart 字段 file + model
  tts: { url: '', key: '', model: '', voice: '' },  // POST {url}，JSON {model, input, voice}
});
let config = defaultConfig();
const log = (...args) => {
  const line = new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n';
  fs.appendFile(LOG, line).catch(() => {});
};

// 日志超过 2MB 就轮转一份，避免无限增长
try {
  if (existsSync(LOG) && statSync(LOG).size > 2 * 1024 * 1024) renameSync(LOG, LOG + '.1');
} catch { /* ignore */ }

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    const j = JSON.parse(raw);
    config = { ...defaultConfig(), ...j };
    config.asr = { ...defaultConfig().asr, ...(j.asr || {}) };
    config.tts = { ...defaultConfig().tts, ...(j.tts || {}) };
  } catch { /* 没配置文件就用默认 */ }
}
const saveConfig = async () => {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
};

// 外接 ASR：OpenAI 兼容 /v1/audio/transcriptions（multipart）
async function transcribeExternal(wav) {
  const { url, key, model } = config.asr;
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  if (model) fd.append('model', model);
  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(url, { method: 'POST', headers, body: fd, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('外部识别 ' + r.status);
  const d = await r.json();
  return String(d.text || d.result || '').trim();
}

// 外接 TTS：OpenAI 兼容 /v1/audio/speech（JSON）
async function ttsExternal(text, voice) {
  const { url, key, model } = config.tts;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'tts-1',
      input: text,
      voice: (voice && voice !== 'auto' ? voice : config.tts.voice) || 'alloy',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('外部合成 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

let asrOkAt = 0;
let asrOk = false;
async function whisperAvailable() {
  if (Date.now() - asrOkAt < 30000) return asrOk;
  try {
    const r = await fetch(ASR_HEALTH, { signal: AbortSignal.timeout(1500) });
    asrOk = r.ok;
  } catch { asrOk = false; }
  asrOkAt = Date.now();
  return asrOk;
}

async function transcribeWhisper(wav, lang) {
  const r = await fetch(ASR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: wav.toString('base64'),
      language: lang && lang !== 'auto' ? lang : undefined,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error('whisper ' + r.status);
  return await r.json();
}

// ---- 识别结果纠错：只用 DSH 自带的模型，不依赖任何外部密钥 ----
const CORRECT_PROVIDER = process.env.VOICE_TUTOR_CORRECT_PROVIDER || 'deepseek-account';
const CORRECT_DSH_MODEL = process.env.VOICE_TUTOR_CORRECT_DSH_MODEL || 'deepseek-flash';

const CORRECT_SYS = '你是语音识别结果的后处理器。只修正识别错误（同音字、漏字、断词、明显的大小写/标点问题），'
  + '保持说话人的原话、原语气、原用词，不要润色、不要扩写、不要翻译、不要解释。'
  + '如果原文没有明显错误，原样返回。只输出修正后的文本本身，不要引号、不要前缀。';

const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thanks', 'thank you.', 'bye', 'bye.', 'okay', 'ok',
  '字幕', '谢谢观看', '谢谢大家', '请不吝点赞', '订阅', '转发', '打赏支持明镜与点点栏目',
  '字幕由amara.org社区提供', 'ご視聴ありがとうございました', 'チャンネル登録',
]);

// Whisper 在静音/噪声上会凭空造词，这些整句丢掉
function looksHallucinated(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.,!?。，！？\s]/g, '');
  if (!t) return true;
  if (t.length <= 1) return true;
  return HALLUCINATIONS.has(t);
}

let llmService = null;   // 由 apply() 注入

async function correctViaDsh(text) {
  if (!llmService) return '';
  let out = '';
  const stream = llmService.stream({
    provider: CORRECT_PROVIDER,
    model: CORRECT_DSH_MODEL,
    system: CORRECT_SYS,
    temperature: 0,
    maxTokens: 400,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    signal: AbortSignal.timeout(8000),
  });
  for await (const ch of stream) {
    if (ch && ch.type === 'text-delta') out += ch.text;
    if (ch && ch.type === 'finish') {
      if (ch.reason && ch.reason.kind !== 'stop') log('correct-finish', ch.reason.kind, JSON.stringify(ch.reason).slice(0, 160));
      break;
    }
  }
  if (!out) log('correct-empty');
  return out.trim();
}

async function correctText(text) {
  if (!text || text.length < 2) return text;
  // 数字、编号、金额这类内容纠错风险高（模型可能把数字改掉），整句跳过
  if (/\d[\d\s\-—–.]{5,}\d/.test(text)) return text;
  try {
    const fixed = await correctViaDsh(text);
    if (!fixed) return text;
    return fixed.replace(/^["'「『]|["'」』]$/g, '').split('\n')[0].trim() || text;
  } catch (e) {
    log('correct-fail', String(e && e.message || e));
    return text;
  }
}

// 只取裸 PCM，再手写最小 WAV 头：ffmpeg 默认会加 LIST/INFO 块，严格解析器会判非法。
function toPcm(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      outputPath,
    ], { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
  });
}

function wrapWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/** 只取可见的助手正文，绝不把 reasoning/thinking 念出来 */
function extractText(data) {
  const m = (data && (data.message || data)) || null;
  if (!m) return '';
  const c = m.content !== undefined ? m.content : m.text;
  if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim();
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && typeof b.text === 'string' && (b.type === 'text' || b.type === undefined))
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

/** 判断一段文本的主语言，用于「跟随用户所说的话」选音色 */
function dominantLang(t) {
  const s = String(t || '');
  const ja = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const ko = (s.match(/[\uac00-\ud7af]/g) || []).length;
  const en = (s.match(/[A-Za-z]/g) || []).length;
  if (ja >= 2 && ja >= zh * 0.25) return 'ja';
  if (ko > zh && ko > 0) return 'ko';
  if (zh > 0 && zh >= en * 0.4) return 'zh';
  if (en > 0) return 'en';
  return 'auto';
}

export const inject = ['webServer', 'llm'];

export function apply(ctx) {
  const web = ctx.get('webServer');
  const speech = ctx.get('speechToText');
  llmService = ctx.get('llm') || null;
  loadConfig().catch(() => {});
  if (!web) return;

  log('apply', 'llm=', !!llmService, 'web=', !!web, 'speech=', !!speech);

  let armedSession = null;
  let armedAt = 0;
  let armedUntil = 0;       // 心跳过期时间：客户端每 5s 续一次，15s 没续就失效
  let armedLang = 'auto';   // auto | zh | en | ja
  let lastSttNorm = '';
  let lastSttAt = 0;
  let voicedAt = 0;         // 最近一次「语音输入」的时间；只有它之后的回复才朗读
  let lastSpoken = '';
  let pending = null;      // { id, buf }
  let seq = 0;
  const seenTypes = new Set();
  let seenSilent = false;

  const synth = async (text, lang) => {
    const voice = lang && lang !== 'auto' ? lang : 'auto';
    // 1) 设置里填的外接 TTS
    if (config.tts.url) {
      try { return await ttsExternal(text, voice); }
      catch (e) { log('tts-external-fail', String(e && e.message || e)); }
    }
    // 2) 内置 Edge TTS（无外部进程）
    try {
      if (await ttsAvailable()) {
        const r = await ttsLocal(text, voice);
        return r.buf;
      }
    } catch (e) {
      log('tts-local-fail', String(e && e.message || e));
    }
    const res = await fetch(TTS_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('TTS ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  };

  // 我这条回复说完 → 合成音频排队
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session && (session.id || session.sessionId);
      const type = event && event.type;
      if (process.env.VOICE_TUTOR_DEBUG === '1' && type && !seenTypes.has(type)) {
        seenTypes.add(type);
        log('event-type-seen', type, 'sid=', sid, 'armed=', armedSession);
      }
      if (!armedSession) return;
      if (Date.now() > armedUntil) { armedSession = null; log('arm-expired'); return; }
      if (String(sid) !== String(armedSession)) {
        log('skip-wrong-session', 'event-sid=', sid, 'armed=', armedSession, 'type=', type);
        return;
      }
      if (type === 'user/message') {
        const kind = (lastSttAt && Date.now() - lastSttAt < 5000) ? 'voice' : 'text';
        if (kind === 'text') voicedAt = 0;   // 打字消息：不许朗读回复
        const said = extractText(event.data).slice(0, 300);
        fs.writeFile(INPUT_FILE, JSON.stringify({
          kind, at: new Date().toISOString(), text: said,
        }, null, 2)).catch(() => {});
        log('input-kind', kind, said.slice(0, 24));
        return;
      }
      if (type !== 'assistant/message') return;
      // 只有「语音输入之后」的回复才朗读：键盘打字时不发声
      if (!voicedAt || Date.now() - voicedAt > 60000) {
        if (!seenSilent) { seenSilent = true; log('skip-not-voice'); }
        return;
      }      // 只念新发生的回复：会话重放历史事件时，旧消息一律跳过
      const rawT = event.data && (event.data.time ?? event.data.at ?? event.data.timestamp);
      let ms = NaN;
      if (typeof rawT === 'number') ms = rawT < 1e12 ? rawT * 1000 : rawT;
      else if (typeof rawT === 'string') ms = Date.parse(rawT);
      if (Number.isFinite(ms) && armedAt && ms < armedAt - 2000) {
        log('skip-old', 'eventT=', ms, 'armedAt=', armedAt);
        return;
      }
      const text = extractText(event.data).slice(0, 600);
      if (text && text === lastSpoken) { log('skip-dup'); return; }
      lastSpoken = text;
      log('assistant-event', 'len=', text.length, 'head=', text.slice(0, 40));
      if (!text || text.length < 2) {
        try {
          const m = (event.data && (event.data.message || event.data)) || {};
          const blocks = Array.isArray(m.content) ? m.content.map((b) => b && b.type).join(',') : typeof m.content;
          log('skip-empty', 'blocks=', blocks);
        } catch { log('skip-empty'); }
        return;
      }
      setImmediate(async () => {
        try {
          // 用「回复本身的文字」决定音色：回中文就中文音色，回英文就英文音色。
          // （之前跟随用户说话语言，导致中文回复被英文音色念成乱码）
          const voice = armedLang !== 'auto' ? armedLang : 'auto';
          log('synth-begin', 'len=', text.length, 'voice=', voice);
          const buf = await synth(text, voice);
          voicedAt = 0;            // 每条语音输入只朗读一次回复
          seq += 1;
          pending = { id: seq, buf };
          log('synth-ok', 'bytes=', buf.length, 'id=', seq);
        } catch (e) {
          log('synth-fail', String(e && e.message || e));
        }
      });
    } catch (e) {
      log('handler-error', String(e && e.message || e));
    }
  });

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/voice-tutor/stt') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-tutor-'));
      const inPath = path.join(tmpDir, randomUUID() + '.bin');
      const pcmPath = path.join(tmpDir, randomUUID() + '.pcm');
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw.toString('utf8')); } catch { /* 空 body */ }
        if (!(Number(body.v) >= 3)) {
          log('ignore-legacy-stt');
          return json(res, 409, { error: 'legacy-client', text: '' });
        }
        const b64 = String(body.audio || '').replace(/^data:[^,]*,/, '');
        if (!b64) return json(res, 400, { error: 'missing audio' });
        if (body.sessionId) {
          armedSession = String(body.sessionId);
          armedAt = Date.now();
          armedUntil = Date.now() + 15000;
          if (body.lang) armedLang = String(body.lang);
          log('auto-arm', armedSession, 'lang=', armedLang);
        }
        const rawAudio = Buffer.from(b64, 'base64');
        let wav;
        if (rawAudio.length > 12 && rawAudio.toString('ascii', 0, 4) === 'RIFF') {
          wav = rawAudio;                       // 新版客户端直接给 16k WAV，不需要 ffmpeg
        } else {
          if (!FFMPEG) return json(res, 400, { error: '需要 WAV 音频（本机未找到 ffmpeg）' });
          await fs.writeFile(inPath, rawAudio);
          await toPcm(inPath, pcmPath);
          wav = wrapWav(await fs.readFile(pcmPath));
        }
        const t0 = Date.now();
        // 识别一律自动判定语言；下拉里选的音色只用于朗读。
        // （之前按所选音色强制识别语言，选日语后说中文会被硬解成日语）
        const sttLang = 'auto';
        let spec;
        let langUsed = 'auto';
        let text = '';
        let engine = 'dsh';
        if (config.asr.url) {
          try {
            text = await transcribeExternal(wav);
            engine = 'external';
          } catch (e) {
            log('asr-external-fail', String(e && e.message || e));
          }
        }
        if (!text && await whisperAvailable()) {
          try {
            const w = await transcribeWhisper(wav, sttLang);
            text = String(w.text || '').trim();
            langUsed = w.language || sttLang;
            engine = 'whisper';
          } catch (e) {
            log('whisper-fail', String(e && e.message || e));
          }
        }
        if (!text) {
          if (sttLang !== 'auto') {
            try {
              spec = speech.resolve({ audio: wav, language: sttLang });
              langUsed = sttLang;
            } catch {
              spec = speech.resolve({ audio: wav });
            }
          } else {
            spec = speech.resolve({ audio: wav });
          }
          const t = await speech.transcribe(spec, AbortSignal.timeout(120000));
          text = String(t.text || '');
          engine = 'dsh';
        }
        const spoken = dominantLang(text);
        if (looksHallucinated(text)) {
          log('stt-hallucination', JSON.stringify(String(text).slice(0, 24)));
          return json(res, 200, { v: 3, text: '', spoken: 'auto', lang: 'auto', engine });
        }

        // 总闸：同一句话 8 秒内只放行一次（挡住多客户端/重复片段）
        const norm = String(text || '').toLowerCase().replace(/[\s.,!?。，！？'’]/g, '');
        const nowMs = Date.now();
        if (norm && norm === lastSttNorm && nowMs - lastSttAt < 8000) {
          log('stt-dup', 'text=', String(text).slice(0, 30));
          return json(res, 200, { text: '', dup: true, spoken, lang: langUsed });
        }
        if (norm) {
          lastSttNorm = norm; lastSttAt = nowMs;
          voicedAt = Date.now();     // 这句是语音输入：下一次回复要朗读
          seenSilent = false;
        }

        log('stt-ok', 'engine=', engine, 'lang=', langUsed, 'spoken=', spoken, 'text=', String(text).slice(0, 30));
        return json(res, 200, {
          text, lang: langUsed, spoken, engine, ms: Date.now() - t0,
        });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      } finally {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (p === '/voice-tutor/correct') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      try {
        const b = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
        const raw = String(b.text || '');
        if (!raw) return json(res, 200, { text: '' });
        const fixed = await correctText(raw);
        if (fixed !== raw) log('corrected', JSON.stringify(raw.slice(0, 30)), '->', JSON.stringify(fixed.slice(0, 30)));
        return json(res, 200, { text: fixed });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      }
    }

    if (p === '/voice-tutor/debug') {
      try {
        const b = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
        log('playback-stats', 'max=', b.max, 'base=', b.base);
      } catch { /* ignore */ }
      return json(res, 200, { ok: true });
    }

    if (p === '/voice-tutor/config') {
      if (req.method === 'GET') return json(res, 200, config);
      if (req.method === 'POST') {
        try {
          const b = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
          const d = defaultConfig();
          config = {
            asr: { ...d.asr, ...(b.asr || {}) },
            tts: { ...d.tts, ...(b.tts || {}) },
          };
          await saveConfig();
          log('config-saved', 'asr=', !!config.asr.url, 'tts=', !!config.tts.url);
          return json(res, 200, { ok: true, config });
        } catch (e) {
          return json(res, 400, { error: String(e && e.message || e) });
        }
      }
      return json(res, 405, { error: 'GET or POST' });
    }

    if (p === '/voice-tutor/voices') {
      // 外接桥（音色最全）优先；没有就用内置目录
      try {
        const r = await fetch(TTS_BRIDGE.replace(/\/audio\/speech$/, '/voices'), { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const body = await r.text();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          return res.end(body);
        }
      } catch { /* 用内置 */ }
      return json(res, 200, { languages: ttsCatalog(), builtin: true });
    }

    if (p === '/voice-tutor/arm') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      try {
        const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
        if (!(Number(body.v) >= 3)) {
          log('ignore-legacy-arm', 'v=', body.v, 'on=', body.on);
          return json(res, 200, { ignored: true, reason: 'legacy-client' });
        }
        armedSession = body.on ? String(body.sessionId || '') || null : null;
        armedAt = body.on ? Date.now() : 0;
        armedUntil = body.on ? Date.now() + 15000 : 0;
        if (body.on && body.lang) armedLang = String(body.lang);
        lastSpoken = '';
        if (!body.on) pending = null;
        log('arm', 'on=', body.on, 'session=', body.sessionId, '->', armedSession,
          'pk=', body.pk, 'recs=', body.recs, 'lang=', body.lang);
        return json(res, 200, { armed: !!armedSession, session: armedSession });
      } catch (e) {
        return json(res, 400, { error: String(e && e.message || e) });
      }
    }

    if (p === '/voice-tutor/audio') {
      if (Number(url.searchParams.get('v')) < 3) { res.writeHead(204); return res.end(); }
      const since = Number(url.searchParams.get('since') || 0);
      if (!pending || pending.id <= since) {
        res.writeHead(204);
        return res.end();
      }
      const item = pending;
      pending = null;
      return json(res, 200, { id: item.id, mime: 'audio/mpeg', audio: item.buf.toString('base64') });
    }

    return json(res, 404, { error: 'not found' });
  };

  ctx.effect(() => web.register({ kind: 'prefix', path: '/voice-tutor', handler }), 'voice-tutor: routes');
}
