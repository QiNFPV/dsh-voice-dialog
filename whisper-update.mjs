// 本地 Whisper 更新检查（宿主侧，只用 Node 内置能力，不引入新依赖）
//
// 检查两样东西：
//   1. faster-whisper 这个 Python 包的版本（PyPI 最新 vs venv 里实际安装）
//   2. 本地 Whisper 模型在 HuggingFace 上的 revision（远程 sha vs 本地 refs/main）
//
// 设计约束：
//   - 所有网络请求都有超时（默认 8 秒），离线/出错只返回错误字段，不抛到语音主流程
//   - 安装版本检测失败可容忍：python → site-packages → 未知
//   - 更新动作只在用户显式确认后执行；失败不删旧缓存，尽量回滚
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

export const DEFAULT_MODEL_REPO = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo';

// faster-whisper 的模型名 → HuggingFace 仓库。ASR_MODEL 与 server.py 保持一致。
const MODEL_REPOS = {
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'large-v3': 'Systran/faster-whisper-large-v3',
  'large-v2': 'Systran/faster-whisper-large-v2',
  'large-v1': 'Systran/faster-whisper-large-v1',
  medium: 'Systran/faster-whisper-medium',
  small: 'Systran/faster-whisper-small',
  base: 'Systran/faster-whisper-base',
  tiny: 'Systran/faster-whisper-tiny',
  'distil-large-v3': 'Systran/faster-distil-whisper-large-v3',
};

/** 模型仓库名：ASR_MODEL_REPO 优先，其次由 ASR_MODEL（默认 large-v3-turbo）映射 */
export function resolveModelRepo(env = process.env) {
  const explicit = String(env.ASR_MODEL_REPO || '').trim();
  if (explicit) return explicit.replace(/^\/+|\/+$/g, '');
  const name = String(env.ASR_MODEL || 'large-v3-turbo').trim();
  if (name.includes('/')) return name.replace(/^\/+|\/+$/g, '');
  return MODEL_REPOS[name] || `mobiuslabsgmbh/faster-whisper-${name}`;
}

/** HuggingFace hub 缓存根目录，尊重 HF_HOME / HF_HUB_CACHE / HUGGINGFACE_HUB_CACHE */
export function hfCacheDir(env = process.env) {
  if (env.HF_HUB_CACHE) return path.resolve(env.HF_HUB_CACHE);
  if (env.HUGGINGFACE_HUB_CACHE) return path.resolve(env.HUGGINGFACE_HUB_CACHE);
  const base = env.HF_HOME
    ? path.resolve(env.HF_HOME)
    : path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(HOME, '.cache'), 'huggingface');
  return path.join(base, 'hub');
}

function repoCacheName(repo) {
  return 'models--' + repo.replace(/\//g, '--');
}

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return (x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i];
}

/** 比较两个版本号；a > b 返回 1，相等 0，a < b 返回 -1（够用的数字段比较） */
export function compareVersions(a, b) {
  const pa = String(a || '').trim().replace(/^v/i, '').split(/[.+-]/);
  const pb = String(b || '').trim().replace(/^v/i, '').split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const xa = pa[i] === undefined ? '0' : pa[i];
    const xb = pb[i] === undefined ? '0' : pb[i];
    const na = /^\d+$/.test(xa) ? Number(xa) : NaN;
    const nb = /^\d+$/.test(xb) ? Number(xb) : NaN;
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (xa !== xb) {
      // 预发布后缀：数字段之后出现的字符串按字典序，稳定即可
      return xa > xb ? 1 : -1;
    }
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 跑一个子进程并收集输出（无 shell，避免引号/注入问题） */
export function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    let child;
    const finish = (code, extra = {}) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, ...extra });
    };
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), error: String(e && e.message || e) });
    }
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish(-1, { error: String(e && e.message || e) }));
    child.on('close', (code) => finish(code));
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(-1, { timedOut: true });
      }, opts.timeoutMs);
    }
  });
}

