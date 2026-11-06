import { useEffect, useMemo, useRef, useState } from 'react';
import { Megaphone, FileText, FolderOpen, Loader2, Check, AlertTriangle, Play, Square, RotateCcw, Film, Hammer } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { pdfText, findScripts, buildBriefRequest, parseBriefReply, partText } from '../lib/ads/brief.js';
import { planAds, buildJob } from '../lib/ads/plan.js';
import { recordingFrom, spokenParts, buildTakesRequest, matchParts } from '../lib/ads/takes.js';
import { askAI, availableEngines, adsEngine, engineLabel } from '../lib/ads/ai.js';
import { usePanelStatus, InstallButton } from '../components/PremierePanel.jsx';
import { playAnalyseSound, SoundControl } from '../components/AnalyseSound.jsx';
import { PartTimeline } from '../components/PartTimeline.jsx';
import { applyEdits, pruneEdits } from '../lib/ads/edits.js';

const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const secs = (pcs) => (pcs || []).reduce((t, p) => t + (p.out - p.in), 0) / 1000;
const VIDEO = /\.(mov|mp4|m4v|mxf|mts|avi|mkv)$/i;

/**
 * Pubs: the client's brief + the raw footage → every hook, transi and corps found in the rushes, checked by
 * the editor (▶, other takes), then built in Premiere. The AI only picks among what was really said.
 */
