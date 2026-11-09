// 内置 TTS：Edge TTS（msedge-tts），不依赖外部桥。
// 如果运行环境里没有这个依赖，调用方会退回外接桥（VOICE_TUTOR_TTS）。
let modPromise = null;
async function loadModule() {
  if (!modPromise) modPromise = import('msedge-tts');
  return modPromise;
}

export async function available() {
  try { await loadModule(); return true; } catch { return false; }
}

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

// 默认音色（每语言一个，够用；需要更多可用外接桥或自己扩展）
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

// 粗略语言判定：按字符范围数一下，够用
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
    if (voice.includes('-')) return voice;                 // 完整音色名
    const lang = String(voice).toLowerCase();
    const hit = VOICES.find((v) => v.lang === lang);
    return hit ? hit.id : 'en-US-AvaNeural';
  }
  const lang = dominantLang(text) || 'en';
  const hit = VOICES.find((v) => v.lang === lang);
  return hit ? hit.id : 'en-US-AvaNeural';
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function synthesize(text, voice) {
  const clean = sanitize(text);
  if (!clean) throw new Error('empty text');
  const { MsEdgeTTS, OUTPUT_FORMAT } = await loadModule();
  const id = pickVoice(clean, voice);
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(id, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(clean, {});
    const buf = await collect(audioStream);
    if (!buf.length) throw new Error('empty audio');
    return { buf, voice: id };
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}
