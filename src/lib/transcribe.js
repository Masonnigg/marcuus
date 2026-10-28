// Turn the engine's word list (Whisper on MLX, word timestamps in ms) into short caption cues.
// Whisper's words keep "c'est", "moment-là", "aujourd'hui" whole; the steps below tidy the rest.

import { fixCues, fixTimings } from './srt.js';
import { segmentUnits, groupsToCues } from './segment.js';

// words Whisper is less sure about than this get highlighted for review
export const DOUBT = 0.7;
const isDoubtful = (u) => (u.p ?? 1) < DOUBT && !/^[\d\s%€$£.,:;!?…-]+$/.test(u.text);

export function wordsFromWhisper(result) {
  const words = [];
  const duration = result?.duration; // ms, from the engine (since 1.0.5)
  for (const w of result?.words || []) {
    const text = String(w.text || '').trim();
    if (!text || (duration && w.start >= duration)) continue; // nothing after the end of the audio
    const prev = words[words.length - 1];
    // a word that starts with "-" or "'" continues the previous one ("moment" + "-là"); lone "?" sticks too
    if (prev && (/^[?!:;…»”"]+$/.test(text) || /^[-'’][\p{L}]/u.test(text))) {
      prev.text += text; prev.end = w.end; prev.p = Math.min(prev.p, w.p ?? 1);
      continue;
    }
    words.push({ text, start: w.start, end: w.end, p: w.p ?? 1 }); // p = Whisper's confidence (0-1)
  }
  // quoted speech: captions drop the quote marks, so 'dire : "Passe' becomes 'dire, passe'
  for (let i = 1; i < words.length; i++) {
    if (/^["«“]/.test(words[i].text)) {
      if (/^:$/.test(words[i - 1].text)) { words[i - 2] && (words[i - 2].text += ','); words.splice(i - 1, 1); i--; }
      else words[i - 1].text = words[i - 1].text.replace(/\s*:$/, ',');
    }
    const m = words[i].text.match(/^["«“]\s*(.)/);
    if (m && !/[.!?…]["»”]?$/.test(words[i - 1].text) && !/^(Je|I)\b/.test(words[i].text.slice(1))) {
      words[i].text = words[i].text.replace(/^(["«“]\s*)(.)/, (_, q, c) => q + c.toLocaleLowerCase('fr-FR'));
    }
  }
  // "ce truc là" -> "ce truc-là" (demonstrative + noun + là)
  for (let i = 2; i < words.length; i++) {
    if (/^là[.,!?…]*$/i.test(words[i].text) && /^(ce|cet|cette|ces)$/i.test(words[i - 2].text)) {
      words[i - 1].text += '-' + words[i].text;
      words[i - 1].end = words[i].end;
      words[i - 1].p = Math.min(words[i - 1].p ?? 1, words[i].p ?? 1);
      words.splice(i, 1);
    }
  }
  // keep times monotonic, non-overlapping and inside the audio
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (duration && w.end > duration) w.end = duration;
    if (i > 0 && w.start < words[i - 1].start) w.start = words[i - 1].start;
    if (w.end < w.start) w.end = w.start;
    if (i < words.length - 1 && w.end > words[i + 1].start) w.end = Math.max(w.start, words[i + 1].start);
  }
  return words;
}

/**
 * Whisper sometimes invents a sentence once the audio is over ("Bonne soirée...", "Merci.") and, with
 * no audio left to place it on, squeezes every word into the last few milliseconds. Real speech never
 * starts 3+ words within 60 ms of each other at the very end, so such a trailing burst is dropped.
 * (The engine filters this since 1.0.5; this also cleans transcriptions made before.)
 */
export function dropGhostTail(words) {
  let i = words.length - 1;
  while (i > 0 && words[i].start - words[i - 1].start <= 60) i--;
  const burst = words.length - i;
  return burst >= 3 && words[words.length - 1].end - words[i].start < burst * 80 ? words.slice(0, i) : words;
}

const isNumberChunk = (prev, w) => /(^|\s)\d{1,3}$/.test(prev) && /^\d{3}\b/.test(w);
const endsSentence = (t) => /[.!?…]$/.test(t);
const endsClause = (t) => /[,;:]$/.test(t);

/**
 * Group words into cues.
 * opts: { wordsPerCue: 2, maxChars: 18, minGapMs: 0, caps: false, punctuation: true }
 */
/** Words → caption units: number groups ("10" "000") and symbols ("1" "%") become one unit. */
export function unitsFromWords(words) {
  const units = [];
  for (const w of words) {
    const prev = units[units.length - 1];
    if (prev && (isNumberChunk(prev.text, w.text) || (/\d$/.test(prev.text) && /^[%€$£]/.test(w.text)))) {
      prev.text += (w.text.startsWith('%') ? '' : ' ') + w.text; // 1% · 15 000 €
      prev.end = w.end;
      prev.p = Math.min(prev.p ?? 1, w.p ?? 1);
    } else {
      units.push({ ...w });
    }
  }
  for (const u of units) u.doubt = isDoubtful(u) ? [u.text.replace(/[.,!?;:…"«»“”]+$/g, '').replace(/^["«“]/, '')] : [];
  return units;
}

/**
 * Group words into cues.
 * opts: { wordsPerCue: 2, maxChars: 18, caps, punctuation, smart: true, expressions, groups }
 * smart = grammar-aware splitting (segment.js); groups = explicit split (from "Affiner avec Claude").
 */
export function cuesFromWords(words, opts = {}) {
  const { wordsPerCue = 2, maxChars = 18, caps = false, punctuation = true, smart = true } = opts;
  words = dropGhostTail(words);
  const units = unitsFromWords(words);
  let cues;
  if (opts.groups || smart) {
    // 2a. grammar-aware split: never strand an article, preposition or subject at the end of a caption
    const groups = opts.groups || segmentUnits(units, { target: wordsPerCue, expressions: opts.expressions });
    cues = groupsToCues(units, groups);
  } else {
    // 2b. simple split: fixed word count, breaking at punctuation and long pauses
    cues = [];
    let cur = null;
    const flush = () => { if (cur) cues.push(cur); cur = null; };
    for (const u of units) {
      const gap = cur ? u.start - cur.end : 0;
      if (cur && (cur.count >= wordsPerCue || (cur.text + ' ' + u.text).length > maxChars || gap > 700)) flush();
      if (!cur) cur = { start: u.start, end: u.end, text: u.text, count: 1, doubt: [...u.doubt] };
      else { cur.text += ' ' + u.text; cur.end = u.end; cur.count++; cur.doubt.push(...u.doubt); }
      if (endsSentence(u.text) || (endsClause(u.text) && cur.count > 1)) flush();
    }
    flush();
  }
  // 3. tidy text (timings are made safe at the end)
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    let t = c.text.replace(/["«»“”]/g, '').replace(/\s+/g, ' ').trim();
    if (!punctuation) t = t.replace(/[.,!?;:…]+(?=\s|$)/g, '');
    if (caps) t = t.toLocaleUpperCase('fr-FR');
    c.text = t;
  }
  const withIds = cues.map((c, i) => ({ id: i + 1, start: Math.round(c.start), end: Math.round(c.end), text: c.text, doubt: c.doubt }));
  // 4. safety net: same fixer as the SRT Fixer (apostrophes, hyphens, numbers across cues)
  // 5. no zero-length / overlapping captions (Premiere merges a 0-second caption with the next ones),
  //    and none running past the last word
  const speechEnd = words.length ? Math.max(...words.map((w) => w.end)) : null;
  return fixTimings(fixCues(withIds).cues.map(({ src, ...c }) => c), { maxEnd: speechEnd });
}
