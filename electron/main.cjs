const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DEV_URL = process.env.EDITKIT_DEV_URL;

// Keep using the data folder from when the app was called "Edit Kit" (palettes, keys, settings).
// MARCUUS_USER_DATA: a separate data folder for tests, so they never touch the real sessions.
app.setPath('userData', process.env.MARCUUS_USER_DATA || path.join(app.getPath('appData'), 'Edit Kit'));
const dataDir = () => app.getPath('userData');
const storePath = (key) => path.join(dataDir(), `${key.replace(/[^a-z0-9_-]/gi, '')}.json`);

function readStore(key, fallback = null) {
  try { return JSON.parse(fs.readFileSync(storePath(key), 'utf8')); } catch { return fallback; }
}
function writeStore(key, value) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = storePath(key);
  fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(p + '.tmp', p);
}
const settings = () => readStore('settings', {}) || {};

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'MARCUUS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // caption playback must stop on time even when the window is behind
    },
  });
  // external links open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  setInterval(async () => {
    const u = await checkForUpdate();
    if (u) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update:available', publicUpdate(u)));
  }, 60 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());

// ---- store / clipboard / files -------------------------------------------

ipcMain.handle('store:get', (_e, key, fallback) => readStore(key, fallback));
ipcMain.handle('store:set', (_e, key, value) => { writeStore(key, value); return true; });
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('shell:open', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openFolder', (_e, p) => { fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); });

ipcMain.handle('file:exists', (_e, p) => fs.existsSync(p));

ipcMain.handle('file:write', (_e, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

ipcMain.handle('file:saveAs', async (e, defaultPath, content) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'Subtitles', extensions: ['srt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

ipcMain.handle('dialog:folder', async (e, defaultPath) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('app:defaults', () => ({
  downloadsDir: path.join(os.homedir(), 'Downloads', 'B-roll'),
  claudePath: findClaude(),
}));

// ---- Claude (uses the user's own Claude login via the Claude Code CLI) ----

function findClaude() {
  const candidates = [
    settings().claudePath,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

let claudeProc = null;

// opts.system replaces Claude Code's own system prompt; opts.schema forces a JSON answer (structured output)
ipcMain.handle('claude:ask', (_e, prompt, model, opts = {}) => new Promise((resolve) => {
  const bin = findClaude();
  if (!bin) return resolve({ ok: false, error: 'Claude Code CLI introuvable. Installe-le : curl -fsSL https://claude.ai/install.sh | bash' });
  const cwd = path.join(dataDir(), 'claude-workdir');
  fs.mkdirSync(cwd, { recursive: true });
  const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', ''];
  if (model) args.push('--model', model);
  if (opts.system) args.push('--system-prompt', opts.system);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  const env = { ...process.env, PATH: `${path.dirname(bin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` };
  delete env.ANTHROPIC_API_KEY; // always use the user's Claude account login
  const p = spawn(bin, args, { cwd, env });
  claudeProc = p;
  let out = '';
  let err = '';
  const timer = setTimeout(() => p.kill('SIGTERM'), 4 * 60 * 1000);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  p.on('close', (code, signal) => {
    clearTimeout(timer);
    claudeProc = null;
    if (signal) return resolve({ ok: false, error: 'Annulé.' });
    try {
      const j = JSON.parse(out);
      if (j.is_error) return resolve({ ok: false, error: j.result || 'Erreur Claude' });
      resolve({ ok: true, text: j.structured_output ? JSON.stringify(j.structured_output) : j.result });
    } catch {
      resolve({ ok: false, error: (err || out || `Claude a quitté (code ${code})`).slice(0, 800) });
    }
  });
  p.stdin.end(prompt);
}));

ipcMain.handle('claude:cancel', () => { if (claudeProc) claudeProc.kill('SIGTERM'); });

ipcMain.handle('claude:status', () => new Promise((resolve) => {
  const bin = findClaude();
  if (!bin) return resolve({ installed: false, loggedIn: false });
  const p = spawn(bin, ['auth', 'status']);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => resolve({ installed: true, loggedIn: false }));
  p.on('close', () => {
    try {
      const j = JSON.parse(out);
      resolve({ installed: true, loggedIn: !!j.loggedIn, plan: j.subscriptionType, email: j.email });
    } catch { resolve({ installed: true, loggedIn: false }); }
  });
}));

// ---- stock footage search ------------------------------------------------

const ORIENT = {
  pexels: { vertical: 'portrait', horizontal: 'landscape' },
};

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}${body ? ' – ' + body.slice(0, 120) : ''}`);
  }
  return r.json();
}

const fitsOrientation = (w, h, o) => !o || o === 'any' || (o === 'vertical' ? h > w : w >= h);

const SOURCES = {
  async pexels({ query, orientation, perPage }, key) {
    const o = ORIENT.pexels[orientation];
    const q = new URLSearchParams({ query, per_page: perPage, ...(o ? { orientation: o } : {}) });
    const j = await getJson(`https://api.pexels.com/videos/search?${q}`, { Authorization: key });
    return j.videos.map((v) => {
      const files = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width);
      const bySize = [...files].sort((a, b) => a.width * a.height - b.width * b.height);
      const preview = bySize.find((f) => Math.min(f.width, f.height) >= 360) || bySize[0];
      const best = bySize.filter((f) => Math.max(f.width, f.height) <= 3840).pop() || bySize.pop();
      return {
        id: `pexels-v-${v.id}`, source: 'pexels', type: 'video', page: v.url, author: v.user?.name,
        thumb: v.image, preview: preview?.link, download: best?.link, width: v.width, height: v.height,
        duration: v.duration, ext: 'mp4',
      };
    });
  },

  async pixabay({ query, orientation, perPage }, key) {
    const n = Math.max(3, Math.min(perPage, 200));
    const q = new URLSearchParams({ key, q: query, per_page: orientation === 'any' ? n : 50, safesearch: 'true' });
    const j = await getJson(`https://pixabay.com/api/videos/?${q}`);
    const all = j.hits.map((v) => {
      const f = v.videos;
      const best = f.large?.url ? f.large : f.medium;
      const prev = f.small?.url ? f.small : f.tiny;
      return {
        id: `pixabay-v-${v.id}`, source: 'pixabay', type: 'video', page: v.pageURL, author: v.user,
        thumb: prev?.thumbnail || best?.thumbnail || `https://i.vimeocdn.com/video/${v.picture_id}_640x360.jpg`,
        preview: prev?.url, download: best?.url, width: best?.width, height: best?.height,
        duration: v.duration, ext: 'mp4',
      };
    });
    // Pixabay has few vertical videos: matching ones first, then the rest (they crop fine)
    const match = all.filter((v) => fitsOrientation(v.width, v.height, orientation));
    return [...match, ...all.filter((v) => !match.includes(v))].slice(0, n);
  },
};

ipcMain.handle('stock:search', async (_e, params) => {
  const keys = settings().keys || {};
  const sources = (params.sources || []).filter((s) => SOURCES[s]);
  const results = await Promise.allSettled(
    sources.map((s) => {
      if (!keys[s]) return Promise.reject(new Error('clé API manquante'));
      return SOURCES[s](params, keys[s]);
    }),
  );
  const items = [];
  const errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors[sources[i]] = r.reason?.message || String(r.reason);
  });
  // interleave sources so one site doesn't dominate the grid
  const bySource = sources.map((s) => items.filter((it) => it.source === s));
  const mixed = [];
  for (let i = 0; bySource.some((l) => l[i]); i++) bySource.forEach((l) => l[i] && mixed.push(l[i]));
  return { items: mixed, errors };
});

ipcMain.handle('stock:download', async (_e, item, dir, baseName) => {
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(item.download);
  if (!r.ok) throw new Error(`Téléchargement échoué (${r.status})`);
  const safe = baseName.replace(/[\/:*?"<>|]/g, '-');
  let file = path.join(dir, `${safe}.${item.ext || 'bin'}`);
  if (fs.existsSync(file)) return file; // same clip already downloaded
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
});

ipcMain.handle('file:writeText', async (e, defaultPath, content, ext = 'md') => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

// ---- ChatGPT (OpenAI API key from Réglages) ------------------------------
// The key never leaves the main process. Answers are forced into a JSON schema (Structured Outputs).
const OPENAI_URL = process.env.MARCUUS_OPENAI_URL || 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';
const openaiConf = () => ({ key: (settings().keys?.openai || '').trim(), model: settings().openaiModel || OPENAI_DEFAULT_MODEL });

function openaiError(status, err, model) {
  const code = err?.code || err?.type || '';
  if (status === 401) return 'Clé OpenAI refusée. Vérifie-la dans Réglages.';
  if (code === 'insufficient_quota') return 'Plus de crédit sur ton compte OpenAI (platform.openai.com → Billing).';
  if (status === 429) return 'OpenAI est saturé, réessaie dans un instant.';
  if (status === 404 || code === 'model_not_found') return `Le modèle « ${model} » n’est pas disponible sur ton compte. Change de modèle dans Réglages.`;
  return `OpenAI : ${err?.message || `erreur ${status}`}`;
}

let openaiAbort = null;
ipcMain.handle('openai:ask', async (_e, { system, user, schema, name }) => {
  const { key, model } = openaiConf();
  if (!key) return { ok: false, code: 'nokey', error: 'Ajoute ta clé OpenAI dans Réglages.' };
  openaiAbort?.abort();
  const ctrl = (openaiAbort = new AbortController());
  const timer = setTimeout(() => ctrl.abort('timeout'), 4 * 60_000);
  try {
    const r = await fetch(`${OPENAI_URL}/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ role: 'system', content: system }, { role: 'user', content: user }],
        text: { format: { type: 'json_schema', name, schema, strict: true } },
        max_output_tokens: 16000,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: openaiError(r.status, j.error, model) };
    if (j.status === 'incomplete') return { ok: false, error: 'La réponse d’OpenAI a été coupée. Réessaie, ou choisis un autre modèle.' };
    const parts = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
    if (parts.some((c) => c.type === 'refusal')) return { ok: false, error: 'OpenAI a refusé d’analyser cet audio.' };
    const text = parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    if (!text) return { ok: false, error: 'OpenAI n’a rien renvoyé. Réessaie.' };
    return { ok: true, text, model };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, code: 'aborted', error: ctrl.signal.reason === 'timeout' ? 'OpenAI ne répond pas (délai dépassé). Réessaie.' : 'Analyse annulée.' };
    return { ok: false, error: 'Pas de connexion à OpenAI. Vérifie ta connexion internet.' };
  } finally {
    clearTimeout(timer);
    if (openaiAbort === ctrl) openaiAbort = null;
  }
});
ipcMain.handle('openai:cancel', () => openaiAbort?.abort());
// "Tester" in Réglages: is the key valid and the model available? (free call)
ipcMain.handle('openai:status', async () => {
  const { key, model } = openaiConf();
  if (!key) return { ok: false, error: 'Pas de clé.' };
  try {
    const r = await fetch(`${OPENAI_URL}/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok) return { ok: true, model };
    const j = await r.json().catch(() => ({}));
    return { ok: false, error: openaiError(r.status, j.error, model) };
  } catch {
    return { ok: false, error: 'Pas de connexion à OpenAI.' };
  }
});

// ---- local transcription (Whisper turbo on Apple MLX) --------------------
// Engine = a private Python venv (uv) with mlx-whisper; model = mlx-community/whisper-large-v3-turbo.
// Picked after scoring 13 engine/model combos on real clips: half the errors of whisper.cpp, ~1s per clip.

// Tools ship inside the app (Resources/bin) so other Macs don't need Homebrew; Homebrew is only a fallback.
const BUNDLED_BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'vendor', process.arch, 'bin');
const BIN_DIRS = [BUNDLED_BIN, '/opt/homebrew/bin', '/usr/local/bin'];
const findBin = (name) => BIN_DIRS.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || null;
// MLX needs Apple Silicon running natively (not an Intel Mac, not Rosetta)
const SUPPORTS_MLX = process.platform === 'darwin' && process.arch === 'arm64';
const engineDir = () => path.join(dataDir(), 'engine');
const enginePy = () => path.join(engineDir(), '.venv', 'bin', 'python');
const engineScript = () => path.join(__dirname, 'engine', 'transcribe_mlx.py').replace('app.asar', 'app.asar.unpacked');
const MODEL_REPO = 'mlx-community/whisper-large-v3-turbo';
const modelReady = () => {
  const snaps = path.join(os.homedir(), '.cache', 'huggingface', 'hub', `models--${MODEL_REPO.replace('/', '--')}`, 'snapshots');
  try { return fs.readdirSync(snaps).some((d) => fs.existsSync(path.join(snaps, d, 'weights.safetensors'))); } catch { return false; }
};
const engineEnv = () => ({
  ...process.env,
  PATH: `${BIN_DIRS.join(':')}:/usr/bin:/bin:${process.env.PATH || ''}`,
  // Use only uv's own Python. Never probe /usr/bin/python3: on a Mac without Apple's developer
  // tools that file is a stub that pops up the "install Command Line Tools" dialog.
  UV_PYTHON_PREFERENCE: 'only-managed',
  NUMBA_CACHE_DIR: path.join(engineDir(), 'numba-cache'), // compile word timing once, not every run
  HF_HUB_DISABLE_TELEMETRY: '1',
});

// ---- engine journal: what the engine printed, so a stuck run can be diagnosed from another Mac
const logPath = () => path.join(dataDir(), 'logs', 'transcription.log');
function journal(line) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
    const st = fs.statSync(logPath());
    if (st.size > 400_000) fs.writeFileSync(logPath(), fs.readFileSync(logPath(), 'utf8').slice(-200_000));
  } catch {}
}
// keep tqdm bars out of the journal, keep everything else
const journalChunk = (tag, chunk) => String(chunk).split(/[\r\n]+/).filter((l) => l.trim() && !/\d+%\|/.test(l)).forEach((l) => journal(`${tag} ${l.slice(0, 400)}`));
ipcMain.handle('whisper:log', () => { try { return fs.readFileSync(logPath(), 'utf8').split('\n').slice(-80).join('\n'); } catch { return ''; } });

// Short and casual on purpose: keeps punctuation and spoken French ("t'as", "on faisait pas")
// without the dropouts a long prompt caused.
const PROMPTS = { fr: "Ouais, t'as vu, c'est ça.", en: 'Yeah, you know, that is it.' };

const activeProcs = new Set();
const runProc = (bin, args, { onOutput, env, idleMs = 0, tag = path.basename(bin) } = {}) => new Promise((resolve, reject) => {
  journal(`$ ${path.basename(bin)} ${args.map((a) => (a.length > 80 ? path.basename(a) : a)).join(' ')}`);
  const p = spawn(bin, args, { env: env || engineEnv() });
  activeProcs.add(p);
  let out = '';
  let err = '';
  let stalled = false;
  let last = Date.now();
  const dog = idleMs ? setInterval(() => {
    if (Date.now() - last > idleMs) { stalled = true; journal(`${tag} !! aucune activité depuis ${Math.round(idleMs / 1000)} s, arrêt`); p.kill('SIGTERM'); }
  }, 2000) : null;
  p.stdout.on('data', (d) => { out += d; last = Date.now(); onOutput?.(String(d)); });
  p.stderr.on('data', (d) => { err += d; last = Date.now(); journalChunk(tag, d); onOutput?.(String(d)); });
  p.on('error', (e) => { clearInterval(dog); activeProcs.delete(p); journal(`${tag} !! ${e.message}`); reject(e); });
  p.on('close', (code, signal) => {
    clearInterval(dog);
    activeProcs.delete(p);
    journal(`${tag} -> exit ${code ?? signal}`);
    if (stalled) return reject(new Error(`Le moteur ne répond plus (aucune activité depuis ${Math.round(idleMs / 1000)} s). Copie le journal et envoie-le.`));
    if (signal) return reject(new Error('Annulé.'));
    if (code === 0) return resolve(out);
    reject(new Error(err.split('\n').filter((l) => l.trim() && !/%\|/.test(l)).slice(-3).join(' ') || `code ${code}`));
  });
});
ipcMain.handle('whisper:cancel', () => { for (const p of activeProcs) p.kill('SIGTERM'); });

// ffmpeg's banner for a file (size, fps, audio): `ffmpeg -i` with no output prints it and exits 1
ipcMain.handle('media:probe', (_e, filePath) => new Promise((resolve, reject) => {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) return reject(new Error('ffmpeg manquant. Dans le Terminal : brew install ffmpeg'));
  const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', filePath]);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', () => (/Duration:/.test(err) ? resolve(err) : reject(new Error(err.trim().split('\n').pop() || 'Fichier illisible.'))));
}));

