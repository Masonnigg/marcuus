// Pubs timeline: "Remplacer la prise" / "Supprimer" for a clip. A clip can hold several sentences: the editor picks
// which first. Replace lists the AI's take, the other takes it found, and a search of every rush for the same words.
// A sentence can also run over several clips: then the search replaces only the selected clip's part of it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, X, Search } from 'lucide-react';
import { piecesFromPhrases } from '../lib/ads/takes.js';
import { searchTakes, inClip, swapInClip } from '../lib/ads/edits.js';

const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;
const textOf = (sg, c) => (c && typeof c === 'object' ? sg.custom?.text : c > 0 ? sg.alternatives[c - 1]?.text : sg.text) || sg.text;

/** Plays a few pieces of the rushes (sound and picture in a hidden player), one at a time across the page. */
let playingNow = null;
function PlayPieces({ pieces }) {
  const v = useRef(), raf = useRef(0);
  const [on, setOn] = useState(false);
  const stop = () => { cancelAnimationFrame(raf.current); v.current?.pause(); setOn(false); };
  useEffect(() => stop, []);
  async function start() {
    if (playingNow && playingNow !== stop) playingNow();
    playingNow = stop;
    setOn(true);
    let i = 0;
    const go = async () => {
      const p = pieces[i], src = fileUrl(p.media);
      if (v.current.dataset.src !== src) { v.current.src = src; v.current.dataset.src = src; await new Promise((r) => v.current.addEventListener('loadedmetadata', r, { once: true })); }
      v.current.currentTime = p.in / 1000;
      await v.current.play().catch(() => {});
      const step = () => {
        if (v.current.currentTime * 1000 >= pieces[i].out) { i++; if (i >= pieces.length) return stop(); return go(); }
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    };
    go();
  }
  return (
    <>
      <video ref={v} className="hidden" playsInline preload="none" />
      <button className="btn h-7 px-2" disabled={!pieces?.length} onClick={() => (on ? stop() : start())} aria-label={on ? 'Arrêter' : 'Écouter'}>{on ? <Square size={11} /> : <Play size={12} />}</button>
    </>
  );
}

/** What deleting sentence i does from this clip: the whole sentence (-1), or only the clip's part of it. */
export function removeFromClip(sg, clip, recordings) {
  return inClip(sg.now, sg.nowTrims, clip, recordings).whole ? -1 : swapInClip(sg.now, sg.nowTrims, clip, recordings);
}

export function TakePicker({ mode, clip, sentences, segments, choice, recordings, onChoose, onClose }) {
  const [seg, setSeg] = useState(sentences.length === 1 ? sentences[0] : null);
  const sg = seg !== null ? segments[seg] : null;
  const now = seg !== null ? choice?.[seg] || 0 : 0;
  const mine = (i) => inClip(segments[i].now, segments[i].nowTrims, clip, recordings); // the clip's part of sentence i
  const part = useMemo(() => (seg !== null ? mine(seg) : null), [seg, segments, clip]);
  const partial = !!part && !part.whole;
  const said = (i) => { const m = mine(i); return m.whole ? textOf(segments[i], choice?.[i] || 0) : m.text; };
  const [query, setQuery] = useState(seg !== null ? said(seg) : '');
  useEffect(() => { if (seg !== null) setQuery(said(seg)); }, [seg]);
  const hits = useMemo(() => (sg && query.trim() ? searchTakes(query, recordings, { limit: 10 }) : []), [query, sg, recordings]);
  const aiPieces = useMemo(() => (sg ? piecesFromPhrases(sg.phrases, recordings, false, sg.trims).pieces : []), [sg, recordings]);

  // several sentences in the clip: which one?
  if (seg === null) {
    return (
      <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-2 flex items-center justify-between text-[12.5px]">
          <span className="text-mute">Ce clip contient {sentences.length} phrases : {mode === 'delete' ? 'laquelle supprimer ?' : 'laquelle remplacer ?'}</span>
          <button className="text-faint hover:text-ink" onClick={onClose} aria-label="Fermer"><X size={14} /></button>
        </div>
        <ul className="space-y-1">
          {sentences.map((i) => (
            <li key={i}><button className="w-full rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-panel" onClick={() => (mode === 'delete' ? onChoose(i, removeFromClip(segments[i], clip, recordings)) : setSeg(i))}>{said(i)}</button></li>
          ))}
        </ul>
      </div>
    );
  }

  const Row = ({ label, text, pieces, value, current, sub }) => (
    <li className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${current ? 'bg-accent/10' : 'hover:bg-panel'}`}>
      <PlayPieces pieces={pieces} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]" title={text}>{text}</div>
        <div className="text-[11px] text-faint">{label}{sub ? ` · ${sub}` : ''}</div>
      </div>
      {current ? <span className="text-[11px] text-accent">utilisée</span> : <button className="btn h-7" onClick={() => onChoose(seg, value)}>Utiliser</button>}
    </li>
  );
  const recName = (id) => recordings.find((r) => r.id === id)?.name || id;
  return (
    <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 flex items-center justify-between text-[12.5px]">
        <span className="min-w-0 truncate text-mute">Remplacer « {said(seg)} »</span>
        <button className="text-faint hover:text-ink" onClick={onClose} aria-label="Fermer"><X size={14} /></button>
      </div>
      <ul className="space-y-0.5">
        <Row label="Prise de l’IA" sub={partial ? 'toute la phrase' : ''} text={sg.text} pieces={aiPieces} value={0} current={now === 0} />
        {sg.alternatives.map((a, n) => <Row key={n} label={`Autre prise ${n + 1}`} sub={partial ? 'toute la phrase' : ''} text={a.text} pieces={a.pieces} value={n + 1} current={now === n + 1} />)}
      </ul>
      <label className="mt-3 flex items-center gap-2 rounded-md border border-line bg-bg px-2">
        <Search size={13} className="text-faint" />
        <input className="h-8 flex-1 bg-transparent text-[12.5px] outline-none" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Les mots à chercher dans les rushes" aria-label="Chercher une prise dans les rushes" />
      </label>
      <ul className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
        {hits.map((h) => {
          const put = { phrases: h.phrases, trims: h.trims };
          const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          // in use already: this clip's part (or the whole sentence) is exactly these words
          const cur = partial ? same(part.ids, h.phrases) && h.trims.every((t) => (sg.nowTrims || []).some((u) => same(u, t)))
            : typeof now === 'object' && same(now.phrases, h.phrases) && same(now.trims || [], h.trims);
          const value = partial ? swapInClip(sg.now, sg.nowTrims, clip, recordings, put) : put;
          return <Row key={h.phrases.join() + JSON.stringify(h.trims)} label={recName(h.rec)} sub={clock(h.at)} text={h.text} pieces={piecesFromPhrases(h.phrases, recordings, false, h.trims).pieces} value={value} current={cur} />;
        })}
        {query.trim() && !hits.length && <li className="px-2 py-1.5 text-[12px] text-faint">Rien de proche dans les rushes.</li>}
      </ul>
    </div>
  );
}
