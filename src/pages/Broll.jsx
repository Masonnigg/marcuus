import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Upload, Copy, ClipboardPaste, Download, ExternalLink, Star, Search, Film,
  Loader2, X, FileDown, AlertCircle, Plus, FolderOpen, RotateCcw,
} from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { fixSrtText } from '../lib/srt.js';
import { buildBrollPrompt, parseBrollResponse, shotListMarkdown } from '../lib/broll.js';
import { loadSettings } from './Settings.jsx';

const SOURCE_META = {
  pexels: { name: 'Pexels', color: '#07a081' },
  pixabay: { name: 'Pixabay', color: '#2ec66d' },
};
const searchCache = new Map();
const slug = (q) => encodeURIComponent(String(q || '').trim().toLowerCase().replace(/\s+/g, '-'));
const EXTERNAL = [
  { name: 'Envato', url: (q) => `https://elements.envato.com/stock-video/${slug(q)}` },
  { name: 'Pexels', url: (q, o) => `https://www.pexels.com/search/videos/${encodeURIComponent(q)}/${o === 'vertical' ? '?orientation=portrait' : o === 'horizontal' ? '?orientation=landscape' : ''}` },
  { name: 'Mixkit', url: (q) => `https://mixkit.co/free-stock-video/${slug(q)}/` },
];