ipcMain.handle('whisper:status', () => ({
  supported: SUPPORTS_MLX,
  bundled: fs.existsSync(path.join(BUNDLED_BIN, 'uv')) && fs.existsSync(path.join(BUNDLED_BIN, 'ffmpeg')),
  uv: !!findBin('uv'),
  ffmpeg: !!findBin('ffmpeg'),
  engine: fs.existsSync(enginePy()) && fs.existsSync(path.join(engineDir(), 'ok')) && fs.existsSync(path.join(engineDir(), 'warm')),
  model: modelReady(),
}));

// One-click setup: venv + mlx-whisper, then the 1.6 GB model.
let installing = null;
ipcMain.handle('whisper:install', (e) => {
  if (installing) return installing;
  const send = (p) => { if (!e.sender.isDestroyed()) e.sender.send('whisper:installProgress', p); };
  installing = (async () => {
    if (!SUPPORTS_MLX) throw new Error('La transcription nécessite un Mac avec puce Apple (M1 ou plus récent).');
    const uv = findBin('uv');
    if (!uv) throw new Error('uv manquant. Dans le Terminal : brew install uv ffmpeg');
    if (!(fs.existsSync(enginePy()) && fs.existsSync(path.join(engineDir(), 'ok')))) {
      send({ stage: 'engine' });
      fs.mkdirSync(engineDir(), { recursive: true });
      await runProc(uv, ['venv', '--allow-existing', '-p', '3.12', path.join(engineDir(), '.venv')]);
      await runProc(uv, ['pip', 'install', '-p', enginePy(), 'mlx-whisper']);
      fs.writeFileSync(path.join(engineDir(), 'ok'), new Date().toISOString());
    }
    if (!modelReady()) {
      send({ stage: 'model' });
      await runProc(enginePy(), ['-c', `from huggingface_hub import snapshot_download; snapshot_download("${MODEL_REPO}")`], { tag: 'model' });
    }
    if (!fs.existsSync(path.join(engineDir(), 'warm'))) {
      // compile everything once (GPU kernels + word timing) so the first real transcription doesn't sit at 0%
      send({ stage: 'warmup' });
      await runProc(enginePy(), [engineScript(), '--warmup'], { tag: 'warmup', idleMs: 5 * 60_000 });
      fs.writeFileSync(path.join(engineDir(), 'warm'), new Date().toISOString());
    }
    send({ stage: 'done' });
    return true;
  })().finally(() => { installing = null; });
  return installing;
});

