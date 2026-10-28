// SRT parsing + French caption fixer.
// Fixes words that auto-captioners (TurboScribe, CapCut, Premiere…) split across cues:
//   "vont t" | "'encourager"  ->  "vont" | "t'encourager"
//   "ce truc" | "-là."        ->  "ce truc-là."
//   "le 1" | "% du"           ->  "le 1%" | "du"
//   "10" | "000 euros"        ->  "10 000" | "euros"

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const L = 'A-Za-zÀ-ÖØ-öø-ÿŒœ';
const APOS = "['’]";

export function toMs(h, m, s, ms) {
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms.padEnd(3, '0');
}

export function fmtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function parseSrt(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l, i, a) => !(i === 0 && l.trim() === '' && a.length > 1));
    const ti = lines.findIndex((l) => TIME_RE.test(l));
    if (ti === -1) continue;
    const t = lines[ti].match(TIME_RE);
    cues.push({
      id: cues.length + 1,
      start: toMs(t[1], t[2], t[3], t[4]),
      end: toMs(t[5], t[6], t[7], t[8]),
      text: lines.slice(ti + 1).join('\n').trim(),
    });
  }
  return cues;
}

/**
 * Make caption timings safe for editing software: every caption lasts at least `minMs`
 * (80 ms = 2 frames at 25 fps) and never overlaps the next one. Whisper sometimes gives a word
 * zero length ("y a" spoken fast); Premiere merges a 0-second caption with the ones after it.
 * Where speech is packed, following captions shift by a few ms and catch up at the next pause.
 * closeGapMs > 0 also stretches a caption over a tiny gap so the next one doesn't flicker in.
 * maxEnd (end of the speech) stops that shift from running past the end of the audio: the last
 * captions are pulled back instead.
 */
export function fixTimings(cues, { minMs = 80, closeGapMs = 250, maxEnd = null } = {}) {
  const out = cues.map((c) => ({ ...c, start: Math.max(0, Math.round(c.start)), end: Math.round(c.end) }));
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const prev = out[i - 1];
    if (prev && c.start < prev.end) c.start = prev.end;
    if (c.end < c.start + minMs) c.end = c.start + minMs;
  }
  if (maxEnd != null) {
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      const limit = i < out.length - 1 ? out[i + 1].start : Math.round(maxEnd);
      if (c.end <= limit) break; // the rest already fits
      c.end = limit;
      c.start = Math.max(0, Math.min(c.start, c.end - minMs));
    }
  }
  if (closeGapMs > 0) {
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].start - out[i].end;
      if (gap > 0 && gap < closeGapMs) out[i].end = out[i + 1].start;
    }
  }
  return out;
}

export function serializeSrt(cues) {
  // safety net for every export: no zero-length or overlapping captions
  return fixTimings(cues, { closeGapMs: 0 })
    .map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

// ---- helpers -------------------------------------------------------------

const tidy = (s) => s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').trim();

function splitLast(text) {
  const m = text.match(/^([\s\S]*?)(\S+)$/);
  return m ? [m[1].trimEnd(), m[2]] : [text, ''];
}

function splitFirst(text, re = /^(\S+)([\s\S]*)$/) {
  const m = text.match(re);
  return m ? [m[1], m[2].trimStart()] : ['', text];
}

// ---- boundary rules (prev cue A, next cue B) -----------------------------
// Each returns null, or { a, b, label } with the new texts. Empty text = cue is removed.

const BOUNDARY_RULES = [
  {
    type: 'elision',
    name: "Apostrophe (c'est, j'ai…)",
    apply(A, B) {
      if (!new RegExp(`^${APOS}[${L}]`).test(B)) return null;
      const [rest, last] = splitLast(A);
      if (!new RegExp(`^[${L}]{1,8}$`).test(last)) return null;
      return { a: rest, b: last + B, label: `${last} ${B.split(/\s/)[0]}` };
    },
  },
  {
    type: 'elision',
    name: "Apostrophe (c'est, j'ai…)",
    // "c'" | "est"  (apostrophe stayed on the left side)
    apply(A, B) {
      const [rest, last] = splitLast(A);
      if (!new RegExp(`^[${L}]{1,8}${APOS}$`).test(last)) return null;
      if (!new RegExp(`^[${L}]`).test(B)) return null;
      return { a: rest, b: last + B, label: `${last} ${B.split(/\s/)[0]}` };
    },
  },
  {
    type: 'hyphen',
    name: 'Trait d’union (moment-là, peut-être…)',
    // "ce truc" | "-là."   or   "peut-" | "être"
    apply(A, B) {
      const startsWithSuffix = new RegExp(`^-[${L}]`).test(B);
      const endsWithHyphen = new RegExp(`[${L}]-$`).test(A);
      if (!startsWithSuffix && !(endsWithHyphen && new RegExp(`^[${L}]`).test(B))) return null;
      if (!new RegExp(`[${L}]-?$`).test(A)) return null;
      const [first, rest] = splitFirst(B);
      return { a: A + first, b: rest, label: `${splitLast(A)[1]} ${first}` };
    },
  },
  {
    type: 'number',
    name: 'Nombres (10 000, 1 500 000…)',
    // "10" | "000 euros"
    apply(A, B) {
      if (!/(^|\s)\d{1,3}$/.test(A)) return null;
      const m = B.match(/^(\d{3}(?:[\s  ]\d{3})*[^\s\d]*)(?=\s|$)([\s\S]*)$/);
      if (!m) return null;
      return { a: `${A} ${m[1]}`, b: m[2].trimStart(), label: `${splitLast(A)[1]} ${m[1]}` };
    },
  },
  {
    type: 'unit',
    name: 'Symboles (1%, 20€…)',
    // "le 1" | "% du"
    apply(A, B) {
      if (!/\d$/.test(A)) return null;
      const m = B.match(/^([%€$£][^\s]*)([\s\S]*)$/);
      if (!m) return null;
      return { a: A + m[1], b: m[2].trimStart(), label: `${splitLast(A)[1]} ${m[1]}` };
    },
  },
];

// ---- single-cue rules ----------------------------------------------------

const CUE_RULES = [
  {
    type: 'watermark',
    name: 'Filigrane TurboScribe',
    re: /\(\s*Transcribed by TurboScribe[^)]*\)\s*/gi,
    replace: '',
  },
  {
    type: 'elision',
    name: "Apostrophe (c'est, j'ai…)",
    re: new RegExp(`(^|[^${L}])([cdjlmnst]|qu|jusqu|lorsqu|puisqu|aujourd|presqu)(${APOS})\\s+(?=[${L}])`, 'gi'),
    replace: '$1$2$3',
  },
  {
    type: 'hyphen',
    name: 'Trait d’union (moment-là, peut-être…)',
    re: new RegExp(`([${L}])\\s+-(là|ci|ce|moi|toi|lui|nous|vous|les|leur|y|en|on|il|elle|ils|elles|je|tu|être)(?![${L}])`, 'g'),
    replace: '$1-$2',
  },
  {
    type: 'accent',
    name: 'Accent « -la » → « -là »',
    re: new RegExp(`(?<![${L}])(moment|jour|truc|chose|fois|temps|époque|heure|soir|matin|mec|type|gars|personne|année|semaine|mois|façon|manière|histoire|côté|cas|endroit|ville|vidéo|projet|business|celui|celle|ceux|celles|ci|par|au|là)-la(?![${L}])`, 'gi'),
    replace: '$1-là',
  },
];

