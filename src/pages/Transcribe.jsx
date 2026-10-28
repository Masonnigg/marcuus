import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Upload, Save, Copy, Clapperboard, X, Check, FolderOpen, Loader2, Download, AlertCircle, Cpu, Wand2, FishingHook } from 'lucide-react';
import CaptionEditor from '../components/CaptionEditor.jsx';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { fmtTime, serializeSrt } from '../lib/srt.js';
import { wordsFromWhisper, cuesFromWords } from '../lib/transcribe.js';
import { unitsFromCues, groupsToCues, enforceLimits, DEFAULT_EXPRESSIONS } from '../lib/segment.js';
import { buildRefinePrompt, parseRefine } from '../lib/refine.js';
import { loadSettings } from './Settings.jsx';

const MEDIA_RE = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mp3|wav|m4a|aac|flac|ogg|aif|aiff)$/i;
const DEFAULT_OPTS = { smart: true, vocab: '', language: 'fr', wordsPerCue: 2, maxChars: 18, caps: false, punctuation: true };
let seq = 0;

export default function Transcribe({ onSendToBroll, onSendToFixer, onSendToHook }) {
  const notify = useToast();
  const [status, setStatus] = useState(null);
  const [install, setInstall] = useState(null); // { stage } while installing
  const [settings, setSettings] = useState({ expressions: DEFAULT_EXPRESSIONS, model: 'sonnet' });
  const [refining, setRefining] = useState(null); // job key while Claude works
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [jobs, setJobs] = useState([]);
  const [sel, setSel] = useState(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef();
  const running = useRef(false);

  const refresh = () => kit.whisper?.status().then(setStatus);
  useEffect(() => {
    refresh();
    loadSettings().then(setSettings);
    kit.store.get('transcribeOpts', null).then((o) => o && setOpts({ ...DEFAULT_OPTS, ...o }));
    kit.store.get('transcribeSession', null).then((sv) => {
      if (!sv?.jobs?.length) return;
      // a job that was running when the app closed simply runs again
      const restored = sv.jobs.map((j) => ({ ...j, key: ++seq, state: j.state === 'running' ? 'queued' : j.state }));
      setJobs((cur) => [...restored, ...cur]);
      setSel((cur) => cur ?? restored[Math.min(sv.selIndex || 0, restored.length - 1)].key);
    });
    if (!kit.whisper) return;
    const offA = kit.whisper.onProgress((p) => setJobs((js) => js.map((j) => (j.path === p.filePath
      ? { ...j, stage: p.stage, pct: p.pct ?? j.pct, note: p.note !== undefined ? p.note : j.note, startedAt: j.startedAt || Date.now() }
      : j))));
    const offB = kit.whisper.onInstallProgress((p) => setInstall(p));
    return () => { offA(); offB(); };
  }, []);

  const setOpt = (patch) => setOpts((o) => { const n = { ...o, ...patch }; kit.store.set('transcribeOpts', n); return n; });
  const update = (key, patch) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  const ready = status?.supported !== false && status?.ffmpeg && status?.engine && status?.model;

  // keep files, transcripts and edits across tab switches and restarts
  useEffect(() => {
    const t = setTimeout(() => {
      const keep = jobs.map(({ key, stage, pct, ...j }) => j);
      kit.store.set('transcribeSession', { jobs: keep, selIndex: Math.max(0, jobs.findIndex((j) => j.key === sel)) });
    }, 400);
    return () => clearTimeout(t);
  }, [jobs, sel]);

  // process the queue one file at a time
  useEffect(() => {
    if (!ready || running.current) return;
    const next = jobs.find((j) => j.state === 'queued');
    if (!next) return;
    running.current = true;
    update(next.key, { state: 'running', stage: 'audio', pct: 0, note: null, startedAt: Date.now() });
    const t0 = Date.now();
    kit.whisper
      .transcribe(next.path, { language: opts.language, vocab: opts.vocab.trim() })
      .then(async (tr) => {
        const words = wordsFromWhisper(tr);
        // nothing is written to disk until the user clicks "Exporter .srt"
        update(next.key, { state: 'done', words, secs: Math.round((Date.now() - t0) / 1000) });
      })
      .catch((e) => update(next.key, { state: 'error', error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
      .finally(() => { running.current = false; setJobs((js) => [...js]); });
  }, [jobs, ready]);

  const addFiles = (list) => {
    const files = [...list].filter((f) => MEDIA_RE.test(f.name));
    if (!files.length) { notify('Glisse une vidéo ou un fichier audio', { tone: 'bad' }); return; }
    const added = files
      .map((f) => ({ key: ++seq, name: f.name, path: kit.pathFor(f), state: 'queued' }))
      .filter((j) => j.path);
    if (!added.length) { notify('Disponible uniquement dans l’app', { tone: 'bad' }); return; }
    setJobs((js) => [...js, ...added]);
    setSel((s) => s ?? added[0].key);
  };

  const cuesFor = (job) => job?.edited || (job?.words ? cuesFromWords(job.words, { ...opts, expressions: settings.expressions }) : []);

  // Claude re-splits the captions as shown; any changed word = rejected. The result is kept as a manual edit.
  async function refine(job, cues) {
    if (refining) return;
    setRefining(job.key);
    const units = cues.flatMap((c) => unitsFromCues([c]).map((u) => ({ ...u, doubt: (c.doubt || []).filter((d) => u.text.includes(d)) })));
    const target = opts.wordsPerCue;
    const r = await kit.claude.ask(buildRefinePrompt(cues.map((c) => c.text), target), settings.model || 'sonnet');
    setRefining(null);
    if (!r.ok) { notify(r.error, { tone: 'bad', ms: 6000 }); return; }
    try {
      const groups = enforceLimits(units, parseRefine(r.text, units), { target, expressions: settings.expressions });
      update(job.key, { edited: groupsToCues(units, groups), refined: true, dirty: true });
      notify('Découpage affiné par Claude');
    } catch (e) {
      notify(e.message, { tone: 'bad', ms: 7000 });
    }
  }
  const srtPathFor = (job) => job.savedTo || job.path.replace(/\.[^./]+$/, '') + '.srt';

  // never overwrite an existing .srt we didn't write (e.g. a TurboScribe one)
  async function targetFor(job) {
    if (job.savedTo) return job.savedTo;
    const base = job.path.replace(/\.[^./]+$/, '');
    return (await kit.exists(base + '.srt')) ? base + ' - MARCUUS.srt' : base + '.srt';
  }

  async function save(job, auto) {
    const content = serializeSrt(cuesFor(job).map(({ start, end, text }) => ({ start, end, text })));
    const target = await targetFor(job);
    try {
      const p = await kit.writeFile(target, content);
      if (!auto) notify('SRT exporté à côté de la vidéo', { ms: 4000, action: { label: 'Afficher', onClick: () => kit.reveal(p) } });
      return p;
    } catch (e) {
      notify(e.message, { tone: 'bad' });
      return null;
    }
  }

  const job = jobs.find((j) => j.key === sel);
  const cues = useMemo(() => cuesFor(job), [job?.words, job?.edited, opts, settings.expressions]);
  const plain = (cs) => cs.map(({ start, end, text }) => ({ start, end, text }));

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
    >
      <PageHeader title="Transcrire" sub="Vidéo ou audio → sous-titres, en local sur ton Mac (Whisper). Les mots ne sont jamais coupés.">
        <input ref={inputRef} type="file" multiple hidden accept="video/*,audio/*,.mxf" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        {ready && <button className="btn" onClick={() => inputRef.current.click()}><Upload size={14} /> Ajouter des fichiers</button>}
      </PageHeader>

      {status && !ready ? (
        <Setup status={status} install={install} onInstall={async () => {
          setInstall({ stage: 'engine' });
          try { await kit.whisper.install(); notify('Moteur prêt'); } catch (e) { notify(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { tone: 'bad', ms: 6000 }); }
          setInstall(null);
          refresh();
        }} onRecheck={refresh} />
      ) : !status ? null : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-8 pb-6">
          <Options opts={opts} setOpt={setOpt} />
          {jobs.length === 0 ? (
            <button
              onClick={() => inputRef.current.click()}
              className={`rise grid flex-1 place-items-center rounded-2xl border-2 border-dashed transition-all duration-300 ${over ? 'scale-[0.99] border-accent bg-accent/5' : 'border-line hover:border-line-2'}`}
            >
              <div className="text-center">
                <div className={`mx-auto mb-4 grid size-14 place-items-center rounded-2xl ${over ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}><AudioLines size={22} /></div>
                <div className="text-[15px] font-semibold">Glisse tes vidéos ou audios ici</div>
                <div className="mt-1 text-mute">MP4, MOV, MP3, WAV… plusieurs à la fois. Relis, puis exporte le .srt quand tu es prêt.</div>
              </div>
            </button>
          ) : (
            <div className="flex min-h-0 flex-1 gap-4">
              <aside className="flex w-[260px] shrink-0 flex-col gap-1.5 overflow-y-auto">
                {jobs.map((j) => <JobItem key={j.key} job={j} active={j.key === sel} onClick={() => setSel(j.key)} onRemove={() => { setJobs((js) => js.filter((x) => x.key !== j.key)); if (sel === j.key) setSel(null); }} />)}
                <button onClick={() => inputRef.current.click()} className="rounded-xl border border-dashed border-line p-3 text-[12px] text-faint transition-colors hover:border-line-2 hover:text-mute">+ Ajouter des fichiers</button>
              </aside>
              <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
                {!job ? (
                  <div className="grid flex-1 place-items-center text-mute">Sélectionne un fichier</div>
                ) : job.state === 'done' ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{job.name}</div>
                        <div className="text-[11.5px] text-faint">{cues.length} sous-titres · transcrit en {job.secs}s{job.dirty ? ' · modifications non exportées' : ''}</div>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <button className="btn" onClick={async () => { await kit.copy(serializeSrt(plain(cues))); notify('SRT copié'); }}><Copy size={13} /> Copier</button>
                        <button className="btn" onClick={async () => {
                          const target = await targetFor(job);
                          onSendToFixer({ name: target.split('/').pop(), path: target, raw: serializeSrt(plain(cues)) });
                        }}><Wand2 size={13} /> SRT Fixer</button>
                        <button className="btn" onClick={() => onSendToBroll({ name: job.name.replace(/\.[^.]+$/, '.srt'), path: srtPathFor(job), cues: plain(cues) })}><Clapperboard size={13} /> B-roll</button>
                        {/* corrected captions are what the person really said: send those when edited */}
                        <button className="btn" onClick={() => onSendToHook({ name: job.name, path: job.path, words: job.edited ? unitsFromCues(job.edited) : job.words })}><FishingHook size={13} /> Hook</button>
                        <button className="btn btn-primary relative" onClick={async () => { const p = await save(job); if (p) update(job.key, { savedTo: p, dirty: false }); }}>
                          <Save size={13} /> Exporter .srt
                          {job.dirty && <span className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-panel bg-warn" />}
                        </button>
                      </div>
                    </div>
                    <CaptionEditor
                      key={job.key}
                      cues={cues}
                      mediaPath={job.path}
                      edited={!!job.edited}
                      onChange={(next) => update(job.key, { edited: next, dirty: true })}
                      onReset={() => update(job.key, { edited: null, refined: false, dirty: true })}
                      refined={!!job.refined}
                      refining={refining === job.key}
                      onRefine={() => refine(job, cues)}
                      dismissed={job.dismissed || []}
                      onDismiss={(start) => update(job.key, { dismissed: [...(job.dismissed || []), start] })}
                    />
                    {job.savedTo && (
                      <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11.5px] text-mute">
                        <Check size={12} className="text-ok" /> <span className="truncate" data-selectable>{job.savedTo}</span>
                        <button className="btn btn-ghost ml-auto h-6 px-2 text-[11.5px]" onClick={() => kit.reveal(job.savedTo)}><FolderOpen size={12} /> Afficher dans le Finder</button>
                      </div>
                    )}
                  </>
                ) : job.state === 'error' ? (
                  <div className="grid flex-1 place-items-center p-8 text-center">
                    <div className="max-w-md">
                      <AlertCircle className="mx-auto mb-2 text-bad" />
                      <div className="font-medium">La transcription a échoué</div>
                      <div className="mt-1 text-[12px] text-mute" data-selectable>{job.error}</div>
                      <div className="mt-4 flex justify-center gap-2">
                        <button className="btn" onClick={() => update(job.key, { state: 'queued', error: null })}>Réessayer</button>
                        <CopyLog />
                      </div>
                    </div>
                  </div>
                ) : (
                  <Running job={job} />
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Options({ opts, setOpt }) {
  return (
    <div className="card rise flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-[12px]">
      <label className="flex items-center gap-2 text-mute">Langue
        <div className="seg">
          {[['fr', 'Français'], ['en', 'Anglais'], ['auto', 'Auto']].map(([id, l]) => <button key={id} data-on={opts.language === id} onClick={() => setOpt({ language: id })}>{l}</button>)}
        </div>
      </label>
      <label className="flex items-center gap-2 text-mute">Mots / sous-titre
        <div className="seg">
          {[1, 2, 3, 4, 6].map((n) => <button key={n} data-on={opts.wordsPerCue === n} onClick={() => setOpt({ wordsPerCue: n, maxChars: n <= 2 ? 18 : n <= 4 ? 28 : 42 })}>{n}</button>)}
        </div>
      </label>
      <Toggle on={opts.smart} onClick={() => setOpt({ smart: !opts.smart })}>Découpage intelligent</Toggle>
      <Toggle on={opts.caps} onClick={() => setOpt({ caps: !opts.caps })}>MAJUSCULES</Toggle>
      <Toggle on={opts.punctuation} onClick={() => setOpt({ punctuation: !opts.punctuation })}>Ponctuation</Toggle>
      <label className="flex min-w-[260px] flex-1 items-center gap-2 text-mute">Mots à reconnaître
        <input
          className="field h-7 flex-1"
          placeholder="ex. un prénom, Shopify, dropshipping…"
          value={opts.vocab}
          onChange={(e) => setOpt({ vocab: e.target.value })}
          spellCheck={false}
        />
      </label>
    </div>
  );
}

function Toggle({ on, onClick, children }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2 text-mute hover:text-ink">
      <span className={`relative h-[18px] w-[30px] rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line-2'}`}>
        <span className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-all duration-200 ${on ? 'left-[14px]' : 'left-[2px]'}`} />
      </span>
      {children}
    </button>
  );
}

function JobItem({ job, active, onClick, onRemove }) {
  return (
    <button onClick={onClick} className={`group relative rounded-xl border p-3 text-left transition-colors ${active ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel'}`}>
      <div className="flex items-start gap-2">
        {job.state === 'done' ? <Check size={15} className="mt-px shrink-0 text-ok" />
          : job.state === 'error' ? <AlertCircle size={15} className="mt-px shrink-0 text-bad" />
          : job.state === 'running' ? <Loader2 size={15} className="mt-px shrink-0 animate-spin text-accent" />
          : <AudioLines size={15} className="mt-px shrink-0 text-faint" />}
        <div className="min-w-0 flex-1">
          <div className="truncate pr-4 text-[12.5px] font-medium">{job.name.replace(/\.[^.]+$/, '')}</div>
          <div className="mt-0.5 text-[11px] text-mute">
            {job.state === 'done' ? (job.savedTo ? (job.dirty ? 'modifié depuis l’export' : '.srt exporté') : 'à exporter') : job.state === 'error' ? 'erreur' : job.state === 'running' ? (job.stage === 'transcribe' ? `${job.pct || 0}%` : 'audio…') : 'en attente'}
          </div>
        </div>
      </div>
      {job.state !== 'running' && (
        <span role="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="absolute top-2.5 right-2 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-ink"><X size={13} /></span>
      )}
    </button>
  );
}

function Setup({ status, install, onInstall, onRecheck }) {
  const toolsOk = status.uv && status.ffmpeg;
  if (status.supported === false) {
    return (
      <div className="px-8 pb-8">
        <div className="card rise mx-auto max-w-xl p-6 text-center">
          <Cpu className="mx-auto mb-3 text-faint" />
          <div className="text-[15px] font-semibold">Transcription indisponible sur ce Mac</div>
          <p className="mt-1.5 text-mute">Le moteur Whisper (MLX) a besoin d’une puce Apple : M1, M2, M3, M4 ou plus récent. Cette version de MARCUUS est celle pour Mac Intel. Sur un Mac à puce Apple, installe plutôt le fichier « arm64 ».</p>
          <p className="mt-3 text-mute">Le SRT Fixer, le B-roll et les Palettes fonctionnent normalement. Pour les sous-titres, utilise TurboScribe puis le SRT Fixer.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="px-8 pb-8">
      <div className="card rise mx-auto max-w-xl p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent/15 text-accent"><Cpu size={18} /></div>
          <div>
            <div className="text-[15px] font-semibold">Installation (une seule fois)</div>
            <div className="text-mute">Whisper turbo sur ta puce Apple (MLX), gratuit et hors-ligne.</div>
          </div>
        </div>
        <Step ok={toolsOk} title={status.bundled ? 'Outils (inclus dans l’app)' : 'Outils (uv, ffmpeg)'}>
          {!toolsOk && <>Dans le Terminal : <span className="kbd" data-selectable>brew install uv ffmpeg</span> <button className="ml-2 underline" onClick={onRecheck}>Vérifier</button></>}
        </Step>
        <Step ok={status.engine} title="Moteur MLX Whisper · ~200 Mo">
          {install?.stage === 'engine' && <span className="flex items-center gap-1.5 text-accent-2"><Loader2 size={12} className="animate-spin" /> Installation…</span>}
        </Step>
        <Step ok={status.model} title="Modèle large-v3-turbo · 1,6 Go">
          {install?.stage === 'model' && <span className="flex items-center gap-1.5 text-accent-2"><Loader2 size={12} className="animate-spin" /> Téléchargement… (quelques minutes)</span>}
        </Step>
        <Step ok={status.engine} title="Préparation du moteur (une fois)">
          {install?.stage === 'warmup' && <span className="flex items-center gap-1.5 text-accent-2"><Loader2 size={12} className="animate-spin" /> Préparation… (jusqu’à 1 min)</span>}
        </Step>
        {toolsOk && !install && (
          <button className="btn btn-primary mt-3" onClick={onInstall}><Download size={14} /> Installer</button>
        )}
      </div>
    </div>
  );
}

function Step({ ok, title, children }) {
  return (
    <div className="flex gap-3 border-t border-line py-3.5">
      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${ok ? 'bg-ok/15 text-ok' : 'bg-panel-2 text-faint'}`}>{ok ? <Check size={12} strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-current" />}</span>
      <div className="flex-1"><div className="font-medium">{title}</div><div className="text-mute">{children}</div></div>
    </div>
  );
}

const STEP_LABEL = { 'chargement du modèle': 'Chargement du modèle…', transcription: 'Transcription…', 'terminé': 'Finalisation…' };

export function Running({ job }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = job.startedAt ? Math.round((now - job.startedAt) / 1000) : 0;
  const pct = job.state === 'running' && job.stage === 'transcribe' ? job.pct || 0 : 0;
  const title = job.state === 'queued' ? 'En attente…'
    : job.stage === 'audio' ? 'Extraction de l’audio…'
    : pct > 0 ? `Transcription… ${pct}%`
    : STEP_LABEL[job.note] || 'Démarrage du moteur…';
  const slow = job.state === 'running' && pct === 0 && secs > 30;
  return (
    <div className="grid flex-1 place-items-center">
      <div className="w-80 text-center">
        <Loader2 className="mx-auto mb-3 animate-spin text-accent" />
        <div className="font-medium">{title}</div>
        {job.state === 'running' && <div className="mt-1 text-[11.5px] text-faint">{secs}s</div>}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        {slow && (
          <div className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-left text-[11.5px] text-warn">
            C’est plus long que prévu. Si ça reste bloqué, copie le journal et envoie-le : il montre où le moteur s’est arrêté.
          </div>
        )}
        {job.state === 'running' && (
          <div className="mt-4 flex justify-center gap-2">
            <button className="btn btn-ghost" onClick={() => kit.whisper.cancel()}>Annuler</button>
            {slow && <CopyLog />}
          </div>
        )}
      </div>
    </div>
  );
}

export function CopyLog() {
  const notify = useToast();
  return (
    <button className="btn" onClick={async () => { const log = (await kit.whisper.log?.()) || ''; await kit.copy(log || '(journal vide)'); notify('Journal copié : colle-le dans le chat'); }}>
      <Copy size={13} /> Copier le journal
    </button>
  );
}