export default function Pubs({ active }) {
  const notify = useToast();
  const [job, setJob] = useState(null); // persisted: { briefName, briefText, scriptId, folder, media, script, takes, choices, edits, adsOff, loose }
  const [phase, setPhase] = useState('setup'); // setup | running | review
  const [run, setRun] = useState(null); // { step, note, pct, file, error }
  const [recs, setRecs] = useState(null); // recordings (words + sound), rebuilt from the engine cache
  const [sel, setSel] = useState(null);
  const restored = useRef(false);

  // restore the last job (the engine cache makes the transcripts instant)
  useEffect(() => {
    kit.store.get('pubsJob', null).then(async (j) => {
      restored.current = true;
      if (!j) return;
      setJob(j);
      if (j.script && j.takes) {
        setPhase('running'); setRun({ step: 'restore' });
        try { setRecs(await loadRecordings(j.media.filter((m) => m.on))); setPhase('review'); setRun(null); } catch (e) { setPhase('setup'); setRun({ error: cleanErr(e) }); }
      }
    });
    return kit.ads.onProgress((p) => setRun((r) => (r && r.step === 'transcribe' ? { ...r, pct: p.pct ?? r.pct, note: p.note ?? r.note } : r)));
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => kit.store.set('pubsJob', job), 400);
    return () => clearTimeout(t);
  }, [job]);

  const scripts = useMemo(() => (job?.briefText ? findScripts(job.briefText, (job.briefName || 'Script').replace(/\.[^.]+$/, '')) : []), [job?.briefText]);
  const parts = useMemo(() => {
    if (!(job?.script && job.takes && recs)) return null;
    const out = matchParts(job.script, recs, job.takes, { loose: !!job.loose, choices: job.choices || {} });
    // the editor's trims on top of the AI's cut (edits.js): the player, the list and Premiere all use the edited pieces
    for (const [k, p] of Object.entries(out)) {
      p.autoPieces = p.pieces;
      p.clips = applyEdits(p.pieces, job.edits?.[k], recs);
      p.pieces = p.clips.map((c) => ({ media: c.media, in: c.in, out: c.out }));
    }
    return out;
  }, [job?.script, job?.takes, job?.loose, job?.choices, job?.edits, recs]);
  const ads = useMemo(() => (job?.script ? planAds(job.script) : []), [job?.script]);
  // the rushes usually say which script they are ("Test S11", "S11 - Acc 1.mp4"): pick it when only one script fits
  useEffect(() => {
    if (!job || job.scriptId || !scripts.length || !job.media?.length) return;
    const names = [(job.folder || '').split('/').pop(), ...job.media.map((m) => m.name)].join(' ');
    const hits = scripts.filter((s) => new RegExp(`(^|[^A-Za-z0-9])${s.id}($|[^0-9])`, 'i').test(names));
    if (hits.length === 1) setJob((j) => ({ ...j, scriptId: hits[0].id }));
  }, [scripts, job?.folder, job?.media, job?.scriptId]);

  async function loadBrief(path) {
    try {
      const r = await kit.ads.readBrief(path);
      const text = r.kind === 'pdf' ? await pdfText(r.data) : r.text;
      setJob((j) => ({ ...(j || {}), briefName: path.split('/').pop(), briefText: text, scriptId: null, script: null, takes: null }));
      setPhase('setup');
    } catch (e) { notify(`Brief illisible : ${cleanErr(e)}`, { tone: 'bad', ms: 4000 }); }
  }
  async function loadFolder(folder) {
    const media = (await kit.ads.listMedia(folder)).map((m) => ({ ...m, on: VIDEO.test(m.name) }));
    setJob((j) => ({ ...(j || {}), folder, media, takes: null }));
    if (!media.length) notify('Aucune vidéo dans ce dossier', { tone: 'bad' });
  }

  async function analyse() {
    const script = scripts.find((s) => s.id === job.scriptId);
    const files = job.media.filter((m) => m.on);
    playAnalyseSound();
    setPhase('running');
    try {
      const names = files.map((f) => f.name);
      setRun({ step: 'brief', t0: Date.now(), names });
      const parsed = parseBriefReply(await askAI(buildBriefRequest(script)), script.id);
      if (!parsed.variants.some((v) => v.hooks.length)) throw new Error('Aucune accroche trouvée dans ce script.');
      const recordings = [];
      for (let i = 0; i < files.length; i++) {
        setRun({ step: 'transcribe', file: files[i].name, n: i + 1, of: files.length, pct: 0, t0: Date.now(), names });
        recordings.push(recordingFrom(`R${i + 1}`, files[i], await kit.ads.prepare(files[i].path)));
      }
      setRun({ step: 'takes', t0: Date.now(), names });
      const spoken = spokenParts(parsed);
      const takes = spoken.length ? await askAI(buildTakesRequest(spoken, recordings)) : { parts: [] };
      setRecs(recordings);
      setJob((j) => ({ ...j, script: parsed, takes, choices: {}, edits: {}, adsOff: [] }));
      setPhase('review'); setRun(null); setSel(null);
    } catch (e) {
      setPhase('setup'); setRun({ error: cleanErr(e) });
      kit.report({ where: 'pubs:analyse', message: cleanErr(e), stack: e?.stack, name: e?.name }).catch(() => {});
    }
  }

  async function sendToPremiere() {
    const off = new Set(job.adsOff || []);
    const live = ads.filter((a) => (a.skip ? off.has(`+${a.name}`) : !off.has(a.name)));
    const media = job.media.filter((m) => m.on);
    const built = buildJob({ script: job.script, parts, live, media });
    await kit.ads.writeJob(built);
    notify(`${live.length} pubs prêtes. Dans Premiere : Fenêtre › Extensions › RYACHA, puis suis les 4 étapes.`, { ms: 9000 });
  }

  const reset = () => { setJob(null); setRecs(null); setPhase('setup'); setRun(null); kit.store.set('pubsJob', null); };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Pubs" sub="Le brief du client + les rushes → chaque accroche, transition et corps retrouvés dans les rushes, puis construits dans Premiere.">
        {phase === 'review' && <ResetButton onReset={reset} />}
        {phase === 'review' && parts && <button className="btn btn-primary" onClick={sendToPremiere}><Hammer size={14} /> Construire dans Premiere</button>}
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-6">
        {phase === 'running' ? <Progress run={run} />
          : phase === 'review' && parts ? (
            <Review job={job} setJob={setJob} parts={parts} recs={recs} ads={ads} sel={sel} setSel={setSel} />
          ) : (
            <Setup job={job} setJob={setJob} scripts={scripts} run={run} onBrief={loadBrief} onFolder={loadFolder} onAnalyse={analyse} />
          )}
      </div>
    </div>
  );
}

async function loadRecordings(files) {
  const out = [];
  for (let i = 0; i < files.length; i++) out.push(recordingFrom(`R${i + 1}`, files[i], await kit.ads.prepare(files[i].path)));
  return out;
}

