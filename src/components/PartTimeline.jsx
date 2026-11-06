// Pubs: one part's timeline, CapCut style. Clips (thumbnails, rush, first words) over the sound wave, a playhead,
// edge handles to trim (snapping to the gaps between words, ⌘ for frame by frame), and the player in step with it.
// The edits go up as data (edits / choices); the cut itself is rebuilt from them by the page (edits.js).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Replace, Trash2, RotateCcw, ZoomIn } from 'lucide-react';
import { kit } from '../lib/kit.js';
import { limits, snapEdge, setEdge, FRAME } from '../lib/ads/edits.js';
import { TakePicker, removeFromClip } from './TakePicker.jsx';

const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;
const THUMB_W = 36; // a 9:16 frame at the clip height
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Clips → where each sits on the timeline (ms from the start of the part). */
function layout(clips) {
  let t = 0;
  return clips.map((c) => { const at = t; t += c.out - c.in; return at; });
}

/** The sentences a clip holds (by their words in the rush), removed ones left out. */
export function sentencesIn(clip, segments, choice) {
  if (!clip?.words || !segments) return [];
  const [a, b] = clip.words;
  const out = [];
  segments.forEach((sg, i) => {
    if (choice?.[i] === -1) return;
    if ((sg.words || []).some((w) => w.rec === clip.rec && w.from <= b && w.to >= a)) out.push(i);
  });
  return out;
}