async function fetchJson(url, timeoutMs = 8000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'dsh-voice-dialog/whisper-update-checker' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function sitePackagesDirs(pythonPath) {
  const root = path.dirname(path.dirname(pythonPath));   // <venv>/Scripts/python.exe → <venv>
  const dirs = [path.join(root, 'Lib', 'site-packages')];
  try {
    const libs = await fs.readdir(path.join(root, 'lib'));
    for (const d of libs) if (/^python\d/.test(d)) dirs.push(path.join(root, 'lib', d, 'site-packages'));
  } catch { /* Windows 没有 lib，正常 */ }
  return dirs.filter((d) => existsSync(d));
}

/**
 * 检测 venv 里实际安装的 faster-whisper 版本。
 * 优先问 python；拿不到再翻 site-packages；都失败返回 null（“未知”）。
 */
export async function detectFasterWhisper(pythonPath, timeoutMs = 6000) {
  const script = 'import faster_whisper;print(faster_whisper.__version__)';
  const r = await execCapture(pythonPath, ['-c', script], { timeoutMs });
  const out = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (r.code === 0 && /^\d+\.\d+/.test(out)) {
    return { version: out, source: 'python', error: '' };
  }
  const reason = (r.stderr || r.error || (r.timedOut ? 'python 检测超时' : '')).trim().slice(0, 300);
  let firstError = reason;
  for (const dir of await sitePackagesDirs(pythonPath)) {
    try {
      const init = await fs.readFile(path.join(dir, 'faster_whisper', '__init__.py'), 'utf8');
      const m = init.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
      if (m) return { version: m[1], source: 'site-packages', error: reason };
    } catch { /* 继续找 dist-info */ }
    try {
      const names = await fs.readdir(dir);
      const hit = names.find((n) => /^faster_whisper-[\d][^/]*\.dist-info$/i.test(n));
      if (hit) {
        const v = hit.replace(/^faster_whisper-/i, '').replace(/\.dist-info$/i, '');
        if (/^\d+\.\d+/.test(v)) return { version: v, source: 'dist-info', error: reason };
      }
    } catch { /* ignore */ }
  }
  if (!reason) firstError = '未检测到 faster-whisper';
  return { version: null, source: 'unknown', error: firstError };
}

/** 读本地模型缓存里的 refs/main */
export async function readLocalRevision(repo, cacheDir) {
  const dir = path.join(cacheDir, repoCacheName(repo));
  try {
    const rev = (await fs.readFile(path.join(dir, 'refs', 'main'), 'utf8')).trim();
    if (rev) return { revision: rev, dir, error: '' };
  } catch { /* 继续尝试 snapshots */ }
  try {
    const snaps = await fs.readdir(path.join(dir, 'snapshots'));
    if (snaps.length) {
      let best = snaps[0];
      let bestAt = 0;
      for (const s of snaps) {
        try {
          const st = await fs.stat(path.join(dir, 'snapshots', s));
          if (st.mtimeMs > bestAt) { bestAt = st.mtimeMs; best = s; }
        } catch { /* ignore */ }
      }
      return { revision: best, dir, error: '没有 refs/main，使用最近的 snapshot' };
    }
  } catch { /* ignore */ }
  return { revision: '', dir, error: '本地缓存里没有该模型' };
}

async function pypiLatestVersion(timeoutMs = 8000) {
  const d = await fetchJson('https://pypi.org/pypi/faster-whisper/json', timeoutMs);
  const v = String((d && d.info && d.info.version) || '').trim();
  if (!v) throw new Error('PyPI 返回里没有 info.version');
  return v;
}

async function hfModelInfo(repo, timeoutMs = 8000) {
  const url = 'https://huggingface.co/api/models/'
    + repo.split('/').map(encodeURIComponent).join('/')
    + '?blobs=true';
  const d = await fetchJson(url, timeoutMs);
  const sha = String((d && d.sha) || '').trim();
  if (!sha) throw new Error('HuggingFace 返回里没有 sha');
  let size = 0;
  for (const s of (d.siblings || [])) {
    const n = Number(s.size || (s.lfs && s.lfs.size) || 0);
    if (Number.isFinite(n) && n > 0) size += n;
  }
  return { sha, size, lastModified: String(d.lastModified || '') };
}

function shortError(e) {
  return String((e && e.message) || e || '').slice(0, 240);
}

/**
 * 检查是否有更新。永不抛异常；结果里带 errors 数组。
 * @returns {Promise<{checkedAt:string,hasUpdate:boolean,fastwhisper:object,model:object,errors:string[]}>}
 */
export async function checkWhisperUpdates(opts = {}) {
  const venvPython = opts.venvPython || '';
  const repo = opts.repo || resolveModelRepo();
  const cacheDir = opts.cacheDir || hfCacheDir();
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 8000, 8000));
  const checkedAt = new Date().toISOString();
  const errors = [];

  const [fwR, pyR, localR, hfR] = await Promise.allSettled([
    venvPython ? detectFasterWhisper(venvPython, Math.min(timeoutMs, 6000)) : Promise.resolve({ version: null, source: 'unknown', error: '没有配置 venv python' }),
    pypiLatestVersion(timeoutMs),
    readLocalRevision(repo, cacheDir),
    hfModelInfo(repo, timeoutMs),
  ]);

  const fw = fwR.status === 'fulfilled' ? fwR.value : { version: null, source: 'unknown', error: shortError(fwR.reason) };
  if (fw.error && fw.version) errors.push('安装版本检测：' + fw.error);
  if (!fw.version) errors.push(fw.error || 'faster-whisper 版本未知');
  let latest = null;
  if (pyR.status === 'fulfilled') latest = pyR.value;
  else errors.push('PyPI 查询失败：' + shortError(pyR.reason));

  const local = localR.status === 'fulfilled' ? localR.value : { revision: '', dir: '', error: shortError(localR.reason) };
  if (local.error && !local.revision) errors.push(local.error);
  let remote = { sha: '', size: 0, lastModified: '' };
  if (hfR.status === 'fulfilled') remote = hfR.value;
  else errors.push('HuggingFace 查询失败：' + shortError(hfR.reason));

  const fwHas = Boolean(fw.version && latest && compareVersions(latest, fw.version) > 0);
  const mHas = Boolean(local.revision && remote.sha && local.revision !== remote.sha);

  return {
    checkedAt,
    hasUpdate: fwHas || mHas,
    fastwhisper: {
      installed: fw.version || null,
      latest: latest || null,
      hasUpdate: fwHas,
      source: fw.source || 'unknown',
      error: fw.error || '',
    },
    model: {
      repo,
      localRevision: local.revision || '',
      remoteRevision: remote.sha || '',
      hasUpdate: mHas,
      sizeBytes: remote.size || 0,
      lastModified: remote.lastModified || '',
      cacheDir,
      error: local.error && !local.revision ? local.error : '',
    },
    errors,
  };
}