export default function Broll({ input, goSettings }) {
  const notify = useToast();
  const [settings, setSettings] = useState(null);
  const [doc, setDoc] = useState(null); // { name, path, cues }
  const [opts, setOpts] = useState({ orientation: 'vertical', media: 'video', beatSeconds: 6, style: '', sources: ['pexels', 'pixabay'] });
  const [beats, setBeats] = useState(null);
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState(false);
  const [active, setActive] = useState({ beat: 1, query: null });
  const [results, setResults] = useState({ loading: false, items: [], errors: {} });
  const [over, setOver] = useState(false);
  const fileRef = useRef();

  // restore last session + settings
  useEffect(() => {
    loadSettings().then(setSettings);
    kit.store.get('brollOpts', null).then((o) => o && setOpts((x) => ({ ...x, ...o, sources: (o.sources || x.sources).filter((id) => SOURCE_META[id]) })));
    if (!input) {
      kit.store.get('brollSession', null).then((s) => {
        if (s?.doc) { setDoc(s.doc); setBeats(s.beats); setPicks(s.picks || {}); if (s.beats?.length) setActive({ beat: 1, query: s.beats[0].queries[0] }); }
      });
    }
  }, []);

  // file sent from the SRT fixer
  useEffect(() => {
    if (!input) return;
    setDoc({ name: input.name, path: input.path, cues: input.cues });
    setBeats(null); setPicks({}); setError(null);
  }, [input?.at]);

  useEffect(() => {
    if (doc) kit.store.set('brollSession', { doc, beats, picks });
  }, [doc, beats, picks]);

  const setOpt = (patch) => setOpts((o) => { const n = { ...o, ...patch }; kit.store.set('brollOpts', n); return n; });

  const loadFile = async (f) => {
    if (!f || !/\.srt$/i.test(f.name)) { notify('Choisis un fichier .srt', { tone: 'bad' }); return; }
    const { cues } = fixSrtText(await f.text()); // always work on cleaned captions
    setDoc({ name: f.name, path: kit.pathFor(f), cues });
    setBeats(null); setPicks({}); setError(null);
  };

  const prompt = useMemo(() => (doc ? buildBrollPrompt(doc.cues, opts) : ''), [doc, opts]);
  const keysOk = settings && opts.sources.some((s) => settings.keys?.[s]);

  const acceptBeats = (b) => {
    setBeats(b);
    setPicks({});
    setActive({ beat: 1, query: b[0]?.queries[0] || null });
  };

  const askClaude = async () => {
    setBusy(true); setError(null);
    const r = await kit.claude.ask(prompt, settings?.model || 'sonnet');
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    try { acceptBeats(parseBrollResponse(r.text)); notify('Idées de B-roll prêtes'); } catch (e) { setError(e.message); }
  };

  // run search whenever the active query changes
  const runSearch = async (query, force) => {
    if (!query || !settings) return;
    const key = JSON.stringify([query, opts.orientation, opts.sources]);
    if (!force && searchCache.has(key)) { setResults({ loading: false, ...searchCache.get(key) }); return; }
    setResults({ loading: true, items: [], errors: {} });
    try {
      const sources = opts.sources.filter((id) => settings.keys?.[id]);
      const r = await kit.stock.search({ query, media: 'video', orientation: opts.orientation, sources, perPage: 18 });
      if (r.items.length) searchCache.set(key, r);
      setResults({ loading: false, ...r });
    } catch (e) {
      setResults({ loading: false, items: [], errors: { app: e.message } });
    }
  };
  useEffect(() => { if (beats) runSearch(active.query); }, [active.query, active.beat, opts.orientation, opts.sources.join(), settings]);

  const beat = beats?.find((b) => b.n === active.beat);
  const videoName = doc?.name.replace(/\.srt$/i, '') || 'video';
  const dlDir = settings ? `${settings.downloadsDir}/${videoName}` : null;

  const togglePick = (item) => setPicks((p) => {
    const cur = p[active.beat] || [];
    const has = cur.some((x) => x.id === item.id);
    return { ...p, [active.beat]: has ? cur.filter((x) => x.id !== item.id) : [...cur, item] };
  });

  const download = async (item, beatN = active.beat, query = active.query) => {
    try {
      const file = await kit.stock.download(item, dlDir, `B${String(beatN).padStart(2, '0')} - ${query || 'broll'} - ${item.source} ${item.id.split('-').pop()}`);
      notify('Téléchargé dans Téléchargements › B-roll', { ms: 5000, action: { label: 'Afficher', onClick: () => kit.reveal(file) } });
      return file;
    } catch (e) { notify(e.message, { tone: 'bad', ms: 3000 }); return null; }
  };

  const downloadPicks = async () => {
    let n = 0;
    let last;
    for (const b of beats) for (const it of picks[b.n] || []) { last = await download(it, b.n, b.queries[0]); if (last) n++; }
    if (n) { notify(`${n} fichier${n > 1 ? 's' : ''} téléchargé${n > 1 ? 's' : ''}`, { ms: 5000, action: { label: 'Afficher', onClick: () => kit.reveal(last) } }); kit.reveal(last); }
  };

  const nPicks = Object.values(picks).reduce((a, l) => a + l.length, 0);

  // ---------------------------------------------------------------- render
  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); loadFile(e.dataTransfer.files[0]); }}
    >
      <PageHeader
        title="B-roll"
        sub={doc ? <span><span className="text-ink">{videoName}</span> · {doc.cues.length} sous-titres</span> : 'Envoie un SRT : Claude propose un plan par moment, puis cherche des vidéos libres de droits sur Pexels et Pixabay.'}
      >
        <input ref={fileRef} type="file" accept=".srt" hidden onChange={(e) => { loadFile(e.target.files[0]); e.target.value = ''; }} />
        {doc && <button className="btn" onClick={() => fileRef.current.click()}><Upload size={14} /> Autre SRT</button>}
        {beats && (
          <>
            <button className="btn" onClick={async () => { const p = await kit.saveText(`${videoName} - shot list.md`, shotListMarkdown(videoName, beats, picks), 'md'); if (p) notify('Shot list exportée'); }}>
              <FileDown size={14} /> Shot list
            </button>
            <button className="btn btn-primary" disabled={!nPicks} onClick={downloadPicks}><Download size={14} /> Télécharger la sélection{nPicks ? ` (${nPicks})` : ''}</button>
          </>
        )}
      </PageHeader>

      {!doc ? (
        <div className="flex flex-1 px-8 pb-8">
          <button
            onClick={() => fileRef.current.click()}
            className={`rise grid flex-1 place-items-center rounded-2xl border-2 border-dashed transition-all duration-300 ${over ? 'scale-[0.99] border-accent bg-accent/5' : 'border-line hover:border-line-2'}`}
          >
            <div className="text-center">
              <div className={`mx-auto mb-4 grid size-14 place-items-center rounded-2xl ${over ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}><Film size={22} /></div>
              <div className="text-[15px] font-semibold">Glisse un .srt pour trouver des B-roll</div>
              <div className="mt-1 text-mute">Il est automatiquement nettoyé avec le SRT Fixer avant l’analyse.</div>
            </div>
          </button>
        </div>
      ) : !beats ? (
        <Setup
          opts={opts} setOpt={setOpt} busy={busy} error={error} settings={settings} keysOk={keysOk}
          onAsk={askClaude} onCancel={() => kit.claude.cancel()} onManual={() => setManual(true)} goSettings={goSettings}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 px-8 pb-6">
          {/* beats */}
          <aside className="flex w-[340px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
            <div className="flex items-center justify-between px-1 pb-1 text-[11.5px] text-faint">
              <span>{beats.length} moments</span>
              <button className="flex items-center gap-1 hover:text-ink" onClick={() => { setBeats(null); setError(null); }}><RotateCcw size={11} /> Refaire l’analyse</button>
            </div>
            {beats.map((b, i) => (
              <BeatCard
                key={b.n} beat={b} index={i} active={b.n === active.beat} activeQuery={active.query} picks={(picks[b.n] || []).length}
                onSelect={(q) => setActive({ beat: b.n, query: q ?? b.queries[0] })}
                onAddQuery={(q) => { setBeats((bs) => bs.map((x) => (x.n === b.n ? { ...x, queries: [...x.queries, q] } : x))); setActive({ beat: b.n, query: q }); }}
              />
            ))}
          </aside>

          {/* results */}
          <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Search size={14} className="shrink-0 text-faint" />
                <span className="truncate font-medium">{active.query}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="flex items-center gap-1">
                  {EXTERNAL.map((x) => (
                    <button key={x.name} className="btn h-7 px-2" onClick={() => kit.open(x.url(active.query, opts.orientation))} title={`Ouvrir « ${active.query} » sur ${x.name}`}>
                      {x.name} <ExternalLink size={11} />
                    </button>
                  ))}
                </div>
                <OrientationSeg value={opts.orientation} onChange={(o) => setOpt({ orientation: o })} />
                <SourceToggles opts={opts} setOpt={setOpt} settings={settings} />
              </div>
            </div>

            {beat && (
              <div className="border-b border-line bg-panel-2/40 px-4 py-2.5 text-[12px]">
                <span className="text-mute">Plan suggéré : </span>{beat.idea}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ResultErrors errors={results.errors} goSettings={goSettings} />
              {results.loading ? (
                <Grid orientation={opts.orientation}>{Array.from({ length: 9 }).map((_, i) => <div key={i} className="skeleton rounded-xl" style={{ aspectRatio: ratio(opts.orientation) }} />)}</Grid>
              ) : results.items.length ? (
                <Grid orientation={opts.orientation}>
                  {results.items.map((it, i) => (
                    <Tile
                      key={it.id} item={it} index={i} orientation={opts.orientation}
                      picked={(picks[active.beat] || []).some((x) => x.id === it.id)}
                      onPick={() => togglePick(it)} onDownload={() => download(it)}
                    />
                  ))}
                </Grid>
              ) : (
                !Object.keys(results.errors).length && (
                  <div className="grid h-full place-items-center text-center text-mute">
                    <div>Aucun résultat pour « {active.query} ».<div className="mt-1 text-faint">Essaie une autre recherche ou change l’orientation.</div></div>
                  </div>
                )
              )}
            </div>
            {dlDir && (
              <button
                onClick={() => kit.openFolder(dlDir)}
                className="flex items-center gap-2 border-t border-line px-4 py-2 text-left text-[11.5px] text-faint transition-colors hover:text-ink"
                title="Ouvrir le dossier dans le Finder"
              >
                <FolderOpen size={12} className="shrink-0" /> <span className="truncate">{dlDir}</span>
                <span className="ml-auto shrink-0 text-accent-2">Ouvrir le dossier</span>
              </button>
            )}
          </section>
        </div>
      )}

      {manual && doc && (
        <ManualModal
          prompt={prompt}
          onClose={() => setManual(false)}
          onSubmit={(text) => {
            try { acceptBeats(parseBrollResponse(text)); setManual(false); setError(null); notify('Idées de B-roll importées'); } catch (e) { notify(e.message, { tone: 'bad', ms: 3000 }); }
          }}
        />
      )}
    </div>
  );
}

const ratio = (o) => (o === 'horizontal' ? '16 / 9' : o === 'vertical' ? '9 / 16' : '1 / 1');

function Grid({ orientation, children }) {
  const min = orientation === 'vertical' ? 150 : 230;
  return <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}

function OrientationSeg({ value, onChange }) {
  return (
    <div className="seg">
      {[['vertical', '9:16'], ['horizontal', '16:9'], ['any', 'Tout']].map(([id, l]) => (
        <button key={id} data-on={value === id} onClick={() => onChange(id)}>{l}</button>
      ))}
    </div>
  );
}

function SourceToggles({ opts, setOpt, settings }) {
  return (
    <div className="flex items-center gap-1">
      {Object.entries(SOURCE_META).map(([id, m]) => {
        const on = opts.sources.includes(id);
        const hasKey = !!settings?.keys?.[id];
        return (
          <button
            key={id}
            title={hasKey ? m.name : `${m.name} : clé API manquante`}
            onClick={() => setOpt({ sources: on ? opts.sources.filter((s) => s !== id) : [...opts.sources, id] })}
            className={`flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] transition-colors ${on ? 'border-line-2 bg-panel-2' : 'border-line text-faint'}`}
          >
            <span className="size-1.5 rounded-full" style={{ background: on && hasKey ? m.color : '#444' }} />
            {m.name}
          </button>
        );
      })}
    </div>
  );
}

function Setup({ opts, setOpt, busy, error, settings, keysOk, onAsk, onCancel, onManual, goSettings }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
      <div className="card rise mx-auto max-w-2xl p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent/15 text-accent"><Sparkles size={18} /></div>
          <div>
            <div className="text-[15px] font-semibold">Analyse du script</div>
            <div className="text-mute">Claude découpe la vidéo en moments et propose un plan + des recherches pour chacun.</div>
          </div>
        </div>

        <div className="grid grid-cols-[130px_1fr] items-center gap-x-4 gap-y-3.5">
          <span className="text-mute">Format</span>
          <div><OrientationSeg value={opts.orientation} onChange={(o) => setOpt({ orientation: o })} /></div>
          <span className="text-mute">Un plan toutes les</span>
          <div className="seg w-fit">
            {[3, 6, 10].map((s) => <button key={s} data-on={opts.beatSeconds === s} onClick={() => setOpt({ beatSeconds: s })}>~{s}s</button>)}
          </div>
          <span className="text-mute">Sources</span>
          <SourceToggles opts={opts} setOpt={setOpt} settings={settings} />
          <span className="self-start pt-2 text-mute">Direction artistique</span>
          <textarea
            className="field"
            rows={2}
            placeholder="Optionnel : ex. cinématique, tons chauds, business / lifestyle à Dubaï, pas de visages…"
            value={opts.style}
            onChange={(e) => setOpt({ style: e.target.value })}
          />
        </div>

        {!keysOk && settings && (
          <div className="mt-5 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
            <AlertCircle size={14} /> Ajoute au moins une clé API (gratuite) pour lancer les recherches.
            <button className="ml-auto underline" onClick={goSettings}>Réglages</button>
          </div>
        )}
        {error && (
          <div className="mt-5 rounded-lg bg-bad/10 px-3 py-2 text-[12px] text-bad" data-selectable>
            <div className="flex items-center gap-2 font-medium"><AlertCircle size={14} /> Claude n’a pas pu répondre</div>
            <div className="mt-1 text-bad/80">{error}</div>
            <div className="mt-1.5 text-mute">Tu peux utiliser « Copier le prompt » et le coller dans Claude à la place.</div>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          {busy ? (
            <>
              <button className="btn btn-primary" disabled><Loader2 size={14} className="animate-spin" /> Claude réfléchit… {elapsed}s</button>
              <button className="btn" onClick={onCancel}>Annuler</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onAsk}><Sparkles size={14} /> Trouver des idées de B-roll</button>
          )}
          <button className="btn btn-ghost ml-auto" onClick={onManual}><ClipboardPaste size={14} /> Copier le prompt / coller une réponse</button>
        </div>
      </div>
    </div>
  );
}

function BeatCard({ beat, index, active, activeQuery, picks, onSelect, onAddQuery }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef();
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [active]);
  return (
    <div
      ref={ref}
      onClick={() => !active && onSelect()}
      className={`rise cursor-pointer rounded-xl border p-3 transition-colors ${active ? 'border-accent/60 bg-panel-2' : 'border-line bg-panel hover:border-line-2'}`}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className={`rounded px-1.5 py-px font-mono font-semibold ${active ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}>B{String(beat.n).padStart(2, '0')}</span>
        <span className="font-mono text-faint">{beat.start.slice(3, 8)} → {beat.end.slice(3, 8)}</span>
        {picks > 0 && <span className="ml-auto flex items-center gap-0.5 text-warn"><Star size={11} fill="currentColor" /> {picks}</span>}
      </div>
      <p className="line-clamp-2 text-[12.5px] text-mute">« {beat.text} »</p>
      <p className="mt-1.5 text-[12.5px]">{beat.idea}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {beat.queries.map((qq) => (
          <button
            key={qq}
            onClick={(e) => { e.stopPropagation(); onSelect(qq); }}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${active && activeQuery === qq ? 'border-accent bg-accent/15 text-ink' : 'border-line text-mute hover:border-line-2 hover:text-ink'}`}
          >
            {qq}
          </button>
        ))}
        {adding ? (
          <input
            autoFocus
            className="field h-6 w-36 rounded-full px-2 text-[11px]"
            placeholder="ta recherche…"
            value={q}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => { setAdding(false); setQ(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { onAddQuery(q.trim()); setAdding(false); setQ(''); } if (e.key === 'Escape') setAdding(false); }}
          />
        ) : (
          <button onClick={(e) => { e.stopPropagation(); setAdding(true); }} className="grid size-[22px] place-items-center rounded-full border border-dashed border-line text-faint hover:border-line-2 hover:text-ink" title="Ajouter une recherche">
            <Plus size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function Tile({ item, index, orientation, picked, onPick, onDownload }) {
  const [hover, setHover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [dl, setDl] = useState(false);
  const meta = SOURCE_META[item.source];
  return (
    <div
      className="rise group relative overflow-hidden rounded-xl bg-panel-2 ring-1 ring-line"
      style={{ aspectRatio: ratio(orientation), animationDelay: `${Math.min(index, 12) * 25}ms` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPlaying(false); }}
    >
      <img src={item.thumb} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      {/* the preview mounts on hover and autoplays; it fades in once frames are actually playing */}
      {hover && item.preview && (
        <video
          src={item.preview}
          autoPlay
          muted
          loop
          playsInline
          onPlaying={() => setPlaying(true)}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${playing ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {hover && !playing && item.preview && (
        <Loader2 size={18} className="absolute top-1/2 left-1/2 -mt-[9px] -ml-[9px] animate-spin text-white/80 drop-shadow" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/30 opacity-70 transition-opacity group-hover:opacity-100" />
      <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium backdrop-blur">
        <span className="size-1.5 rounded-full" style={{ background: meta.color }} /> {meta.name}
      </div>
      {item.duration ? <div className="absolute top-2 right-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10.5px] backdrop-blur">{item.duration}s</div> : null}
      <button
        onClick={onPick}
        className={`absolute right-2 bottom-2 grid size-8 place-items-center rounded-lg backdrop-blur transition-all ${picked ? 'bg-warn text-black' : 'bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 hover:text-white'}`}
        title={picked ? 'Retirer de la sélection' : 'Ajouter à la sélection'}
      >
        <Star size={14} fill={picked ? 'currentColor' : 'none'} />
      </button>
      <div className="absolute bottom-2 left-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={async () => { setDl(true); await onDownload(); setDl(false); }}
          className="grid size-8 place-items-center rounded-lg bg-black/55 text-white/85 backdrop-blur hover:text-white"
          title="Télécharger"
        >
          {dl ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        </button>
        <button onClick={() => kit.open(item.page)} className="grid size-8 place-items-center rounded-lg bg-black/55 text-white/85 backdrop-blur hover:text-white" title={`Ouvrir sur ${meta.name}`}>
          <ExternalLink size={14} />
        </button>
      </div>
    </div>
  );
}

function ResultErrors({ errors, goSettings }) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {entries.map(([src, msg]) => (
        <div key={src} className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
          <AlertCircle size={13} /> <span className="font-medium">{SOURCE_META[src]?.name || src}</span> <span className="truncate text-warn/80">{msg}</span>
          {/clé/.test(msg) && <button className="ml-auto shrink-0 underline" onClick={goSettings}>Ajouter la clé</button>}
        </div>
      ))}
    </div>
  );
}

function ManualModal({ prompt, onClose, onSubmit }) {
  const notify = useToast();
  const [text, setText] = useState('');
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="card rise flex max-h-full w-full max-w-2xl flex-col p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} style={{ animationDuration: '0.3s' }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Utiliser Claude manuellement</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="mb-1.5 flex items-center gap-2 text-mute">
          <span className="grid size-5 place-items-center rounded-full bg-panel-2 text-[11px] font-semibold text-ink">1</span>
          Copie le prompt et colle-le dans claude.ai
          <button className="btn ml-auto h-7" onClick={async () => { await kit.copy(prompt); notify('Prompt copié'); }}><Copy size={13} /> Copier le prompt</button>
        </div>
        <pre className="mb-4 max-h-40 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] whitespace-pre-wrap text-mute" data-selectable>{prompt}</pre>
        <div className="mb-1.5 flex items-center gap-2 text-mute">
          <span className="grid size-5 place-items-center rounded-full bg-panel-2 text-[11px] font-semibold text-ink">2</span>
          Colle sa réponse (le JSON) ici
        </div>
        <textarea className="field min-h-36 font-mono text-[11.5px]" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"beats":[…]}' />
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text)}>Importer</button>
        </div>
      </div>
    </div>
  );
}
