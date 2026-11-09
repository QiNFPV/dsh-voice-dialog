// 内置 Edge TTS：直接用 WebSocket 与微软语音服务通信。
// 依赖 ws（纯 JS，无安装脚本），安装时不会触发构建授权。
import { randomUUID } from 'node:crypto';
import WS from 'ws';

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const GEC_VERSION = '2-143.0.3650.96';
const HEADERS = {
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'Accept-Language': 'en-US,en;q=0.9',
};

// 去掉 Markdown、日语注音括号（否则会被念两遍）
export function sanitize(s) {
  return String(s || '')
    .replace(/[（(][\u3040-\u30ffー]+[）)]/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const VOICES = [
  { lang: 'zh', id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女）' },
  { lang: 'zh', id: 'zh-CN-YunxiNeural', name: '云希（男）' },
  { lang: 'en', id: 'en-US-AvaNeural', name: 'Ava（女）' },
  { lang: 'en', id: 'en-US-AndrewNeural', name: 'Andrew（男）' },
  { lang: 'ja', id: 'ja-JP-NanamiNeural', name: '七海（女）' },
  { lang: 'ja', id: 'ja-JP-KeitaNeural', name: '圭太（男）' },
  { lang: 'ko', id: 'ko-KR-SunHiNeural', name: '선히（女）' },
  { lang: 'fr', id: 'fr-FR-DeniseNeural', name: 'Denise（女）' },
  { lang: 'de', id: 'de-DE-KatjaNeural', name: 'Katja（女）' },
  { lang: 'es', id: 'es-ES-ElviraNeural', name: 'Elvira（女）' },
  { lang: 'it', id: 'it-IT-ElsaNeural', name: 'Elsa（女）' },
  { lang: 'pt', id: 'pt-BR-FranciscaNeural', name: 'Francisca（女）' },
  { lang: 'ru', id: 'ru-RU-SvetlanaNeural', name: 'Svetlana（女）' },
];

export function catalog() {
  const byLang = new Map();
  for (const v of VOICES) {
    if (!byLang.has(v.lang)) byLang.set(v.lang, []);
    byLang.get(v.lang).push({ id: v.id, name: v.name });
  }
  return [...byLang.entries()].map(([lang, voices]) => ({ lang, voices }));
}

export function dominantLang(text) {
  const s = String(text || '');
  const count = (re) => (s.match(re) || []).length;
  const za = count(/[\u3040-\u30ff]/g);
  const ko = count(/[\uac00-\ud7af]/g);
  const zh = count(/[\u4e00-\u9fff]/g);
  const en = count(/[A-Za-z]/g);
  if (za > 0) return 'ja';
  if (ko > 0) return 'ko';
  if (zh > 0 && zh >= en / 2) return 'zh';
  if (en > 0) return 'en';
  return '';
}

function pickVoice(text, voice) {
  if (voice && voice !== 'auto') {
    if (String(voice).includes('-')) return String(voice);
    const hit = VOICES.find((v) => v.lang === String(voice).toLowerCase());
    return hit ? hit.id : 'en-US-AvaNeural';
  }
  const lang = dominantLang(text) || 'en';
  const hit = VOICES.find((v) => v.lang === lang);
  return hit ? hit.id : 'en-US-AvaNeural';
}

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildSsml(text, voice) {
  const lang = voice.split('-').slice(0, 2).join('-');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>`
    + `<voice name='${voice}'><prosody rate='0%' pitch='0Hz'>${escapeXml(text)}</prosody></voice></speak>`;
}

const ts = () => new Date().toString().replace(/GMT.*$/, 'GMT+0000 (Coordinated Universal Time)');

// ---- Sec-MS-GEC v2 令牌（微软用来挡非客户端请求）----
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const SWAP_FIRST_WORD = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 };
const SWAP_SECOND_WORD = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 };
const MIX_FIRST_WORD = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const MIX_SECOND_WORD = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];
const swapHalves = (v) => ((v << 16) | (v >>> 16)) >>> 0;

function swapTerm(word, key, m) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), m.swappedWord);
  const product = Math.imul(swapHalves(sum), m.swappedSum) >>> 0;
  return (Math.imul(swapHalves(product), m.swappedProduct) + product) >>> 0;
}

function swapAndMultiply(value, multipliers) {
  let v = value;
  for (const k of multipliers) v = Math.imul(swapHalves(v), k) >>> 0;
  return v;
}

function cs64(message, digest) {
  const dv = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const firstKey = (dv.getUint32(0, true) | 1) >>> 0;
  const secondKey = (dv.getUint32(4, true) | 1) >>> 0;
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8);
  padded.set(message);
  const words = new DataView(padded.buffer);
  let swapSum = 0; let lastSwap = 0; let mix = 0; let mixSum = 0;
  for (let off = 0; off < padded.length; off += 8) {
    const w1 = words.getUint32(off, true);
    const w2 = words.getUint32(off + 4, true);
    const s1 = swapTerm(w1, firstKey, SWAP_FIRST_WORD);
    lastSwap = swapTerm(w2, secondKey, SWAP_SECOND_WORD);
    swapSum = (swapSum + s1 + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + w1, firstKey), MIX_FIRST_WORD);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + w2, secondKey), MIX_SECOND_WORD);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = new Uint8Array(8);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, lastSwap ^ mix, true);
  ov.setUint32(4, swapSum ^ mixSum, true);
  return out;
}

const toUpperHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

async function hashSecMsGecV2(input) {
  const message = new TextEncoder().encode(EDGE_COPYRIGHT + input);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', message));
  return toUpperHex(cs64(message, digest)) + '-' + toUpperHex(digest);
}

async function secMsGec(token) {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  return hashSecMsGecV2(String(rounded * 10000000) + token);
}

// 二进制帧：前 2 字节是大端头长度，头里 Path:audio 表示这段是音频
function parseAudioFrame(buf) {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  if (buf.length < 2 + headerLen) return null;
  const header = buf.toString('utf8', 2, 2 + headerLen);
  const bodyStart = 2 + headerLen;
  const m = /Content-Length:\s*(\d+)/i.exec(header);
  let len = m ? Number(m[1]) : buf.length - bodyStart;
  if (buf.length < bodyStart + len) len = buf.length - bodyStart;
  const isAudio = /Path:audio/i.test(header);
  return { total: bodyStart + len, audio: isAudio ? buf.subarray(bodyStart, bodyStart + len) : null };
}

export async function synthesize(text, voice, opts = {}) {
  const clean = sanitize(text);
  if (!clean) throw new Error('empty text');
  const id = pickVoice(clean, voice);
  const connId = randomUUID().replace(/-/g, '');
  const gec = await secMsGec(TRUSTED_TOKEN);
  const url = WS_BASE + '?TrustedClientToken=' + TRUSTED_TOKEN
    + '&Sec-MS-GEC=' + gec + '&Sec-MS-GEC-Version=' + GEC_VERSION
    + '&ConnectionId=' + connId;
  const socket = new WS(url, { headers: HEADERS });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge tts connect timeout')), 10000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error('edge tts handshake ' + res.statusCode));
    });
  });

  const chunks = [];
  let tail = Buffer.alloc(0);

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge tts timeout')), opts.timeoutMs || 25000);
    const done = (err) => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };
socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (String(data).includes('Path:turn.end')) done(null);
        return;
      }
      const buf = Buffer.concat([tail, Buffer.from(data)]);
      tail = Buffer.alloc(0);
      let off = 0;
      while (off < buf.length) {
        const parsed = parseAudioFrame(buf.subarray(off));
        if (!parsed) { tail = buf.subarray(off); break; }
        if (parsed.audio) chunks.push(parsed.audio);
        off += parsed.total;
      }
    });
    socket.on('error', (e) => done(e));
    socket.on('close', () => { if (!chunks.length) done(new Error('edge tts closed early')); });
  });

  const reqId = randomUUID().replace(/-/g, '');
  socket.send(
    'X-Timestamp:' + ts() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
    + JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: OUTPUT_FORMAT,
          },
        },
      },
    }),
  );
  socket.send(
    'X-RequestId:' + reqId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts() + 'Z\r\nPath:ssml\r\n\r\n'
    + buildSsml(clean, id),
  );

  await finished;
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('empty audio');
  return { buf, voice: id };
}

export async function available() { return true; }
