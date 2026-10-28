import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Search, Replace, AlertTriangle, RotateCcw, Sparkles, Loader2, Check, ListChecks, List } from 'lucide-react';
import { fmtTime } from '../lib/srt.js';

const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Editable caption list with per-caption audio playback, doubtful-word highlights and find & replace.
 * cues: [{ start, end, text, doubt?: string[] }]   onChange(nextCues) is called on every edit.
 */
export default function CaptionEditor({ cues, mediaPath, edited, onChange, onReset, onRefine, refining, refined, dismissed = [], onDismiss }) {
  const audio = useRef();
  const listRef = useRef();
  const [playing, setPlaying] = useState(null); // cue index
  const [editing, setEditing] = useState(null); // cue index
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [showFind, setShowFind] = useState(false);

  const [view, setView] = useState('all'); // 'all' | 'review'
  const [reviewIdx, setReviewIdx] = useState([]); // flagged captions, frozen while reviewing so the list doesn't jump
  const dismissedSet = useMemo(() => new Set(dismissed), [dismissed]);
  const flagged = (c) => c.doubt?.length > 0 && !dismissedSet.has(c.start);
  const doubtIdx = useMemo(() => cues.map((c, i) => (flagged(c) ? i : -1)).filter((i) => i >= 0), [cues, dismissedSet]);

  // review view: each flagged caption with the line before and after for context
  const rows = useMemo(() => {
    if (view !== 'review') return cues.map((_, i) => ({ i }));
    const keep = new Map();
    for (const i of reviewIdx) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < cues.length && !keep.has(k)) keep.set(k, k !== i);
    for (const i of reviewIdx) keep.set(i, false);
    const order = [...keep.keys()].sort((a, b) => a - b);
    return order.map((i, n) => ({ i, context: keep.get(i), gapBefore: n > 0 && i - order[n - 1] > 1 }));
  }, [view, reviewIdx, cues]);
  const openReview = () => { setReviewIdx(doubtIdx); setView('review'); setEditing(null); };
  const findRe = useMemo(() => (find.trim() ? new RegExp(escapeRe(find.trim()), 'gi') : null), [find]);
  const matches = useMemo(() => (findRe ? cues.reduce((n, c) => n + (c.text.match(findRe)?.length || 0), 0) : 0), [cues, findRe]);

  // stop playback right at the end of the caption (a 20 ms timer: precise, and unlike
  // requestAnimationFrame it keeps running when the window isn't in front)
  const raf = useRef();
  const play = (i) => {
    const a = audio.current;
    clearInterval(raf.current);
    if (!a || !cues[i]) return;
    if (playing === i && !a.paused) { a.pause(); setPlaying(null); return; }
    const end = cues[i].end / 1000 + 0.08;
    const go = () => {
      a.currentTime = Math.max(0, cues[i].start / 1000 - 0.05);
      a.play().then(() => {
        setPlaying(i);
        raf.current = setInterval(() => {
          if (a.paused || a.currentTime >= end) { a.pause(); clearInterval(raf.current); setPlaying(null); }
        }, 20);
      }).catch(() => setPlaying(null));
    };
    // seeking before the audio is loaded is ignored (it would play from 0:00), so wait for it
    if (a.readyState >= 1) go();
    else a.addEventListener('loadedmetadata', go, { once: true });
  };
  useEffect(() => () => clearInterval(raf.current), []);

  const setText = (i, text) => {
    const next = cues.map((c, j) => (j === i ? { ...c, text: text.replace(/\s+/g, ' ').trim(), doubt: [] } : c));
    onChange(next.filter((c) => c.text));
  };

  const startEdit = (i) => {
    setEditing(i);
    play(i); // hear it while correcting
    setTimeout(() => listRef.current?.querySelector(`[data-row="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
  };


  const replaceAll = () => {
    if (!findRe || !matches) return;
    onChange(cues.map((c) => (c.text.match(findRe) ? { ...c, text: c.text.replace(findRe, repl), doubt: [] } : c)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mediaPath && <audio ref={audio} src={fileUrl(mediaPath)} preload="auto" />}

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-[12px]">
        <div className="seg">
          <button data-on={view === 'all'} onClick={() => setView('all')}><List size={12} className="mr-1 inline" />Tout · {cues.length}</button>
          <button data-on={view === 'review'} onClick={openReview} className={doubtIdx.length ? '!text-warn' : ''}>
            <ListChecks size={12} className="mr-1 inline" />À vérifier · {doubtIdx.length}
          </button>
        </div>
        <span className="text-faint">Clique sur un texte pour le modifier · Entrée = suivant · Échap = annuler</span>
        <div className="ml-auto flex items-center gap-1.5">
          {edited && (
            <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={onReset} title="Revenir à la transcription d’origine">
              <RotateCcw size={12} /> Annuler mes modifs
            </button>
          )}
          {onRefine && (
            <button className="btn h-7 px-2 text-[12px]" disabled={refining} onClick={onRefine} title="Claude re-découpe selon le sens, sans pouvoir changer un mot">
              {refining ? <><Loader2 size={12} className="animate-spin" /> Claude réfléchit…</> : <><Sparkles size={12} /> Affiner avec Claude</>}
            </button>
          )}
          <button className={`btn h-7 px-2 text-[12px] ${showFind ? 'border-accent/60' : ''}`} onClick={() => setShowFind((v) => !v)}>
            <Search size={12} /> Rechercher
          </button>
        </div>
      </div>

      {showFind && (
        <div className="rise flex items-center gap-2 border-b border-line bg-panel-2/40 px-4 py-2" style={{ animationDuration: '0.2s' }}>
          <input autoFocus className="field h-7 w-56" placeholder="Rechercher…" value={find} onChange={(e) => setFind(e.target.value)} />
          <Replace size={13} className="text-faint" />
          <input className="field h-7 w-56" placeholder="Remplacer par…" value={repl} onChange={(e) => setRepl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && replaceAll()} />
          <button className="btn btn-primary h-7 text-[12px]" disabled={!matches} onClick={replaceAll}>Tout remplacer{find.trim() ? ` (${matches})` : ''}</button>
        </div>
      )}

      {edited && (
        <div className="border-b border-line bg-accent/5 px-4 py-1.5 text-[11.5px] text-mute">
          {refined ? '✨ Découpage affiné par Claude' : 'Texte modifié à la main'} : le découpage (mots / sous-titre, majuscules…) est figé pour ce fichier.
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {view === 'review' && reviewIdx.length === 0 && (
          <div className="py-16 text-center text-mute"><Check className="mx-auto mb-2 text-ok" size={20} />Aucun mot à vérifier dans ce fichier.</div>
        )}
        {view === 'review' && reviewIdx.length > 0 && (
          <div className="px-4 pt-1 pb-2 text-[11.5px] text-faint">
            {reviewIdx.length} sous-titre{reviewIdx.length > 1 ? 's' : ''} où Whisper hésite, avec la ligne d’avant et d’après. Écoute ▶, corrige, ou clique « C’est bon ».
          </div>
        )}
        {rows.map(({ i, context, gapBefore }, n) => {
          const c = cues[i];
          if (!c) return null;
          // in review mode, Enter jumps to the next flagged caption instead of the next line
          const nextIdx = view === 'review' ? reviewIdx.find((k) => k > i) : i + 1;
          return (
            <div key={i}>
              {gapBefore && <div className="mx-4 my-2 border-t border-dashed border-line" />}
              <Row
                index={i}
                cue={{ ...c, doubt: flagged(c) ? c.doubt : [] }}
                dim={context}
                wasFlagged={view === 'review' && !context && !flagged(c)}
                playing={playing === i}
                editing={editing === i}
                findRe={findRe}
                onPlay={() => play(i)}
                onEdit={() => startEdit(i)}
                onDismiss={onDismiss && flagged(c) ? () => onDismiss(c.start) : null}
                onCommit={(text, move) => {
                  if (text !== c.text) setText(i, text);
                  setEditing(null);
                  if (move && nextIdx != null && nextIdx < cues.length) startEdit(nextIdx);
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ index, cue, dim, wasFlagged, playing, editing, findRe, onPlay, onEdit, onDismiss, onCommit, onCancel }) {
  const [draft, setDraft] = useState(cue.text);
  const done = useRef(false);
  useEffect(() => { if (editing) { setDraft(cue.text); done.current = false; } }, [editing]);
  const finish = (fn) => { if (done.current) return; done.current = true; fn(); };
  const hasDoubt = cue.doubt?.length > 0;

  return (
    <div
      data-row={index}
      className={`group flex items-center gap-3 px-4 py-[3px] transition-colors ${playing ? 'bg-accent/10' : editing ? 'bg-panel-2' : 'hover:bg-panel-2/50'} ${dim && !playing && !editing ? 'opacity-50' : ''}`}
    >
      <button
        onClick={onPlay}
        className={`grid size-6 shrink-0 place-items-center rounded-md transition-colors ${playing ? 'bg-accent text-[#140802]' : 'text-faint opacity-60 group-hover:opacity-100 hover:bg-panel-2 hover:text-ink'}`}
        title="Écouter"
      >
        {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
      </button>
      <span className="w-[150px] shrink-0 font-mono text-[11.5px] text-faint">{fmtTime(cue.start).slice(3, 11)} → {fmtTime(cue.end).slice(3, 11)}</span>
      {editing ? (
        <input
          autoFocus
          className="field h-7 flex-1 font-mono text-[12.5px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => finish(() => onCommit(draft, false))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(() => onCommit(draft, true)); }
            if (e.key === 'Escape') { e.preventDefault(); finish(onCancel); }
          }}
        />
      ) : (
        <button onClick={onEdit} className="min-h-7 flex-1 cursor-text rounded-md px-2 py-1 text-left font-mono text-[12.5px] hover:bg-bg/60">
          <Highlighted text={cue.text} doubt={cue.doubt} findRe={findRe} />
        </button>
      )}
      {hasDoubt && !editing && <AlertTriangle size={12} className="shrink-0 text-warn" title={`À vérifier : ${cue.doubt.join(', ')}`} />}
      {hasDoubt && !editing && onDismiss && (
        <button onClick={onDismiss} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-mute hover:bg-ok/10 hover:text-ok" title="Le mot est correct">
          <Check size={11} /> C’est bon
        </button>
      )}
      {wasFlagged && !editing && <span className="flex shrink-0 items-center gap-1 text-[11px] text-ok"><Check size={11} /> vérifié</span>}
    </div>
  );
}

// Doubtful words get an amber underline, search matches a soft highlight.
function Highlighted({ text, doubt, findRe }) {
  const marks = [];
  for (const w of doubt || []) {
    const i = text.indexOf(w);
    if (w && i >= 0) marks.push({ s: i, e: i + w.length, kind: 'doubt' });
  }
  if (findRe) for (const m of text.matchAll(findRe)) marks.push({ s: m.index, e: m.index + m[0].length, kind: 'find' });
  if (!marks.length) return text;
  marks.sort((a, b) => a.s - b.s);
  const out = [];
  let at = 0;
  for (const m of marks) {
    if (m.s < at) continue;
    out.push(text.slice(at, m.s));
    out.push(
      <mark key={m.s} className={m.kind === 'doubt' ? 'rounded-sm bg-warn/15 text-warn underline decoration-warn/70 decoration-dotted underline-offset-4' : 'rounded-sm bg-accent/30 text-ink'}>
        {text.slice(m.s, m.e)}
      </mark>,
    );
    at = m.e;
  }
  out.push(text.slice(at));
  return out;
}
