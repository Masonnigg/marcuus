// Pubs: from transcript words to cut pieces on the raw recording.
// Times are ms. A piece is { media, in, out } on the recording's own timeline.
// The rules come from scoring an engine against an editor's finished ad project (41 hooks/transis/corps):
// remove every pause ≥ 150 ms, cut on the sound rather than Whisper's word times (they drift into pauses),
// drop sound no kept word accounts for (stammers Whisper didn't write down), never play a sentence twice.

export const CUT_GAP = 150; // fine cuts: a silence at least this long inside a take is removed
export const BODY_GAP = 1000; // body only (the default): just dead air this long goes, the editor does the small cuts
export const LEAD = 20; // air kept before the first sound of a piece
export const TAIL = 30; // …and after its last sound
export const FILLERS = new Set(['euh', 'heu', 'hum', 'hmm', 'mmh', 'bah', 'ben', 'euhm']);
// "très très vite" is emphasis, not a stammer
const EMPHASIS = new Set(['tres', 'trop', 'vraiment', 'super', 'hyper', 'non', 'oui', 'si', 'fort', 'beaucoup', 'tellement']);

const strip = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');
/** "Très," → "tres" ; "'était" → "etait" (one token per transcript word, for repeats and fillers) */
export const norm = (t) => strip(String(t).toLowerCase()).replace(/[^a-z0-9]+/g, '');
/** Words → readable text: Whisper splits elisions ("c" + "'est"), so those are glued back. */
export const sayWords = (texts) => texts.join(' ').replace(/ (?=['’-]\p{L})/gu, '');

/** Text → comparison tokens, the same way for the brief and the transcript ("j'ai" → j, ai ; "100k" → 100 000). */
export function expand(text) {
  let t = strip(String(text).toLowerCase()).replace(/’/g, "'").replace(/€/g, ' euros ').replace(/%/g, ' pourcent ');
  t = t.replace(/(\d)\s*k\b/g, '$1 000').replace(/(\d)\s*m\b/g, '$1 millions');
  return t.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whisper words → [{ text, n, s, e, p }] sorted, empty ones dropped. */
export function prepWords(raw) {
  return (raw || [])
    .map((w) => ({ text: String(w.text || '').trim(), s: w.start, e: w.end, p: w.p ?? 1 }))
    .filter((w) => w.text)
    .sort((a, b) => a.s - b.s)
    .map((w) => ({ ...w, n: norm(w.text) }));
}

/** Words grouped into phrases: a break at each pause ≥ gap ms or after . ? ! … → [[wordIndex…]] */
export function phrases(words, gap = 300) {
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    if (cur.length && w.s - words[cur[cur.length - 1]].e >= gap) { out.push(cur); cur = []; }
    cur.push(i);
    if (/[.?!…]$/.test(w.text)) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

// ---------- sound ----------
/** Speech runs from the engine ([[a, b]] ms) → a 10 ms frame mask. */
export function speechMask(runs, durationMs) {
  const m = new Uint8Array(Math.ceil((durationMs || (runs.at(-1)?.[1] ?? 0)) / 10) + 1);
  for (const [a, b] of runs || []) m.fill(1, Math.max(0, Math.floor(a / 10)), Math.min(m.length, Math.ceil(b / 10)));
  return m;
}
const on = (m, f) => f >= 0 && f < m.length && m[f] === 1;

/** The engine's fine level track ({ hop: 5, db, zcr } in base64) → byte arrays, or null for old results. */
export function levelTrack(env) {
  if (!env?.db || env.hop !== HOP) return null;
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return { db: bytes(env.db), zcr: bytes(env.zcr) };
}

// ---------- joins inside connected speech ----------
// Where a kept word and a cut one are said in one breath ("soixante‿et que…"), the mask has no pause and
// Whisper's boundary can be 300 ms off. The real join is the quiet point between them on the 5 ms level track.
export const HOP = 5;
const letters = (w) => w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
const minLen = (w) => Math.max(60, 40 * letters(w)); // a kept word is at least this long: no join cuts deeper into it
const NOISY = 30; // zero crossings per 5 ms above this = noise (a consonant's burst or hiss), under it = voice

/** Quiet points between lo and hi ms: local minima at least 12 dB under the loudest frame 60 ms before AND after. */
function dips(env, lo, hi) {
  const out = [];
  const db = env.db, a = Math.max(1, Math.floor(lo / HOP)), b = Math.min(db.length - 2, Math.ceil(hi / HOP));
  for (let f = a; f <= b; f++) {
    if (db[f] > db[f + 1] || db[f] >= db[f - 1]) continue; // a minimum (the first frame of a flat one)
    let L = 0, R = 0;
    for (let k = 1; k <= 12; k++) { L = Math.max(L, db[f - k] ?? 0); R = Math.max(R, db[f + k] ?? 0); }
    if (L - db[f] >= 12 && R - db[f] >= 12) out.push(f);
  }
  return out;
}
const nearest = (frames, ms) => frames.reduce((a, b) => (Math.abs(b * HOP - ms) < Math.abs(a * HOP - ms) ? b : a));

/** Start of a kept word glued to the cut word before it → ms, or null when the track shows no join. */
export function joinStart(env, w) {
  const near = dips(env, w.s - 150, w.e - minLen(w));
  if (!near.length) return null;
  let f = nearest(near, w.s);
  const peak = Math.max(...env.db.subarray(f + 1, f + 13));
  while (f < env.db.length - 1 && env.db[f] < peak - 12) f++;
  // a word starting with a vowel takes the last consonant of the word before ("soixan|t‿et"): its burst is noise
  // right after the gap, and it belongs to the cut word
  if (/^[aeiouyh]/.test(norm(w.text))) for (let k = 0; k < 12 && env.zcr[f] >= NOISY; k++) f++;
  return f * HOP;
}
/** End of a kept word glued to the cut word after it → ms (the quietest point between them), or null. */
export function joinEnd(env, w) {
  const near = dips(env, w.s + minLen(w), w.e + 150);
  return near.length ? nearest(near, w.e) * HOP : null;
}
const gluedBefore = (m, w, prevEnd) => prevEnd > w.s - 100 && on(m, Math.round(Math.max(prevEnd, w.s - 100) / 10)) && on(m, Math.round(Math.max(prevEnd, w.s - 100) / 10) - 1);
const gluedAfter = (m, w, nextStart) => nextStart < w.e + 100 && on(m, Math.round(nextStart / 10)) && on(m, Math.round(nextStart / 10) - 1);

function onset(m, w, prevEnd) {
  const a = Math.round(Math.max(prevEnd, w.s - 100) / 10);
  if (on(m, a) && on(m, a - 1) && prevEnd > w.s - 100) return w.s; // glued to the previous word
  for (let j = a; j <= Math.floor(w.e / 10); j++) if (on(m, j)) return j * 10;
  return w.s;
}
/** Whisper often ends a sentence's last word early (a year above all: its "1962" ends before "deux" is said, its
 *  "1991" before "onze", after a 60 ms gap). When the voice runs on, through gaps under 150 ms, and nothing else
 *  is said before it stops, the word ends with the voice → frame, or null (no voice there, or it runs too far). */
function voiceEnd(m, w, nextStart) {
  const limit = Math.min(nextStart, w.e + 700) / 10;
  let f = Math.floor(w.e / 10), end = null;
  if (!on(m, f)) return null;
  for (;;) {
    while (on(m, f)) f++;
    if (f > limit) return end; // this run goes beyond what the word can account for
    end = f;
    let g = f;
    while (g < f + 15 && !on(m, g)) g++;
    if (g >= f + 15) return end; // a real pause: the voice has stopped
    f = g;
  }
}
function offset(m, w, nextStart) {
  const v = voiceEnd(m, w, nextStart);
  if (v != null) return v * 10;
  const b = Math.round(Math.min(nextStart, w.e + 100) / 10);
  for (let j = b; j >= Math.floor(w.s / 10); j--) if (on(m, j)) return (j + 1) * 10;
  return w.e;
}

/** Whisper sometimes writes one spoken number twice, the second time only its end ("1974." then "74..", said
 *  once as "…soixante-quatorze"), and the sentence split falls between them: the tail goes with the number. */
export function numberTails(words, idx) {
  const keep = new Set(idx);
  const digits = (t) => t.replace(/\D/g, '');
  for (const i of idx) {
    for (let j = i; words[j + 1] && !keep.has(j + 1); j++) {
      const a = digits(words[j].text), b = digits(words[j + 1].text);
      if (!(a && b && b.length < a.length && a.endsWith(b) && words[j + 1].s - words[j].e < 60)) break;
      keep.add(j + 1);
    }
  }
  return [...keep];
}

/**
 * Kept word indices → pieces cut on the real sound. One span per run of consecutive kept words; inside it,
 * sound no kept word accounts for is dropped (Whisper leaves stammers out of the text and stretches a
 * neighbouring word over them; its word ENDS are reliable, so a word sits at [end − expected length, end]),
 * then every silence ≥ gap is removed (CUT_GAP for the editor's fine-cut style, BODY_GAP to keep takes whole).
 */
export function piecesFor(words, idx, mask, media, gap = CUT_GAP, env = null) {
  idx = [...new Set(numberTails(words, idx))].sort((a, b) => a - b);
  if (!idx.length) return [];
  const runsOfIdx = [];
  let cur = [idx[0]];
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] === idx[k - 1] + 1) cur.push(idx[k]); else { runsOfIdx.push(cur); cur = [idx[k]]; }
  }
  runsOfIdx.push(cur);
  const out = [];
  for (const r of runsOfIdx) {
    const f = words[r[0]], l = words[r[r.length - 1]];
    const prevEnd = r[0] > 0 ? words[r[0] - 1].e : 0;
    const nextStart = r[r.length - 1] + 1 < words.length ? words[r[r.length - 1] + 1].s : l.e + 1000;
    // inside connected speech, the level track gives the exact join (no air added there: it would be the other word)
    const jA = env && r[0] > 0 && gluedBefore(mask, f, prevEnd) ? joinStart(env, f) : null;
    const jB = env && r[r.length - 1] + 1 < words.length && gluedAfter(mask, l, nextStart) ? joinEnd(env, l) : null;
    const A = Math.floor((jA ?? onset(mask, f, prevEnd)) / 10), B = Math.round((jB ?? offset(mask, l, nextStart)) / 10);
    let raw = [];
    for (let j = A; j < B;) {
      if (on(mask, j)) {
        let k = j;
        while (k < B && on(mask, k)) k++;
        if (raw.length && j - raw[raw.length - 1][1] < 5) raw[raw.length - 1][1] = k; else raw.push([j, k]);
        j = k;
      } else j++;
    }
    const l0 = r[r.length - 1];
    const occ = r.map((i) => {
      const w = words[i];
      const exp = 80 + 55 * w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
      // the last word reaches the voice's end when offset() found Whisper ended it early
      return [Math.max(w.s, w.e - exp) - 50, i === l0 ? Math.max(w.e + 50, B * 10) : w.e + 50];
    });
    raw = raw.filter(([a, b]) => b - a > 100 || occ.some(([x, y]) => a * 10 < y && b * 10 > x));
    // a silence inside one word is a stop consonant ("cinq", "parce"), not a pause: never cut there
    const inWord = (a, b) => r.some((i) => words[i].s + 60 < a * 10 && b * 10 < words[i].e - 60);
    const isl = [];
    for (const [a, b] of raw) {
      const prev = isl[isl.length - 1];
      if (prev && (a - prev[1] < gap / 10 || inWord(prev[1], a))) prev[1] = b; else isl.push([a, b]);
    }
    if (!isl.length) isl.push([A, B]);
    isl.forEach(([a, b], i) => out.push({
      media,
      in: Math.max(0, a * 10 - (i === 0 && jA != null ? 0 : LEAD)),
      out: b * 10 + (i === isl.length - 1 && jB != null ? 0 : TAIL),
    }));
  }
  return out;
}

// ---------- cleanup inside a chosen take ----------
/**
 * Drop fillers, a hesitant word at the edges ("Et…" then a pause) and stammered repeats
 * ("c'était un, c'était un, un partenariat" → "c'était un partenariat": the last attempt is kept).
 * → { keep: [wordIndex], removed: [text] }
 */
export function cleanDisfluencies(words, idx) {
  const removed = [];
  let keep = [...new Set(idx)].sort((a, b) => a - b).filter((i) => (FILLERS.has(words[i].n) ? (removed.push(words[i].text), false) : true));
  const hesitant = (t) => /(\.\.\.|…)$/.test(t);
  while (keep.length > 2 && hesitant(words[keep[0]].text) && words[keep[1]].s - words[keep[0]].e >= 350) removed.push(words[keep.shift()].text);
  while (keep.length > 2 && hesitant(words[keep.at(-1)].text) && words[keep.at(-1)].s - words[keep.at(-2)].e >= 350) removed.push(words[keep.pop()].text);
  for (let changed = true; changed;) {
    changed = false;
    const seq = keep.map((i) => words[i].n);
    outer: for (const n of [4, 3, 2, 1]) {
      for (let k = 0; k + 2 * n <= seq.length; k++) {
        let same = true;
        for (let t = 0; t < n; t++) if (!seq[k + t] || seq[k + t] !== seq[k + n + t]) { same = false; break; }
        if (!same) continue;
        if (n === 1 && EMPHASIS.has(seq[k])) continue;
        if (n === 1 && (seq[k] === 'nous' || seq[k] === 'vous') && words[keep[k + 1]].s - words[keep[k]].e < 120) continue;
        removed.push(keep.slice(k, k + n).map((i) => words[i].text).join(' '));
        keep.splice(k, n);
        changed = true;
        break outer;
      }
    }
  }
  return { keep, removed };
}

// ---------- fuzzy matching ----------
/** 0..1 similarity of two short tokens (Levenshtein). */
export function sim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Smith-Waterman between token lists → matched pairs [[qi, ti]] (ti indexes `t`). */
export function localAlign(q, t) {
  const n = q.length, m = t.length;
  const MATCH = 3, MIS = -2, GAP_Q = -1.5, GAP_T = -1;
  const H = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const P = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(q[i - 1], t[j - 1]);
      const d = H[i - 1][j - 1] + (s >= 0.75 ? MATCH * s : MIS);
      const u = H[i - 1][j] + GAP_Q, l = H[i][j - 1] + GAP_T;
      const v = Math.max(0, d, u, l);
      H[i][j] = v;
      P[i][j] = v === 0 ? 0 : v === d ? 1 : v === u ? 2 : 3;
      if (v > best) { best = v; bi = i; bj = j; }
    }
  }
  const pairs = [];
  for (let i = bi, j = bj; i > 0 && j > 0 && H[i][j] > 0;) {
    if (P[i][j] === 1) { if (sim(q[i - 1], t[j - 1]) >= 0.75) pairs.push([i - 1, j - 1]); i--; j--; }
    else if (P[i][j] === 2) i--;
    else j--;
  }
  return { score: best, pairs: pairs.reverse() };
}