async function pipInstall(pythonPath, spec, onProgress) {
  if (onProgress) onProgress('正在安装 ' + spec + '…（可能需要几分钟）');
  const r = await execCapture(pythonPath, ['-m', 'pip', 'install', '-U', spec], { timeoutMs: 600000 });
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout || r.error || '')
      .split(/\r?\n/).filter(Boolean).slice(-5).join(' | ').slice(0, 600);
    throw new Error('pip install ' + spec + ' 失败（exit ' + r.code + '）：' + (tail || '没有输出'));
  }
  return r;
}

/** 找监听指定端口的进程（只返回 PID 列表，不杀） */
export async function findListeningPids(port) {
  const pids = new Set();
  if (IS_WIN) {
    const r = await execCapture('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ], { timeoutMs: 10000 });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
    if (pids.size) return [...pids];
    // 没有 PowerShell 或命令不可用时退回 netstat
    const n = await execCapture('netstat', ['-ano'], { timeoutMs: 10000 });
    for (const line of (n.stdout || '').split(/\r?\n/)) {
      if (!/\bTCP\b/i.test(line) || !/LISTEN/i.test(line)) continue;
      if (!new RegExp('[:.]' + Number(port) + '\\s').test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  const r = await execCapture('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 10000 });
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
}

async function processCommandLine(pid) {
  if (IS_WIN) {
    const r = await execCapture('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue).CommandLine`,
    ], { timeoutMs: 8000 });
    return (r.stdout || '').trim();
  }
  const r = await execCapture('ps', ['-p', String(Number(pid)), '-o', 'command='], { timeoutMs: 8000 });
  return (r.stdout || '').trim();
}

async function waitPortFree(port, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await findListeningPids(port)).length === 0) return true;
    await sleep(500);
  }
  return false;
}

function silenceWav(ms = 400) {
  const n = Math.max(1600, Math.round(16000 * ms / 1000));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/**
 * 等 /health 变 ok。刚重启的桥是懒加载模型，health.ok 只有在第一次转写后才会变 true，
 * 所以进程起来后用一小段静音音频做一次“热身”，把模型加载出来（不写入任何用户数据）。
 */
export async function waitAsrHealthy(asrHealth, timeoutMs = 180000, transcribeUrl = '') {
  const start = Date.now();
  let last = '';
  let warmed = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(asrHealth, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        if (d.ok === true) return { ok: true, model: d.model || '', ms: Date.now() - start };
        if (d.error) throw new Error('识别桥模型加载失败：' + String(d.error).slice(0, 240));
        last = '模型还在加载';
        if (!warmed && transcribeUrl) {
          warmed = true;
          try {
            await fetch(transcribeUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: silenceWav(400).toString('base64'), language: 'en' }),
              signal: AbortSignal.timeout(120000),
            });
          } catch { /* 热身失败不影响继续等 health */ }
        }
      } else {
        last = 'HTTP ' + r.status;
      }
    } catch (e) {
      last = String((e && e.message) || e).slice(0, 160);
    }
    await sleep(1200);
  }
  throw new Error('识别桥 ' + Math.round(timeoutMs / 1000) + ' 秒内没有就绪' + (last ? '：' + last : ''));
}