export const FIX_TYPES = [
  { type: 'elision', name: "Apostrophes (c'est, j'ai…)" },
  { type: 'hyphen', name: 'Traits d’union (moment-là…)' },
  { type: 'number', name: 'Nombres (10 000)' },
  { type: 'unit', name: 'Symboles (1%, 20€)' },
  { type: 'accent', name: '« -la » → « -là »' },
  { type: 'watermark', name: 'Filigrane TurboScribe' },
];

/**
 * Fix a list of cues.
 * @param {Array} input  parsed cues
 * @param {Object} opts  { types: {elision:true,...}, disabled: Set<fixId> }
 * @returns {{ cues: Array, fixes: Array }}
 */
export function fixCues(input, opts = {}) {
  const types = opts.types || {};
  const disabled = opts.disabled || new Set();
  const on = (t) => types[t] !== false;
  const cues = input.map((c) => ({ ...c, src: [c.id] }));
  const fixMap = new Map();
  const record = (f) => { if (!fixMap.has(f.id)) fixMap.set(f.id, f); };

  // 1. per-cue cleanups (watermark first so boundaries see clean text)
  const runCueRules = (only) => {
    for (const c of cues) {
      CUE_RULES.forEach((r, ri) => {
        if (only && !only.includes(r.type)) return;
        if (!on(r.type)) return;
        const id = `${r.type}:c${c.id}:${ri}`;
        const next = tidy(c.text.replace(r.re, r.replace));
        if (next === c.text) return;
        record({ id, type: r.type, name: r.name, cueIds: [c.id], before: [c.text], after: [next], start: c.start });
        if (!disabled.has(id)) c.text = next;
      });
    }
  };
  runCueRules(['watermark']);

  // 2. boundary merges
  for (let i = 0; i < cues.length - 1; i++) {
    const A = cues[i];
    const B = cues[i + 1];
    for (const r of BOUNDARY_RULES) {
      if (!on(r.type)) continue;
      const res = r.apply(A.text, B.text);
      if (!res) continue;
      const id = `${r.type}:${A.id}-${B.id}`;
      const a = tidy(res.a);
      const b = tidy(res.b);
      record({
        id, type: r.type, name: r.name, label: res.label, cueIds: [A.id, B.id],
        before: [A.text, B.text], after: [a, b], start: A.start,
      });
      if (disabled.has(id)) continue;
      A.text = a;
      B.text = b;
      if (!a) {
        // A emptied: B takes over A's start
        B.start = A.start;
        B.src = [...A.src, ...B.src];
        cues.splice(i, 1);
        i = Math.max(-1, i - 2);
        break;
      }
      if (!b) {
        // B emptied: A extends to B's end
        A.end = B.end;
        A.src = [...A.src, ...B.src];
        cues.splice(i + 1, 1);
        i = Math.max(-1, i - 1);
        break;
      }
    }
  }

  // 3. in-cue cleanups (spaces after apostrophes, hyphens, accents)
  runCueRules(['elision', 'hyphen', 'accent']);

  const fixes = [...fixMap.values()].sort((x, y) => x.start - y.start);
  return { cues: cues.filter((c) => c.text.trim()), fixes };
}

export function fixSrtText(raw, opts) {
  const parsed = parseSrt(raw);
  const { cues, fixes } = fixCues(parsed, opts);
  return { parsed, cues, fixes, output: serializeSrt(cues) };
}
