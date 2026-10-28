import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Upload, Save, Copy, Clapperboard, X, ArrowRight, Check, FolderOpen, Wand2, Sparkles, Loader2, Scissors, RotateCcw } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { fixSrtText, fmtTime, FIX_TYPES, serializeSrt } from '../lib/srt.js';
import { unitsFromCues, segmentUnits, groupsToCues, groupsFromCues, splitChanges, inferTarget, enforceLimits, DEFAULT_EXPRESSIONS } from '../lib/segment.js';
import { buildRefinePrompt, parseRefine } from '../lib/refine.js';
import { loadSettings } from './Settings.jsx';

const TYPE_COLOR = {
  elision: '#ff8a63',
  hyphen: '#a78bfa',
  number: '#38bdf8',
  unit: '#34d399',
  accent: '#fbbf24',
  watermark: '#f472b6',
};

let keySeq = 0;

let lastInputAt = 0; // an SRT sent from another tab is added once

export default function SrtFixer({ onSendToBroll, input }) {
  const notify = useToast();
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(null);
  const [types, setTypes] = useState({});
  const [saveMode, setSaveMode] = useState('suffix');
  const [tab, setTab] = useState('fixes');
  const [smart, setSmart] = useState(true);
  const [settings, setSettings] = useState({ expressions: DEFAULT_EXPRESSIONS, model: 'sonnet' });
  const [refining, setRefining] = useState(null); // file key while Claude works
  const [over, setOver] = useState(false);
  const inputRef = useRef();

  useEffect(() => {
    loadSettings().then(setSettings);
    kit.store.get('srtPrefs', {}).then((p) => {
      if (p?.types) setTypes(p.types);
      if (p?.smart === false) setSmart(false);
      if (p?.saveMode) setSaveMode(p.saveMode);
    });
    kit.store.get('srtSession', []).then((s) => {
      let restored = Array.isArray(s) ? s.map((f) => ({ ...f, key: ++keySeq, disabled: new Set(f.disabled || []) })) : [];
      let selKey = restored[0]?.key ?? null;
      if (input && input.at > lastInputAt) {
        // file sent from Transcrire: replaces an older copy of the same file
        lastInputAt = input.at;
        const f = { key: ++keySeq, name: input.name, path: input.path, raw: input.raw, disabled: new Set() };
        restored = [...restored.filter((r) => !(r.path && r.path === f.path)), f];
        selKey = f.key;
      }
      setFilesP(restored);
      setSel(selKey);
    });
  }, []);

  const persistPrefs = (next) => kit.store.set('srtPrefs', { types, saveMode, smart, ...next });
  const persistSession = (fs) => kit.store.set('srtSession', fs.map(({ name, path, raw, disabled, savedTo, refined }) => ({ name, path, raw, disabled: [...disabled], savedTo, refined })));

  const setFilesP = (fn) => setFiles((prev) => { const next = typeof fn === 'function' ? fn(prev) : fn; persistSession(next); return next; });

  const results = useMemo(() => {
    const m = new Map();
    const expressions = settings.expressions;
    for (const f of files) {
      const r = fixSrtText(f.raw, { types, disabled: f.disabled });
      if (smart && r.cues.length) {
        // smart split: re-cut the fixed captions into grammatical groups (word times estimated per caption)
        const units = unitsFromCues(r.cues);
        const target = inferTarget(r.cues);
        const sig = units.map((u) => u.text).join(' ');
        const refined = f.refined?.sig === sig ? f.refined.groups : null;
        const groups = refined || segmentUnits(units, { target, expressions });
        r.split = { units, target, sig, refined: !!refined, changes: splitChanges(units, groupsFromCues(r.cues), groups) };
        r.cues = groupsToCues(units, groups).map(({ doubt, ...c }) => c);
        r.output = serializeSrt(r.cues);
      }
      m.set(f.key, r);
    }
    return m;
  }, [files, types, smart, settings.expressions]);

  const addFiles = async (list) => {
    const srts = [...list].filter((f) => /\.srt$/i.test(f.name));
    if (!srts.length) { notify('Glisse des fichiers .srt', { tone: 'bad' }); return; }
    const loaded = await Promise.all(srts.map(async (f) => ({ key: ++keySeq, name: f.name, path: kit.pathFor(f), raw: await f.text(), disabled: new Set() })));
    setFilesP((prev) => {
      const kept = prev.filter((p) => !loaded.some((l) => (l.path && l.path === p.path) || (!l.path && l.name === p.name)));
      return [...kept, ...loaded];
    });
    setSel(loaded[0].key);
    setTab('fixes');
  };

  const file = files.find((f) => f.key === sel);
  const res = file && results.get(file.key);
  const activeFixes = res ? res.fixes.filter((x) => !file.disabled.has(x.id)) : [];

  const toggleFix = (id) => setFilesP((prev) => prev.map((f) => {
    if (f.key !== sel) return f;
    const d = new Set(f.disabled);
    d.has(id) ? d.delete(id) : d.add(id);
    return { ...f, disabled: d, savedTo: null };
  }));

  const toggleType = (t) => {
    const next = { ...types, [t]: types[t] === false };
    setTypes(next);
    persistPrefs({ types: next });
  };

  const refine = async () => {
    const sp = res?.split;
    if (!sp || refining) return;
    const key = file.key;
    setRefining(key);
    const r = await kit.claude.ask(buildRefinePrompt(res.cues.map((c) => c.text), sp.target), settings.model || 'sonnet');
    setRefining(null);
    if (!r.ok) { notify(r.error, { tone: 'bad', ms: 6000 }); return; }
    try {
      const groups = enforceLimits(sp.units, parseRefine(r.text, sp.units), { target: sp.target, expressions: settings.expressions });
      setFilesP((prev) => prev.map((x) => (x.key === key ? { ...x, refined: { sig: sp.sig, groups }, savedTo: null } : x)));
      notify('Découpage affiné par Claude');
    } catch (e) {
      notify(e.message, { tone: 'bad', ms: 7000 });
    }
  };
  const unrefine = () => setFilesP((prev) => prev.map((x) => (x.key === file.key ? { ...x, refined: null, savedTo: null } : x)));

  const outPath = (f) => (saveMode === 'replace' ? f.path : f.path.replace(/(\.srt)?$/i, ' (corrigé).srt'));

  const saveOne = async (f) => {
    const out = results.get(f.key).output;
    let saved;
    if (f.path) saved = await kit.writeFile(outPath(f), out);
    else saved = await kit.saveAs(f.name.replace(/\.srt$/i, ' (corrigé).srt'), out);
    if (saved) setFilesP((prev) => prev.map((x) => (x.key === f.key ? { ...x, savedTo: saved } : x)));
    return saved;
  };

  const saveAll = async () => {
    let n = 0;
    for (const f of files) if (await saveOne(f)) n++;
    notify(`${n} fichier${n > 1 ? 's' : ''} enregistré${n > 1 ? 's' : ''}`);
  };

  const remove = (key) => {
    setFilesP((prev) => prev.filter((f) => f.key !== key));
    if (sel === key) setSel(files.find((f) => f.key !== key)?.key ?? null);
  };

  const totalFixes = (f) => results.get(f.key)?.fixes.filter((x) => !f.disabled.has(x.id)).length ?? 0;

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
    >
      <PageHeader title="SRT Fixer" sub="Recolle les mots coupés entre deux sous-titres : c'est, j'ai, moment-là, 10 000, 1%…">
        <input ref={inputRef} type="file" accept=".srt" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button className="btn" onClick={() => inputRef.current.click()}><Upload size={14} /> Ouvrir .srt</button>
        {files.length > 1 && <button className="btn btn-primary" onClick={saveAll}><Save size={14} /> Tout enregistrer ({files.length})</button>}
      </PageHeader>

      {files.length === 0 ? (
        <DropZone over={over} onClick={() => inputRef.current.click()} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 px-8 pb-6">
          {/* file list */}
          <aside className="flex w-[250px] shrink-0 flex-col gap-1.5 overflow-y-auto">
            {files.map((f) => {
              const n = totalFixes(f);
              return (
                <button
                  key={f.key}
                  onClick={() => setSel(f.key)}
                  className={`group relative rounded-xl border p-3 text-left transition-colors ${f.key === sel ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel'}`}
                >
                  <div className="flex items-start gap-2">
                    <FileText size={15} className={`mt-px shrink-0 ${f.key === sel ? 'text-accent' : 'text-faint'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate pr-4 text-[12.5px] font-medium">{f.name.replace(/\.srt$/i, '')}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mute">
                        <span>{n} correction{n > 1 ? 's' : ''}</span>
                        {f.savedTo && <span className="flex items-center gap-0.5 text-ok"><Check size={11} /> enregistré</span>}
                      </div>
                    </div>
                  </div>
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); remove(f.key); }}
                    className="absolute top-2.5 right-2 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-ink"
                  >
                    <X size={13} />
                  </span>
                </button>
              );
            })}
            <button onClick={() => inputRef.current.click()} className="rounded-xl border border-dashed border-line p-3 text-[12px] text-faint transition-colors hover:border-line-2 hover:text-mute">
              + Ajouter des fichiers
            </button>
          </aside>

          {/* detail */}
          {file && res && (
            <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                <div className="seg">
                  <button data-on={tab === 'fixes'} onClick={() => setTab('fixes')}>Corrections · {activeFixes.length}</button>
                  <button data-on={tab === 'split'} onClick={() => setTab('split')}>Découpage · {res.split ? res.split.changes.length : 'off'}</button>
                  <button data-on={tab === 'preview'} onClick={() => setTab('preview')}>Résultat · {res.cues.length} sous-titres</button>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button className="btn" onClick={async () => { await kit.copy(res.output); notify('SRT copié'); }}><Copy size={13} /> Copier</button>
                  <button className="btn" onClick={() => onSendToBroll({ name: file.name, path: file.path, cues: res.cues })}><Clapperboard size={13} /> Chercher des B-roll</button>
                  <button
                    className="btn btn-primary"
                    onClick={async () => { const p = await saveOne(file); if (p) notify('Enregistré à côté de l’original'); }}
                  >
                    <Save size={13} /> Enregistrer
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
                <span className="mr-1 text-[11.5px] text-faint">Corriger :</span>
                {FIX_TYPES.map((t) => {
                  const count = res.fixes.filter((x) => x.type === t.type).length;
                  const on = types[t.type] !== false;
                  return (
                    <button
                      key={t.type}
                      onClick={() => toggleType(t.type)}
                      className={`flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors ${on ? 'border-line-2 bg-panel-2 text-ink' : 'border-line text-faint line-through'}`}
                    >
                      <span className="size-1.5 rounded-full" style={{ background: on ? TYPE_COLOR[t.type] : '#444' }} />
                      {t.name}
                      {on && count > 0 && <span className="text-mute">{count}</span>}
                    </button>
                  );
                })}
                <button
                  onClick={() => { setSmart(!smart); persistPrefs({ smart: !smart }); }}
                  className={`flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors ${smart ? 'border-accent/50 bg-accent/10 text-ink' : 'border-line text-faint line-through'}`}
                  title="Re-découpe les sous-titres sans séparer sujet/verbe, article/nom, préposition/mot…"
                >
                  <Scissors size={11} /> Découpage intelligent
                </button>
                <div className="ml-auto flex items-center gap-2 text-[11.5px] text-faint">
                  Enregistrer
                  <div className="seg">
                    <button data-on={saveMode === 'suffix'} onClick={() => { setSaveMode('suffix'); persistPrefs({ saveMode: 'suffix' }); }}>en copie</button>
                    <button data-on={saveMode === 'replace'} onClick={() => { setSaveMode('replace'); persistPrefs({ saveMode: 'replace' }); }}>remplacer</button>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {tab === 'fixes' ? (
                  res.fixes.length === 0 ? (
                    <div className="grid h-full place-items-center text-center text-mute">
                      <div><Wand2 className="mx-auto mb-2 text-ok" size={20} />Rien à corriger dans ce fichier.</div>
                    </div>
                  ) : (
                    <ul className="divide-y divide-line">
                      {res.fixes.map((x, i) => (
                        <FixRow key={x.id} fix={x} index={i} off={file.disabled.has(x.id)} onToggle={() => toggleFix(x.id)} />
                      ))}
                    </ul>
                  )
                ) : tab === 'split' ? (
                  <SplitTab split={res.split} refining={refining === file.key} onRefine={refine} onUnrefine={unrefine} onEnable={() => { setSmart(true); persistPrefs({ smart: true }); }} />
                ) : (
                  <Preview cues={res.cues} />
                )}
              </div>

              {file.savedTo && (
                <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11.5px] text-mute">
                  <Check size={12} className="text-ok" />
                  <span className="truncate" data-selectable>{file.savedTo}</span>
                  <button className="btn btn-ghost ml-auto h-6 px-2 text-[11.5px]" onClick={() => kit.reveal(file.savedTo)}><FolderOpen size={12} /> Afficher dans le Finder</button>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {over && files.length > 0 && (
        <div className="pointer-events-none fixed inset-0 left-[212px] z-40 grid place-items-center bg-bg/70 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent px-10 py-8 font-medium">Dépose tes .srt</div>
        </div>
      )}
    </div>
  );
}

function DropZone({ over, onClick }) {
  return (
    <div className="flex flex-1 px-8 pb-8">
      <button
        onClick={onClick}
        className={`rise grid flex-1 place-items-center rounded-2xl border-2 border-dashed transition-all duration-300 ${over ? 'scale-[0.99] border-accent bg-accent/5' : 'border-line hover:border-line-2'}`}
      >
        <div className="text-center">
          <div className={`mx-auto mb-4 grid size-14 place-items-center rounded-2xl transition-colors ${over ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}>
            <Upload size={22} />
          </div>
          <div className="text-[15px] font-semibold">Glisse tes fichiers .srt ici</div>
          <div className="mt-1 text-mute">ou clique pour parcourir · plusieurs fichiers à la fois</div>
          <div className="mx-auto mt-6 grid w-[420px] grid-cols-2 gap-x-6 gap-y-1.5 text-left font-mono text-[11.5px]">
            {[["vont t | 'encourager", "vont | t'encourager"], ['ce truc | -là.', 'ce truc-là.'], ['10 | 000 abonnés', '10 000 | abonnés'], ['le 1 | % du', 'le 1% | du']].map(([a, b]) => (
              <div key={a} className="contents">
                <span className="text-faint line-through decoration-bad/60">{a}</span>
                <span className="text-ink">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </button>
    </div>
  );
}

function Cue({ text, dim }) {
  if (!text) return <span className="rounded-md border border-dashed border-line-2 px-1.5 py-0.5 text-[11px] text-faint">fusionné</span>;
  return <span className={`rounded-md px-1.5 py-0.5 ${dim ? 'bg-bad/10 text-mute' : 'bg-ok/10 text-ink'}`}>{text}</span>;
}

function FixRow({ fix, index, off, onToggle }) {
  return (
    <li
      onClick={onToggle}
      className={`rise flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-panel-2/60 ${off ? 'opacity-45' : ''}`}
      style={{ animationDelay: `${Math.min(index, 20) * 18}ms` }}
    >
      <span className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${off ? 'border-line-2' : 'border-accent bg-accent text-[#140802]'}`}>
        {!off && <Check size={11} strokeWidth={3.5} />}
      </span>
      <span className="w-[62px] shrink-0 font-mono text-[11px] text-faint">{fmtTime(fix.start).slice(3, 11)}</span>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: TYPE_COLOR[fix.type] }} title={fix.name} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 font-mono text-[12px]">
        {fix.before.map((t, i) => (
          <span key={'b' + i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-faint">|</span>}
            <Cue text={t} dim />
          </span>
        ))}
        <ArrowRight size={13} className="mx-1 text-faint" />
        {fix.after.map((t, i) => (
          <span key={'a' + i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-faint">|</span>}
            <Cue text={t} />
          </span>
        ))}
      </div>
    </li>
  );
}

function Preview({ cues }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0 px-4 py-3 font-mono text-[12px]" data-selectable>
      {cues.map((c, i) => (
        <div key={i} className="contents">
          <span className="py-1 text-faint">{fmtTime(c.start).slice(3, 11)} → {fmtTime(c.end).slice(3, 11)}</span>
          <span className={`py-1 ${c.src?.length > 1 ? 'text-accent-2' : ''}`}>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

function SplitTab({ split, refining, onRefine, onUnrefine, onEnable }) {
  if (!split) {
    return (
      <div className="grid h-full place-items-center text-center text-mute">
        <div>
          <Scissors className="mx-auto mb-2 text-faint" size={20} />Découpage intelligent désactivé.
          <div className="mt-3"><button className="btn" onClick={onEnable}>Activer</button></div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-panel/95 px-4 py-2.5 text-[12px] backdrop-blur">
        <span className="text-mute">
          {split.changes.length} passage{split.changes.length > 1 ? 's' : ''} redécoupé{split.changes.length > 1 ? 's' : ''} · 1 à {split.target} mot{split.target > 1 ? 's' : ''} par ligne
        </span>
        {split.refined && (
          <>
            <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-accent-2"><Sparkles size={11} /> Affiné par Claude</span>
            <button className="flex items-center gap-1 text-faint hover:text-ink" onClick={onUnrefine}><RotateCcw size={11} /> Revenir aux règles</button>
          </>
        )}
        <button className="btn ml-auto h-7 text-[12px]" disabled={refining} onClick={onRefine} title="Claude re-découpe selon le sens. Il ne peut changer aucun mot : sinon le résultat est refusé.">
          {refining ? <><Loader2 size={13} className="animate-spin" /> Claude réfléchit…</> : <><Sparkles size={13} /> Affiner avec Claude</>}
        </button>
      </div>
      {split.changes.length === 0 ? (
        <div className="py-16 text-center text-mute">Le découpage d’origine respecte déjà la grammaire.</div>
      ) : (
        <ul className="divide-y divide-line">
          {split.changes.map((c, i) => (
            <li key={i} className="rise flex items-start gap-3 px-4 py-2.5" style={{ animationDelay: `${Math.min(i, 20) * 15}ms` }}>
              <span className="w-[62px] shrink-0 pt-1 font-mono text-[11px] text-faint">{fmtTime(c.start).slice(3, 11)}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 font-mono text-[12px]">
                <div className="flex flex-wrap items-center gap-1">
                  {c.old.map((t, k) => <span key={k} className="rounded-md bg-bad/10 px-1.5 py-0.5 text-mute">{t}</span>)}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <ArrowRight size={12} className="mr-0.5 text-faint" />
                  {c.next.map((t, k) => <span key={k} className="rounded-md bg-ok/10 px-1.5 py-0.5 text-ink">{t}</span>)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