/**
 * 只结束监听指定端口的 server.py，然后用同样的命令行重新拉起并等健康。
 * 端口被非 server.py 程序占用时拒绝操作，避免误杀。
 */
export async function restartAsrBridge(opts = {}) {
  const { serverPy, venvPython, asrHealth, transcribeUrl } = opts;
  const port = Number(opts.port) || 8789;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  if (!serverPy || !existsSync(serverPy)) throw new Error('未找到本地 ASR 桥：' + (serverPy || '(空)'));
  if (!venvPython || !existsSync(venvPython)) throw new Error('未找到 venv python：' + (venvPython || '(空)'));

  const pids = await findListeningPids(port);
  if (pids.length) {
    for (const pid of pids) {
      const cmd = await processCommandLine(pid);
      if (!cmd || !/server\.py/i.test(cmd)) {
        throw new Error('端口 ' + port + ' 被其它程序占用（PID ' + pid + '），已停止操作，未杀任何进程');
      }
    }
    for (const pid of pids) {
      onProgress('停止旧识别桥进程 ' + pid + '…');
      try { process.kill(pid); } catch { /* 可能已经退出 */ }
    }
    if (!(await waitPortFree(port, 12000))) {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      if (!(await waitPortFree(port, 6000))) {
        throw new Error('端口 ' + port + ' 仍被占用，无法重启识别桥');
      }
    }
  }

  onProgress('启动识别桥…');
  const child = spawn(venvPython, [serverPy], {
    cwd: path.dirname(serverPy),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  const health = await waitAsrHealthy(asrHealth, Number(opts.waitMs) || 180000, transcribeUrl);
  return { ...health, pids };
}

/**
 * 更新 faster-whisper：pip install -U → 重启桥 → 等 health。
 * 桥起不来时尝试装回旧版本并再重启一次；旧版本号未知则只报错，不动环境。
 */
export async function applyFasterWhisperUpdate(opts = {}) {
  const { venvPython, serverPy, asrHealth, transcribeUrl } = opts;
  const port = Number(opts.port) || 8789;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  if (!venvPython || !existsSync(venvPython)) throw new Error('未找到 venv python：' + (venvPython || '(空)'));
  if (!serverPy || !existsSync(serverPy)) throw new Error('未找到本地 ASR 桥：' + (serverPy || '(空)'));

  const before = String(opts.previousVersion || '').trim()
    || (await detectFasterWhisper(venvPython, 6000)).version
    || '';

  await pipInstall(venvPython, 'faster-whisper', onProgress);
  const after = (await detectFasterWhisper(venvPython, 6000)).version || '';
  if (before && after && compareVersions(after, before) < 0) {
    onProgress('pip 装上的版本比原来旧（' + after + '），继续尝试启动…');
  }

  onProgress('重启本地识别桥…');
  try {
    await restartAsrBridge({ serverPy, venvPython, port, asrHealth, transcribeUrl, onProgress });
  } catch (e) {
    let rollback = '';
    if (before) {
      onProgress('新版本启动失败，正在回滚到 ' + before + '…');
      try {
        await pipInstall(venvPython, 'faster-whisper==' + before, onProgress);
        await restartAsrBridge({ serverPy, venvPython, port, asrHealth, transcribeUrl, onProgress });
        rollback = '已回滚到 ' + before + ' 并重新启动识别桥';
      } catch (e2) {
        rollback = '回滚也失败：' + shortError(e2);
      }
    }
    throw new Error('faster-whisper 已更新为 ' + (after || '新版本') + '，但识别桥启动失败：'
      + shortError(e) + (rollback ? '；' + rollback : '；请手动检查 asr-bridge 日志'));
  }
  return { version: after || '新版本', previousVersion: before };
}

const DOWNLOAD_PY = String.raw`
import sys
repo, rev, cache = sys.argv[1], sys.argv[2], sys.argv[3]
from huggingface_hub import snapshot_download
kw = {}
try:
    from tqdm.auto import tqdm
    class P(tqdm):
        done = 0
        last = -1
        def update(self, n=1):
            try:
                P.done += max(0, int(n))
            except Exception:
                pass
            mb = P.done // (8 * 1024 * 1024)
            if mb != P.last:
                P.last = mb
                print("PROGRESS", P.done, flush=True)
            return super().update(n)
    kw["tqdm_class"] = P
except Exception:
    pass
p = snapshot_download(repo_id=repo, revision=rev, cache_dir=cache, max_workers=4, **kw)
print("DONE", p, flush=True)
`;

function runDownload(opts = {}) {
  const { venvPython, repo, revision, cacheDir, sizeBytes } = opts;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let tail = '';
    let done = false;
    let child;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    try {
      child = spawn(venvPython, ['-c', DOWNLOAD_PY, repo, revision, cacheDir], {
        env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error('下载模型超时（30 分钟）'));
    }, 1800000);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/^PROGRESS\s+(\d+)/);
        if (m) {
          const got = Number(m[1]);
          const pct = sizeBytes ? Math.min(99, Math.round((got / sizeBytes) * 100)) : null;
          onProgress('正在下载模型…' + formatBytes(got) + (sizeBytes ? ' / ' + formatBytes(sizeBytes) : ''), pct);
        } else if (line.startsWith('DONE ')) {
          tail = line.slice(5).trim();
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (done) return;
      if (code !== 0 || !tail) {
        const msg = (stderr || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ').slice(0, 800);
        return finish(new Error('模型下载失败（exit ' + code + '）：' + (msg || '没有输出')));
      }
      finish(null, { snapshotPath: tail });
    });
  });
}