function Setup({ job, setJob, scripts, run, onBrief, onFolder, onAnalyse }) {
  const briefRef = useRef();
  const [over, setOver] = useState(null);
  const drop = (kind) => ({
    onDragOver: (e) => { e.preventDefault(); setOver(kind); },
    onDragLeave: () => setOver(null),
    onDrop: (e) => { e.preventDefault(); setOver(null); const p = kit.pathFor(e.dataTransfer.files[0]); if (p) (kind === 'brief' ? onBrief : onFolder)(p); },
  });
  const on = (job?.media || []).filter((m) => m.on);
  const ready = job?.scriptId && on.length;
  return (
    <div className="rise mx-auto grid w-full max-w-4xl gap-4 overflow-y-auto">
      {run?.error && <div className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad" data-selectable>{run.error}</div>}
      <section className={`card p-5 ${over === 'brief' ? 'ring-1 ring-accent' : ''}`} {...drop('brief')}>
        <div className="flex items-center gap-3">
          <Step n={1} done={!!job?.scriptId} />
          <div className="flex-1">
            <div className="font-semibold">Le brief du client</div>
            <div className="text-[12.5px] text-mute">{job?.briefName ? `${job.briefName} · ${scripts.length} script${scripts.length > 1 ? 's' : ''}` : 'PDF, Word ou texte. Glisse-le ici.'}</div>
          </div>
          <input ref={briefRef} type="file" hidden accept=".pdf,.docx,.doc,.rtf,.txt,.md,.odt" onChange={(e) => { const p = kit.pathFor(e.target.files[0]); if (p) onBrief(p); e.target.value = ''; }} />
          <button className="btn" onClick={() => briefRef.current.click()}><FileText size={14} /> Choisir</button>
        </div>
        {scripts.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {scripts.map((s) => (
              <button key={s.id} onClick={() => setJob((j) => ({ ...j, scriptId: s.id }))} title={s.title}
                className={`rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors ${job.scriptId === s.id ? 'border-accent bg-accent/10 text-ink' : 'border-line text-mute hover:border-line-2 hover:text-ink'}`}>
                <b>{s.id}</b> <span className="text-faint">{s.title.slice(0, 32)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className={`card p-5 ${over === 'folder' ? 'ring-1 ring-accent' : ''}`} {...drop('folder')}>
        <div className="flex items-center gap-3">
          <Step n={2} done={on.length > 0} />
          <div className="flex-1">
            <div className="font-semibold">Les rushes de ce script</div>
            <div className="text-[12.5px] text-mute">{job?.folder ? `${job.folder.split('/').pop()} · ${on.length} fichier${on.length > 1 ? 's' : ''} choisi${on.length > 1 ? 's' : ''}` : 'Le dossier avec les vidéos tournées (prompteur, témoignages…).'}</div>
          </div>
          <button className="btn" onClick={async () => { const p = await kit.pickFolder(); if (p) onFolder(p); }}><FolderOpen size={14} /> Choisir</button>
        </div>
        {job?.media?.length > 0 && (
          <div className="mt-3 max-h-56 overflow-y-auto">
            {job.media.map((m) => (
              <label key={m.path} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-[12.5px] hover:bg-panel-2/60">
                <input type="checkbox" checked={m.on} onChange={() => setJob((j) => ({ ...j, media: j.media.map((x) => (x.path === m.path ? { ...x, on: !x.on } : x)) }))} />
                <span className="min-w-0 flex-1 truncate" title={m.path}>{m.path.slice(job.folder.length + 1)}</span>
                <span className="text-faint">{(m.size / 1e6).toFixed(0)} Mo</span>
              </label>
            ))}
          </div>
        )}
      </section>
      <PanelHint />
      <div className="flex items-center justify-end gap-3">
        <span className={`text-[12px] ${ready ? 'text-faint' : 'text-warn'}`}>
          {!job?.briefText ? 'Ajoute le brief du client.' : !job.scriptId ? 'Choisis le script dans le brief (clique sur S…).' : !on.length ? 'Choisis les rushes de ce script.' : 'Transcription des rushes en local, puis l’IA lit le script et choisit les prises.'}
        </span>
        <EnginePicker />
        <SoundControl />
        <button className="btn btn-primary h-9 px-5" disabled={!ready} onClick={onAnalyse}><Megaphone size={14} /> Analyser</button>
      </div>
    </div>
  );
}

// Pubs needs the Premiere panel: say so (with the button) until it is installed.
function PanelHint() {
  const { st, busy, install } = usePanelStatus();
  if (!st || st.installed || !st.available) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-[12.5px]">
      <span className="flex-1 text-mute">{st.ok ? 'Panneau installé : redémarre Premiere, puis Fenêtre › Extensions › RYACHA.' : 'Le panneau Premiere n’est pas encore installé : c’est lui qui construit les pubs dans Premiere.'}</span>
      {!st.ok && <InstallButton st={st} busy={busy} install={install} />}
    </div>
  );
}

// Which AI reads the script and picks the takes: only the ones connected on this Mac (Réglages connects them).
function EnginePicker() {
  const [list, setList] = useState(null);
  const [cur, setCur] = useState(null);
  useEffect(() => { Promise.all([availableEngines(), adsEngine()]).then(([l, c]) => { setList(l); setCur(c); }); }, []);
  if (!list) return null;
  if (!list.length) return <span className="text-[12px] text-warn">Connecte Claude ou ChatGPT dans Réglages.</span>;
  const pick = async (id) => { const s = (await kit.store.get('settings', {})) || {}; await kit.store.set('settings', { ...s, adsEngine: id }); setCur(id); };
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line p-0.5 text-[12px]" role="radiogroup" aria-label="IA utilisée">
      {list.map((id) => (
        <button key={id} role="radio" aria-checked={cur === id} onClick={() => pick(id)}
          className={`h-7 rounded-md px-2.5 transition-colors ${cur === id ? 'bg-panel-2 text-ink' : 'text-mute hover:text-ink'}`}>{engineLabel(id)}</button>
      ))}
    </div>
  );
}

const Step = ({ n, done }) => (
  <span className={`grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${done ? 'bg-ok/15 text-ok' : 'bg-panel-2 text-mute'}`}>{done ? <Check size={14} /> : n}</span>
);

// The three stages of an analysis on one bar. Transcription reports its real percentage; the AI doesn't,
// so its stages move on an estimate (slowing near the end, never reaching it) with the time spent shown.
const STAGES = [
  { step: 'brief', label: 'Lecture du script', from: 0, to: 0.1, expect: 45 },
  { step: 'transcribe', label: 'Transcription des rushes', from: 0.1, to: 0.7 },
  { step: 'takes', label: 'Choix des prises', from: 0.7, to: 1, expect: 180 },
];
const clockOf = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.floor(s % 60)).padStart(2, '0')} s` : `${Math.floor(s)} s`);

function Progress({ run }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, []);
  const at = STAGES.findIndex((x) => x.step === run?.step);
  const stage = STAGES[Math.max(0, at)];
  const elapsed = run?.t0 ? (Date.now() - run.t0) / 1000 : 0;
  const inside = !run ? 0
    : run.step === 'transcribe' ? ((run.n - 1) + (run.pct || 0) / 100) / run.of
    : Math.min(0.95, 1 - Math.exp(-elapsed / stage.expect));
  const overall = stage.from + (stage.to - stage.from) * inside;
  // the render bar, like Premiere's: one segment per stage, each rush file its own
  const names = run?.names || [];
  const segments = [
    { label: 'Lecture du script', fill: at > 0 ? 1 : at === 0 ? inside : 0 },
    ...names.map((name, i) => ({ label: name, fill: at > 1 ? 1 : at === 1 ? (i < run.n - 1 ? 1 : i === run.n - 1 ? (run.pct || 0) / 100 : 0) : 0 })),
    { label: 'Choix des prises', fill: at === 2 ? inside : 0 },
  ];
  const label = !run ? 'Chargement…'
    : run.step === 'brief' ? 'L’IA lit le script'
    : run.step === 'transcribe' ? `Transcription ${run.n}/${run.of} · ${run.file}`
    : 'L’IA cherche chaque partie dans les rushes';
  return (
    <div className="grid flex-1 place-items-center">
      <div className="w-[26rem]">
        <div className="flex items-baseline justify-between gap-3">
          <div className="truncate font-semibold">{label}</div>
          <div className="shrink-0 tabular-nums text-[12px] text-mute">{Math.round(overall * 100)} %</div>
        </div>
        <div className="mt-2.5 flex h-1.5 gap-px overflow-hidden rounded-[3px]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)} aria-label="Avancement de l’analyse">
          {segments.map((g, i) => (
            <div key={i} title={g.label} className="relative flex-1 bg-white/10">
              <div className={`absolute inset-y-0 left-0 w-full origin-left transition-transform duration-500 ${g.fill >= 1 ? 'bg-ok' : 'bg-accent'}`} style={{ transform: `scaleX(${Math.max(0, Math.min(1, g.fill))})` }} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[12px] text-faint">
          <span>{run?.note || (run?.step === 'transcribe' ? 'Sur ton Mac, rien n’est envoyé' : 'Estimation : l’IA ne dit pas où elle en est')}</span>
          <span className="tabular-nums">{run?.t0 ? clockOf(elapsed) : ''}</span>
        </div>
        <ol className="mt-6 grid gap-2 text-[12.5px]">
          {STAGES.map((x, i) => (
            <li key={x.step} className={`flex items-center gap-2.5 ${i === at ? 'text-ink' : i < at ? 'text-mute' : 'text-faint'}`}>
              {i < at ? <Check size={14} className="text-ok" /> : i === at ? <Loader2 size={14} className="animate-spin text-accent motion-reduce:animate-none" /> : <span className="size-3.5 rounded-full border border-line" />}
              {x.label}{x.step === 'transcribe' && names.length > 1 ? ` · ${names.length} fichiers` : ''}
            </li>
          ))}
        </ol>
        <div className="mt-6 flex justify-end"><SoundControl /></div>
      </div>
    </div>
  );
}

const KIND = { H: 'Accroches', T: 'Transitions', C: 'Corps de pub' };

function Review({ job, setJob, parts, recs, ads, sel, setSel }) {
  const script = job.script;
  const okSet = new Set(job.ok || []);
  const keys = Object.keys(parts);
  const warn = (k) => parts[k].confidence === 'check' && !okSet.has(k);
  const current = sel && parts[sel] ? sel : keys.find(warn) || keys[0];
  const flagged = keys.filter(warn).length;
  const off = new Set(job.adsOff || []);
  const live = ads.filter((a) => (a.skip ? off.has(`+${a.name}`) : !off.has(a.name)));
  const choose = (key, seg, attempt) => setJob((j) => ({ ...j, choices: { ...j.choices, [key]: { ...(j.choices?.[key] || {}), [seg]: attempt } }, ok: [...new Set([...(j.ok || []), key])] }));
  // timeline edits: kept only while they sit on an edge of the AI's cut (a replaced take drops its own)
  const setEdits = (key, e) => setJob((j) => ({ ...j, edits: { ...j.edits, [key]: pruneEdits(e, parts[key].autoPieces, recs) }, ok: [...new Set([...(j.ok || []), key])] }));
  const restore = (key, snap) => setJob((j) => ({ ...j, edits: { ...j.edits, [key]: snap.edits }, choices: { ...j.choices, [key]: snap.choice } }));
  const resetPart = (key) => setJob((j) => {
    const edits = { ...(j.edits || {}) }, choices = { ...(j.choices || {}) };
    delete edits[key]; delete choices[key];
    return { ...j, edits, choices };
  });

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="card flex w-[300px] shrink-0 flex-col overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-[12px] text-mute">
          <b className="text-ink">{script.script}</b> {script.title} · {live.length} pubs{flagged ? ` · ${flagged} à vérifier` : ''}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {script.variants.map((v) => (
            <div key={v.id} className="mb-2">
              {script.variants.length > 1 && <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{v.name ? `Variante ${v.name}` : `Variante ${v.id.slice(1)}`}</div>}
              {['H', 'T', 'C'].map((k) => {
                const list = keys.filter((key) => key.startsWith(`${v.id}|${k}`));
                if (!list.length) return null;
                return (
                  <div key={k}>
                    <div className="px-2 py-0.5 text-[11px] text-faint">{KIND[k]}</div>
                    {list.map((key) => (
                      <button key={key} onClick={() => setSel(key)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] ${key === current ? 'bg-panel-2' : 'hover:bg-panel-2/60'}`}>
                        {warn(key) ? <AlertTriangle size={13} className="shrink-0 text-warn" /> : <Check size={13} className="shrink-0 text-ok" />}
                        <b className="w-7 shrink-0">{key.split('|')[1]}</b>
                        <span className="min-w-0 flex-1 truncate text-mute">{parts[key].text || '—'}</span>
                        <span className="shrink-0 text-[11px] text-faint">{secs(parts[key].pieces).toFixed(0)} s</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        <PartDetail key={current} k={current} title={partTitle(script, current)} part={parts[current]} choice={job.choices?.[current] || {}} ok={okSet.has(current)}
          recs={recs} edits={job.edits?.[current] || {}} onEdits={(e) => setEdits(current, e)} onRestore={(snap) => restore(current, snap)} onReset={() => resetPart(current)}
          onChoose={(seg, attempt) => choose(current, seg, attempt)}
          onOk={() => setJob((j) => ({ ...j, ok: [...new Set([...(j.ok || []), current])] }))} />
        <AdsList ads={ads} off={off} onToggle={(a) => setJob((j) => {
          const s = new Set(j.adsOff || []);
          const key = a.skip ? `+${a.name}` : a.name;
          s.has(key) ? s.delete(key) : s.add(key);
          return { ...j, adsOff: [...s] };
        })} />
      </div>
    </div>
  );
}

