// Pubs timeline: the editor's edits, on top of the AI's cut. The cut is still computed from the AI's answer each time
// (matchParts); an edit only says where an edge of that cut was moved to. The edge is named by the word it sits on in
// the rush ("R1#42:in"), so an edit stays on its clip while its sentence keeps the same take, and stops applying by
// itself when the sentence gets another one.
import { expand, sayWords, LEAD, TAIL } from './cut.js';
import { phraseWords } from './takes.js';

export const FRAME = 1000 / 30;
export const MIN_CLIP = 100; // a clip never gets shorter than this
export const REACH = 3000; // how far an edge can go past the AI's cut, into the rush

const recFor = (media, recordings) => recordings.find((r) => r.path === media) || null;

/** The words a stretch of a rush holds: the first one ending after its In, the last one starting before its Out. */
export function wordsIn(piece, rec) {
  let first = -1, last = -1;
  const w = rec.words;
  for (let i = 0; i < w.length; i++) {
    if (w[i].e <= piece.in + 15) continue;
    if (w[i].s >= piece.out - 15) break;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last];
}

/** The AI's pieces → clips: { media, rec, in, out, auto: { in, out }, keyIn, keyOut, words: [first, last] | null }. */
export function clipsOf(pieces, recordings) {
  return (pieces || []).map((p) => {
    const rec = recFor(p.media, recordings);
    const words = rec ? wordsIn(p, rec) : null;
    const id = rec ? rec.id : p.media;
    return {
      media: p.media, rec: rec ? rec.id : null, in: p.in, out: p.out, auto: { in: p.in, out: p.out }, words,
      keyIn: words ? `${id}#${words[0]}:in` : `${id}@${Math.round(p.in)}:in`,
      keyOut: words ? `${id}#${words[1]}:out` : `${id}@${Math.round(p.out)}:out`,
    };
  });
}

/**
 * How far clip i's edges may go: at least MIN_CLIP long, at most REACH past the AI's cut and inside the rush, and never
 * over the next or previous clip when it continues the same rush (no sound said twice).
 */
export function limits(clips, i, recordings) {
  const c = clips[i];
  const rec = recordings.find((r) => r.id === c.rec);
  const end = rec?.duration ?? Infinity;
  const prev = clips[i - 1], next = clips[i + 1];
  const prevSame = prev && prev.media === c.media && prev.auto.out <= c.auto.in ? prev.out : -Infinity;
  const nextSame = next && next.media === c.media && next.auto.in >= c.auto.out ? next.in : Infinity;
  return {
    minIn: Math.max(0, c.auto.in - REACH, prevSame),
    maxIn: c.out - MIN_CLIP,
    minOut: c.in + MIN_CLIP,
    maxOut: Math.min(end, c.auto.out + REACH, nextSame),
  };
}

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

/** The AI's pieces + the editor's edits → the clips as edited (the pieces the player and Premiere use). */
export function applyEdits(pieces, edits, recordings) {
  const clips = clipsOf(pieces, recordings);
  for (const c of clips) {
    if (edits && c.keyIn in edits) c.in = edits[c.keyIn];
    if (edits && c.keyOut in edits) c.out = edits[c.keyOut];
  }
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const L = limits(clips, i, recordings);
    c.in = clamp(c.in, L.minIn, Math.max(L.minIn, c.out - MIN_CLIP));
    c.out = clamp(c.out, c.in + MIN_CLIP, Math.max(c.in + MIN_CLIP, L.maxOut));
  }
  return clips;
}

/** An edge dragged to `ms` → where it lands: on the nearest gap between words within `tolerance` ms, else on a frame. */
export function snapEdge(ms, side, rec, { free = false, tolerance = 120 } = {}) {
  const onFrame = Math.round(ms / FRAME) * FRAME;
  if (free || !rec) return onFrame;
  let best = null;
  for (const w of rec.words) {
    const t = side === 'in' ? w.s - LEAD : w.e + TAIL;
    if (Math.abs(t - ms) <= tolerance && (best === null || Math.abs(t - ms) < Math.abs(best - ms))) best = t;
  }
  return best === null ? onFrame : best;
}

/** Edits with one edge moved; back where the AI had it, the edit is dropped. */
export function setEdge(edits, clip, side, ms) {
  const key = side === 'in' ? clip.keyIn : clip.keyOut;
  const next = { ...(edits || {}) };
  if (Math.abs(ms - clip.auto[side]) < 1) delete next[key];
  else next[key] = Math.round(ms);
  return next;
}

/** Only the edits that still sit on an edge of the AI's cut (the others belonged to a take that was replaced). */
export function pruneEdits(edits, pieces, recordings) {
  const live = new Set(clipsOf(pieces, recordings).flatMap((c) => [c.keyIn, c.keyOut]));
  const out = {};
  for (const [k, v] of Object.entries(edits || {})) if (live.has(k)) out[k] = v;
  return out;
}

