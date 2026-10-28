import { fixTimings } from './srt.js';

// Smart caption splitting for French.
// Finds the best way to cut a word sequence into short captions, like a word processor
// chooses line breaks: every possible cut gets a cost, dynamic programming picks the cheapest.
// Costs come from subtitle rules: never end a caption on a word that leans on the next one
// (article, preposition, subject pronoun, possessive…), don't run across punctuation,
// keep known expressions ("de A à Z") whole, stay close to the target length.

export const DEFAULT_EXPRESSIONS = [
  'de A à Z', 'en fait', 'du coup', 'parce que', 'tout le monde', 'en train de', 'par exemple',
  "c'est-à-dire", 'à chaque fois', 'tout le temps', 'tout de suite', 'en vrai', 'au final',
  'au début', 'à la fin', "d'un coup", 'de toute façon', 'en même temps', 'pour la première fois',
  "il y a", "il n'y a", "qu'est-ce que", "est-ce que", 'à 100 %', 'à 100%', 'plus que', 'moins que',
  'tous les jours', 'chaque jour', "aujourd'hui encore", 'pas du tout', 'du tout', 'à fond',
  'de plus en plus', 'de moins en moins', 'petit à petit', 'peu à peu', 'au moins', 'quand même',
  'autour de', 'en face de', 'à côté de', 'grâce à', 'près de', 'loin de', 'au lieu de', 'à cause de',
  'par rapport à', 'en dehors de', 'au niveau de', 'en moins de', 'en plus de',
];

const W = {
  // words that must not end a caption (they lean on the next word) → penalty for a break after them
  // determiners: tightest link (article/possessive + noun), then "ne" + verb
  det: new Set(['le', 'la', 'les', 'un', 'une', 'des', 'du', 'au', 'aux', 'ce', 'cet', 'cette', 'ces',
    'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leurs',
    'quel', 'quelle', 'quels', 'quelles', 'chaque', 'plusieurs', 'quelques', 'ne']),
  // prepositions and other words that lean on what follows
  strong: new Set(['à', 'de', 'dans', 'pour', 'par', 'sur', 'sous', 'avec', 'sans', 'chez', 'vers', 'entre', 'contre',
    'depuis', 'pendant', 'jusqu', 'très', 'trop', 'si', 'plus', 'moins', 'ultra', 'super', 'hyper',
    'tellement', 'assez', 'aussi', 'parce']),
  pronoun: new Set(['je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'me', 'te', 'se', 'lui',
    'leur', 'y', 'en']),
  link: new Set(['et', 'ou', 'mais', 'que', 'quand', 'dont', 'où', 'car', 'donc', 'comme',
    'avant', 'après', 'tout', 'toute', 'tous', 'toutes']),
  // helper verbs: glue only when the next word is a past participle ("a fait", "suis allé")
  aux: new Set(['ai', 'as', 'a', 'avons', 'avez', 'ont', 'avais', 'avait', 'avaient', 'suis', 'es', 'est',
    'sommes', 'êtes', 'sont', 'étais', 'était', "j'ai", "t'as", "j'avais", "t'avais", "j'étais", "t'étais", "s'est", "m'a", "t'a"]),
  // verbs followed by an infinitive ("vais réussir", "veux savoir", "faut faire")
  modal: new Set(['vais', 'vas', 'va', 'allons', 'allez', 'vont', 'peux', 'peut', 'pouvez', 'peuvent', 'veux', 'veut',
    'voulez', 'veulent', 'dois', 'doit', 'devez', 'doivent', 'faut', 'sais', 'sait', 'savez', 'aime', 'aimes',
    'commence', 'arrête', 'essaye', 'essaie', 'laisse', 'fais', 'fait', "j'vais", "j'peux"]),
  // words that attach backwards → penalty when a caption starts with them
  follow: new Set(['pas', 'jamais', 'rien', 'là', 'aussi', 'même']),
};
const PEN = { det: 12, strong: 9, pronoun: 11, link: 4, aux: 6, number: 7, follow: 4, expr: 15, sentence: 12, comma: 5, pause: 6, extraWord: 5, shortWord: 2 };