/**
 * A quote from the brief → the transcript words that say it. Extra words he says in the middle are left
 * out (strict mode, word for word); where the brief paraphrased him, his own words are kept; one extra
 * connecting word ("mais") is kept rather than making a micro-cut. loose = keep everything between the
 * first and last matched word. → { idx, coverage }
 */
export function quoteWords(quote, words, { loose = false } = {}) {
  const q = expand(quote);
  const tt = [], tmap = [];
  words.forEach((w, i) => { for (const x of expand(w.text)) { tt.push(x); tmap.push(i); } });
  const { pairs } = localAlign(q, tt);
  if (!pairs.length) return { idx: [], coverage: 0 };
  const keep = new Set(pairs.map((p) => p[1]));
  if (loose) for (let t = pairs[0][1]; t <= pairs.at(-1)[1]; t++) keep.add(t);
  for (let k = 1; k < pairs.length; k++) {
    const [q1, t1] = pairs[k - 1], [q2, t2] = pairs[k];
    const qg = q2 - q1 - 1, tg = t2 - t1 - 1;
    if (qg > 0 && tg > 0 && tg <= 2 * qg + 2) for (let t = t1 + 1; t < t2; t++) keep.add(t);
    else if (qg === 0 && tg === 1 && !FILLERS.has(tt[t1 + 1])) keep.add(t1 + 1);
  }
  // the brief's first/last words paraphrased ("c'est allé" for "ça allait"): take his words just before
  // the first match / after the last one, in the same breath, never reaching into the previous sentence
  const [q0, t0] = pairs[0];
  for (let t = t0 - 1, n = 0; q0 > 0 && t >= 0 && n <= q0; t--, n++) {
    const wi = tmap[t], wn = tmap[t + 1];
    if (wi !== wn && (words[wn].s - words[wi].e > 300 || /[.?!,;:]$/.test(words[wi].text))) break;
    if (FILLERS.has(tt[t])) break;
    keep.add(t);
  }
  const [qn, tn] = pairs.at(-1);
  for (let t = tn + 1, n = 0; qn < q.length - 1 && t < tt.length && n <= q.length - 1 - qn; t++, n++) {
    const wp = tmap[t - 1], wi = tmap[t];
    if (wi !== wp && (words[wi].s - words[wp].e > 300 || /[.?!,;:]$/.test(words[wp].text))) break;
    if (FILLERS.has(tt[t])) break;
    keep.add(t);
  }
  return { idx: [...new Set([...keep].map((t) => tmap[t]))].sort((a, b) => a - b), coverage: pairs.length / q.length };
}

