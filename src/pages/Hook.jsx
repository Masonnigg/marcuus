import { useEffect, useRef, useState } from 'react';
import { FishingHook, Upload, Loader2, Check, AlertCircle, X, Play, Pause, Copy, RotateCcw, KeyRound, AudioLines, Clapperboard } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { wordsFromWhisper } from '../lib/transcribe.js';
import { linesFromWords, buildHookRequest, parseHookReply, momentToText, fmtClock } from '../lib/hook.js';
import { premiereXml, parseProbe } from '../lib/premiere.js';
import { Running, CopyLog } from './Transcribe.jsx';

const MEDIA_RE = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mp3|wav|m4a|aac|flac|ogg|aif|aiff)$/i;
const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let seq = 0;

/**
 * Hook finder: MP3/video → local transcription → Claude (or ChatGPT) picks the hook moment and the body of a Reel.
 * input = { name, path, words, duration, at } sent from Transcrire (already transcribed, no second pass).
 */
export default function Hook({ active, input, goSettings, goTranscribe }) {
  const notify = useToast();
  const [jobs, setJobs] = useState([]);
  const [sel, setSel] = useState(null);
  const [over, setOver] = useState(false);
  const [engineOk, setEngineOk] = useState(null);
  const [ai, setAi] = useState(null); // { engine: 'claude' | 'openai', ok } — is the analyser set up?
  const inputRef = useRef();
  const busy = useRef(false);
  const restored = useRef(false);

  const update = (key, patch) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  useEffect(() => {
    kit.store.get('hookSession', null).then((sv) => {
      if (sv?.jobs?.length) {
        const back = sv.jobs.map((j) => ({ ...j, key: ++seq, state: j.state === 'running' ? 'queued' : j.state }));
        setJobs((cur) => [...back, ...cur]);
        setSel((cur) => cur ?? back[Math.min(sv.selIndex || 0, back.length - 1)].key);
      }
      restored.current = true;
    });
    if (!kit.whisper) return;
    return kit.whisper.onProgress((p) => setJobs((js) => js.map((j) => (j.path === p.filePath && j.state === 'running' && j.phase === 'transcribe'
      ? { ...j, stage: p.stage, pct: p.pct ?? j.pct, note: p.note !== undefined ? p.note : j.note }
      : j))));
  }, []);

  // the key and the engine can be set up in other tabs: re-check whenever this tab is shown
  useEffect(() => {
    kit.store.get('settings', {}).then(async (s) => {
      if (s?.hookEngine === 'openai') setAi({ engine: 'openai', ok: !!s?.keys?.openai?.trim() });
      else setAi({ engine: 'claude', ok: (await kit.claude.status())?.loggedIn !== false });
    });
    kit.whisper?.status().then((s) => setEngineOk(!!(s?.supported !== false && s?.ffmpeg && s?.engine && s?.model)));
  }, [active]);

  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      const keep = jobs.map(({ key, stage, pct, note, ...j }) => j);
      kit.store.set('hookSession', { jobs: keep, selIndex: Math.max(0, jobs.findIndex((j) => j.key === sel)) });
    }, 400);
    return () => clearTimeout(t);
  }, [jobs, sel]);

  // a file sent from Transcrire: reuse its transcript
  useEffect(() => {
    if (!input?.words?.length) return;
    const existing = jobs.find((j) => j.path === input.path && j.state !== 'running');
    const job = { name: input.name, path: input.path, words: input.words, duration: input.duration, state: 'queued', error: null, moments: null };
    if (existing) { update(existing.key, job); setSel(existing.key); }
    else { const key = ++seq; setJobs((js) => [...js, { key, ...job }]); setSel(key); }
  }, [input?.at]);

  // one file at a time: transcribe (unless already done) → analyse
  useEffect(() => {
    if (busy.current) return;
    const next = jobs.find((j) => j.state === 'queued' && (j.words || engineOk));
    if (!next) return;
    busy.current = true;
    run(next).finally(() => { busy.current = false; setJobs((js) => [...js]); });
  }, [jobs, engineOk]);

  async function run(job) {
    let { words, duration } = job;
    if (!words) {
      update(job.key, { state: 'running', phase: 'transcribe', stage: 'audio', pct: 0, note: null, startedAt: Date.now() });
      try {
        const o = (await kit.store.get('transcribeOpts', {})) || {};
        const tr = await kit.whisper.transcribe(job.path, { language: o.language || 'fr', vocab: (o.vocab || '').trim() });
        words = wordsFromWhisper(tr);
        duration = tr.duration || words.at(-1)?.end || 0;
        update(job.key, { words, duration });
      } catch (e) {
        update(job.key, { state: 'error', failed: 'transcribe', error: cleanErr(e) });
        return;
      }
    }
    duration = duration || words.at(-1)?.end || 0;
    const lines = linesFromWords(words);
    if (!lines.length) { update(job.key, { state: 'error', failed: 'analyze', error: 'Aucune parole trouvée dans ce fichier.' }); return; }
    // Claude = the user's own Claude subscription (default, no extra cost); ChatGPT = OpenAI API key
    const s = (await kit.store.get('settings', {})) || {};
    const engine = s.hookEngine === 'openai' ? 'openai' : 'claude';
    const model = s.model || 'sonnet';
    update(job.key, { state: 'running', phase: 'analyze', engine, lines: lines.length, startedAt: Date.now() });
    const req = buildHookRequest(lines, duration);
    const r = engine === 'openai' ? await kit.openai.ask(req) : await kit.claude.ask(req.user, model, { system: req.system, schema: req.schema });
    if (r.ok && engine === 'claude') r.model = `Claude ${model}`;
    if (!r.ok) {
      if (r.code === 'nokey') setAi({ engine: 'openai', ok: false });
      update(job.key, { state: 'error', failed: 'analyze', code: r.code, error: r.error });
      return;
    }
    try {
      const moments = parseHookReply(r.text, lines, { durationMs: duration });
      if (!moments.length) throw new Error('Aucun moment exploitable trouvé. Relance l’analyse.');
      update(job.key, { state: 'done', moments, model: r.model, error: null });
    } catch (e) {
      update(job.key, { state: 'error', failed: 'analyze', error: e instanceof SyntaxError ? 'Réponse illisible. Relance l’analyse.' : cleanErr(e) });
    }
  }

  const addFiles = (list) => {
    const files = [...list].filter((f) => MEDIA_RE.test(f.name));
    if (!files.length) { notify('Glisse un MP3 ou une vidéo', { tone: 'bad' }); return; }
    const added = files.map((f) => ({ key: ++seq, name: f.name, path: kit.pathFor(f), state: 'queued' })).filter((j) => j.path);
    if (!added.length) { notify('Disponible uniquement dans l’app', { tone: 'bad' }); return; }
    setJobs((js) => [...js, ...added]);
    setSel(added[0].key);
  };

  const job = jobs.find((j) => j.key === sel);
  const reanalyze = (j) => update(j.key, { state: 'queued', error: null });

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
    >
      <PageHeader title="Hook" sub="MP3 ou vidéo → le hook pour ouvrir le Reel, le body à garder, des titres et la légende. Analyse par Claude ou ChatGPT (Réglages).">
        <input ref={inputRef} type="file" multiple hidden accept="video/*,audio/*,.mxf" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        {jobs.length > 0 && <button className="btn" onClick={() => inputRef.current.click()}><Upload size={14} /> Ajouter des fichiers</button>}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 pb-6">
        {ai?.ok === false && (
          <Banner icon={KeyRound} action="Ouvrir Réglages" onAction={goSettings}>
            {ai.engine === 'openai'
              ? 'Ajoute ta clé OpenAI dans Réglages pour lancer les analyses, ou choisis Claude.'
              : 'Claude n’est pas connecté sur ce Mac. Regarde dans Réglages.'}
          </Banner>
        )}
        {engineOk === false && (
          <Banner icon={AudioLines} action="Aller dans Transcrire" onAction={goTranscribe}>
            Le moteur de transcription n’est pas installé. Installe-le une fois dans Transcrire.
          </Banner>
        )}

        {jobs.length === 0 ? (
          <button
            onClick={() => inputRef.current.click()}
            className={`rise grid flex-1 place-items-center rounded-2xl border-2 border-dashed transition-all duration-300 ${over ? 'scale-[0.99] border-accent bg-accent/5' : 'border-line hover:border-line-2'}`}
          >
            <div className="text-center">
              <div className={`mx-auto mb-4 grid size-14 place-items-center rounded-2xl ${over ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}><FishingHook size={22} /></div>
              <div className="text-[15px] font-semibold">Glisse un MP3 ou une vidéo ici</div>
              <div className="mt-1 text-mute">Un clip court = 1 Reel. Un long enregistrement = les meilleurs moments, chacun avec son hook.</div>
            </div>
          </button>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            <aside className="flex w-[260px] shrink-0 flex-col gap-1.5 overflow-y-auto">
              {jobs.map((j) => (
                <JobItem key={j.key} job={j} active={j.key === sel} waiting={!j.words && engineOk === false} onClick={() => setSel(j.key)}
                  onRemove={() => { setJobs((js) => js.filter((x) => x.key !== j.key)); if (sel === j.key) setSel(null); }} />
              ))}
              <button onClick={() => inputRef.current.click()} className="rounded-xl border border-dashed border-line p-3 text-[12px] text-faint transition-colors hover:border-line-2 hover:text-mute">+ Ajouter des fichiers</button>
            </aside>
            <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
              {!job ? (
                <div className="grid flex-1 place-items-center text-mute">Sélectionne un fichier</div>
              ) : job.state === 'done' ? (
                <Results key={job.key} job={job} onReanalyze={() => reanalyze(job)} />
              ) : job.state === 'error' ? (
                <div className="grid flex-1 place-items-center p-8 text-center">
                  <div className="max-w-md">
                    <AlertCircle className="mx-auto mb-2 text-bad" />
                    <div className="font-medium">{job.failed === 'transcribe' ? 'La transcription a échoué' : 'L’analyse a échoué'}</div>
                    <div className="mt-1 text-[12px] text-mute" data-selectable>{job.error}</div>
                    <div className="mt-4 flex justify-center gap-2">
                      {job.code === 'nokey' ? (
                        <button className="btn btn-primary" onClick={goSettings}><KeyRound size={13} /> Ajouter la clé</button>
                      ) : null}
                      <button className="btn" onClick={() => reanalyze(job)}><RotateCcw size={13} /> {job.failed === 'transcribe' ? 'Réessayer' : 'Relancer l’analyse'}</button>
                      {job.failed === 'transcribe' && <CopyLog />}
                    </div>
                  </div>
                </div>
              ) : job.state === 'running' && job.phase === 'analyze' ? (
                <Analyzing job={job} />
              ) : !job.words && engineOk === false ? (
                <div className="grid flex-1 place-items-center p-8 text-center text-mute">En attente du moteur de transcription (à installer dans Transcrire).</div>
              ) : (
                <Running job={job} />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Banner({ icon: Icon, children, action, onAction }) {
  return (
    <div className="rise flex items-center gap-3 rounded-xl border border-warn/25 bg-warn/5 px-4 py-2.5 text-[12.5px]">
      <Icon size={15} className="shrink-0 text-warn" />
      <span className="flex-1 text-mute">{children}</span>
      <button className="btn h-7 shrink-0 px-2.5 text-[12px]" onClick={onAction}>{action}</button>
    </div>
  );
}

function JobItem({ job, active, waiting, onClick, onRemove }) {
  const sub = job.state === 'done' ? `${job.moments.length} moment${job.moments.length > 1 ? 's' : ''}`
    : job.state === 'error' ? 'erreur'
    : job.state === 'running' ? (job.phase === 'analyze' ? 'analyse…' : `transcription ${job.pct || 0}%`)
    : waiting ? 'moteur à installer' : 'en attente';
  return (
    <button onClick={onClick} className={`group relative rounded-xl border p-3 text-left transition-colors ${active ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel'}`}>
      <div className="flex items-start gap-2">
        {job.state === 'done' ? <Check size={15} className="mt-px shrink-0 text-ok" />
          : job.state === 'error' ? <AlertCircle size={15} className="mt-px shrink-0 text-bad" />
          : job.state === 'running' ? <Loader2 size={15} className="mt-px shrink-0 animate-spin text-accent" />
          : <FishingHook size={15} className="mt-px shrink-0 text-faint" />}
        <div className="min-w-0 flex-1">
          <div className="truncate pr-4 text-[12.5px] font-medium">{job.name.replace(/\.[^.]+$/, '')}</div>
          <div className="mt-0.5 text-[11px] text-mute">{sub}</div>
        </div>
      </div>
      {job.state !== 'running' && (
        <span role="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="absolute top-2.5 right-2 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-ink"><X size={13} /></span>
      )}
    </button>
  );
}

function Analyzing({ job }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = job.startedAt ? Math.round((now - job.startedAt) / 1000) : 0;
  return (
    <div className="grid flex-1 place-items-center">
      <div className="w-80 text-center">
        <Loader2 className="mx-auto mb-3 animate-spin text-accent" />
        <div className="font-medium">{job.engine === 'openai' ? 'ChatGPT' : 'Claude'} cherche le hook…</div>
        <div className="mt-1 text-[11.5px] text-faint">{job.lines} phrases · {secs}s</div>
        <button className="btn btn-ghost mt-4" onClick={() => (job.engine === 'openai' ? kit.openai.cancel() : kit.claude.cancel())}>Annuler</button>
      </div>
    </div>
  );
}

function Results({ job, onReanalyze }) {
  const notify = useToast();
  const audio = useRef();
  const timer = useRef();
  const [playing, setPlaying] = useState(null);
  useEffect(() => () => clearInterval(timer.current), []);

  // play one passage and stop at its end (same 20 ms timer as the caption editor)
  const play = (id, start, end) => {
    const a = audio.current;
    clearInterval(timer.current);
    if (!a) return;
    if (playing === id && !a.paused) { a.pause(); setPlaying(null); return; }
    const go = () => {
      a.currentTime = Math.max(0, start / 1000 - 0.05);
      a.play().then(() => {
        setPlaying(id);
        timer.current = setInterval(() => {
          if (a.paused || a.currentTime >= end / 1000 + 0.1) { a.pause(); clearInterval(timer.current); setPlaying(null); }
        }, 20);
      }).catch(() => setPlaying(null));
    };
    if (a.readyState >= 1) go();
    else a.addEventListener('loadedmetadata', go, { once: true });
  };
  const copy = async (text, msg) => { await kit.copy(text); notify(msg); };
  const all = job.moments.map(momentToText).join('\n\n———\n\n');

  // the moment as a Premiere sequence: hook first, then the body, cut in the file that was analysed
  const toPremiere = async (m, i) => {
    try {
      const media = parseProbe(await kit.probe(job.path));
      if (!media.video && !media.audio) throw new Error('Ni image ni son dans ce fichier.');
      const xml = premiereXml({ moment: m, index: i, words: job.words, media, path: job.path, name: job.name });
      const saved = await kit.saveText(`${job.path.replace(/\.[^./]+$/, '')} - Hook ${i + 1}.xml`, xml, 'xml');
      if (saved) notify('Séquence prête : glisse le .xml dans Premiere', { ms: 6000, action: { label: 'Afficher', onClick: () => kit.reveal(saved) } });
    } catch (e) {
      notify(cleanErr(e), { tone: 'bad', ms: 5000 });
    }
  };

  return (
    <>
      <audio ref={audio} src={fileUrl(job.path)} preload="metadata" />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{job.name}</div>
          <div className="text-[11.5px] text-faint">
            {job.moments.length} moment{job.moments.length > 1 ? 's' : ''} · audio de {fmtClock(job.duration || 0)}{job.model ? ` · ${job.model}` : ''}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn" onClick={onReanalyze}><RotateCcw size={13} /> Relancer l’analyse</button>
          <button className="btn btn-primary" onClick={() => copy(all, 'Tout est copié')}><Copy size={13} /> Tout copier</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {job.moments.map((m, i) => (
            <Moment key={i} m={m} i={i} playing={playing} play={play} copy={copy} toPremiere={toPremiere} />
          ))}
        </div>
      </div>
    </>
  );
}

function PlayBtn({ on, onClick }) {
  return (
    <button onClick={onClick} className={`grid size-7 shrink-0 place-items-center rounded-full transition-colors ${on ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute hover:text-ink'}`}>
      {on ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" className="ml-px" />}
    </button>
  );
}

const Label = ({ children }) => <div className="mt-4 mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{children}</div>;
const span = (s) => `${fmtClock(s.start)} → ${fmtClock(s.end)}`;

function Moment({ m, i, playing, play, copy, toPremiere }) {
  const hookId = `${i}-hook`;
  return (
    <div className="rise rounded-xl border border-line bg-bg/40 p-4" style={{ animationDelay: `${i * 50}ms` }}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-6 place-items-center rounded-md bg-accent/15 text-[12px] font-bold text-accent">{i + 1}</span>
        <div className="min-w-0 truncate font-semibold">{m.title || `Moment ${i + 1}`}</div>
        <span className="shrink-0 text-[11.5px] text-faint">≈ {Math.round(m.durationMs / 1000)} s</span>
        <button className="btn btn-ghost ml-auto h-7 shrink-0 px-2 text-[12px]" onClick={() => copy(momentToText(m, i), 'Moment copié')}><Copy size={12} /> Copier</button>
        <button className="btn h-7 shrink-0 px-2 text-[12px]" title="Enregistre une séquence déjà coupée (hook puis body). Glisse le .xml dans le panneau Projet de Premiere." onClick={() => toPremiere(m, i)}><Clapperboard size={12} /> Premiere</button>
      </div>

      <Label>Hook · à mettre au début</Label>
      <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
        <PlayBtn on={playing === hookId} onClick={() => play(hookId, m.hook.start, m.hook.end)} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] text-accent-2">{span(m.hook)}</div>
          <div className="mt-0.5 text-[15px] leading-snug font-medium" data-selectable>« {m.hook.text} »</div>
          {m.hook.why && <div className="mt-1 text-[12px] text-mute">{m.hook.why}</div>}
          {!m.hook.exact && <div className="mt-1 text-[11px] text-warn">L’IA a cité la phrase de travers : vérifie à l’écoute.</div>}
        </div>
      </div>

      {m.body.length > 0 && (
        <>
          <Label>Body · dans l’ordre du montage</Label>
          <div className="flex flex-col">
            {m.body.map((b, k) => {
              const id = `${i}-b${k}`;
              return (
                <div key={k} className="flex items-start gap-3 border-t border-line py-2 first:border-t-0 first:pt-0">
                  <PlayBtn on={playing === id} onClick={() => play(id, b.start, b.end)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-[11.5px]">
                      <span className="shrink-0 font-mono text-faint">{span(b)}</span>
                      {b.label && <span className="truncate font-medium text-ink">{b.label}</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[12.5px] text-mute" title={b.text} data-selectable>{b.text}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {m.headlines.length > 0 && (
        <>
          <Label>Titres à l’écran · clic pour copier</Label>
          <div className="flex flex-wrap gap-1.5">
            {m.headlines.map((h, k) => (
              <button key={k} onClick={() => copy(h, 'Titre copié')} className="group flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-left text-[12.5px] font-medium transition-colors hover:border-line-2">
                {h} <Copy size={11} className="shrink-0 text-faint group-hover:text-ink" />
              </button>
            ))}
          </div>
        </>
      )}

      {m.caption && (
        <>
          <Label>Légende du post</Label>
          <div className="flex items-start gap-2 rounded-lg bg-panel-2 p-3">
            <p className="flex-1 text-[12.5px] leading-relaxed" data-selectable>{m.caption}</p>
            <button className="btn btn-icon h-7 shrink-0" onClick={() => copy(m.caption, 'Légende copiée')}><Copy size={12} /></button>
          </div>
        </>
      )}
    </div>
  );
}