const norm = (t) => t.toLowerCase().replace(/[’]/g, "'").replace(/^[«"“(]+|[»"”),.!?;:…]+$/g, '');
const endsSentence = (t) => /[.!?…]["»”]?$/.test(t);
const endsClause = (t) => /[,;:]$/.test(t);

const PARTICIPLE = /(é|ée|és|ées|i|is|ie|it|u|us|ue|ues|ert|erte|eint|aint|oint|ait)$/;
const INFINITIVE = /(er|ir|re|oir)$/;
const SUBJECT_ELIDED = /^(qu|s|j|lorsqu|puisqu)'(il|ils|elle|elles|on)$/; // qu'il, s'ils, qu'on…

// how much breaking right after `word` hurts (the word leans on `next`)
function glueAfter(word, next = '') {
  const w = norm(word);
  const nx = norm(next);
  if (W.det.has(w)) return PEN.det;
  if (W.strong.has(w)) return PEN.strong;
  if (W.pronoun.has(w) || w === 'qui' || SUBJECT_ELIDED.test(w)) return PEN.pronoun; // subject stays with its verb
  if (/^[a-zàâçéèêëîïôûùüÿœ]+'$/.test(w)) return PEN.strong; // bare elision "l'" "d'"
  if (W.aux.has(w) && PARTICIPLE.test(nx)) return PEN.aux;
  if (W.modal.has(w) && INFINITIVE.test(nx)) return PEN.aux;
  if (/\d$/.test(w) && /^(euros?|€|%|dollars?|ans?|mois|jours?|fois|heures?|minutes?|secondes?|millions?|milliards?|personnes?|k|m)$/.test(nx)) return PEN.number;
  if (W.link.has(w)) return PEN.link;
  return 0;
}

// content words carry the meaning; function words (je, ne, de, la…) are read almost for free
const isFunctionWord = (t) => {
  const w = norm(t);
  return W.det.has(w) || W.strong.has(w) || W.pronoun.has(w) || W.link.has(w) || w === 'qui' || w === 'pas' || SUBJECT_ELIDED.test(w) || /^[a-zàâçéèêëîïôûùüÿœ]+'$/.test(w);
};

// expression occurrences as [start, end) unit index spans
function findExpressions(units, expressions, maxWords = Infinity) {
  const toks = units.map((u) => norm(u.text));
  const spans = [];
  for (const e of expressions) {
    const ex = e.toLowerCase().replace(/[’]/g, "'").split(/\s+/).filter(Boolean);
    if (ex.length < 2) continue;
    // "autour de" only helps if it fits on a line with the word after it ("autour de toi");
    // with short lines, the preposition is better with what follows ("autour / de toi")
    if ((W.strong.has(ex[ex.length - 1]) || W.det.has(ex[ex.length - 1])) && ex.length + 1 > maxWords) continue;
    for (let i = 0; i + ex.length <= toks.length; i++) {
      if (ex.every((t, k) => toks[i + k] === t)) spans.push([i, i + ex.length]);
    }
  }
  return spans;
}

/**
 * units: [{ text, start, end }] in order (a unit can hold "200 000" or "c'est").
 * opts: { target: 2, maxWords, expressions: [...] } → returns an array of [start, end) unit index groups.
 * maxWords = hard cap per caption (default: target, i.e. "1-2 words per line" for target 2).
 */
export function segmentUnits(units, opts = {}) {
  const target = Math.max(1, opts.target ?? 2);
  const maxWords = Math.max(1, opts.maxWords ?? target);
  const hardMax = target + 1;
  const maxChars = target <= 2 ? 22 : target * 7 + 6;
  const spans = findExpressions(units, opts.expressions ?? DEFAULT_EXPRESSIONS, maxWords);
  const exprMax = Math.max(hardMax, ...spans.map(([s, e]) => e - s));
  const n = units.length;

  // boundary b = break between unit b-1 and unit b
  const crossesExpr = (b) => spans.some(([s, e]) => s < b && b < e);
  const breakCost = (b) => {
    if (b <= 0 || b >= n) return 0;
    const last = units[b - 1].text;
    let c = 0;
    if (!endsSentence(last) && !endsClause(last)) {
      const gap = units[b].start - units[b - 1].end;
      const g = glueAfter(last, units[b].text);
      c += gap > 400 ? g / 2 : g; // a real pause excuses a lot
      if (W.follow.has(norm(units[b].text))) c += PEN.follow;
    }
    if (crossesExpr(b)) c += PEN.expr;
    // "en train de / te dire": an expression may end on a preposition
    if (spans.some(([, e]) => e === b)) c = Math.min(c, PEN.link);
    return c;
  };
  const groupCost = (j, i) => {
    const L = i - j;
    const content = units.slice(j, i).filter((u) => !isFunctionWord(u.text)).length;
    const light = content <= 2; // "Si je ne trouve", "et de la nature," read like two words
    const allowed = Math.min(maxWords, Math.max(spans.some(([s, e]) => s >= j && e <= i && e - s >= L - 1) ? exprMax : hardMax, light ? hardMax + 1 : 0));
    if (L > allowed) return Infinity;
    let c = 0;
    if (L > target && light) c -= 2 * (L - target);
    const lastText = units[i - 1].text;
    const closesThought = i >= n || endsSentence(lastText) || endsClause(lastText) || units[i].start - units[i - 1].end > 400;
    if (L > target) c += PEN.extraWord * (L - target);
    if (L < target) c += PEN.shortWord * (target - L) * (closesThought ? 0.25 : 1);
    const chars = units.slice(j, i).reduce((s, u) => s + u.text.length + 1, -1);
    if (chars > maxChars) c += (chars - maxChars) * 1.5;
    for (let k = j; k < i - 1; k++) {
      const t = units[k].text;
      if (endsSentence(t)) c += PEN.sentence;
      else if (endsClause(t)) c += PEN.comma;
      if (units[k + 1].start - units[k].end > 500) c += PEN.pause;
    }
    return c;
  };

  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let L = 1; L <= Math.min(exprMax, maxWords) && L <= i; L++) {
      const j = i - L;
      if (best[j] === Infinity) continue;
      const c = best[j] + groupCost(j, i) + breakCost(i);
      if (c < best[i]) { best[i] = c; from[i] = j; }
    }
  }
  const groups = [];
  for (let i = n; i > 0; i = from[i]) groups.unshift([from[i], i]);
  return groups;
}