/**
 * 更新模型：按远程 revision 重新下载到同一个 HF 缓存（不删旧 snapshot），
 * 然后重启桥。桥起不来就把 refs/main 指回旧 revision 再重启。
 */
export async function applyModelUpdate(opts = {}) {
  const { venvPython, repo, revision, cacheDir, serverPy, asrHealth, transcribeUrl } = opts;
  const port = Number(opts.port) || 8789;
  const sizeBytes = Number(opts.sizeBytes) || 0;
  const previousRevision = String(opts.previousRevision || '').trim();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  if (!venvPython || !existsSync(venvPython)) throw new Error('未找到 venv python：' + (venvPython || '(空)'));
  if (!repo || !revision) throw new Error('缺少模型仓库或远程 revision');
  if (!serverPy || !existsSync(serverPy)) throw new Error('未找到本地 ASR 桥：' + (serverPy || '(空)'));

  onProgress('正在下载模型 ' + repo + ' @ ' + revision.slice(0, 8)
    + (sizeBytes ? '（约 ' + formatBytes(sizeBytes) + '）' : '') + '…', 0);
  const dl = await runDownload({ venvPython, repo, revision, cacheDir, sizeBytes, onProgress });

  // snapshot_download(revision=<sha>) 只会写 refs/<sha>，不会移动 refs/main；
  // 这里显式把 refs/main 指向新 revision，桥才会加载新模型。
  const dir = path.join(cacheDir, repoCacheName(repo));
  const snapDir = path.join(dir, 'snapshots', revision);
  if (!existsSync(snapDir)) {
    throw new Error('下载完成但找不到 snapshot 目录 ' + snapDir + '，未重启识别桥');
  }
  await fs.mkdir(path.join(dir, 'refs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'refs', 'main'), revision + '\n');
  const local = await readLocalRevision(repo, cacheDir);
  if (local.revision !== revision) {
    throw new Error('下载完成但本地 refs/main 仍是 ' + (local.revision || '空') + '，未重启识别桥');
  }
  onProgress('模型下载完成，重启本地识别桥…');
  try {
    await restartAsrBridge({ serverPy, venvPython, port, asrHealth, transcribeUrl, onProgress });
  } catch (e) {
    let rollback = '';
    if (previousRevision) {
      onProgress('新模型启动失败，正在回滚到 ' + previousRevision.slice(0, 8) + '…');
      try {
        const dir = path.join(cacheDir, repoCacheName(repo));
        await fs.mkdir(path.join(dir, 'refs'), { recursive: true });
        await fs.writeFile(path.join(dir, 'refs', 'main'), previousRevision + '\n');
        await restartAsrBridge({ serverPy, venvPython, port, asrHealth, transcribeUrl, onProgress });
        rollback = '已回滚到旧模型 ' + previousRevision.slice(0, 8) + ' 并重新启动识别桥';
      } catch (e2) {
        rollback = '回滚失败：' + shortError(e2);
      }
    }
    throw new Error('模型已下载，但识别桥启动失败：' + shortError(e)
      + (rollback ? '；' + rollback : '；旧缓存未删除，可手动检查'));
  }
  return { revision, snapshotPath: dl.snapshotPath, previousRevision };
}