ipcMain.handle('whisper:transcribe', async (e, filePath, opts = {}) => {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg manquant. Dans le Terminal : brew install ffmpeg');
  if (!fs.existsSync(enginePy()) || !modelReady()) throw new Error('Moteur pas encore installé.');
  const send = (p) => { if (!e.sender.isDestroyed()) e.sender.send('whisper:progress', { filePath, ...p }); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marcuus-'));
  try {
    send({ stage: 'audio', pct: 0 });
    const wav = path.join(tmp, 'audio.wav');
    await runProc(ffmpeg, ['-nostdin', '-y', '-i', filePath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { tag: 'ffmpeg', idleMs: 2 * 60_000 });
    send({ stage: 'transcribe', pct: 0 });
    const lang = opts.language || 'fr';
    const prompt = [PROMPTS[lang], opts.vocab && `${opts.vocab}.`].filter(Boolean).join(' ');
    journal(`--- ${path.basename(filePath)} (${process.arch}, ${os.cpus()[0]?.model || '?'}, ${Math.round(os.totalmem() / 1e9)} Go)`);
    const out = await runProc(enginePy(), [engineScript(), wav, lang, prompt], {
      tag: 'engine',
      idleMs: 3 * 60_000, // progress prints several times per second; 3 min of silence = stuck
      onOutput: (chunk) => {
        const m = [...chunk.matchAll(/(\d+)%\|/g)].pop();
        if (m) send({ stage: 'transcribe', pct: +m[1], note: null });
        const step = [...chunk.matchAll(/\[marcuus[^\]]*\] ([^\n]+)/g)].pop();
        if (step) send({ stage: 'transcribe', note: step[1] });
      },
    });
    send({ stage: 'done', pct: 100 });
    return JSON.parse(out.slice(out.indexOf('{')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- updates: every published version is required ---------------------------------------
// The version file lives in the public "marcuus-releases" repo (the code repo is private).
// No network / GitHub down → the app opens normally (transcription works offline).

const UPDATE_URL = process.env.MARCUUS_UPDATE_URL || 'https://raw.githubusercontent.com/Masonnigg/marcuus-releases/main/latest.json';
const RELEASES_PAGE = 'https://github.com/Masonnigg/marcuus-releases/releases/latest';
const crypto = require('node:crypto');

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
let pendingUpdate = null;
const publicUpdate = (u) => ({ version: u.version, notes: u.notes || '', current: app.getVersion() });

async function checkForUpdate() {
  if (!app.isPackaged && !process.env.MARCUUS_UPDATE_URL) return null; // not while developing
  try {
    const r = await fetch(`${UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const info = await r.json();
    if (info?.version && cmpVersion(info.version, app.getVersion()) > 0 && info.assets?.[process.arch]) {
      pendingUpdate = info;
      return info;
    }
  } catch {} // offline: let the app open
  return null;
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => { const u = await checkForUpdate(); return u ? publicUpdate(u) : null; });
ipcMain.handle('update:openPage', () => shell.openExternal(RELEASES_PAGE));

ipcMain.handle('update:install', async (e) => {
  const u = pendingUpdate;
  if (!u) throw new Error('Aucune mise à jour en attente.');
  const send = (p) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', p); };
  const asset = u.assets[process.arch];
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..'); // …/MARCUUS.app
  if (!bundle.endsWith('.app')) throw new Error('Emplacement de l’app inattendu.');
  if (bundle.includes('/AppTranslocation/')) throw new Error('Glisse MARCUUS dans le dossier Applications, relance-le, puis réessaie.');
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { throw new Error(`Pas le droit de modifier ${path.dirname(bundle)}.`); }

  // 1. download with macOS's curl (Electron's fetch can crash on large streamed downloads).
  //    Files curl writes aren't quarantined, so there's no Gatekeeper prompt after the update.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marcuus-update-'));
  const zip = path.join(tmp, 'MARCUUS.zip');
  const total = asset.size || 0;
  const poll = setInterval(() => {
    try { send({ stage: 'download', got: fs.statSync(zip).size, total }); } catch {}
  }, 250);
  try {
    await runProc('/usr/bin/curl', ['-fL', '--retry', '3', '--connect-timeout', '15', '-sS', '-o', zip, asset.url], { tag: 'update', idleMs: 0 });
  } catch (err) {
    throw new Error(`Téléchargement impossible : ${String(err.message).slice(0, 160)}`);
  } finally {
    clearInterval(poll);
  }
  send({ stage: 'download', got: total || 1, total: total || 1 });
  const hash = crypto.createHash('sha256');
  await new Promise((res, rej) => fs.createReadStream(zip).on('data', (d) => hash.update(d)).on('end', res).on('error', rej));
  // 2. verify: checksum from the version file, then the unpacked app's version
  if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('Fichier corrompu (checksum). Réessaie.');
  send({ stage: 'unpack' });
  await runProc('/usr/bin/ditto', ['-x', '-k', zip, path.join(tmp, 'x')], { tag: 'update' });
  const newApp = path.join(tmp, 'x', 'MARCUUS.app');
  const plist = path.join(newApp, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error('Archive invalide.');
  const v = (await runProc('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { tag: 'update' })).trim();
  if (v !== u.version) throw new Error(`Version inattendue dans l’archive (${v}).`);
  // 3. swap once this app has quit, roll back if the move fails, then relaunch
  const script = path.join(tmp, 'swap.sh');
  fs.writeFileSync(script, `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
OLD="${bundle}"; NEW="${newApp}"
rm -rf "$OLD.old"
if mv "$OLD" "$OLD.old"; then
  if mv "$NEW" "$OLD"; then rm -rf "$OLD.old"; else mv "$OLD.old" "$OLD"; fi
fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
open "$OLD"
rm -rf "${tmp}"
`);
  send({ stage: 'restart' });
  journal(`update ${app.getVersion()} -> ${u.version}`);
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
  return true;
});