// "Accroche H2", with the variant only when the script has several ("Variante Paul · Transition T1")
function partTitle(script, key) {
  const [vid, pid] = key.split('|');
  const v = script.variants.find((x) => x.id === vid);
  const kind = { H: 'Accroche', T: 'Transition', C: 'Corps' }[pid[0]] || '';
  const variant = script.variants.length > 1 && v ? `${v.name ? `Variante ${v.name}` : `Variante ${vid.slice(1)}`} · ` : '';
  return `${variant}${kind} ${pid}`;
}

function ResetButton({ onReset }) {
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return undefined; const t = setTimeout(() => setSure(false), 3000); return () => clearTimeout(t); }, [sure]);
  return sure
    ? <button className="btn text-bad" onClick={onReset}><RotateCcw size={13} /> Effacer cette analyse ?</button>
    : <button className="btn" onClick={() => setSure(true)}><RotateCcw size={13} /> Nouveau projet</button>;
}

function PartDetail({ k, title, part, choice, ok, onChoose, onOk, recs, edits, onEdits, onRestore, onReset }) {
  return (
    <div className="card p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{title || k.replace('|', ' · ')}</div>
          <div className="mt-1 text-[12px] text-faint" data-selectable>Brief : {part.script}</div>
        </div>
        {part.confidence === 'check' && !ok && <button className="btn h-8" onClick={onOk}><Check size={13} /> C’est bon</button>}
      </div>
      {part.flags.length > 0 && !ok && (
        <ul className="mt-3 space-y-1 text-[12.5px] text-warn">{part.flags.map((f, i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{f}</li>)}</ul>
      )}
      <div className="mt-4">
        <PartTimeline clips={part.clips || []} recordings={recs || []} segments={part.segments} choice={choice} edits={edits}
          onEdits={onEdits} onChoose={onChoose} onRestore={onRestore} onReset={onReset} />
      </div>
      <div className="mt-4">
        <div className="min-w-0">
          {part.segments?.length ? (
            <ol className="space-y-2">
              {part.segments.map((g, i) => {
                const now = choice[i] || 0;
                const found = typeof now === 'object'; // a take changed in the timeline: found by search, or a clip's part replaced or removed
                const attempts = [{ text: g.text }, ...g.alternatives];
                return (
                  <li key={i} className="group text-[13px] leading-relaxed">
                    <span data-selectable className={now === -1 ? 'text-faint line-through' : ''}>{found ? g.custom?.text || g.text : attempts[Math.max(0, now)]?.text || g.text}</span>
                    {found && <span className="ml-2 rounded-md border border-accent px-1.5 align-middle text-[11px] text-accent">{now.kind === 'clip' ? 'prise retouchée' : 'prise trouvée'}</span>}
                    <button onClick={() => onChoose(i, now === -1 ? 0 : -1)} className={`ml-2 rounded-md border border-line px-1.5 align-middle text-[11px] ${now === -1 ? 'text-accent' : 'text-faint opacity-0 group-hover:opacity-100 hover:text-ink'}`}>
                      {now === -1 ? 'remettre' : 'retirer'}
                    </button>
                    {now !== -1 && g.alternatives.length > 0 && (
                      <span className="ml-2 inline-flex gap-1 align-middle">
                        {attempts.map((a, n) => (
                          <span key={n} className="inline-flex">
                            <button onClick={() => onChoose(i, n)} title={a.text}
                              className={`rounded-l-md border px-1.5 text-[11px] ${n === now ? 'border-accent bg-accent/10' : 'border-line text-faint hover:text-ink'}`}>
                              {n === 0 ? 'prise choisie' : `autre ${n}`}
                            </button>
                            {n > 0 && <MiniPlay pieces={a.pieces} />}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-[13.5px] leading-relaxed" data-selectable>{part.text || <span className="text-faint">Rien trouvé dans les rushes.</span>}</p>
          )}
          {part.removed?.length > 0 && <p className="mt-3 text-[12px] text-faint">Retiré (bégaiements, faux départs) : {part.removed.join(' · ')}</p>}
        </div>
      </div>
    </div>
  );
}

/** Plays a list of pieces from the raw files, jumping over everything that was cut. */
function Player({ pieces, autoPlay }) {
  const v = useRef();
  const st = useRef({ q: [], i: 0, raf: 0 });
  const [playing, setPlaying] = useState(false);
  const stop = () => { cancelAnimationFrame(st.current.raf); v.current?.pause(); setPlaying(false); };
  useEffect(() => stop, []);
  async function go() {
    const s = st.current, p = s.q[s.i];
    const src = fileUrl(p.media);
    if (v.current.dataset.src !== src) {
      v.current.src = src; v.current.dataset.src = src;
      await new Promise((r) => v.current.addEventListener('loadedmetadata', r, { once: true }));
    }
    v.current.currentTime = p.in / 1000;
    await v.current.play().catch(() => {});
    const step = () => {
      const q = s.q[s.i];
      if (!q) return;
      if (v.current.currentTime * 1000 >= q.out) {
        s.i++;
        if (s.i >= s.q.length) return stop();
        if (s.q[s.i].media === q.media) v.current.currentTime = s.q[s.i].in / 1000; else return go();
      }
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
  }
  useEffect(() => {
    if (autoPlay) return toggle();
    if (!pieces?.length) return undefined;
    // first frame of the take as a still, so the player is never a black box
    const el = v.current, src = fileUrl(pieces[0].media);
    const seek = () => { el.currentTime = pieces[0].in / 1000 + 0.05; };
    el.addEventListener('loadedmetadata', seek, { once: true });
    el.src = src; el.dataset.src = src;
    return () => el.removeEventListener('loadedmetadata', seek);
  }, []);
  const toggle = () => {
    if (playing) return stop();
    if (!pieces?.length) return;
    st.current.q = pieces; st.current.i = 0; setPlaying(true); go();
  };
  return (
    <div className="relative w-[150px] shrink-0 overflow-hidden rounded-xl bg-black" style={{ aspectRatio: '9 / 16' }}>
      <video ref={v} className="size-full object-cover" playsInline preload="metadata" />
      <button onClick={toggle} className="absolute inset-0 grid place-items-center bg-black/0 transition-colors hover:bg-black/25">
        <span className="grid size-10 place-items-center rounded-full bg-black/60 text-white">{playing ? <Square size={14} /> : <Play size={16} />}</span>
      </button>
    </div>
  );
}

function MiniPlay({ pieces }) {
  const [on, setOn] = useState(false);
  return (
    <span className="relative">
      <button onClick={() => setOn((x) => !x)} className="rounded-r-md border border-l-0 border-line px-1 text-faint hover:text-ink"><Play size={10} /></button>
      {on && <span className="absolute top-6 left-0 z-20" onMouseLeave={() => setOn(false)}><Player pieces={pieces} autoPlay /></span>}
    </span>
  );
}

function AdsList({ ads, off, onToggle }) {
  const [open, setOpen] = useState(false);
  const isOn = (a) => (a.skip ? off.has(`+${a.name}`) : !off.has(a.name));
  const on = ads.filter(isOn).length;
  const skipped = ads.filter((a) => a.skip && !isOn(a)).length;
  return (
    <div className="card px-5 py-4">
      <button className="flex w-full items-center gap-2 text-left text-[13px]" onClick={() => setOpen((x) => !x)}>
        <Film size={14} className="text-faint" />
        <span className="font-semibold">{on} pub{on > 1 ? 's' : ''} à construire</span>
        <span className="text-faint">{ads.length - on ? `· ${ads.length - on} retirée${ads.length - on > 1 ? 's' : ''}${skipped ? ` (${skipped} répètent une phrase)` : ''}` : ''}</span>
        <span className="ml-auto text-[12px] text-mute underline decoration-line underline-offset-2">{open ? 'Fermer' : 'Choisir'}</span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-x-4">
          {ads.map((a) => {
            const yes = isOn(a);
            return (
              <label key={a.name} className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px]" title={a.skip || ''}>
                <input type="checkbox" checked={yes} onChange={() => onToggle(a)} />
                <span className={yes ? '' : 'text-faint line-through'}>{a.name}</span>
                {a.skip && <span className="text-[11px] text-warn">{a.skip}</span>}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