/**
 * The part of a sentence a clip holds. A sentence can run over several clips (its first words from one rush, the
 * rest from another): replacing or deleting in the timeline then acts on the selected clip's part only.
 * now / trims = the sentence's phrases and cut points as used now → { ids, text, whole } (whole = all of it).
 */
export function inClip(now, trims, clip, recordings) {
  const ps = phraseWords(now, recordings, trims).filter((p) => p.idx.length);
  const [a, b] = clip?.words || [-1, -2];
  const mine = ps.filter((p) => p.rec.id === clip?.rec && p.idx[0] <= b && p.idx[p.idx.length - 1] >= a);
  return {
    ids: mine.map((p) => p.id),
    text: sayWords(mine.flatMap((p) => p.idx.map((i) => p.rec.words[i].text))),
    whole: mine.length > 0 && mine.length === ps.length,
  };
}

/**
 * A sentence with the phrases its clip holds swapped for others (put = { phrases, trims }), or dropped (no put):
 * the rest of the sentence keeps its phrases and cut points. → a take { phrases, trims, kind: 'clip' }, or -1 when
 * nothing is left.
 */
export function swapInClip(now, trims, clip, recordings, put = { phrases: [], trims: [] }) {
  const mine = new Set(inClip(now, trims, clip, recordings).ids);
  const phrases = [];
  let placed = false;
  for (const id of now) {
    if (!mine.has(id)) { phrases.push(id); continue; }
    if (!placed) { phrases.push(...put.phrases); placed = true; }
  }
  if (!phrases.length) return -1;
  const kept = (trims || []).filter((t) => phrases.includes(t.phrase) && !put.phrases.includes(t.phrase));
  return { phrases, trims: [...kept, ...(put.trims || [])], kind: 'clip' };
}

/** Longest run of `want` tokens found in order in `have` (a small LCS). */
function inOrder(want, have) {
  const dp = new Array(have.length + 1).fill(0);
  for (let i = 1; i <= want.length; i++) {
    let prev = 0;
    for (let j = 1; j <= have.length; j++) {
      const keep = dp[j];
      dp[j] = want[i - 1] === have[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = keep;
    }
  }
  return dp[have.length];
}

/**
 * Where the query's words sit in `have`, in order: from the first to the last one matched, stretched by the query's
 * words left unmatched at either end (said otherwise: another year, another number) → { from, to } token places.
 */
function stretch(want, have) {
  const n = want.length, m = have.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = want[i - 1] === have[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  let i = n, j = m, first = null, last = null;
  while (i > 0 && j > 0) {
    if (want[i - 1] === have[j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) { last ||= [i - 1, j - 1]; first = [i - 1, j - 1]; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  if (!first) return { from: 0, to: m - 1 };
  return { from: Math.max(0, first[1] - first[0]), to: Math.min(m - 1, last[1] + (n - 1 - last[0])) };
}

/**
 * The rushes searched for a sentence: phrases (or two phrases in a row) holding the query's words in order, kept to
 * the words that match (the rest of the phrase stays out; the editor can still drag the clip's edges out to it) →
 * [{ phrases: ['R2#14', …], trims: [{ phrase, span }], text, rec, name, at (ms), score }], best first.
 */
export function searchTakes(query, recordings, { limit = 12 } = {}) {
  const want = expand(query);
  if (!want.length) return [];
  const hits = [];
  for (const rec of recordings) {
    // each phrase's tokens, with the word each comes from
    const toks = rec.phrases.map((p) => p.flatMap((w) => expand(rec.words[w].text).map((t) => ({ t, w }))));
    for (let k = 0; k < rec.phrases.length; k++) {
      for (const span of [1, 2]) {
        if (k + span > rec.phrases.length) continue;
        const have = toks.slice(k, k + span).flat();
        const plain = have.map((x) => x.t);
        const found = inOrder(want, plain);
        if (found / want.length < 0.5) continue;
        const { from, to } = stretch(want, plain);
        const w0 = have[from].w, w1 = have[to].w;
        const phrases = [], trims = [], words = [];
        let left = 0; // words of these phrases left out: a whole phrase said as asked beats a piece of a longer one
        for (let j = k; j < k + span; j++) {
          const all = rec.phrases[j];
          const a = all.findIndex((w) => w >= w0), b = all.findLastIndex((w) => w <= w1);
          if (a < 0 || b < a) continue;
          const id = `${rec.id}#${j}`;
          phrases.push(id);
          if (a > 0 || b < all.length - 1) trims.push({ phrase: id, span: [a, b] });
          left += all.length - (b - a + 1);
          words.push(...all.slice(a, b + 1));
        }
        hits.push({
          phrases, trims,
          text: sayWords(words.map((i) => rec.words[i].text)),
          rec: rec.id, name: rec.name, at: rec.words[words[0]].s,
          score: found / want.length - Math.max(0, to - from + 1 - want.length) * 0.005 - left * 0.001,
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.at - b.at);
  // one entry per place in a rush: a two-phrase hit that adds nothing to its first phrase goes
  const out = [], taken = new Set();
  for (const h of hits) {
    if (taken.has(h.phrases[0])) continue;
    taken.add(h.phrases[0]);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