/** Split cue texts into units with estimated word timings (for SRTs that only have cue times). */
export function unitsFromCues(cues) {
  const units = [];
  for (const c of cues) {
    const toks = joinNumberTokens(c.text.split(/\s+/).filter(Boolean));
    const total = toks.reduce((s, t) => s + t.length + 1, 0) || 1;
    let t0 = c.start;
    for (const tok of toks) {
      const dur = ((c.end - c.start) * (tok.length + 1)) / total;
      const prev = units[units.length - 1];
      // "toi ?" (French spacing): the "?" stays with its word, spacing kept as is
      if (prev && /^[?!:;»…]+$/.test(tok)) { prev.text += ' ' + tok; prev.end = Math.round(t0 + dur); }
      else units.push({ text: tok, start: Math.round(t0), end: Math.round(t0 + dur) });
      t0 += dur;
    }
  }
  return units;
}

/** The existing split of `cues`, as unit groups matching unitsFromCues(cues). */
export function groupsFromCues(cues) {
  const groups = [];
  let at = 0;
  for (const c of cues) {
    const toks = joinNumberTokens(c.text.split(/\s+/).filter(Boolean));
    const n = toks.filter((t, k) => !(k > 0 && /^[?!:;»…]+$/.test(t)) && !(k === 0 && at > 0 && /^[?!:;»…]+$/.test(t))).length;
    if (n) groups.push([at, at + n]);
    at += n;
  }
  return groups;
}

// "200" "000" → "200 000", "100" "%" → "100 %" so numbers never split across captions (text unchanged)
export function joinNumberTokens(toks) {
  const out = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    if (prev != null && /(^|\s)\d{1,3}$/.test(prev) && /^\d{3}(\D|$)/.test(t)) out[out.length - 1] = `${prev} ${t}`;
    else if (prev != null && /\d$/.test(prev) && /^[%€$£]/.test(t)) out[out.length - 1] = `${prev} ${t}`; // keep the original spacing
    else out.push(t);
  }
  return out;
}

/** Re-split cues into grammatical captions. Returns new cues [{ start, end, text }]. */
export function resegmentCues(cues, opts = {}) {
  const units = opts.units || unitsFromCues(cues);
  return groupsToCues(units, opts.groups || segmentUnits(units, opts));
}

export function groupsToCues(units, groups) {
  const cues = groups.map(([j, i]) => ({
    start: units[j].start,
    end: units[i - 1].end,
    text: units.slice(j, i).map((u) => u.text).join(' '),
    doubt: units.slice(j, i).flatMap((u) => u.doubt || []),
  }));
  return fixTimings(cues, { maxEnd: units.length ? units[units.length - 1].end : null });
}

/** Re-split any group longer than allowed (e.g. from Claude) with the rules, inside that group only. */
export function enforceLimits(units, groups, opts = {}) {
  const target = Math.max(1, opts.target ?? 2);
  const maxWords = Math.max(1, opts.maxWords ?? target);
  const out = [];
  for (const [j, i] of groups) {
    if (i - j <= maxWords) { out.push([j, i]); continue; }
    for (const [a, b] of segmentUnits(units.slice(j, i), opts)) out.push([j + a, j + b]);
  }
  return out;
}

/** Typical words per caption in an existing SRT (TurboScribe = 2), used as the split target. */
export function inferTarget(cues) {
  const counts = cues.map((c) => c.text.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  return Math.min(6, Math.max(1, counts[Math.floor(counts.length / 2)] || 2));
}

/** Where the new split differs from the old one: [{ start, old: [texts], next: [texts] }]. */
export function splitChanges(units, oldGroups, newGroups) {
  const ends = (gs) => new Set(gs.map(([, i]) => i));
  const a = ends(oldGroups);
  const b = ends(newGroups);
  const common = [0, ...[...a].filter((x) => b.has(x)).sort((x, y) => x - y)];
  const texts = (gs, s, e) => gs.filter(([j, i]) => j >= s && i <= e).map(([j, i]) => units.slice(j, i).map((u) => u.text).join(' '));
  const out = [];
  for (let k = 0; k < common.length - 1; k++) {
    const [s, e] = [common[k], common[k + 1]];
    const o = texts(oldGroups, s, e);
    const nw = texts(newGroups, s, e);
    if (o.length === 1 && nw.length === 1) continue;
    out.push({ start: units[s].start, old: o, next: nw });
  }
  return out;
}
