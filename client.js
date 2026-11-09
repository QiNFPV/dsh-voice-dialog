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

    // ---------- 界面文案 ----------
    // 跟随 DSH 主体语言：宿主把当前语言同步到 <html lang>（zh-CN / en-US …）。
    // 非中文一律用英文，缺键时回退中文原文，避免出现空白。
    const MESSAGES = {
      zh: {
        auto: '自动',
        on: '开',
        off: '关',
        checking: '检查中…',
        checkNow: '立即检查',
        never: '从未检查',
        unknown: '未知',
        upToDate: '已是最新',
        hasUpdate: '有新版',
        pleaseWait: '请稍候…',
        save: '保存',
        saved: '已保存',
        saveFailed: '保存失败',
        saveFailedWith: '保存失败：${err}',
        checkDone: '检查完成',
        checkFailedWith: '检查失败：${err}',
        updateStarted: '更新任务已开始',
        updateStartFailedWith: '更新启动失败：${err}',
        labelThinking: '识别中…',
        labelSpeaking: '朗读中…',
        labelOn: '语音对话中',
        labelOff: '语音对话',
        titleLang: '朗读语言（在 设置 → 插件 → 语音对话 里增减）',
        titleStart: '进入语音对话（连续对话）',
        titleStop: '退出语音对话',
        titleWuBadge: '本地 Whisper / 模型有新版，点击查看并更新',
        wuFw: 'Whisper 有新版 ${v}',
        wuModel: '模型有新版',
        notePaused: '已暂停发送，改完按回车',
        noteWillSend: '2 秒后自动发送 · 点一下输入框可修改',
        noteDup: '（重复，已忽略）',
        noteNotHeard: '没听清，请再说一次',
        noteCorrected: '已纠错 · 2 秒后发送',
        noteInputUnavailable: '输入框不可用',
        noteSttFailed: '转写失败：${err}',
        noteMicFailed: '麦克风不可用：${err}',
        noteWuCheckFailed: 'Whisper 检查失败：${err}',
        noteUpdatingFw: '正在更新 faster-whisper…',
        noteDownloadingModel: '正在下载模型…',
        wuTitle: '本地 Whisper 更新',
        wuAuto: '自动检查：${state} · 每 ${n} 小时',
        wuHostDown: '宿主暂未响应（宿主侧改动需要重启 DSH 后生效）',
        wuLastCheck: '上次检查',
        wuModelLabel: '模型',
        localLabel: '本地',
        remoteLabel: '远程',
        wuModelSize: '模型体积',
        wuTips: '提示',
        wuJob: '更新任务',
        wuUpdateFw: '更新 faster-whisper',
        wuDownloadModel: '下载新模型',
        close: '关闭',
        confirmFw: '确定更新 faster-whisper 吗？\n\n将执行：venv python -m pip install -U faster-whisper\n然后重启 127.0.0.1:8789 上的本地识别桥，等待 /health 就绪。\n失败会自动尝试回滚到当前版本。',
        confirmModel: '确定下载新模型吗？${size}\n下载完成后会重启本地识别桥；旧缓存不会删除，失败可回滚。',
        sizeNote: '\n\n体积约 ${size}。',
        extTitle: '外接接口（可选，OpenAI 兼容）',
        extAsrHint: '识别接口：POST {url}，multipart 字段 file 与 model，例如 /v1/audio/transcriptions',
        extAsr: '识别',
        extTtsHint: '合成接口：POST {url}，JSON {model, input, voice}，例如 /v1/audio/speech',
        extTts: '合成',
        phModel: '模型',
        phVoice: '音色',
        extSaveHint: '留空则用内置 Edge TTS 与本地识别',
        wuSectionTitle: '本地 Whisper 更新检查',
        wuSectionHint: '检查 PyPI 上的 faster-whisper 版本和 HuggingFace 上的模型 revision；离线或出错会静默跳过，不影响语音功能。',
        wuAutoLabel: '自动检查本地 Whisper 更新',
        interval: '检查间隔',
        everyNHours: '每 ${n} 小时',
        langSectionTitle: '对话栏里可供选择的语言',
        langSectionHint: '勾选的语言会出现在输入框旁边的下拉里；「自动」始终保留。识别语言始终自动判定。',
        showAllVoices: '显示全部音色（高级）',
        voicePick: '具体音色',
        correctLabel: '识别结果自动纠错（只改错字，数字句跳过）',
        usageHint: '点一下输入框左侧的麦克风进入连续对话；说完停顿自动断句，文字先进输入框，2 秒后自动发送，期间按任意键或点一下即可暂停修改。',
        tabVoice: '语音对话',
      },
      en: {
        auto: 'Auto',
        on: 'on',
        off: 'off',
        checking: 'Checking…',
        checkNow: 'Check now',
        never: 'Never checked',
        unknown: 'Unknown',
        upToDate: 'Up to date',
        hasUpdate: 'Update available',
        pleaseWait: 'Working…',
        save: 'Save',
        saved: 'Saved',
        saveFailed: 'Save failed',
        saveFailedWith: 'Save failed: ${err}',
        checkDone: 'Check complete',
        checkFailedWith: 'Check failed: ${err}',
        updateStarted: 'Update started',
        updateStartFailedWith: 'Failed to start update: ${err}',
        labelThinking: 'Transcribing…',
        labelSpeaking: 'Speaking…',
        labelOn: 'Voice chat on',
        labelOff: 'Voice chat',
        titleLang: 'Speech language (edit in Settings → Plugins → Voice chat)',
        titleStart: 'Start continuous voice chat',
        titleStop: 'Stop voice chat',
        titleWuBadge: 'Whisper / model update available — click to review',
        wuFw: 'Whisper ${v} available',
        wuModel: 'Model update available',
        notePaused: 'Send paused — edit, then press Enter',
        noteWillSend: 'Sending in 2 seconds · click the input to edit',
        noteDup: '(duplicate, ignored)',
        noteNotHeard: "Didn't catch that — please say it again",
        noteCorrected: 'Corrected · sending in 2s',
        noteInputUnavailable: 'Input box unavailable',
        noteSttFailed: 'Transcription failed: ${err}',
        noteMicFailed: 'Microphone unavailable: ${err}',
        noteWuCheckFailed: 'Whisper check failed: ${err}',
        noteUpdatingFw: 'Updating faster-whisper…',
        noteDownloadingModel: 'Downloading model…',
        wuTitle: 'Local Whisper update',
        wuAuto: 'Auto-check: ${state} · every ${n}h',
        wuHostDown: 'Host not responding yet (host-side changes need a DSH restart)',
        wuLastCheck: 'Last check',
        wuModelLabel: 'Model',
        localLabel: 'local',
        remoteLabel: 'remote',
        wuModelSize: 'Model size',
        wuTips: 'Notes',
        wuJob: 'Update job',
        wuUpdateFw: 'Update faster-whisper',
        wuDownloadModel: 'Download model',
        close: 'Close',
        confirmFw: 'Update faster-whisper?\n\nThis runs: venv python -m pip install -U faster-whisper\nthen restarts the local ASR bridge on 127.0.0.1:8789 and waits for /health. On failure it tries to roll back to the current version.',
        confirmModel: 'Download the new model?${size}\nThe local ASR bridge restarts afterwards; the old cache is kept, so a failure can be rolled back.',
        sizeNote: '\n\nAbout ${size}.',
        extTitle: 'External endpoints (optional, OpenAI-compatible)',
        extAsrHint: 'Speech-to-text: POST {url}, multipart fields file and model, e.g. /v1/audio/transcriptions',
        extAsr: 'STT',
        extTtsHint: 'Text-to-speech: POST {url}, JSON {model, input, voice}, e.g. /v1/audio/speech',
        extTts: 'TTS',
        phModel: 'model',
        phVoice: 'voice',
        extSaveHint: 'Leave empty to use the built-in Edge TTS and local speech recognition',
        wuSectionTitle: 'Local Whisper update check',
        wuSectionHint: 'Checks the faster-whisper version on PyPI and the model revision on HuggingFace. Offline or failing checks are skipped silently and never affect voice features.',
        wuAutoLabel: 'Auto-check for local Whisper updates',
        interval: 'Interval',
        everyNHours: 'Every ${n}h',
        langSectionTitle: 'Languages offered in the composer',
        langSectionHint: 'Checked languages appear in the dropdown next to the input; “Auto” is always kept. The recognition language is always detected automatically.',
        showAllVoices: 'Show all voices (advanced)',
        voicePick: 'Voice',
        correctLabel: 'Auto-correct transcriptions (typos only, numeric sentences skipped)',
        usageHint: 'Click the microphone left of the input to start continuous chat: a pause ends the sentence, the text lands in the input, and it is sent after 2 seconds — press any key or click to pause and edit.',
        tabVoice: 'Voice chat',
      },
    };

    const uiLang = () => {
      try {
        const l = String((document.documentElement && document.documentElement.getAttribute('lang')) || '').toLowerCase();
        if (l) return l.startsWith('zh') ? 'zh' : 'en';
        return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch { return 'zh'; }
    };

    const t = (key, vars) => {
      const dict = MESSAGES[uiLang()] || MESSAGES.en;
      let text = dict[key] !== undefined ? dict[key] : (MESSAGES.zh[key] !== undefined ? MESSAGES.zh[key] : key);
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.split('${' + k + '}').join(String(v));
      return text;
    };

    // 语言切换后让已渲染的 React 组件重画（宿主改的是 <html lang>）
    const LANG_LISTENERS = new Set();
    const notifyLang = () => { for (const f of LANG_LISTENERS) { try { f(); } catch {} } };
    const useUiLang = () => {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((n) => n + 1);
        LANG_LISTENERS.add(f);
        return () => { LANG_LISTENERS.delete(f); };
      }, []);
      return uiLang();
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
      if (!iso) return t('never');
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
    };
    const wuBadgeText = () => {
      const r = wuStatus && wuStatus.result;
      if (!r || !r.hasUpdate) return '';
      const parts = [];
      if (r.fastwhisper && r.fastwhisper.hasUpdate) parts.push(t('wuFw', { v: r.fastwhisper.latest || '' }));
      if (r.model && r.model.hasUpdate) parts.push(t('wuModel'));
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
      if (btn) { btn.disabled = true; btn.textContent = t('checking'); }
      try {
        const r = await fetch('/voice-tutor/whisper-update/check', { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        if (d.ok) wuStatus = d;
        emit();
        return d;
      } catch (e) {
        note(t('noteWuCheckFailed', { err: String(e && e.message || e) }));
        return null;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = t('checkNow'); }
      }
    };

    // 更新动作：二次确认（confirm）后才向后端发 confirm: true
    const applyWhisper = async (target) => {
      const r = (wuStatus && wuStatus.result) || {};
      if (target === 'fastwhisper') {
        const ok = window.confirm(t('confirmFw'));
        if (!ok) return;
      } else {
        const size = fmtBytes(r.model && r.model.sizeBytes);
        const ok = window.confirm(t('confirmModel', { size: size ? t('sizeNote', { size }) : '' }));
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
        note(target === 'fastwhisper' ? t('noteUpdatingFw') : t('noteDownloadingModel'));
        loadWu(true);
        startWuPolling();
      } catch (e) {
        window.alert(t('updateStartFailedWith', { err: String(e && e.message || e) }));
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

        box.appendChild(el('div', 'font-size:15px;font-weight:600;margin-bottom:2px;', t('wuTitle')));
        box.appendChild(el('div', 'font-size:11px;opacity:.5;margin-bottom:10px;',
          st ? t('wuAuto', { state: t(st.enabled ? 'on' : 'off'), n: st.intervalHours || 24 })
            : t('wuHostDown')));

        const body = el('div', 'display:flex;flex-direction:column;gap:4px;');
        body.appendChild(line(t('wuLastCheck'), fmtTime(st && st.lastCheckAt)));
        body.appendChild(line('faster-whisper',
          (fw.installed || t('unknown')) + ' → ' + (fw.latest || t('unknown')) + ' · '
          + (fw.hasUpdate ? t('hasUpdate') : (fw.installed && fw.latest ? t('upToDate') : t('unknown'))),
          fw.hasUpdate ? '#f5b544' : ''));
        body.appendChild(line(t('wuModelLabel'),
          (md.repo || '') + ' · ' + t('localLabel') + ' ' + (shortRev(md.localRevision) || '—')
          + ' · ' + t('remoteLabel') + ' ' + (shortRev(md.remoteRevision) || '—') + ' · '
          + (md.hasUpdate ? t('hasUpdate') : (md.localRevision && md.remoteRevision ? t('upToDate') : t('unknown'))),
          md.hasUpdate ? '#f5b544' : ''));
        if (md.sizeBytes) body.appendChild(line(t('wuModelSize'), fmtBytes(md.sizeBytes)));
        if (r && r.errors && r.errors.length) {
          body.appendChild(line(t('wuTips'), r.errors.slice(0, 2).join(' / '), '#f59e0b'));
        }
        if (job) {
          body.appendChild(line(t('wuJob'),
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
        const checkBtn = mkBtn(t('checkNow'), () => checkWhisperNow(checkBtn));
        row.appendChild(checkBtn);
        if (r && fw.hasUpdate) {
          row.appendChild(mkBtn(t('wuUpdateFw'), () => applyWhisper('fastwhisper'), true));
        }
        if (r && md.hasUpdate) {
          row.appendChild(mkBtn(t('wuDownloadModel'), () => applyWhisper('model'), true));
        }
        row.appendChild(mkBtn(t('close'), () => closeWhisperDialog()));
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
      note(t('notePaused'));
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
      note(t('noteWillSend'));
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
        if (d.dup) { note(t('noteDup')); return; }
        const text = String(d.text || '').trim();
        if (!text) { note(t('noteNotHeard')); return; }
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
            note(t('noteCorrected'));
          }).catch(() => {});
        } else note(t('noteInputUnavailable'));
      } catch (e) {
        note(t('noteSttFailed', { err: String(e && e.message || e) }));
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
        note(t('noteMicFailed', { err: String(e && e.message || e) }));
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
      useUiLang();
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
        { id: 'auto', label: t('auto') },
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

      const label = E.state === 'thinking' ? t('labelThinking')
        : E.state === 'speaking' ? t('labelSpeaking')
        : on ? t('labelOn') : t('labelOff');

      const ring = Math.min(1, E.level * 18);
      // 语言 chip：只列出用户在设置里勾选过的语言
      const langItems = [{ id: 'auto', label: t('auto') }]
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
          title: t('titleLang'),
          onClick: (e) => openMenu(e.currentTarget.getBoundingClientRect(), langItems, curId, pickLangChip),
        }, curLabel, ' ▾'),
        h('button', {
          type: 'button',
          onClick: () => (on ? stop() : start()),
          title: on ? t('titleStop') : t('titleStart'),
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
          title: t('titleWuBadge'),
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
      useUiLang();
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
          setMsg(r.ok ? t('saved') : t('saveFailed'));
        } catch { setMsg(t('saveFailed')); }
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
        h('div', { style: { fontSize: 13, opacity: .85 } }, t('extTitle')),
        h('div', { style: hint }, t('extAsrHint')),
        h('div', { style: line },
          h('span', { style: { width: 46, opacity: .7 } }, t('extAsr')),
          h('input', { style: inp, placeholder: 'URL', value: (cfg.asr || {}).url || '', onChange: (e) => set('asr', 'url', e.target.value) }),
          h('input', { style: inp, placeholder: 'API Key', type: 'password', value: (cfg.asr || {}).key || '', onChange: (e) => set('asr', 'key', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 150 }, placeholder: t('phModel'), value: (cfg.asr || {}).model || '', onChange: (e) => set('asr', 'model', e.target.value) })),
        h('div', { style: hint }, t('extTtsHint')),
        h('div', { style: line },
          h('span', { style: { width: 46, opacity: .7 } }, t('extTts')),
          h('input', { style: inp, placeholder: 'URL', value: (cfg.tts || {}).url || '', onChange: (e) => set('tts', 'url', e.target.value) }),
          h('input', { style: inp, placeholder: 'API Key', type: 'password', value: (cfg.tts || {}).key || '', onChange: (e) => set('tts', 'key', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 120 }, placeholder: t('phModel'), value: (cfg.tts || {}).model || '', onChange: (e) => set('tts', 'model', e.target.value) }),
          h('input', { style: { ...inp, maxWidth: 110 }, placeholder: t('phVoice'), value: (cfg.tts || {}).voice || '', onChange: (e) => set('tts', 'voice', e.target.value) })),
        h('div', { style: { ...line, gap: 10 } },
          h('button', {
            type: 'button', onClick: save,
            style: {
              height: 28, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l2,#444)', background: 'transparent', color: 'inherit',
            },
          }, t('save')),
          h('span', { style: { ...hint, opacity: .7 } }, msg || t('extSaveHint'))),
      );
    }

    // ---------- 设置页：本地 Whisper 更新检查 ----------
    function WhisperSettings() {
      useUiLang();
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
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
      }, []);

      const save = async (patch) => {
        const next = { ...(cfg || { enabled: true, intervalHours: 24 }), ...patch };
        setCfg(next);
        try {
          await getJson('/voice-tutor/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ whisperUpdate: { enabled: next.enabled, intervalHours: Number(next.intervalHours) || 24 } }),
          });
          setMsg(t('saved'));
          setTimeout(() => setMsg(''), 2000);
          load();
        } catch (e) {
          setMsg(t('saveFailedWith', { err: String(e && e.message || e) }));
        }
      };

      const checkNow = async () => {
        setBusy(true);
        setMsg(t('checking'));
        try {
          const d = await getJson('/voice-tutor/whisper-update/check', { method: 'POST' });
          setSt(d);
          setMsg(t('checkDone'));
        } catch (e) {
          setMsg(t('checkFailedWith', { err: String(e && e.message || e) }));
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
          ? window.confirm(t('confirmFw'))
          : window.confirm(t('confirmModel', { size: md.sizeBytes ? t('sizeNote', { size: fmtBytes(md.sizeBytes) }) : '' }));
        if (!ok) return;
        setBusy(true);
        try {
          await getJson('/voice-tutor/whisper-update/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, confirm: true }),
          });
          setMsg(t('updateStarted'));
          load();
        } catch (e) {
          setMsg(t('updateStartFailedWith', { err: String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      };

      const status = st
        ? t('wuAuto', { state: t(st.enabled ? 'on' : 'off'), n: st.intervalHours || 24 })
        : t('wuHostDown');
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2,#333)' },
      },
        h('div', { style: { fontSize: 13, opacity: .85 } }, t('wuSectionTitle')),
        h('div', { style: hint }, t('wuSectionHint')),
        h('label', { style: { ...row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: cfg.enabled !== false,
            onChange: () => save({ enabled: cfg.enabled === false }),
          }),
          h('span', null, t('wuAutoLabel'))),
        h('div', { style: row },
          h('span', { style: { ...hint, width: 96 } }, t('interval')),
          h('select', {
            value: Number(cfg.intervalHours) || 24,
            style: {
              height: 30, minWidth: 140, borderRadius: 8, padding: '0 8px', fontSize: 13,
              border: '1px solid var(--dsw-alias-border-l2,#444)',
              background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit',
            },
            onChange: (e) => save({ intervalHours: Number(e.target.value) }),
          }, [6, 12, 24, 72].map((n) => h('option', { key: n, value: n }, t('everyNHours', { n }))))),
        h('div', { style: row },
          h('button', { type: 'button', style: btnStyle, disabled: busy, onClick: checkNow },
            busy ? t('pleaseWait') : t('checkNow')),
          h('span', { style: { ...hint, opacity: .7 } }, msg || status)),
        h('div', { style: box },
          line(t('wuLastCheck'), fmtTime(st && st.lastCheckAt)),
          line('faster-whisper', (fw.installed || t('unknown')) + ' → ' + (fw.latest || t('unknown')) + ' · '
            + (fw.hasUpdate ? t('hasUpdate') : (fw.installed && fw.latest ? t('upToDate') : t('unknown'))),
            fw.hasUpdate ? '#f5b544' : ''),
          line(t('wuModelLabel'), (md.repo || '—') + ' · ' + t('localLabel') + ' ' + (shortRev(md.localRevision) || '—')
            + ' · ' + t('remoteLabel') + ' ' + (shortRev(md.remoteRevision) || '—') + ' · '
            + (md.hasUpdate ? t('hasUpdate') : (md.localRevision && md.remoteRevision ? t('upToDate') : t('unknown'))),
            md.hasUpdate ? '#f5b544' : ''),
          md.sizeBytes ? line(t('wuModelSize'), fmtBytes(md.sizeBytes)) : null,
          w && w.errors && w.errors.length ? line(t('wuTips'), w.errors.slice(0, 2).join(' / '), '#f59e0b') : null,
          job ? line(t('wuJob'), (job.phase || '')
            + (job.percent !== null && job.percent !== undefined ? ' ' + job.percent + '%' : '')
            + (job.error ? ' × ' + job.error : ''), job.error ? '#ef4444' : '') : null,
          (w && (fw.hasUpdate || md.hasUpdate)) ? h('div', { style: { ...row, marginTop: 6 } },
            fw.hasUpdate ? h('button', {
              type: 'button', disabled: busy, onClick: () => apply('fastwhisper'),
              style: { ...btnStyle, borderColor: '#f5b544', color: '#f5b544' },
            }, t('wuUpdateFw')) : null,
            md.hasUpdate ? h('button', {
              type: 'button', disabled: busy, onClick: () => apply('model'),
              style: { ...btnStyle, borderColor: '#f5b544', color: '#f5b544' },
            }, t('wuDownloadModel')) : null) : null));
    }

    // ---------- 设置面板（设置 → 插件 → 语音对话）----------
    function Settings() {
      useUiLang();
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((x) => x + 1);
        E.listeners.add(f);
        ensureVoices();
        return () => { E.listeners.delete(f); };
      }, []);

      const SIMPLE = [
        { id: 'auto', label: t('auto') },
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
          h('div', { style: { fontSize: 13, opacity: .85 } }, t('langSectionTitle')),
          h('div', { style: { fontSize: 12, opacity: .5 } }, t('langSectionHint')),
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
          h('span', null, t('showAllVoices'))),
        adv ? h('div', { style: { ...row } },
          h('span', { style: { width: 96, opacity: .8 } }, t('voicePick')),
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
          h('span', null, t('correctLabel'))),
        h('div', { style: { fontSize: 12, opacity: .55, lineHeight: '18px' } },
          t('usageHint')),
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
          name: 'settings.plugins.tab', id: 'voice-chat', label: t('tabVoice'), order: 25,
        }, Settings));
        // 宿主切换界面语言时只改 <html lang>，这里跟一下，让已渲染的文案重画
        try {
          const root = document.documentElement;
          const mo = new MutationObserver(() => { notifyLang(); emit(); });
          mo.observe(root, { attributes: true, attributeFilter: ['lang'] });
          notifyLang();
          ctx.effect(() => () => mo.disconnect(), 'voice-tutor: lang');
        } catch { /* ignore */ }
      },
    };
  },
});