export function PartTimeline({ clips, recordings, segments, choice, edits, onEdits, onChoose, onRestore, onReset }) {
  const [t, setT] = useState(0); // playhead, ms on the timeline
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState(null); // selected clip index
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [drag, setDrag] = useState(null); // { i, side, ms }
  const [thumbs, setThumbs] = useState({}); // media → [{ t, file }]
  const [picker, setPicker] = useState(null); // { mode: 'replace' | 'delete' }
  const undo = useRef([]);
  const box = useRef(), wave = useRef(), video = useRef(), loop = useRef({ raf: 0, i: 0 });

  // the clips as shown, with the edge being dragged
  const shown = useMemo(() => clips.map((c, i) => (drag && drag.i === i ? { ...c, [drag.side]: drag.ms } : c)), [clips, drag]);
  const starts = useMemo(() => layout(shown), [shown]);
  const total = shown.reduce((s, c) => s + c.out - c.in, 0);
  const pxPerMs = total ? (zoom * Math.max(200, width - 6)) / total : 0;
  const recOf = (c) => recordings.find((r) => r.id === c.rec);
  const edited = Object.keys(edits || {}).length > 0 || Object.keys(choice || {}).length > 0;

  // the width to fill: the timeline's column (not the scrolling box, whose first measure can come before the page
  // has settled), measured right after layout and again whenever the column changes size
  useLayoutEffect(() => {
    const col = box.current?.parentElement;
    if (!col) return undefined;
    const measure = () => setWidth((w) => (Math.abs(w - col.clientWidth) > 1 ? col.clientWidth : w));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  // ---------- player, in step with the playhead ----------
  const locate = (ms) => {
    for (let i = 0; i < shown.length; i++) if (ms < starts[i] + (shown[i].out - shown[i].in)) return { i, at: shown[i].in + Math.max(0, ms - starts[i]) };
    const i = shown.length - 1;
    return i < 0 ? null : { i, at: shown[i].out };
  };
  async function show(ms) {
    const v = video.current, p = locate(ms);
    if (!v || !p) return;
    const src = fileUrl(shown[p.i].media);
    if (v.dataset.src !== src) {
      v.src = src; v.dataset.src = src;
      await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    }
    v.currentTime = p.at / 1000;
    return p;
  }
  const stop = () => { cancelAnimationFrame(loop.current.raf); video.current?.pause(); setPlaying(false); };
  async function play() {
    if (!shown.length) return;
    const from = t >= total - 40 ? 0 : t;
    const p = await show(from);
    if (!p) return;
    loop.current.i = p.i;
    setPlaying(true);
    await video.current.play().catch(() => {});
    const step = () => {
      const v = video.current, i = loop.current.i, c = shown[i];
      if (!v || !c) return;
      const now = v.currentTime * 1000;
      if (now >= c.out) {
        if (i + 1 >= shown.length) { setT(total); return stop(); }
        loop.current.i = i + 1;
        const n = shown[i + 1];
        if (n.media === c.media) v.currentTime = n.in / 1000;
        else { show(starts[i + 1]).then(() => v.play().catch(() => {})); }
      } else setT(starts[i] + Math.max(0, now - c.in));
      loop.current.raf = requestAnimationFrame(step);
    };
    loop.current.raf = requestAnimationFrame(step);
  }
  const seek = (ms) => { stop(); const x = Math.max(0, Math.min(total, ms)); setT(x); show(x); };
  useEffect(() => () => cancelAnimationFrame(loop.current.raf), []);
  useEffect(() => { if (!playing) show(Math.min(t, total)); }, [clips]); // the cut changed: show the frame under the playhead

  // ---------- thumbnails (asked once per rush and zoom, cached by the app) ----------
  useEffect(() => {
    if (!pxPerMs) return undefined;
    const timer = setTimeout(async () => {
      const wanted = {};
      shown.forEach((c) => {
        const step = THUMB_W / pxPerMs;
        for (let x = c.in; x < c.out; x += step) (wanted[c.media] ||= []).push(x + step / 2);
      });
      const got = {};
      for (const [media, times] of Object.entries(wanted)) got[media] = await kit.ads.thumbs(media, times).catch(() => []);
      setThumbs(got);
    }, 250);
    return () => clearTimeout(timer);
  }, [clips, Math.round(pxPerMs * 1e6)]);
  const thumbAt = (media, ms) => {
    const list = thumbs[media];
    if (!list?.length) return null;
    let best = list[0];
    for (const th of list) if (Math.abs(th.t - ms) < Math.abs(best.t - ms)) best = th;
    return fileUrl(best.file);
  };

  // ---------- sound wave, from each rush's 5 ms level track ----------
  useEffect(() => {
    const cv = wave.current;
    if (!cv || !pxPerMs) return;
    const w = Math.ceil(total * pxPerMs), h = 28, ratio = window.devicePixelRatio || 1;
    cv.width = w * ratio; cv.height = h * ratio; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.scale(ratio, ratio);
    g.clearRect(0, 0, w, h);
    g.fillStyle = css('--color-mute') || '#8d8d97';
    shown.forEach((c, i) => {
      const env = recOf(c)?.env;
      if (!env) return;
      const x0 = Math.round(starts[i] * pxPerMs), x1 = Math.round((starts[i] + c.out - c.in) * pxPerMs);
      for (let x = x0; x < x1; x++) {
        const a = c.in + (x - x0) / pxPerMs, b = a + 1 / pxPerMs;
        let db = 0;
        for (let f = Math.floor(a / 5); f <= Math.ceil(b / 5); f++) db = Math.max(db, env.db[f] || 0);
        const bar = Math.max(1, Math.min(1, Math.max(0, (db - 25) / 50)) * (h - 2));
        g.fillRect(x, (h - bar) / 2, 1, bar);
      }
    });
  }, [shown, starts, pxPerMs, total]);

  // ---------- edits ----------
  const snapshot = () => ({ edits: edits || {}, choice: choice || {} });
  const remember = () => { undo.current.push(snapshot()); if (undo.current.length > 30) undo.current.shift(); };
  function startDrag(e, i, side) {
    e.stopPropagation();
    e.preventDefault();
    stop();
    setSel(i);
    const c = clips[i], rec = recOf(c), startX = e.clientX, from = c[side];
    const L = limits(clips, i, recordings);
    const [lo, hi] = side === 'in' ? [L.minIn, L.maxIn] : [L.minOut, L.maxOut];
    let ms = from;
    const move = (ev) => {
      const raw = from + (ev.clientX - startX) / pxPerMs;
      ms = Math.min(hi, Math.max(lo, snapEdge(raw, side, rec, { free: ev.metaKey, tolerance: 8 / pxPerMs })));
      setDrag({ i, side, ms });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.abs(ms - from) >= 1) { remember(); onEdits(setEdge(edits, c, side, ms)); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const chooseTake = (seg, value) => { remember(); onChoose(seg, value); setPicker(null); };
  const sentences = sel !== null ? sentencesIn(clips[sel], segments, choice) : [];
  const remove = () => (sentences.length === 1 ? chooseTake(sentences[0], removeFromClip(segments[sentences[0]], clips[sel], recordings)) : setPicker({ mode: 'delete' }));
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(t + (e.key === 'ArrowLeft' ? -FRAME : FRAME)); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sentences.length) { e.preventDefault(); remove(); }
    else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const s = undo.current.pop(); if (s) onRestore(s); }
  };

  const ruler = [];
  const tick = zoom >= 4 ? 500 : 1000;
  for (let ms = 0; ms <= total; ms += tick) ruler.push(ms);

  return (
    <div className="flex gap-4 outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Timeline de la partie">
      <div className="relative w-[150px] shrink-0 overflow-hidden rounded-xl bg-black" style={{ aspectRatio: '9 / 16' }}>
        <video ref={video} className="size-full object-cover" playsInline preload="metadata" />
        <button onClick={() => (playing ? stop() : play())} aria-label={playing ? 'Pause' : 'Lire'} className="absolute inset-0 grid place-items-center bg-black/0 transition-colors hover:bg-black/25">
          <span className="grid size-10 place-items-center rounded-full bg-black/60 text-white">{playing ? <Pause size={15} /> : <Play size={16} />}</span>
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button className="btn h-8 px-2.5" onClick={() => (playing ? stop() : play())} aria-label={playing ? 'Pause' : 'Lire'}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
          <span className="tabular-nums text-[12px] text-mute">{clock(t)} / {clock(total)}</span>
          <span className="flex-1" />
          <button className="btn h-8" disabled={!sentences.length} title={sel === null ? 'Choisis un clip' : sentences.length ? '' : 'Ce clip vient d’une citation'} onClick={() => setPicker({ mode: 'replace' })}><Replace size={13} /> Remplacer la prise</button>
          <button className="btn h-8" disabled={!sentences.length} onClick={remove}><Trash2 size={13} /> Supprimer</button>
          {edited && <button className="btn h-8" onClick={() => { remember(); onReset(); }}><RotateCcw size={13} /> Revenir à la coupe de l’IA</button>}
          <label className="flex items-center gap-1.5 text-faint" title="Zoom"><ZoomIn size={13} /><input type="range" min="1" max="8" step="0.5" value={zoom} onChange={(e) => setZoom(+e.target.value)} className="w-20 accent-ink" aria-label="Zoom de la timeline" /></label>
        </div>
        <div ref={box} className="overflow-x-auto rounded-lg border border-line bg-bg">
          <div className="relative select-none" style={{ width: Math.ceil(total * pxPerMs) + 4, padding: '0 2px' }}
            onPointerDown={(e) => { if (e.target === e.currentTarget || e.target.dataset.seek) seek((e.clientX - e.currentTarget.getBoundingClientRect().left - 2) / pxPerMs); }}>
            <div className="relative h-5 border-b border-line" data-seek="1">
              {ruler.map((ms) => (
                <span key={ms} data-seek="1" className="absolute top-0 h-full border-l border-line pl-1 text-[10.5px] tabular-nums text-faint" style={{ left: ms * pxPerMs }}>{ms % 1000 ? '' : `${ms / 1000}s`}</span>
              ))}
            </div>
            <div className="relative mt-1.5 h-[52px]">
              {shown.map((c, i) => {
                const left = starts[i] * pxPerMs, w = (c.out - c.in) * pxPerMs, on = sel === i;
                const rec = recOf(c);
                const first = c.words && rec ? rec.words.slice(c.words[0], c.words[0] + 4).map((x) => x.text).join(' ') : '';
                const slots = Math.max(1, Math.ceil(w / THUMB_W));
                return (
                  <div key={i} onPointerDown={(e) => { e.stopPropagation(); setSel(i); seek(starts[i] + (e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerMs); }}
                    className={`group absolute top-0 h-full overflow-hidden rounded-md border ${on ? 'border-2 border-accent' : 'border-line-2 hover:border-mute'}`}
                    style={{ left, width: Math.max(2, w - 2) }} title={rec ? `${rec.name} · ${clock(c.in)} → ${clock(c.out)}` : ''}>
                    <div className="absolute inset-0 flex">
                      {Array.from({ length: slots }, (_, k) => {
                        const url = thumbAt(c.media, c.in + (k + 0.5) * (THUMB_W / pxPerMs));
                        return <div key={k} className="h-full shrink-0 bg-panel-2 bg-cover bg-center" style={{ width: THUMB_W, backgroundImage: url ? `url("${url}")` : undefined }} />;
                      })}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 text-[10.5px] text-white/90">{rec ? rec.name.replace(/\.[^.]+$/, '') : ''}{first ? ` · ${first}…` : ''}</div>
                    {['in', 'out'].map((side) => (
                      <div key={side} onPointerDown={(e) => startDrag(e, i, side)} role="slider" aria-label={side === 'in' ? 'Début du clip' : 'Fin du clip'}
                        className={`absolute inset-y-0 w-2 cursor-ew-resize ${side === 'in' ? 'left-0 rounded-l-md' : 'right-0 rounded-r-md'} ${on ? 'bg-accent' : 'bg-white/0 group-hover:bg-white/40'}`} />
                    ))}
                  </div>
                );
              })}
            </div>
            <canvas ref={wave} className="mt-1 mb-1.5 block" data-seek="1" />
            <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-accent" style={{ left: 2 + t * pxPerMs }} />
          </div>
        </div>
        <p className="mt-1.5 text-[11.5px] text-faint">Tire un bord pour couper plus tôt ou plus tard (⌘ : image par image) · espace pour lire · ← → image par image · ⌘Z annule</p>
        {picker && sel !== null && (
          <TakePicker key={`${sel}:${picker.mode}`} mode={picker.mode} clip={clips[sel]} sentences={sentences} segments={segments} choice={choice} recordings={recordings}
            onChoose={chooseTake} onClose={() => setPicker(null)} />
        )}
      </div>
    </div>
  );
}
