// DSH语音对话 · 客户端
// 一个状态机：off → listening → thinking → speaking → listening
// 规则只有三条：听的时候不播、播的时候不听、发完就回去听。
window.__ModuleLoader__.load({
  id: 'dsh-voice-dialog',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SILENCE_MS = 1200;     // 停顿多久算说完
    const MIN_SPEECH_MS = 400;   // 太短的片段丢掉
    const SPEECH_RMS = 0.015;     // 说话音量门槛
    const AFTER_SEND_MS = 900;   // 发送后多久恢复收音
    const POLL_MS = 700;         // 取音频轮询间隔
    const IDLE_MS = 10000;       // 20 秒没有语音输入就自动退出
    const BARGE_BASE_MS = 400;   // 开头这段时间只测回声基线，不响应打断
    const BARGE_MIN_RMS = 0.012;  // 打断的绝对下限
    const BARGE_HOLD_MS = 150;   // 超过阈值需要持续多久

    const LANG_LABEL = {
      zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch',
      es: 'Español', it: 'Italiano', pt: 'Português', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी',
      th: 'ไทย', vi: 'Tiếng Việt', tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski', sv: 'Svenska',
      id: 'Indonesia', ms: 'Melayu', he: 'עברית', cs: 'Čeština', da: 'Dansk', fi: 'Suomi',
      nb: 'Norsk', el: 'Ελληνικά', hu: 'Magyar', ro: 'Română', sk: 'Slovenčina', uk: 'Українська',
    };

    const store = {
      get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    };

    const DEFAULT_LANGS = ['zh', 'en', 'ja'];
    const getLangs = () => {
      try {
        const a = JSON.parse(store.get('vt-langs', '') || 'null');
        return Array.isArray(a) && a.length ? a : DEFAULT_LANGS.slice();
      } catch { return DEFAULT_LANGS.slice(); }
    };
    const setLangs = (arr) => store.set('vt-langs', JSON.stringify(arr));

    const DEFAULT_VOICE = {
      zh: 'zh-CN-XiaoxiaoNeural',
      en: 'en-US-AvaNeural',
      ja: 'ja-JP-NanamiNeural',
      ko: 'ko-KR-SunHiNeural',
      fr: 'fr-FR-DeniseNeural',
      de: 'de-DE-KatjaNeural',
      es: 'es-ES-ElviraNeural',
      it: 'it-IT-ElsaNeural',
      pt: 'pt-BR-FranciscaNeural',
      ru: 'ru-RU-SvetlanaNeural',
    };

    // 自定义下拉：按窗口空间决定向上还是向下弹（原生 select 做不到）
    let menuEl = null;
    const closeMenu = () => { if (menuEl) { menuEl.remove(); menuEl = null; } };
    const openMenu = (rect, items, current, onPick) => {
      closeMenu();
      const rowH = 30;
      const h = items.length * rowH + 8;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const up = spaceBelow < h + 8 && spaceAbove > h + 8;
      const el = document.createElement('div');
      el.style.cssText = [
        'position:fixed', 'z-index:99999', 'min-width:132px', 'padding:4px',
        'background:var(--dsw-alias-bg-layer-3,#242424)',
        'border:1px solid var(--dsw-alias-border-l2,#444)', 'border-radius:8px',
        'box-shadow:0 8px 24px rgba(0,0,0,.35)',
        'font-size:12px', 'color:var(--dsw-alias-label-primary,#ddd)',
        `left:${Math.round(rect.left)}px`,
        `top:${Math.round(up ? rect.top - h - 4 : rect.bottom + 4)}px`,
        'max-height:320px', 'overflow:auto',
      ].join(';');
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        b.style.cssText = [
          `height:${rowH - 4}px`, 'display:block', 'width:100%', 'text-align:left',
          'padding:0 10px', 'margin:2px 0', 'border:none', 'border-radius:6px',
          'background:' + (it.id === current ? 'rgba(96,165,250,.22)' : 'transparent'),
          'color:inherit', 'font-size:12px', 'cursor:pointer',
        ].join(';');
        b.onclick = (ev) => { ev.stopPropagation(); onPick(it.id); closeMenu(); };
        el.appendChild(b);
      }
      document.body.appendChild(el);
      menuEl = el;
      setTimeout(() => {
        const off = (ev) => { if (menuEl && !menuEl.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
        document.addEventListener('pointerdown', off, true);
      }, 0);
    };

    const E = {
      state: 'off',          // off | listening | thinking | speaking
      level: 0,
      note: '',
      voice: store.get('vt-voice', 'auto'),
      voices: null,
      listeners: new Set(),
      stream: null,
      ctx: null,
      analyser: null,
      buf: null,
      rec: null,
      recStart: 0,
      silence: null,
      raf: 0,
      poll: null,
      audio: null,
      audios: [],
      props: null,
      busy: false,
    };

    const emit = () => { for (const f of E.listeners) { try { f(); } catch {} } };
    const go = (s) => { E.state = s; E.lastActive = Date.now(); emit(); };
    const note = (t) => { E.note = t; emit(); };

    // ---------- 本地 Whisper 更新状态 ----------
    let wuStatus = null;
    let wuLoading = false;
    let wuLastLoad = 0;
    let wuPoll = 0;

    const fmtBytes = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return '';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let x = v; let i = 0;
      while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
      return (x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i];
    };
    const shortRev = (r) => String(r || '').slice(0, 8);
    const fmtTime = (iso) => {
      if (!iso) return '从未检查';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
    };
    const wuBadgeText = () => {
      const r = wuStatus && wuStatus.result;
      if (!r || !r.hasUpdate) return '';
      const parts = [];
      if (r.fastwhisper && r.fastwhisper.hasUpdate) parts.push('Whisper 有新版 ' + (r.fastwhisper.latest || ''));
      if (r.model && r.model.hasUpdate) parts.push('模型有新版');
      return parts.join(' · ');
    };
    const loadWu = (force) => {
      if (wuLoading) return;
      if (!force && Date.now() - wuLastLoad < 4000) return;
      wuLoading = true;
      fetch('/voice-tutor/whisper-update', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.ok) { wuStatus = d; wuLastLoad = Date.now(); } })
        .catch(() => {})
        .finally(() => { wuLoading = false; emit(); });
    };
    const startWuPolling = () => {
      if (wuPoll) return;
      wuPoll = setInterval(() => {
        loadWu(true);
        const job = wuStatus && wuStatus.job;
        if (job && job.done) { clearInterval(wuPoll); wuPoll = 0; }
      }, 1500);
    };
    const stopWuPolling = () => { if (wuPoll) { clearInterval(wuPoll); wuPoll = 0; } };

    const checkWhisperNow = async (btn) => {
      if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
      try {
        const r = await fetch('/voice-tutor/whisper-update/check', { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        if (d.ok) wuStatus = d;
        emit();
        return d;
      } catch (e) {
        note('Whisper 检查失败：' + String(e && e.message || e));
        return null;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '立即检查'; }
      }
    };

    // 更新动作：二次确认（confirm）后才向后端发 confirm: true
    const applyWhisper = async (target) => {
      const r = (wuStatus && wuStatus.result) || {};
      if (target === 'fastwhisper') {
        const ok = window.confirm('确定更新 faster-whisper 吗？\n\n'
          + '将执行：venv python -m pip install -U faster-whisper\n'
          + '然后重启 127.0.0.1:8789 上的本地识别桥，等待 /health 就绪。\n'
          + '失败会自动尝试回滚到当前版本。');
        if (!ok) return;
      } else {
        const size = fmtBytes(r.model && r.model.sizeBytes);
        const ok = window.confirm('确定下载新模型吗？'
          + (size ? '\n\n体积约 ' + size + '。' : '')
          + '\n下载完成后会重启本地识别桥；旧缓存不会删除，失败可回滚。');
        if (!ok) return;
      }
      try {
        const resp = await fetch('/voice-tutor/whisper-update/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, confirm: true }),
        });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(d.error || ('HTTP ' + resp.status));
        note(target === 'fastwhisper' ? '正在更新 faster-whisper…' : '正在下载模型…');
        loadWu(true);
        startWuPolling();
      } catch (e) {
        window.alert('更新启动失败：' + String(e && e.message || e));
      }
    };

    // 语音按钮旁边的小提示，点击打开详情/更新面板（纯 DOM，避免额外 React 状态）
    const closeWhisperDialog = () => {
      const el = document.getElementById('vt-wu-dialog');
      if (!el) return;
      if (el._vtTimer) clearInterval(el._vtTimer);
      el.remove();
    };

    const openWhisperDialog = () => {
      closeWhisperDialog();
      loadWu(true);
      const wrap = document.createElement('div');
      wrap.id = 'vt-wu-dialog';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.38);'
        + 'display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'width:min(580px,92vw);max-height:82vh;overflow:auto;'
        + 'background:var(--dsw-alias-bg-layer-3,#242424);border:1px solid var(--dsw-alias-border-l2,#444);'
        + 'border-radius:12px;padding:16px 18px;color:var(--dsw-alias-label-primary,#ddd);'
        + 'font-size:12px;line-height:1.7;box-shadow:0 18px 50px rgba(0,0,0,.5);';
      wrap.appendChild(box);
      wrap.onclick = (ev) => { if (ev.target === wrap) closeWhisperDialog(); };
      document.body.appendChild(wrap);

      const el = (tag, style, text) => {
        const n = document.createElement(tag);
        if (style) n.style.cssText = style;
        if (text !== undefined) n.textContent = text;
        return n;
      };
      const line = (k, v, color) => {
        const row = el('div', 'display:flex;gap:8px;align-items:baseline;');
        row.appendChild(el('span', 'width:92px;flex:none;opacity:.55;', k));
        const val = el('span', 'flex:1;word-break:break-all;' + (color ? 'color:' + color + ';' : ''), v);
        row.appendChild(val);
        return row;
      };

      function render() {
        const st = wuStatus;
        const r = (st && st.result) || null;
        const fw = (r && r.fastwhisper) || {};
        const md = (r && r.model) || {};
        const job = st && st.job;
        box.textContent = '';

        box.appendChild(el('div', 'font-size:15px;font-weight:600;margin-bottom:2px;', '本地 Whisper 更新'));
        box.appendChild(el('div', 'font-size:11px;opacity:.5;margin-bottom:10px;',
          st ? ('自动检查：' + (st.enabled ? '开' : '关') + ' · 每 ' + (st.intervalHours || 24) + ' 小时')
            : '宿主暂未响应（宿主侧改动需要重启 DSH 后生效）'));

        const body = el('div', 'display:flex;flex-direction:column;gap:4px;');
        body.appendChild(line('上次检查', fmtTime(st && st.lastCheckAt)));
        body.appendChild(line('faster-whisper',
          (fw.installed || '未知') + ' → ' + (fw.latest || '未知') + ' · '
          + (fw.hasUpdate ? '有新版' : (fw.installed && fw.latest ? '已是最新' : '未知')),
          fw.hasUpdate ? '#f5b544' : ''));
        body.appendChild(line('模型',
          (md.repo || '') + ' · 本地 ' + (shortRev(md.localRevision) || '—')
          + ' · 远程 ' + (shortRev(md.remoteRevision) || '—') + ' · '
          + (md.hasUpdate ? '有新版' : (md.localRevision && md.remoteRevision ? '已是最新' : '未知')),
          md.hasUpdate ? '#f5b544' : ''));
        if (md.sizeBytes) body.appendChild(line('模型体积', fmtBytes(md.sizeBytes)));
        if (r && r.errors && r.errors.length) {
          body.appendChild(line('提示', r.errors.slice(0, 2).join('；'), '#f59e0b'));
        }
        if (job) {
          body.appendChild(line('更新任务',
            (job.phase || '') + (job.percent !== null && job.percent !== undefined ? ' ' + job.percent + '%' : '')
            + (job.error ? ' × ' + job.error : ''),
            job.error ? '#ef4444' : ''));
        }
        box.appendChild(body);

        const row = el('div', 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center;');
        const btnStyle = 'height:28px;padding:0 12px;border-radius:8px;cursor:pointer;font-size:12px;'
          + 'border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:inherit;';
        const mkBtn = (label, onclick, accent) => {
          const b = el('button', btnStyle + (accent ? 'border-color:#f5b544;color:#f5b544;' : ''), label);
          b.type = 'button';
          b.onclick = onclick;
          return b;
        };
        const checkBtn = mkBtn('立即检查', () => checkWhisperNow(checkBtn));
        row.appendChild(checkBtn);
        if (r && fw.hasUpdate) {
          row.appendChild(mkBtn('更新 faster-whisper', () => applyWhisper('fastwhisper'), true));
        }
        if (r && md.hasUpdate) {
          row.appendChild(mkBtn('下载新模型', () => applyWhisper('model'), true));
        }
        row.appendChild(mkBtn('关闭', () => closeWhisperDialog()));
        box.appendChild(row);
      }

      render();
      wrap._vtTimer = setInterval(() => {
        loadWu(true);
        render();
      }, 1500);
    };

    // ---------- 与宿主通信 ----------
    const arm = () => {
      const p = E.props || {};
      fetch('/voice-tutor/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 3, on: true, sessionId: p.sessionId, lang: E.voice }),
      }).catch(() => {});
    };
    const disarm = () => {
      fetch('/voice-tutor/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 3, on: false }),
      }).catch(() => {});
    };

    // ---------- 录音 ----------
    const beginClip = () => {
      if (!E.stream || E.rec) return;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      let rec;
      try { rec = new MediaRecorder(E.stream, { mimeType: mime }); } catch { return; }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        E.rec = null;
        const ms = Date.now() - E.recStart;
        if (ms < MIN_SPEECH_MS || !chunks.length) { if (E.state === 'thinking') go('listening'); return; }
        submit(new Blob(chunks, { type: mime.split(';')[0] }));
      };
      E.recStart = Date.now();
      E.rec = rec;
      try { rec.start(); } catch { E.rec = null; }
    };

    const endClip = () => {
      if (E.rec && E.rec.state !== 'inactive') { try { E.rec.stop(); } catch {} }
    };

    // ---------- 2 秒确认窗口 ----------
    const cancelDwell = () => {
      if (!E.dwell) return;
      clearTimeout(E.dwell.timer);
      window.removeEventListener('keydown', E.dwell.onInteract, true);
      window.removeEventListener('pointerdown', E.dwell.onInteract, true);
      E.dwell = null;
      note('已暂停发送，改完按回车');
    };

    const beginDwell = (text, ia) => {
      cancelDwell();
      const onInteract = () => cancelDwell();
      const timer = setTimeout(() => {
        window.removeEventListener('keydown', onInteract, true);
        window.removeEventListener('pointerdown', onInteract, true);
        if (!E.dwell) return;
        E.dwell = null;
        note('');
        try { if (ia && ia.submit) ia.submit(); } catch {}
      }, 2000);
      E.dwell = { text, timer, onInteract };
      window.addEventListener('keydown', onInteract, true);
      window.addEventListener('pointerdown', onInteract, true);
      note('2 秒后自动发送 · 点一下输入框可修改');
    };

    // ---------- 浏览器端转 WAV：不需要 ffmpeg ----------
    const resampleTo16k = (buffer, srcRate) => {
      if (srcRate === 16000) return buffer;
      const ratio = srcRate / 16000;
      const outLen = Math.round(buffer.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
        let sum = 0; let n = 0;
        for (let j = start; j < end; j++) { sum += buffer[j]; n++; }
        out[i] = n ? sum / n : 0;
      }
      return out;
    };

    const encodeWav = (samples, rate = 16000) => {
      const buf = new ArrayBuffer(44 + samples.length * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
      w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, samples.length * 2, true);
      let o = 44;
      for (let i = 0; i < samples.length; i++, o += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Uint8Array(buf);
    };

    const blobToWav = async (blob) => {
      const ab = await blob.arrayBuffer();
      const ctx = E.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ctx.decodeAudioData(ab.slice(0));
      const ch = audio.getChannelData(0);
      const mono = audio.numberOfChannels > 1
        ? (() => {
            const l = audio.getChannelData(0); const r = audio.getChannelData(1);
            const m = new Float32Array(l.length);
            for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2;
            return m;
          })()
        : ch;
      return encodeWav(resampleTo16k(mono, audio.sampleRate), 16000);
    };

    const bytesToBase64 = (bytes) => {
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(s);
    };

    const submit = async (blob) => {
      if (E.busy) return;
      E.busy = true;
      go('thinking');
      try {
        const wav = await blobToWav(blob);
        const b64 = bytesToBase64(wav);
        const r = await fetch('/voice-tutor/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 3, audio: b64, sessionId: (E.props || {}).sessionId, lang: E.voice }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        if (d.dup) { note('（重复，已忽略）'); return; }
        const text = String(d.text || '').trim();
        if (!text) { note('没听清，请再说一次'); return; }
        note('「' + text.slice(0, 32) + '」');
        const ia = (E.props || {}).inputActions;
        if (ia && ia.setDraft) {
          ia.setDraft(text);
          beginDwell(text, ia);
          // 并行纠错：结果回来再替换，不阻塞发送窗口
          if (store.get('vt-correct', '1') === '1') fetch('/voice-tutor/correct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, lang: E.voice }),
          }).then((r) => r.json()).then((d) => {
            const fixed = String(d.text || '').trim();
            if (!fixed || fixed === text) return;
            if (!E.dwell || E.dwell.text !== text) return;   // 已被取消或用户改过
            try { ia.setDraft(fixed); } catch {}
            beginDwell(fixed, ia);
            note('已纠错 · 2 秒后发送');
          }).catch(() => {});
        } else note('输入框不可用');
      } catch (e) {
        note('转写失败：' + String(e && e.message || e));
      } finally {
        E.busy = false;
        setTimeout(() => { if (E.state === 'thinking') go('listening'); }, AFTER_SEND_MS);
      }
    };

    // ---------- 音量循环 ----------
    const tick = () => {
      if (E.state === 'off') return;
      const a = E.analyser;
      if (a) {
        a.getFloatTimeDomainData(E.buf);
        let sum = 0;
        for (let i = 0; i < E.buf.length; i++) sum += E.buf[i] * E.buf[i];
        E.level = Math.sqrt(sum / E.buf.length);
        if (E.state === 'listening') {
          const loud = E.level > SPEECH_RMS;
          if (loud) {
            if (E.silence) { clearTimeout(E.silence); E.silence = null; }
            if (!E.rec) { beginClip(); E.lastActive = Date.now(); }
          } else if (E.rec && !E.silence) {
            E.silence = setTimeout(() => { E.silence = null; endClip(); }, SILENCE_MS);
          } else if (!E.rec && E.lastActive && Date.now() - E.lastActive > IDLE_MS) {
            stop();   // 20 秒没说话：自动退出语音对话
          }
        } else if (E.state === 'speaking') {
          // 自适应打断：先测回声基线，明显高于基线且持续，才算用户开口
          const el = E.playT ? Date.now() - E.playT : 0;
          if (el < BARGE_BASE_MS) {
            E.baseSum = (E.baseSum || 0) + E.level;
            E.baseN = (E.baseN || 0) + 1;
          } else {
            const base = E.baseN ? E.baseSum / E.baseN : 0;
            if (E.level > (E.maxLevel || 0)) E.maxLevel = E.level;
            const thr = Math.max(BARGE_MIN_RMS, base * 1.5);
            if (E.level > thr) {
              E.loudMs = (E.loudMs || 0) + 16;
              if (E.loudMs >= BARGE_HOLD_MS) {
                try { if (E.audio) E.audio.pause(); } catch {}
                E.audio = null; E.loudMs = 0;
                go('listening');
                beginClip();
              }
            } else E.loudMs = 0;
          }
        }
        const now = Date.now();
        if (!E.lastEmit || now - E.lastEmit > 100) { E.lastEmit = now; emit(); }
      }
      E.raf = requestAnimationFrame(tick);
    };

    // ---------- 播放 ----------
    const pollAudio = async () => {
      if (E.state === 'off' || E.state === 'speaking') return;
      try {
        const r = await fetch('/voice-tutor/audio?since=' + (E.lastId || 0) + '&v=3', { cache: 'no-store' });
        if (r.status !== 200) return;
        const d = await r.json();
        E.lastId = d.id;
        // 新音频开始前，先把所有可能还在响的旧音频彻底停掉
        for (const a of (E.audios || [])) { try { a.pause(); a.currentTime = 0; } catch {} }
        E.audios = [];
        if (E.audio) { try { E.audio.pause(); } catch {} E.audio = null; }
        const el = new Audio('data:' + (d.mime || 'audio/mpeg') + ';base64,' + d.audio);
        E.audios.push(el);
        E.audio = el;
        E.playT = Date.now(); E.baseSum = 0; E.baseN = 0; E.loudMs = 0; E.maxLevel = 0;
        go('speaking');
        el.onended = el.onerror = () => {
          try { el.pause(); } catch {}
          E.audio = null;
          fetch('/voice-tutor/debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              v: 3,
              max: Math.round((E.maxLevel || 0) * 1000) / 1000,
              base: E.baseN ? Math.round((E.baseSum / E.baseN) * 1000) / 1000 : 0,
            }),
          }).catch(() => {});
          if (E.state === 'speaking') go('listening');
        };
        try { await el.play(); } catch { E.audio = null; go('listening'); }
      } catch { /* 下次再试 */ }
    };

    // ---------- 生命周期 ----------
    const start = async () => {
      if (E.state !== 'off') return;
      note('');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        if (ctx.state === 'suspended') await ctx.resume();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        E.stream = stream; E.ctx = ctx; E.analyser = analyser; E.buf = new Float32Array(1024);
        E.lastId = 0;
        go('listening');
        arm();
        E.hb = setInterval(() => { if (E.state !== 'off') arm(); }, 5000);
        E.poll = setInterval(pollAudio, POLL_MS);
        E.raf = requestAnimationFrame(tick);
      } catch (e) {
        stop();
        note('麦克风不可用：' + String(e && e.message || e));
      }
    };

    const stop = () => {
      if (E.dwell) {
        clearTimeout(E.dwell.timer);
        window.removeEventListener('keydown', E.dwell.onInteract, true);
        window.removeEventListener('pointerdown', E.dwell.onInteract, true);
        E.dwell = null;
      }
      try { if (E.rec) E.rec.stop(); } catch {}
      E.rec = null;
      try { if (E.stream) E.stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { if (E.ctx) E.ctx.close(); } catch {}
      try { if (E.audio) E.audio.pause(); } catch {}
      for (const a of (E.audios || [])) { try { a.pause(); } catch {} }
      E.audios = [];
      clearTimeout(E.silence); clearTimeout(E.wait);
      clearInterval(E.poll); clearInterval(E.hb);
      cancelAnimationFrame(E.raf);
      E.silence = E.poll = E.hb = E.raf = null; E.audio = null;
      E.stream = E.ctx = E.analyser = E.buf = null;
      E.level = 0;
      go('off');
      note('');
      disarm();
    };

    const ensureVoices = () => {
      if (E.voices) return;
      fetch('/voice-tutor/voices', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { E.voices = Array.isArray(d.languages) ? d.languages : []; emit(); })
        .catch(() => { E.voices = []; });
    };

    // ---------- UI ----------
    function Panel(props) {
      const [, force] = React.useState(0);
      E.props = props;
      React.useEffect(() => {
        const f = () => force((x) => x + 1);
        E.listeners.add(f);
        ensureVoices();
        loadWu();
        const wuT = setInterval(() => loadWu(), 60000);
        return () => { E.listeners.delete(f); clearInterval(wuT); };
      }, []);

      const on = E.state !== 'off';
      const cur = E.voice;
      const langCode = cur === 'auto' ? 'auto' : (cur === 'ext' ? 'ext' : cur.split('-')[0]);
      const langs = (E.voices || []).map((g) => g.lang);
      const group = (E.voices || []).find((g) => g.lang === langCode);
      const voices = group ? group.voices : [];

      // 默认只给四种：自动 / 中文 / English / 日本語；「⋯」展开全部音色
      const SIMPLE = [
        { id: 'auto', label: '自动' },
        { id: 'zh-CN-XiaoxiaoNeural', label: '中文' },
        { id: 'en-US-AvaNeural', label: 'English' },
        { id: 'ja-JP-NanamiNeural', label: '日本語' },
      ];
      const simpleVal = (() => {
        if (cur === 'auto') return 'auto';
        if (cur === 'ext') return 'auto';
        const pre = String(cur).split('-')[0];
        const hit = SIMPLE.find((x) => x.id.split('-')[0] === pre);
        return hit ? hit.id : 'auto';
      })();
      const setVoice = (v) => {
        E.voice = v;
        store.set('vt-voice', E.voice);
        if (on) arm();
        emit();
      };
      const adv = store.get('vt-adv', '0') === '1';

      const label = E.state === 'thinking' ? '识别中…'
        : E.state === 'speaking' ? '朗读中…'
        : on ? '语音对话中' : '语音对话';

      const ring = Math.min(1, E.level * 18);
      // 语言 chip：只列出用户在设置里勾选过的语言
      const langItems = [{ id: 'auto', label: '自动' }]
        .concat(getLangs().map((c) => ({ id: c, label: LANG_LABEL[c] || c.toUpperCase() })));
      const curId = cur === 'auto' ? 'auto' : String(cur).split('-')[0];
      const curLabel = (langItems.find((x) => x.id === curId) || langItems[0]).label;
      const pickLangChip = (id) => {
        if (id === 'auto') { setVoice('auto'); return; }
        const g = (E.voices || []).find((x) => x.lang === id);
        setVoice(g && g.voices[0] ? g.voices[0].id : (DEFAULT_VOICE[id] || id));
      };
      const chipStyle = {
        height: 28, padding: '0 8px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l2,#444)',
        background: 'var(--dsw-alias-bg-layer-2,transparent)',
        color: 'var(--dsw-alias-label-secondary,#aaa)',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      };

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('button', {
          type: 'button',
          style: chipStyle,
          title: '朗读语言（在 设置 → 插件 → 语音对话 里增减）',
          onClick: (e) => openMenu(e.currentTarget.getBoundingClientRect(), langItems, curId, pickLangChip),
        }, curLabel, ' ▾'),
        h('button', {
          type: 'button',
          onClick: () => (on ? stop() : start()),
          title: on ? '退出语音对话' : '进入语音对话（连续对话）',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
            borderRadius: 999, cursor: 'pointer', fontSize: 12, lineHeight: '26px',
            border: '1px solid ' + (on ? '#e5484d' : 'var(--dsw-alias-border-l2,#444)'),
            background: on ? 'rgba(229,72,77,.16)' : 'var(--dsw-alias-bg-layer-2,transparent)',
            color: on ? '#ff6b6f' : 'var(--dsw-alias-label-secondary,#aaa)',
            boxShadow: on ? '0 0 0 ' + (2 + ring * 8).toFixed(1) + 'px rgba(229,72,77,.18)' : 'none',
            transition: 'box-shadow 100ms linear',
          },
        },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
            h('path', { d: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', fill: 'currentColor' }),
            h('path', { d: 'M6 11v1a6 6 0 0 0 12 0v-1M12 18v3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' })),
          h('span', null, label),
          (on && E.state === 'speaking')
            ? h('span', { style: { fontSize: 11, opacity: .6, fontVariantNumeric: 'tabular-nums' } },
                E.level.toFixed(3))
            : null),
        wuBadgeText() ? h('button', {
          type: 'button',
          title: '本地 Whisper / 模型有新版，点击查看并更新',
          onClick: () => openWhisperDialog(),
          style: {
            height: 28, padding: '0 9px', borderRadius: 999, cursor: 'pointer', fontSize: 11,
            border: '1px solid rgba(245,158,11,.55)', background: 'rgba(245,158,11,.14)',
            color: '#f5b544', whiteSpace: 'nowrap',
          },
        }, '⬆ ' + wuBadgeText()) : null,
        E.note ? h('span', {
          style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#888)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, E.note) : null);
    }

    // ---------- 外接接口表单（OpenAI 兼容）----------
    function ExternalForm() {
      const [cfg, setCfg] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      React.useEffect(() => {
        fetch('/voice-tutor/config', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => setCfg({ asr: d.asr || {}, tts: d.tts || {} }))
          .catch(() => setCfg({ asr: {}, tts: {} }));
      }, []);
      if (!cfg) return null;
      const set = (g, k, v) => setCfg({ ...cfg, [g]: { ...(cfg[g] || {}), [k]: v } });
      const save = async () => {
        try {
          const r = await fetch('/voice-tutor/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
          });
          setMsg(r.ok ? '已保存' : '保存失败');
        } catch { setMsg('保存失败'); }
        setTimeout(() => setMsg(''), 2500);
      };
      const inp = {
        height: 28, borderRadius: 6, padding: '0 8px', fontSize: 12, flex: 1, minWidth: 120,
        border: '1px solid var(--dsw-alias-border-l2,#444)',
        background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit',
      };
      const line = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 };
      const hint = { fontSize: 11, opacity: .5, lineHeight: '16px' };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 } },
        h('div', { style: { fontSize: 13, opacity: .85 } }, '外接接口（可选，OpenAI 兼容）'),
        h('div', { style: hint }, '识别接口：POST {url}，multipart 字段 file 与 model，例如 /v1/audio/transcriptions'),
        h('div', { style: line },
          h('span', { style: { width: 46, opacity: .7 } }, '识别'),
          h('input', { style: inp, placeholder: 'URL', value: (cfg.asr || {}).url || '', onChange: (e) => set('asr', 'url', e.target.value) }),
          h('input', { style: inp, placeholder: 'API Key', type: 'password', value: (cfg.asr || {}).key || '', onChange: (e) => set('asr', 'key', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 150 }, placeholder: '模型', value: (cfg.asr || {}).model || '', onChange: (e) => set('asr', 'model', e.target.value) })),
        h('div', { style: hint }, '合成接口：POST {url}，JSON {model, input, voice}，例如 /v1/audio/speech'),
        h('div', { style: line },
          h('span', { style: { width: 46, opacity: .7 } }, '合成'),
          h('input', { style: inp, placeholder: 'URL', value: (cfg.tts || {}).url || '', onChange: (e) => set('tts', 'url', e.target.value) }),
          h('input', { style: inp, placeholder: 'API Key', type: 'password', value: (cfg.tts || {}).key || '', onChange: (e) => set('tts', 'key', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 120 }, placeholder: '模型', value: (cfg.tts || {}).model || '', onChange: (e) => set('tts', 'model', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 110 }, placeholder: '音色', value: (cfg.tts || {}).voice || '', onChange: (e) => set('tts', 'voice', e.target.value) })),
        h('div', { style: { ...line, gap: 10 } },
          h('button', {
            type: 'button', onClick: save,
            style: {
              height: 28, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l2,#444)', background: 'transparent', color: 'inherit',
            },
          }, '保存'),
          h('span', { style: { ...hint, opacity: .7 } }, msg || '留空则用内置 Edge TTS 与本地识别')),
      );
    }

    // ---------- 设置页：本地 Whisper 更新检查 ----------
    function WhisperSettings() {
      const [cfg, setCfg] = React.useState(null);
      const [st, setSt] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const getJson = async (u, opt) => {
        const r = await fetch(u, opt);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      };
      const load = async () => {
        try {
          const [c, s] = await Promise.all([
            getJson('/voice-tutor/config', { cache: 'no-store' }),
            getJson('/voice-tutor/whisper-update', { cache: 'no-store' }),
          ]);
          const w = c.whisperUpdate || {};
          setCfg({ enabled: w.enabled !== false, intervalHours: Number(w.intervalHours) || 24 });
          setSt(s);
        } catch {
          setSt(null);   // 宿主侧路由需要重启 DSH 后才存在
        }
      };
      React.useEffect(() => {
        load();
        const t = setInterval(load, 4000);
        return () => clearInterval(t);
      }, []);

      const save = async (patch) => {
        const next = { ...(cfg || { enabled: true, intervalHours: 24 }), ...patch };
        setCfg(next);
        try {
          await getJson('/voice-tutor/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ whisperUpdate: { enabled: next.enabled, intervalHours: Number(next.intervalHours) || 24 } }),
          });
          setMsg('已保存');
          setTimeout(() => setMsg(''), 2000);
          load();
        } catch (e) {
          setMsg('保存失败：' + String(e && e.message || e));
        }
      };

      const checkNow = async () => {
        setBusy(true);
        setMsg('检查中…');
        try {
          const d = await getJson('/voice-tutor/whisper-update/check', { method: 'POST' });
          setSt(d);
          setMsg('检查完成');
        } catch (e) {
          setMsg('检查失败：' + String(e && e.message || e));
        } finally {
          setBusy(false);
          setTimeout(() => setMsg(''), 3000);
        }
      };

      if (!cfg) return null;
      const w = (st && st.result) || null;
      const fw = (w && w.fastwhisper) || {};
      const md = (w && w.model) || {};
      const job = st && st.job;
      const row = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' };
      const hint = { fontSize: 11, opacity: .55, lineHeight: '17px' };
      const box = {
        display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2,#333)', borderRadius: 8, fontSize: 12, lineHeight: '19px',
      };
      const line = (k, v, color) => h('div', { style: { display: 'flex', gap: 8 } },
        h('span', { style: { width: 92, flex: 'none', opacity: .55 } }, k),
        h('span', { style: { flex: 1, wordBreak: 'break-all', color: color || 'inherit' } }, v));
      const btnStyle = {
        height: 28, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l2,#444)', background: 'transparent', color: 'inherit',
      };
      const apply = async (target) => {
        const ok = target === 'fastwhisper'
          ? window.confirm('确定更新 faster-whisper 吗？\n\n将执行 venv python -m pip install -U faster-whisper，'
            + '并重启 127.0.0.1:8789 上的本地识别桥；失败会尝试回滚。')
          : window.confirm('确定下载新模型吗？'
            + (md.sizeBytes ? '\n体积约 ' + fmtBytes(md.sizeBytes) + '。' : '')
            + '\n下载完成后重启本地识别桥，旧缓存不会删除，失败可回滚。');
        if (!ok) return;
        setBusy(true);
        try {
          await getJson('/voice-tutor/whisper-update/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, confirm: true }),
          });
          setMsg('更新任务已开始');
          load();
        } catch (e) {
          setMsg('更新启动失败：' + String(e && e.message || e));
        } finally {
          setBusy(false);
        }
      };

      const status = st
        ? ('自动检查：' + (st.enabled ? '开' : '关') + ' · 每 ' + (st.intervalHours || 24) + ' 小时')
        : '宿主侧尚未响应：宿主改动需重启 DSH 后生效';
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2,#333)' },
      },
        h('div', { style: { fontSize: 13, opacity: .85 } }, '本地 Whisper 更新检查'),
        h('div', { style: hint }, '检查 PyPI 上的 faster-whisper 版本和 HuggingFace 上的模型 revision；离线或出错会静默跳过，不影响语音功能。'),
        h('label', { style: { ...row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: cfg.enabled !== false,
            onChange: () => save({ enabled: cfg.enabled === false }),
          }),
          h('span', null, '自动检查本地 Whisper 更新')),
        h('div', { style: row },
          h('span', { style: { ...hint, width: 96 } }, '检查间隔'),
          h('select', {
            value: Number(cfg.intervalHours) || 24,
            style: {
              height: 30, minWidth: 140, borderRadius: 8, padding: '0 8px', fontSize: 13,
              border: '1px solid var(--dsw-alias-border-l2,#444)',
              background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit',
            },
            onChange: (e) => save({ intervalHours: Number(e.target.value) }),
          }, [6, 12, 24, 72].map((n) => h('option', { key: n, value: n }, '每 ' + n + ' 小时')))),
        h('div', { style: row },
          h('button', { type: 'button', style: btnStyle, disabled: busy, onClick: checkNow },
            busy ? '请稍候…' : '立即检查'),
          h('span', { style: { ...hint, opacity: .7 } }, msg || status)),
        h('div', { style: box },
          line('上次检查', fmtTime(st && st.lastCheckAt)),
          line('faster-whisper', (fw.installed || '未知') + ' → 最新 ' + (fw.latest || '未知') + ' · '
            + (fw.hasUpdate ? '有新版' : (fw.installed && fw.latest ? '已是最新' : '未知')),
            fw.hasUpdate ? '#f5b544' : ''),
          line('模型', (md.repo || '—') + ' · 本地 ' + (shortRev(md.localRevision) || '—')
            + ' · 远程 ' + (shortRev(md.remoteRevision) || '—') + ' · '
            + (md.hasUpdate ? '有新版' : (md.localRevision && md.remoteRevision ? '已是最新' : '未知')),
            md.hasUpdate ? '#f5b544' : ''),
          md.sizeBytes ? line('模型体积', fmtBytes(md.sizeBytes)) : null,
          w && w.errors && w.errors.length ? line('提示', w.errors.slice(0, 2).join('；'), '#f59e0b') : null,
          job ? line('更新任务', (job.phase || '')
            + (job.percent !== null && job.percent !== undefined ? ' ' + job.percent + '%' : '')
            + (job.error ? ' × ' + job.error : ''), job.error ? '#ef4444' : '') : null,
          (w && (fw.hasUpdate || md.hasUpdate)) ? h('div', { style: { ...row, marginTop: 6 } },
            fw.hasUpdate ? h('button', {
              type: 'button', disabled: busy, onClick: () => apply('fastwhisper'),
              style: { ...btnStyle, borderColor: '#f5b544', color: '#f5b544' },
            }, '更新 faster-whisper') : null,
            md.hasUpdate ? h('button', {
              type: 'button', disabled: busy, onClick: () => apply('model'),
              style: { ...btnStyle, borderColor: '#f5b544', color: '#f5b544' },
            }, '下载新模型') : null) : null));
    }

    // ---------- 设置面板（设置 → 插件 → 语音对话）----------
    function Settings() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((x) => x + 1);
        E.listeners.add(f);
        ensureVoices();
        return () => { E.listeners.delete(f); };
      }, []);

      const SIMPLE = [
        { id: 'auto', label: '自动' },
        { id: 'zh-CN-XiaoxiaoNeural', label: '中文' },
        { id: 'en-US-AvaNeural', label: 'English' },
        { id: 'ja-JP-NanamiNeural', label: '日本語' },
      ];
      const cur = E.voice;
      const adv = store.get('vt-adv', '0') === '1';
      const simpleVal = (() => {
        if (cur === 'auto' || cur === 'ext') return 'auto';
        const pre = String(cur).split('-')[0];
        const hit = SIMPLE.find((x) => x.id.split('-')[0] === pre);
        return hit ? hit.id : 'auto';
      })();
      const langCode = cur === 'auto' ? 'auto' : (cur === 'ext' ? 'ext' : String(cur).split('-')[0]);
      const group = (E.voices || []).find((g) => g.lang === langCode);
      const voices = group ? group.voices : [];

      const setVoice = (v) => { E.voice = v; store.set('vt-voice', v); if (E.state !== 'off') arm(); emit(); };
      const row = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 };
      const sel = {
        height: 30, minWidth: 150, borderRadius: 8, padding: '0 8px', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2,#444)',
        background: 'var(--dsw-alias-bg-layer-2,transparent)',
        color: 'var(--dsw-alias-label-primary,#ddd)',
      };

      const allLangs = (E.voices && E.voices.length)
        ? E.voices.map((g) => g.lang)
        : Object.keys(LANG_LABEL);
      const chosen = getLangs();
      const toggleLang = (code) => {
        const next = chosen.includes(code) ? chosen.filter((x) => x !== code) : chosen.concat([code]);
        setLangs(next.length ? next : ['zh']);
        emit();
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', maxWidth: 620 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 13, opacity: .85 } }, '对话栏里可供选择的语言'),
          h('div', { style: { fontSize: 12, opacity: .5 } }, '勾选的语言会出现在输入框旁边的下拉里；「自动」始终保留。识别语言始终自动判定。'),
          h('div', {
            style: {
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))',
              gap: '4px 10px', maxHeight: 220, overflow: 'auto',
              border: '1px solid var(--dsw-alias-border-l2,#333)', borderRadius: 8, padding: 8,
            },
          }, allLangs.map((code) => h('label', {
            key: code, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' },
          },
            h('input', {
              type: 'checkbox', checked: chosen.includes(code),
              onChange: () => toggleLang(code),
            }),
            h('span', null, (LANG_LABEL[code] || code.toUpperCase()) + ' · ' + code))))) ,
        h('label', { style: { ...row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: adv,
            onChange: () => { store.set('vt-adv', adv ? '0' : '1'); emit(); },
          }),
          h('span', null, '显示全部音色（高级）')),
        adv ? h('div', { style: { ...row } },
          h('span', { style: { width: 96, opacity: .8 } }, '具体音色'),
          h('select', {
            value: voices.some((v) => v.id === cur) ? cur : (voices[0] ? voices[0].id : ''),
            style: { ...sel, minWidth: 260 },
            onChange: (e) => setVoice(e.target.value),
          }, voices.map((v) => h('option', { value: v.id, key: v.id },
            String(v.name || v.id).replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, ''))))) : null,
        h('label', { style: { ...row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: store.get('vt-correct', '1') === '1',
            onChange: () => {
              const next = store.get('vt-correct', '1') === '1' ? '0' : '1';
              store.set('vt-correct', next);
              emit();
            },
          }),
          h('span', null, '识别结果自动纠错（只改错字，数字句跳过）')),
        h('div', { style: { fontSize: 12, opacity: .55, lineHeight: '18px' } },
          '点一下输入框左侧的麦克风进入连续对话；说完停顿自动断句，文字先进输入框，2 秒后自动发送，期间按任意键或点一下即可暂停修改。'),
        h(WhisperSettings),
        h(ExternalForm));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 页面关闭/刷新时确保解除朗读授权
        try {
          const bye = () => {
            try {
              navigator.sendBeacon('/voice-tutor/arm', new Blob([JSON.stringify({ v: 3, on: false })], { type: 'application/json' }));
            } catch { disarm(); }
          };
          window.addEventListener('beforeunload', bye);
          ctx.effect(() => () => window.removeEventListener('beforeunload', bye), 'voice-tutor: unload');
        } catch { /* ignore */ }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'voice-tutor', order: 4,
        }, Panel));
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'voice-chat', label: '语音对话', order: 25,
        }, Settings));
      },
    };
  },
});
