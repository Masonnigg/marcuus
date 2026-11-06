// RYACHA panel: reads the job RYACHA wrote, then in four steps: (1) imports the rushes and builds every
// part and ad, (2) captions the parts the editor picks, from their final cut, (3) zooms on the cuts,
// (4) queues the ads in Media Encoder. Every step shows its progress; the work runs through host.jsx.
(function () {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const zlib = require('zlib');
  const { spawn } = require('child_process');
  const HERE = path.dirname(decodeURIComponent(location.pathname));
  const REPO = path.dirname(fs.realpathSync(HERE)); // the panel is linked from the app's code folder
  const lib = require(path.join(HERE, 'lib', 'pubs.cjs'));
  const captionsLib = require(path.join(HERE, 'lib', 'captions.cjs'));
  const APP_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Edit Kit');
  const DATA = path.join(APP_DATA, 'pubs');
  const JOB = path.join(DATA, 'job.json');
  const PARTS = ['hook', 'transi', 'corps'];
  const GROUPS = { hook: 'Accroches', transi: 'Transitions', corps: 'Corps' };
  const $ = (id) => document.getElementById(id);
  const steps = [...document.querySelectorAll('.step')];

  let job = null;
  let project = null; // { project, path }
  let present = null; // sequence name → true when it is in the project
  let busy = false;
  let openStep = null; // the step the editor opened by hand
  let unticked = new Set(); // parts the editor unticked for captions

  // zoomi's Max zoom and face point from the editor's own ads; the rest is remembered per project
  // zoomTracks: the zoomed video tracks (the layer goes right above the highest); ignoredTracks: tracks whose clip
  // edges aren't cuts (null = every track but V1, where graphics usually sit)
  const settings = { maxZoom: 138, anchor: { x: 50.7, y: 48.9 }, roots: {}, preset: '', styles: {}, zoomTracks: [0], ignoredTracks: null, formats: ['9x16', '4x5'], startNow: true };
  let einfo = {}; // step 4: job sequence index → { present, has4x5 } in the open project
  let filesOff = new Set(); // step 4: files the editor unticked (their output paths)
  const formats = () => (settings.formats && settings.formats.length ? settings.formats : ['9x16']);
  try { Object.assign(settings, JSON.parse(localStorage.getItem('pubs-settings') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('pubs-settings', JSON.stringify(settings)); } catch (e) {} };
  // what was done in this project for this job: { captioned: { name: date }, zoomed, exported }
  const doneKey = () => `ryacha-done:${project && project.path}:${job && job.created}`;
  const done = () => { try { return Object.assign({ captioned: {} }, JSON.parse(localStorage.getItem(doneKey()) || '{}')); } catch (e) { return { captioned: {} }; } };
  const markDone = (patch) => { const d = Object.assign(done(), patch); try { localStorage.setItem(doneKey(), JSON.stringify(d)); } catch (e) {} };

  // The panel loads its own host.jsx each time it opens: Premiere reads the manifest's copy only when it starts, so
  // after the app updated the panel (Premiere still open) the new panel would talk to the old host until a restart.
  const hostReady = new Promise((resolve) => {
    window.__adobe_cep__.evalScript(`$.evalFile(${JSON.stringify(path.join(HERE, 'jsx', 'host.jsx'))})`, resolve);
  });
  function host(fn, ...args) {
    const call = `${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return hostReady.then(() => new Promise((resolve, reject) => {
      window.__adobe_cep__.evalScript(call, (result) => {
        try { resolve(JSON.parse(result)); } catch (e) { reject(new Error(`Premiere n'a pas pu exécuter ${fn} : ${result}`)); }
      });
    }));
  }
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  // Progress reads like Premiere's render bar: one segment per sequence or part. progress() lights the item being
  // worked on, log() stamps its outcome on it (done, skipped, failed); the lines themselves fold under "Détail".
  let segs = [], cur = -1, lines = 0;
  // Errors are written next to the job; the app sends them on (Réglages › Rapports d'erreur), cleaned of names.
  const ERRORS = path.join(DATA, 'panel-errors.jsonl');
  const PANEL_VERSION = (() => { try { return fs.readFileSync(path.join(HERE, '.ryacha-version'), 'utf8').trim(); } catch (e) { return 'dev'; } })();
  const STEP_NAMES = ['import', 'sous-titres', 'zooms', 'export'];
  function reportError(message, stack, level = 'error') {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      const step = typeof openStep === 'number' ? STEP_NAMES[openStep] || String(openStep) : '?';
      fs.appendFileSync(ERRORS, `${JSON.stringify({ t: Date.now(), step, level, message: String(message).slice(0, 600), stack: stack || undefined, version: PANEL_VERSION })}\n`);
    } catch (e) {}
  }
  window.addEventListener('error', (e) => reportError(e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => reportError((e.reason && e.reason.message) || String(e.reason), e.reason && e.reason.stack));

  // A file dropped on the panel (a clip from the Finder that misses the timeline) would replace the panel with that
  // file: an empty panel until it is closed and reopened. Nothing here takes drops, so none goes through.
  const noDrop = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; };
  window.addEventListener('dragover', noDrop);
  window.addEventListener('drop', noDrop);

  // The panel's own journal, on this Mac only (pubs/panel-journal.log): when it opens, closes, hides, and when it
  // froze, so an empty panel can be explained afterwards. Kept short.
  const JOURNAL = path.join(DATA, 'panel-journal.log');
  function journal(text) {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      try { if (fs.statSync(JOURNAL).size > 200000) fs.renameSync(JOURNAL, `${JOURNAL}.1`); } catch (e) {}
      const step = typeof openStep === 'number' ? ` [${STEP_NAMES[openStep] || openStep}]` : '';
      fs.appendFileSync(JOURNAL, `${new Date().toISOString()} ${text}${step}\n`);
    } catch (e) {}
  }
  journal(`ouvert (${PANEL_VERSION}, ${window.innerWidth}×${window.innerHeight})`);
  window.addEventListener('error', (e) => journal(`erreur : ${String(e.message).slice(0, 200)}`));
  window.addEventListener('beforeunload', () => journal('fermé ou rechargé'));
  document.addEventListener('visibilitychange', () => journal(document.visibilityState === 'visible' ? 'visible' : 'caché'));
  // a tick every second: one that comes late while the panel is visible means the panel was frozen that long
  let tick = Date.now(), seenVisible = document.visibilityState === 'visible';
  setInterval(() => {
    const now = Date.now(), visible = document.visibilityState === 'visible';
    if (visible && seenVisible && now - tick > 3000) journal(`figé ${((now - tick) / 1000).toFixed(1)} s (${($('status') && $('status').textContent || '').slice(0, 80)})`);
    tick = now; seenVisible = visible;
  }, 1000);

  function bars(n) {
    const r = $('render');
    r.innerHTML = '';
    segs = Array.from({ length: Math.max(0, n) }, () => r.appendChild(document.createElement('i')));
    cur = -1;
  }
  const progress = (fraction, text) => {
    if (segs.length) {
      const i = Math.min(segs.length - 1, Math.floor(Math.max(0, fraction) * segs.length));
      if (i !== cur) { cur = i; if (!segs[i].className) segs[i].className = 'run'; }
    }
    if (text !== undefined) $('status').textContent = text;
  };
  const log = (text, cls = '') => {
    // failures and warnings go to the app's error reports, without the file or part name before " : "
    if (cls === 'err' || cls === 'warn') reportError(text.includes(' : ') ? text.slice(text.indexOf(' : ') + 3) : text, null, cls === 'warn' ? 'warning' : 'error');
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    $('log').prepend(d);
    const mark = { ok: 'ok', skip: 'skip', err: 'bad' }[cls];
    if (mark && segs[cur] && segs[cur].className !== 'bad') segs[cur].className = mark;
    $('detailSum').textContent = `Détail (${++lines})`;
    if (cls === 'err') $('detail').open = true; // a failure is never hidden
  };
  const kindOf = (s) => s.kind || (String(s.key).startsWith('ad:') ? 'ad' : String(s.key).startsWith('review:') ? 'review' : 'corps');
  const partsOf = () => (job ? job.sequences.map((s, index) => ({ ...s, index, kind: kindOf(s) })).filter((s) => PARTS.includes(s.kind)) : []);

  // ---------- tools on this Mac (Premiere starts without the shell's PATH) ----------
  const first = (list) => list.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
  // the app's tools: where RYACHA says it is (it writes it at each start), else where it is installed by default
  const RESOURCES = [(() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'app.json'), 'utf8')).resources; } catch (e) { return null; } })(), '/Applications/RYACHA.app/Contents/Resources'].filter(Boolean);
  // the ffmpeg inside RYACHA first (the same on every Mac), Homebrew's only as a last resort
  const ffmpeg = () => first([...RESOURCES.map((r) => `${r}/bin/ffmpeg`), path.join(REPO, 'vendor', process.arch, 'bin', 'ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
  const python = () => first([path.join(APP_DATA, 'engine', '.venv', 'bin', 'python')]);
  const engine = () => first([path.join(REPO, 'electron', 'engine', 'transcribe_mlx.py'), ...RESOURCES.map((r) => `${r}/app.asar.unpacked/electron/engine/transcribe_mlx.py`)]);
  function premierePreset(rel) {
    try {
      for (const a of fs.readdirSync('/Applications').filter((n) => /^Adobe Premiere Pro/.test(n)).sort().reverse()) {
        const bundle = fs.readdirSync(path.join('/Applications', a)).find((n) => n.endsWith('.app'));
        const p = bundle && path.join('/Applications', a, bundle, 'Contents/MediaIO/systempresets', rel);
        if (p && fs.existsSync(p)) return p;
      }
    } catch (e) {}
    return null;
  }
  // Premiere's "Match Source – High bitrate" (H.264 10–12 Mbps, AAC 320k: what the editor's real deliverables are;
  // the "Adaptive" one came out at ~19 Mbps on the same ad), then the editor's own Media Encoder presets
  function presets() {
    const list = [];
    const ms = premierePreset('4E49434B_48323634/00 - Match Source - High bitrate.epr');
    if (ms) list.push({ path: ms, label: 'H.264 · Match Source – High bitrate' });
    try {
      const ame = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
      for (const v of fs.readdirSync(ame).sort().reverse()) {
        const dir = path.join(ame, v, 'Presets');
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.epr')).sort()) list.push({ path: path.join(dir, f), label: `${f.replace(/\.epr$/, '')} (AME ${v})` });
      }
    } catch (e) {}
    return list;
  }

  // A command, with its output lines for progress (onLine) → stdout.
  function run(cmd, args, { env, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { env: Object.assign({}, process.env, env || {}) });
      let out = '', err = '';
      const feed = (chunk) => { if (onLine) String(chunk).split(/[\r\n]+/).forEach((l) => l && onLine(l)); };
      p.stdout.on('data', (d) => { out += d; feed(d); });
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); feed(d); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').pop() || `${path.basename(cmd)} a échoué (${code})`).slice(0, 300)))));
    });
  }

  // The Transcrire tab's own options (words per caption, capitals, punctuation, vocabulary, expressions), read only.
  function transcribeOptions() {
    const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(APP_DATA, `${name}.json`), 'utf8')) || fallback; } catch (e) { return fallback; } };
    const opts = Object.assign({ smart: true, vocab: '', language: 'fr', wordsPerCue: 2, maxChars: 18, caps: false, punctuation: true }, read('transcribeOpts', {}));
    opts.expressions = read('settings', {}).expressions;
    return opts;
  }
  const PROMPTS = { fr: "Ouais, t'as vu, c'est ça.", en: 'Yeah, you know, that is it.' };

  // The caption style chosen for this project: one of its styles { name } or a .prtextstyle { file }. A project with
  // styles starts on its first one; with none, the first captions run asks for a file.
  let projectStyles = [];
  function styleChoice() {
    const saved = project && project.path ? (settings.styles || {})[project.path] : null;
    if (typeof saved === 'string') return { file: saved }; // remembered by an older panel
    if (saved && (saved.file || saved.name)) return saved;
    return projectStyles.length ? { name: projectStyles[0] } : null;
  }
  function setChoice(choice) {
    if (!project || !project.path) return;
    settings.styles = Object.assign({}, settings.styles, { [project.path]: choice });
    save();
  }
  function pickStyleFile() {
    const c = styleChoice();
    const start = c && c.file ? path.dirname(c.file) : project && project.path ? path.dirname(project.path) : os.homedir();
    const r = window.cep && window.cep.fs.showOpenDialogEx(false, false, 'Style des sous-titres (.prtextstyle)', start, ['prtextstyle']);
    if (!r || r.err || !r.data || !r.data[0]) return false;
    setChoice({ file: r.data[0] });
    return true;
  }

  // ---------- screen ----------
  function rootFolder() {
    if (!project || !project.path) return '';
    return settings.roots[project.path] || path.join(path.dirname(project.path), '1.Delivrables');
  }

  function stepStates() {
    if (!job) return [null, null, null, null];
    const d = done();
    const all = job.sequences.length;
    const built = present ? job.sequences.filter((s) => present[s.name]).length : 0;
    const parts = partsOf();
    const captioned = parts.filter((p) => d.captioned[p.name]).length;
    const files = lib.exportPlan(job, '/', formats()).length;
    return [
      { done: built === all, text: built === all ? 'Fait' : built ? `${built}/${all} séquences` : `${all} séquences` },
      { done: parts.length > 0 && captioned === parts.length, text: captioned ? `${captioned}/${parts.length} sous-titrées` : plural(parts.length, 'partie') },
      { done: !!d.zoomed, text: d.zoomed ? 'Fait' : '' },
      { done: !!d.exported, text: d.rendered ? `${d.rendered} rendu${d.rendered > 1 ? 's' : ''}` : d.exported ? `${d.exported} en file` : plural(files, 'fichier') },
    ];
  }

  function paint() {
    const states = stepStates();
    const auto = states.findIndex((s) => s && !s.done);
    const open = openStep !== null ? openStep : auto < 0 ? 3 : auto;
    steps.forEach((el, i) => {
      el.classList.toggle('open', i === open);
      el.querySelector('.head').setAttribute('aria-expanded', String(i === open));
      el.classList.toggle('done', !!(states[i] && states[i].done));
      $(`state${i + 1}`).textContent = states[i] ? states[i].text : '';
    });
    steps[open].querySelector('.body').appendChild($('activity'));
    for (const id of ['build', 'captions', 'zoom', 'export']) $(id).disabled = !job || busy;
    for (const el of document.querySelectorAll('.head')) el.disabled = busy;
    // step 2: the parts to caption
    const parts = partsOf();
    const d = done();
    const list = $('parts');
    list.innerHTML = parts.length ? '' : '<div class="empty">Aucune partie : envoie d’abord un job depuis RYACHA › Pubs.</div>';
    for (const kind of PARTS) {
      const mine = parts.filter((p) => p.kind === kind);
      if (!mine.length) continue;
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = `${GROUPS[kind]} · ${mine.length}`;
      list.appendChild(g);
      for (const p of mine) {
        const row = document.createElement('label');
        row.className = 'part';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !unticked.has(p.name);
        box.disabled = busy;
        box.onchange = () => { if (box.checked) unticked.delete(p.name); else unticked.add(p.name); paintCount(); };
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        row.append(box, name);
        const tag = d.captioned[p.name] ? ['tag', 'sous-titrée'] : present && !present[p.name] ? ['tag missing', 'pas importée'] : null;
        if (tag) { const t = document.createElement('span'); t.className = tag[0]; t.textContent = tag[1]; row.appendChild(t); }
        list.appendChild(row);
      }
    }
    const choice = styleChoice();
    const menu = $('style');
    menu.innerHTML = '';
    const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; menu.appendChild(o); };
    for (const n of projectStyles) add(`name:${n}`, n);
    if (choice && choice.file) add(`file:${choice.file}`, `${path.basename(choice.file).replace(/\.prtextstyle$/i, '')} (fichier)`);
    if (!choice) add('', 'Choisis un style…');
    add('pick', 'Un fichier .prtextstyle…');
    menu.value = choice ? (choice.file ? `file:${choice.file}` : `name:${choice.name}`) : '';
    paintCount();
    // step 3
    paintZoom();
    // step 4
    const root = rootFolder();
    $('root').textContent = root || 'Enregistre d’abord le projet';
    $('root').title = root;
    const list4 = presets();
    $('preset').innerHTML = '';
    for (const p of list4) { const o = document.createElement('option'); o.value = p.path; o.textContent = p.label; $('preset').appendChild(o); }
    if (list4.some((p) => p.path === settings.preset)) $('preset').value = settings.preset;
    $('fmt916').checked = formats().includes('9x16');
    $('fmt45').checked = formats().includes('4x5');
    $('startNow').checked = settings.startNow !== false;
    paintFiles();
  }

  // step 4: every file that will be exported, by destination folder, with what will happen to it
  function filePlan() {
    const root = rootFolder();
    const coll = new Intl.Collator('fr', { numeric: true }); // H2 before H10
    const rank = (p) => (p.review ? 0 : p.format === '9x16' ? 1 : 2); // review, then 9x16, then 4x5
    return job && root ? lib.exportPlan(job, root, formats()).sort((a, b) => rank(a) - rank(b) || coll.compare(path.dirname(a.out), path.dirname(b.out)) || coll.compare(a.out, b.out)) : [];
  }
  function fileState(p) {
    const e = einfo[p.index];
    if (e && !e.present) return ['tag missing', 'pas dans le projet'];
    if (fs.existsSync(p.out)) return ['tag missing', 'déjà exportée'];
    if (p.format === '4x5' && e && !e.has4x5) return ['tag warn', '4x5 à créer'];
    return null;
  }
  function paintFiles() {
    const box = $('files');
    const root = rootFolder();
    const plan = filePlan();
    box.innerHTML = plan.length ? '' : `<div class="empty">${root ? 'Rien à exporter.' : 'Enregistre d’abord le projet.'}</div>`;
    let group = null;
    for (const p of plan) {
      const dir = path.relative(root, path.dirname(p.out)) || '.';
      if (dir !== group) {
        group = dir;
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = dir;
        g.style.textTransform = 'none';
        box.appendChild(g);
      }
      const row = document.createElement('label');
      row.className = 'part file';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !filesOff.has(p.out);
      cb.disabled = busy;
      cb.onchange = () => { if (cb.checked) filesOff.delete(p.out); else filesOff.add(p.out); paintExportButton(); };
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = path.basename(p.out);
      name.title = p.out;
      row.append(cb, name);
      const st = fileState(p);
      if (st) { const t = document.createElement('span'); t.className = st[0]; t.textContent = st[1]; row.appendChild(t); }
      box.appendChild(row);
    }
    paintExportButton();
  }
  function paintExportButton() {
    const n = filePlan().filter((p) => !filesOff.has(p.out)).length;
    $('export').textContent = n ? `Exporter ${plural(n, 'fichier')}` : 'Coche au moins un fichier';
    if (!busy) $('export').disabled = !job || !n;
  }
  function paintCount() {
    const n = partsOf().filter((p) => !unticked.has(p.name)).length;
    $('captions').textContent = n ? `Sous-titrer ${n} partie${n > 1 ? 's' : ''}` : 'Coche au moins une partie';
    if (!busy) $('captions').disabled = !job || !n;
  }

  async function refresh() {
    try {
      const info = await host('pubs_info');
      project = info.error ? null : info;
      $('project').textContent = info.error || info.project;
    } catch (e) { project = null; $('project').textContent = e.message; }
    let next = null;
    try { next = JSON.parse(fs.readFileSync(JOB, 'utf8')); } catch (e) {}
    if (!next || !job || next.created !== job.created) { unticked = new Set(); filesOff = new Set(); openStep = null; }
    job = next;
    present = null;
    if (job) {
      const ads = job.sequences.filter((s) => kindOf(s) === 'ad').length;
      $('job').textContent = `${job.script} ${job.title || ''} · ${plural(ads, 'pub')}, ${plural(partsOf().length, 'partie')}`;
      if (project) {
        try {
          const info = await host('pubs_zoomInfo', JOB);
          if (!info.error) {
            present = {};
            for (const s of info.sequences) present[s.name] = !s.missing;
            zinfo = info.sequences.filter((s) => !s.missing && PARTS.includes(s.kind)); // the zoom preview is ready at once
          }
        } catch (e) {}
        try { const st = await host('pubs_listStyles'); projectStyles = st.error ? [] : st.names; } catch (e) { projectStyles = []; }
        try { const ex = await host('pubs_exportInfo', JOB); einfo = {}; if (!ex.error) for (const e of ex.sequences) einfo[e.index] = e; } catch (e) { einfo = {}; }
        const d = done(); // parts already captioned in this project stay unticked
        for (const p of partsOf()) if (d.captioned[p.name]) unticked.add(p.name);
      }
    } else {
      $('job').textContent = 'Rien à construire : dans RYACHA › Pubs, clique « Construire dans Premiere ».';
    }
    paint();
  }

  async function task(stepIndex, fn) {
    if (!job || busy) return;
    busy = true;
    openStep = stepIndex;
    $('log').innerHTML = '';
    lines = 0;
    $('detailSum').textContent = 'Détail';
    $('detail').open = false;
    bars(0);
    $('activity').hidden = false;
    $('status').className = 'status';
    progress(0, '');
    paint();
    const t0 = Date.now();
    let failed = false;
    try {
      const summary = await fn();
      progress(1, `${summary} · ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      failed = true;
      reportError(e.message, e.stack);
      $('status').textContent = `Erreur : ${e.message}`;
      $('status').className = 'status err';
    } finally {
      busy = false;
      await refresh();
      if (!failed) $('status').className = 'status';
    }
  }

  // ---------- 1 · import ----------
  const build = () => task(0, async () => {
    let made = 0, skipped = 0, failed = 0;
    try {
      bars(job.sequences.length);
      progress(0, 'Import des rushes…');
      const b = await host('pubs_begin', JOB);
      if (b.error) throw new Error(b.error);
      for (let i = 0; i < job.sequences.length; i++) {
        progress((i + 0.5) / job.sequences.length, `Séquence ${i + 1}/${job.sequences.length} : ${job.sequences[i].name}`);
        const r = await host('pubs_sequence', i);
        if (r.error) { failed++; log(`✗ ${job.sequences[i].name} : ${r.error}`, 'err'); }
        else if (r.skipped) { skipped++; log(`= ${r.name} existe déjà, laissée telle quelle`, 'skip'); }
        else { made++; log(`✓ ${r.name} · ${r.seconds.toFixed(1)} s`, 'ok'); }
      }
    } finally {
      await host('pubs_finish').catch(() => {});
    }
    return [`${made} créées`, skipped && `${skipped} déjà là`, failed && `${failed} en erreur`].filter(Boolean).join(', ');
  });

  // ---------- 2 · captions ----------
  // The first run in a project asks for the style file; cancelling captions with Premiere's default style.
  const captions = () => {
    if (!busy && job && !styleChoice()) pickStyleFile();
    return captionsRun();
  };
  const captionsRun = () => task(1, async () => {
    const style = styleChoice();
    const todo = partsOf().filter((p) => !unticked.has(p.name));
    if (!todo.length) throw new Error('Coche au moins une partie.');
    const tools = { ffmpeg: ffmpeg(), python: python(), engine: engine(), mp3: premierePreset('3F3F3F3F_4D503320/MP3 256kbps High Quality.epr') };
    if (!tools.ffmpeg) throw new Error('ffmpeg introuvable : ouvre RYACHA une fois (l’app donne ses outils au panneau).');
    if (!tools.python || !tools.engine) throw new Error('Moteur de transcription pas installé : ouvre RYACHA › Transcrire une fois.');
    if (!tools.mp3) throw new Error('Préréglage MP3 de Premiere introuvable.');
    const opts = transcribeOptions();
    const prompt = [PROMPTS[opts.language] || PROMPTS.fr, opts.vocab && `${String(opts.vocab).trim()}.`].filter(Boolean).join(' ');
    const dir = path.join(DATA, 'captions', String(job.script).replace(/[^\w -]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    progress(0.01, 'Lecture du projet…');
    const info = await host('pubs_zoomInfo', JOB); // loads the job in Premiere
    if (info.error) throw new Error(info.error);
    let made = 0, failed = 0;
    const styled = [];
    bars(todo.length);
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      const at = (sub, what) => progress((i + sub) / todo.length, `${p.name} (${i + 1}/${todo.length}) · ${what}`);
      at(0, 'préparation…');
      if (info.sequences[p.index].missing) { failed++; log(`✗ ${p.name} : pas dans le projet (étape 1)`, 'err'); continue; }
      const base = path.join(dir, p.name.replace(/[/:]/g, '-'));
      try {
        at(0.02, 'rendu du son…');
        const r = await host('pubs_renderAudio', p.index, `${base}.mp3`, tools.mp3);
        if (r.error) throw new Error(r.error);
        at(0.2, 'préparation du son…');
        const wav = `${base}.wav`;
        await run(tools.ffmpeg, ['-nostdin', '-y', '-i', `${base}.mp3`, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
        at(0.25, 'transcription 0 %');
        const out = await run(tools.python, [tools.engine, wav, opts.language || 'fr', prompt], {
          env: { NUMBA_CACHE_DIR: path.join(APP_DATA, 'engine', 'numba-cache'), UV_PYTHON_PREFERENCE: 'only-managed', HF_HUB_DISABLE_TELEMETRY: '1', PATH: `${path.dirname(tools.ffmpeg)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }, // the ffmpeg found here (the app's own on a Mac without Homebrew) first
          onLine: (line) => { const m = line.match(/(\d+)%\|/); if (m) at(0.25 + (0.65 * +m[1]) / 100, `transcription ${m[1]} %`); },
        });
        fs.rmSync(wav, { force: true });
        at(0.92, 'sous-titres…');
        const srt = captionsLib.srtFromEngine(JSON.parse(out.slice(out.indexOf('{'))), opts);
        if (!srt) { log(`= ${p.name} : rien n’est dit, pas de sous-titres`, 'skip'); continue; }
        fs.writeFileSync(`${base}.srt`, srt);
        const c = await host('pubs_addCaptions', p.index, `${base}.srt`);
        if (c.error) throw new Error(c.error);
        made++;
        styled.push(p.name);
        const d = done();
        d.captioned[p.name] = new Date().toISOString();
        markDone({ captioned: d.captioned });
        log(`✓ ${p.name} · ${srt.split('\n\n').filter(Boolean).length} sous-titres`, 'ok');
      } catch (e) {
        failed++;
        log(`✗ ${p.name} : ${e.message}`, 'err');
      }
    }
    if (style && made) await applyStyle(style, styled);
    return `Sous-titres : ${made} partie${made > 1 ? 's' : ''}${failed ? `, ${failed} en erreur` : ''}`;
  });

  // No script can set a caption style: the project is saved and closed, its captions get the style in the file
  // (a copy of the project is kept next to it first), then it is reopened. The style's look is learned from a
  // caption Premiere styled (any part styled by hand once) and remembered for the next projects.
  const styleCache = (uid) => path.join(DATA, 'styles', `${uid}.json`);
  async function applyStyle(choice, names) {
    let name = choice.name;
    if (choice.file) {
      progress(0.95, 'Style : import dans le projet…');
      let own = null;
      try { own = lib.styleName(fs.readFileSync(choice.file, 'utf8')); } catch (e) { log(`Style : ${choice.file} illisible`, 'warn'); return; }
      const s = await host('pubs_importStyle', choice.file, own || '');
      if (s.error) { log(`Style : ${s.error}`, 'warn'); return; }
      name = s.name;
    }
    progress(0.96, 'Style : le projet se ferme et se rouvre…');
    const c = await host('pubs_saveAndClose');
    if (c.error || !c.ok) { log(`Style : ${c.error || 'Premiere n’a pas fermé le projet'}`, 'warn'); return; }
    try {
      fs.copyFileSync(c.path, c.path.replace(/\.prproj$/i, ' (avant style).prproj'));
      const xml = zlib.gunzipSync(fs.readFileSync(c.path)).toString('utf8');
      // Premiere gives an imported style a new ID: the tracks are linked to the style as it is in the project
      const styleXml = lib.styleFromProject(xml, name) || (choice.file ? fs.readFileSync(choice.file, 'utf8') : null);
      if (!styleXml) throw new Error(`le style « ${name} » n’est pas dans le projet`);
      const { uid } = lib.readStyleFile(styleXml);
      // the look: from a caption Premiere styled with it (this project, or remembered), else straight from the style
      let learned = lib.learnStyle(xml, styleXml, names);
      if (learned) { fs.mkdirSync(path.dirname(styleCache(uid)), { recursive: true }); fs.writeFileSync(styleCache(uid), JSON.stringify(learned)); }
      else { try { learned = JSON.parse(fs.readFileSync(styleCache(uid), 'utf8')); } catch (e) { learned = lib.styleFromFile(styleXml); } }
      const r = lib.styleCaptionTracks(xml, styleXml, names, learned);
      fs.writeFileSync(c.path, zlib.gzipSync(Buffer.from(r.xml, 'utf8')));
      if (r.captions) log(`✓ Style « ${name} » sur ${r.captions} sous-titres (${plural(r.tracks, 'partie')})`, 'ok');
      else log(`Style « ${name} » lié aux ${plural(r.tracks, 'partie')}, mais ce style n’a pas pu être lu : pose-le à la main sur une partie, puis clique « Appliquer ».`, 'warn');
    } catch (e) {
      log(`Style : ${e.message}`, 'warn');
    } finally {
      progress(0.98, 'Réouverture du projet…');
      const o = await host('pubs_reopen', c.path);
      if (o.error || !o.ok) log(`Rouvre le projet à la main : ${c.path}`, 'err');
    }
  }
  const restyle = () => task(1, async () => {
    const choice = styleChoice() || (pickStyleFile() && styleChoice());
    if (!choice) throw new Error('Choisis d’abord le style.');
    await applyStyle(choice, partsOf().map((p) => p.name));
    return 'Style appliqué';
  });

  // ---------- 3 · zooms ----------
  // zoomi's three tools: the point to zoom into (picked on the frame under the playhead), which tracks are zoomed
  // and which make cuts, and a preview of where every zoom lands. zinfo = the job's parts as they are in Premiere.
  let zinfo = null;
  let frameSize = null; // { width, height } of the grabbed frame's sequence
  const zoomTracks = () => (settings.zoomTracks && settings.zoomTracks.length ? settings.zoomTracks : [0]);
  const ignoredTracks = (n) => settings.ignoredTracks || Array.from({ length: n }, (_, i) => i).filter((i) => i > 0);
  const trackCount = () => (zinfo ? Math.max(1, ...zinfo.map((p) => p.tracks.length)) : 1);

  // per part: its zooms and where the layer goes, from the current settings (instant, no Premiere call)
  function zoomPlan() {
    if (!zinfo) return [];
    return zinfo.map((p) => {
      const tracks = p.tracks.map((list) => list.filter((c) => c.name !== lib.LAYER));
      const { clips, layerTrack } = lib.cutsAndLayer(tracks, zoomTracks(), ignoredTracks(tracks.length));
      return { ...p, layerTrack, cuts: clips, zooms: lib.zoomsFor(clips, p.end, p.fps, { maxZoom: settings.maxZoom }) };
    });
  }

  function paintZoom() {
    // anchor: the dot, and the box that stays in frame at max zoom
    const share = 100 / settings.maxZoom;
    const ax = settings.anchor.x / 100, ay = settings.anchor.y / 100;
    $('maxZoomLabel').textContent = `${settings.maxZoom}\u202f%`;
    $('maxZoom').value = settings.maxZoom;
    $('dot').style.left = `${ax * 100}%`;
    $('dot').style.top = `${ay * 100}%`;
    const L = ax * (1 - share) * 100, T = ay * (1 - share) * 100, W = share * 100;
    Object.assign($('crop').style, { width: `${W}%`, height: `${W}%`, left: `${L}%`, top: `${T}%` });
    Object.assign($('shadeT').style, { left: 0, top: 0, width: '100%', height: `${T}%` });
    Object.assign($('shadeB').style, { left: 0, top: `${T + W}%`, width: '100%', height: `${100 - T - W}%` });
    Object.assign($('shadeL').style, { left: 0, top: `${T}%`, width: `${L}%`, height: `${W}%` });
    Object.assign($('shadeR').style, { left: `${L + W}%`, top: `${T}%`, width: `${100 - L - W}%`, height: `${W}%` });
    const size = frameSize || (zinfo && zinfo[0]) || null;
    if (size && size.width && size.height) $('frame').style.aspectRatio = `${size.width} / ${size.height}`;
    // tracks: top track first, like Premiere
    const n = trackCount();
    const body = $('tracks').querySelector('tbody');
    body.innerHTML = '';
    for (let t = n - 1; t >= 0; t--) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = `V${t + 1}`;
      row.appendChild(name);
      for (const key of ['zoom', 'ignore']) {
        const cell = document.createElement('td');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = busy;
        box.setAttribute('aria-label', `${key === 'zoom' ? 'Zoomer' : 'Ignorer les coupes de'} V${t + 1}`);
        box.checked = key === 'zoom' ? zoomTracks().includes(t) : ignoredTracks(n).includes(t);
        box.onchange = () => {
          if (key === 'zoom') settings.zoomTracks = box.checked ? [...new Set([...zoomTracks(), t])] : zoomTracks().filter((i) => i !== t);
          else settings.ignoredTracks = box.checked ? [...new Set([...ignoredTracks(n), t])] : ignoredTracks(n).filter((i) => i !== t);
          save(); paintZoom();
        };
        cell.appendChild(box);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    drawPreview();
  }

  // one row per part: cut ticks above, zooms below (light / full)
  function drawPreview() {
    const box = $('preview');
    box.innerHTML = '';
    const plan = zoomPlan();
    if (!plan.length) { $('summary').textContent = 'Analyse pour voir où tombent les zooms.'; return; }
    let total = 0;
    for (const p of plan) {
      total += p.zooms.length;
      const row = document.createElement('div');
      row.className = 'prow';
      const name = document.createElement('span');
      name.textContent = p.name;
      name.title = `${p.name} · ${plural(p.zooms.length, 'zoom')} · V${p.layerTrack + 1}`;
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      row.setAttribute('aria-label', `${p.name} : ${plural(p.zooms.length, 'zoom')}`);
      row.append(name, c);
      box.appendChild(row);
      const ratio = window.devicePixelRatio || 1, w = c.clientWidth || 200, h = 14;
      c.width = w * ratio; c.height = h * ratio;
      const g = c.getContext('2d');
      g.scale(ratio, ratio);
      const x = (t) => (t / (p.end || 1)) * w;
      g.fillStyle = '#ff6a3d'; // cuts: playhead orange, the only colour in the strip
      for (const cut of p.cuts) for (const t of [cut.start, cut.end]) if (t > 0 && t < p.end) g.fillRect(Math.round(x(t)), 0, 1, 4);
      for (const z of p.zooms) {
        g.fillStyle = z.scale >= settings.maxZoom ? 'rgba(255,255,255,.62)' : 'rgba(255,255,255,.26)';
        g.fillRect(x(z.start), 5, Math.max(1, x(z.end) - x(z.start) - 1), 9); // a hairline keeps neighbours apart
      }
    }
    $('summary').textContent = `${plural(total, 'zoom')} dans ${plural(plan.length, 'partie')}`;
  }

  async function analyse() {
    if (!job || busy) return;
    try {
      $('summary').textContent = 'Lecture des parties…';
      const info = await host('pubs_zoomInfo', JOB);
      if (info.error) throw new Error(info.error);
      zinfo = info.sequences.filter((s) => !s.missing && PARTS.includes(s.kind));
      if (!zinfo.length) throw new Error('Aucune partie dans le projet : fais d’abord l’étape 1.');
      paintZoom();
    } catch (e) { $('summary').textContent = e.message; }
  }

  // the picture under the playhead, rebuilt with ffmpeg (exporting from Premiere would include the zooms already there)
  async function grab() {
    if (busy) return;
    const hint = $('frameHint');
    try {
      hint.hidden = false; hint.textContent = 'Lecture de l’image…';
      const info = await host('pubs_playhead', Math.max(...zoomTracks()));
      if (info.error) throw new Error(info.error);
      const tool = ffmpeg();
      if (!tool) throw new Error('ffmpeg introuvable : ouvre RYACHA une fois (l’app donne ses outils au panneau).');
      const out = path.join(DATA, 'frames', 'playhead.jpg');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await run(tool, ['-nostdin', '-v', 'error', '-y', '-ss', String(info.time), '-i', info.path, '-filter_complex', lib.frameFilter(info, info.width, info.height), '-frames:v', '1', '-q:v', '3', out]);
      frameSize = { width: info.width, height: info.height };
      $('frameImage').src = `file://${encodeURI(out)}?${Date.now()}`;
      $('frameImage').alt = `Image de ${info.sequence} sous le playhead`;
      $('frameImage').hidden = false;
      hint.hidden = true;
      paintZoom();
    } catch (e) { hint.hidden = false; hint.textContent = e.message; }
  }

  function templateFor(width, height) {
    const out = path.join(DATA, 'templates', `zoomi-${width}x${height}.prproj`);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const xml = zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'template', 'adjustment-layer.prproj'))).toString('utf8');
    fs.writeFileSync(out, zlib.gzipSync(lib.resizeTemplate(xml, width, height)));
    return out;
  }

  const zoom = () => task(2, async () => {
    let made = 0, layers = 0, failed = 0;
    try {
      progress(0.02, 'Lecture des coupes…');
      await analyse(); // fresh cuts: the editor may have cut since the last preview
      const plan = zoomPlan();
      if (!plan.length) throw new Error($('summary').textContent || 'Aucune partie de ce job dans le projet : fais d’abord l’étape 1.');
      const anchor = { x: settings.anchor.x / 100, y: settings.anchor.y / 100 };
      bars(plan.length);
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        progress((i + 0.5) / plan.length, `Zooms ${i + 1}/${plan.length} : ${p.name}`);
        if (!p.zooms.length) { log(`= ${p.name} : aucun plan`, 'skip'); continue; }
        const b = await host('pubs_zoomBegin', templateFor(p.width, p.height), lib.layerName(p.width, p.height));
        if (b.error) throw new Error(b.error);
        const r = await host('pubs_zoom', p.index, p.zooms, anchor, p.layerTrack);
        if (r.error) { failed++; log(`✗ ${p.name} : ${r.error}`, 'err'); continue; }
        made++; layers += r.zooms;
        log(`✓ ${p.name} · ${plural(r.zooms, 'zoom')}${r.replaced ? ` (${r.replaced} remplacés)` : ''}`, 'ok');
      }
    } finally {
      await host('pubs_zoomFinish').catch(() => {});
    }
    if (made) markDone({ zoomed: new Date().toISOString() });
    return `Zooms : ${layers} dans ${plural(made, 'partie')}${failed ? `, ${failed} en erreur` : ''}`;
  });

  // ---------- 4 · export ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ameRunning = () => {
    try { require('child_process').execFileSync('/usr/bin/pgrep', ['-f', 'Adobe Media Encoder [0-9]+\\.app/Contents/MacOS/']); return true; } catch (e) { return false; }
  };
  // Media Encoder's own log of what it rendered (one per version: the one it writes to is the newest)
  const AME_DIR = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
  const ameLogs = () => { try { return fs.readdirSync(AME_DIR).map((v) => path.join(AME_DIR, v, 'AMEEncodingLog.txt')).filter((f) => fs.existsSync(f)); } catch (e) { return []; } };
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (e) { return -1; } };
  const samePath = (f) => { try { return path.join(fs.realpathSync(path.dirname(f)), path.basename(f)); } catch (e) { return f; } };

  /**
   * Follows what Media Encoder really renders, from its log and the files on disk: one bar segment per file. A file
   * it never received (it happens to the first ones sent after Premiere starts) is sent once more when nothing has
   * moved for 40 s; after that it is reported, never silently counted as done.
   */
  async function followEncodes(sent, preset, logFrom) {
    const left = new Map(sent.map((s) => [samePath(s.p.out), s]));
    const sizes = new Map(), tried = new Set();
    let done = 0, bad = 0, idleSince = Date.now(), seen = '';
    for (const s of sent) segs[s.seg].className = '';
    cur = -1; // this follows each file's own segment: log() must not mark the "current" one
    const finish = (s, ok, why) => {
      left.delete(samePath(s.p.out));
      segs[s.seg].className = ok ? 'ok' : 'bad';
      if (ok) { done++; log(`✓ ${s.label} rendu`, 'ok'); } else { bad++; log(`✗ ${s.label} : ${why}`, 'err'); }
    };
    while (left.size) {
      await sleep(2000);
      let text = '';
      for (const f of ameLogs()) {
        const buf = (() => { try { return fs.readFileSync(f); } catch (e) { return Buffer.alloc(0); } })();
        const from = buf.length >= (logFrom[f] || 0) ? (logFrom[f] || 0) : 0;
        text += lib.decodeLog(buf.subarray(from - (from % 2)));
      }
      if (text !== seen) { seen = text; idleSince = Date.now(); }
      const rec = new Map([...lib.ameRecords(text)].map(([k, v]) => [samePath(k), v]));
      for (const [out, s] of [...left]) {
        const size = sizeOf(out);
        if (size !== sizes.get(out)) { sizes.set(out, size); if (size > 0) { idleSince = Date.now(); segs[s.seg].className = 'run'; } }
        const r = rec.get(out);
        if (r) finish(s, size > 0 && !r.failed, r.failed ? `Media Encoder : ${r.status}` : 'le fichier n’est pas là');
      }
      $('status').textContent = `Media Encoder : ${done}/${sent.length} rendu${done > 1 ? 's' : ''}${bad ? ` · ${bad} en erreur` : ''}…`;
      if (!left.size) break;
      if (!ameRunning()) { for (const s of [...left.values()]) finish(s, sizeOf(samePath(s.p.out)) > 0, 'Media Encoder s’est fermé avant de le rendre'); break; }
      if (Date.now() - idleSince < 40000) continue;
      // nothing has moved for 40 s
      for (const s of [...left.values()]) {
        const out = samePath(s.p.out);
        if (sizeOf(out) > 0) { finish(s, true); continue; } // written, its log line not there yet
        if (tried.has(out)) { finish(s, false, 'Media Encoder ne l’a pas reçu, même renvoyé'); continue; }
        tried.add(out);
        const r = await host('pubs_exportAs', s.p.index, s.p.format, s.p.out, preset);
        log(r.error ? `✗ ${s.label} : ${r.error}` : `↻ ${s.label} : Media Encoder ne l’avait pas reçu, renvoyé`, r.error ? 'err' : 'skip');
        if (r.error) finish(s, false, r.error);
      }
      if (left.size) await host('pubs_exportStart');
      idleSince = Date.now();
    }
    return { done, bad };
  }

  const exportAds = () => task(3, async () => {
    const root = rootFolder();
    const preset = $('preset').value;
    if (!root) throw new Error('Enregistre le projet, ou choisis le dossier des livrables.');
    if (!preset || !fs.existsSync(preset)) throw new Error('Préréglage d’export introuvable.');
    progress(0, 'Lecture du projet…');
    const ex = await host('pubs_exportInfo', JOB); // also loads the job in Premiere
    if (ex.error) throw new Error(ex.error);
    einfo = {};
    for (const e of ex.sequences) einfo[e.index] = e;
    const plan = filePlan().filter((p) => !filesOff.has(p.out));
    let queued = 0, skipped = 0, failed = 0, made4x5 = 0;
    bars(plan.length);
    // Media Encoder first: a file sent while it is still starting can be lost
    if (!ameRunning()) {
      progress(0, 'Ouverture de Media Encoder…');
      await host('pubs_launchEncoder');
      for (let i = 0; i < 120 && !ameRunning(); i++) await sleep(500);
      await sleep(10000); // it takes files once it has finished starting
    }
    const logFrom = Object.fromEntries(ameLogs().map((f) => [f, sizeOf(f)]));
    const sent = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const label = path.basename(p.out);
      progress((i + 0.5) / plan.length, `Mise en file ${i + 1}/${plan.length} : ${label}`);
      const e = einfo[p.index];
      if (!e || !e.present) { skipped++; log(`= ${p.name} pas dans le projet`, 'skip'); continue; }
      if (fs.existsSync(p.out)) { skipped++; log(`= ${label} déjà exportée, pas écrasée`, 'skip'); continue; }
      if (p.format === '4x5' && !e.has4x5) {
        const m = await host('pubs_make4x5', p.index);
        if (m.error) { failed++; log(`✗ ${label} : ${m.error}`, 'err'); continue; }
        e.has4x5 = true;
        made4x5++;
      }
      fs.mkdirSync(path.dirname(p.out), { recursive: true });
      const r = await host('pubs_exportAs', p.index, p.format, p.out, preset);
      if (r.error) { failed++; log(`✗ ${label} : ${r.error}`, 'err'); continue; }
      queued++;
      sent.push({ p, seg: i, label });
      log(`→ ${path.relative(root, p.out)}`, 'ok');
    }
    let rendered = null;
    if (queued && settings.startNow !== false) {
      const s = await host('pubs_exportStart');
      if (s.error) log(`Lance la file dans Media Encoder : ${s.error}`, 'warn');
      else rendered = await followEncodes(sent, preset, logFrom);
    }
    if (queued) markDone({ exported: queued, rendered: rendered ? rendered.done : 0 });
    const where = rendered ? `rendu${rendered.done > 1 ? 's' : ''} par Media Encoder${rendered.bad ? ` · ${rendered.bad} en erreur` : ''}`
      : settings.startNow !== false ? 'envoyés à Media Encoder' : 'en file dans Media Encoder : vérifie, puis lance-la';
    return `${plural(rendered ? rendered.done : queued, 'fichier')} ${where}${made4x5 ? ` · ${made4x5} séquence${made4x5 > 1 ? 's' : ''} 4x5 créée${made4x5 > 1 ? 's' : ''}` : ''}${skipped ? ` · ${skipped} passés` : ''}${failed ? ` · ${failed} en erreur` : ''}`;
  });

  // ---------- wiring ----------
  steps.forEach((el, i) => { el.querySelector('.head').onclick = () => { if (!busy) { openStep = i; paint(); } }; });
  $('reload').onclick = refresh;
  $('build').onclick = build;
  $('captions').onclick = captions;
  $('zoom').onclick = zoom;
  $('export').onclick = exportAds;
  $('allParts').onclick = () => { unticked = new Set(); paint(); };
  $('noParts').onclick = () => { unticked = new Set(partsOf().map((p) => p.name)); paint(); };
  $('style').onchange = () => {
    const v = $('style').value;
    if (v === 'pick') pickStyleFile();
    else if (v.startsWith('name:')) setChoice({ name: v.slice(5) });
    else if (v.startsWith('file:')) setChoice({ file: v.slice(5) });
    paint();
  };
  $('applyStyle').onclick = () => restyle();
  $('maxZoom').oninput = () => { settings.maxZoom = Math.min(200, Math.max(105, +$('maxZoom').value || 138)); paintZoom(); };
  $('maxZoom').onchange = save;
  const aim = (e) => {
    const box = $('frame').getBoundingClientRect();
    settings.anchor = { x: Math.round(((e.clientX - box.left) / box.width) * 1000) / 10, y: Math.round(((e.clientY - box.top) / box.height) * 1000) / 10 };
    save(); paintZoom();
  };
  $('frame').onclick = aim;
  $('frame').onkeydown = (e) => { // arrows move the point, for keyboard users
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    settings.anchor = { x: Math.min(100, Math.max(0, settings.anchor.x + d[0])), y: Math.min(100, Math.max(0, settings.anchor.y + d[1])) };
    save(); paintZoom();
  };
  $('grab').onclick = () => grab();
  $('analyse').onclick = () => analyse();
  $('preset').onchange = () => { settings.preset = $('preset').value; save(); };
  const setFormat = () => { settings.formats = [$('fmt916').checked && '9x16', $('fmt45').checked && '4x5'].filter(Boolean); save(); paint(); };
  $('fmt916').onchange = setFormat;
  $('fmt45').onchange = setFormat;
  $('startNow').onchange = () => { settings.startNow = $('startNow').checked; save(); };
  $('allFiles').onclick = () => { filesOff = new Set(); paintFiles(); };
  $('noFiles').onclick = () => { filesOff = new Set(filePlan().map((p) => p.out)); paintFiles(); };
  $('pickRoot').onclick = () => {
    const r = window.cep && window.cep.fs.showOpenDialogEx(false, true, 'Dossier des livrables', rootFolder() || os.homedir());
    if (r && !r.err && r.data && r.data[0] && project && project.path) { settings.roots[project.path] = r.data[0]; save(); paint(); }
  };
  refresh();
})();