// ---------- safety net for a chosen take ----------
function ratio(a, b) {
  // difflib-style similarity of two token lists: 2·matches / total, matches by longest common subsequence
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const row = [0];
    for (let j = 1; j <= n; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return (2 * prev[n]) / (m + n);
}

/**
 * Phrases chosen for one part, in playback order → word indices, with the same sentence never played twice:
 * a phrase that ends with a false start of a later chosen phrase ("…lancement, d'ailleurs Valère ou" then
 * "d'ailleurs Valère ou n'importe quel…") loses only that false start; a phrase said again in full later is dropped.
 * → { idx, removed }
 */
export function noRepeats(words, phraseList) {
  const content = (ws) => ws.filter((i) => words[i].n && !FILLERS.has(words[i].n));
  const kept = phraseList.map((p) => [...p]);
  const removed = [];
  const dropped = new Set();
  for (let x = 0; x < kept.length; x++) {
    for (let y = x + 1; y < kept.length; y++) {
      const ca = content(kept[x]), cb = content(phraseList[y]);
      const na = ca.map((i) => words[i].n), nb = cb.map((i) => words[i].n);
      if (na.length < 2 || nb.length < 2) continue;
      let best = 0, hit = -1;
      for (let i = 0; i < na.length - 1; i++) {
        const r = ratio(na.slice(i), nb.slice(0, na.length - i + 2));
        if (r > best + 1e-9) { best = r; hit = i; }
      }
      if (best < 0.8) continue;
      if (hit === 0) {
        if (na.length >= 4) { dropped.add(x); removed.push('prise répétée : ' + kept[x].map((i) => words[i].text).join(' ')); break; }
        continue;
      }
      const from = ca[hit];
      removed.push('faux départ : ' + kept[x].filter((i) => i >= from).map((i) => words[i].text).join(' '));
      kept[x] = kept[x].filter((i) => i < from);
    }
  }
  return { idx: kept.filter((_, x) => !dropped.has(x)).flat(), removed };
}
