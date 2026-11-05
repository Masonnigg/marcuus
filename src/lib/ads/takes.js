// Pubs: find every part of the script (hooks, transis, corps) in the footage.
//  - quotes (testimonial videos): fuzzy word alignment across all recordings, word for word by default;
//  - spoken lines (teleprompter reads, often several takes): Claude picks the clean take's phrases, and
//    lists the other complete takes so the editor can switch in one click.
// Claude only answers with phrase ids, so nothing it says can put words in the video that weren't said.
import { prepWords, phrases, speechMask, piecesFor, cleanDisfluencies, quoteWords, noRepeats, sayWords, expand, FILLERS, CUT_GAP, BODY_GAP } from './cut.js';
import { partText } from './brief.js';

const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;

/** Engine result for one file → a recording ready for matching. */
export function recordingFrom(id, file, result) {
  const words = prepWords(result.words);
  return { id, path: file.path, name: file.name, words, mask: speechMask(result.speech, result.duration), duration: result.duration, phrases: phrases(words, 300) };
}

/** "1 min 35" / "40 sec" / "2:17" → ms, or null. */
export function parseTimecode(tc) {
  if (!tc) return null;
  const s = String(tc).toLowerCase();
  let m = s.match(/(\d+)\s*:\s*(\d{1,2})/);
  if (m) return (+m[1] * 60 + +m[2]) * 1000;
  const min = s.match(/(\d+)\s*min/), sec = s.match(/(\d+)\s*s/);
  if (min || sec) return ((min ? +min[1] : 0) * 60 + (sec && (!min || sec.index > min.index) ? +sec[1] : 0)) * 1000;
  return null;
}

/** Best place a quote is said, across recordings. A brief timecode breaks near-ties. */
export function findQuote(line, recordings, opts = {}) {
  const hint = parseTimecode(line.timecode);
  let best = null;
  for (const r of recordings) {
    const { idx, coverage } = quoteWords(line.text, r.words, opts);
    if (!idx.length) continue;
    const near = hint == null ? 0 : Math.abs(r.words[idx[0]].s - hint) < 30_000 ? 0.05 : 0;
    const score = coverage + near;
    if (!best || score > best.score) best = { rec: r, idx, coverage, score };
  }
  return best;
}

const SYSTEM = `You are a video editor's assistant. You receive (1) transcripts of raw recordings, split into phrases with ids like R1#12 and timecodes. A presenter reads ad scripts from a teleprompter, often in several takes, with false starts, restarts, slates ("accroche 4", "c'est parti", "on la refait") and off-script chatter. (2) The script parts to find.
For EACH part, choose the phrases that make its clean take.
Rules:
- Only use phrase ids that exist. Never invent text.
- The presenter rephrases the script: match by meaning, not exact words.
- A clean take says the whole part without a stumble. When a part was recorded several times, prefer the last complete clean take.
- If no single take is complete and clean, you may combine phrases from different takes, in script order, as long as nothing is said twice and the flow stays natural.
- Leave out slates, instructions, off-script chatter, false starts, unfinished sentences, and phrases repeated later in a better version.
- An off-screen voice saying a name, or a comment the presenter reads aloud, belongs to the hook when it is in the recording.
- Phrases in playback order. A phrase belongs to one part's chosen take, EXCEPT when several parts share the same text in the script: then the same recorded phrases are reused in each of them. Typical case: many hooks that differ only by their first sentence (a year, a name, a job) and continue with the same text, recorded once — each hook = its own first sentence + that shared continuation, and that is a complete take (confidence "sure" when both are clean).
- A take can start or end inside a phrase (e.g. a shared continuation glued to another hook's first sentence with no pause). Then add that phrase to the segment's trims: from = the first 3 to 6 words to KEEP, copied exactly from the transcript, and/or to = the last 3 to 6 words to keep; "" when that side stays whole. Never trim a phrase that is used whole.
- Return the chosen take split into its sentences (segments), in order. For each segment, alternatives = the OTHER attempts of that same sentence anywhere in the recordings, each as its phrase ids, best first, at most 3: a retake, an earlier take, or the same sentence inside a take that was abandoned later (long parts like a corps are often redone sentence by sentence: list those attempts too). Each alternative must say the whole sentence. Empty only when the sentence was said once.
- confidence "sure" when the take is clearly clean and complete; "check" when you chose between close takes, combined takes, or something may be missing. note: one short sentence in French for the editor.`;

const SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                phrases: { type: 'array', items: { type: 'string' } },
                alternatives: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                trims: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { phrase: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
                    required: ['phrase', 'from', 'to'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['phrases', 'alternatives', 'trims'],
              additionalProperties: false,
            },
          },
          confidence: { type: 'string', enum: ['sure', 'check'] },
          note: { type: 'string' },
        },
        required: ['id', 'segments', 'confidence', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['parts'],
  additionalProperties: false,
};

/** Parts with lines the presenter says (not quotes) → [{ key, label, text }] */
export function spokenParts(script) {
  const out = [];
  for (const v of script.variants) {
    for (const [kind, list] of [['hook', v.hooks], ['transi', v.transis], ['corps', v.corps]]) {
      for (const p of list) {
        const spoken = p.lines.filter((l) => l.kind === 'spoken');
        if (spoken.length) out.push({ key: `${v.id}|${p.id}`, kind, text: spoken.map((l) => (l.who ? `${l.who} : ${l.text}` : l.text)).join(' / ') });
      }
    }
  }
  return out;
}

/** The Claude request for the spoken parts, over the recordings that aren't pure testimonials. */
export function buildTakesRequest(parts, recordings) {
  const lines = [];
  for (const r of recordings) {
    lines.push(`=== ${r.id}: ${r.name}`);
    r.phrases.forEach((p, k) => lines.push(`${r.id}#${k} [${clock(r.words[p[0]].s)}] ${sayWords(p.map((i) => r.words[i].text))}`));
  }
  const user = 'SCRIPT PARTS:\n' + parts.map((p) => `- id: ${p.key}\n  text: ${p.text}`).join('\n') + '\n\nTRANSCRIPTS:\n' + lines.join('\n');
  return { system: SYSTEM, user, schema: SCHEMA, name: 'ad_takes' };
}

/** "R1#12" ids → [{ rec, phrase }] (unknown ids dropped) */
function resolve(ids, recordings) {
  return (ids || []).map((id) => {
    const m = String(id).match(/^(R\d+)#(\d+)$/);
    const rec = m && recordings.find((r) => r.id === m[1]);
    return rec && rec.phrases[+m[2]] ? { rec, phrase: +m[2] } : null;
  }).filter(Boolean);
}

/**
 * A phrase's words cut to what Claude said to keep: from its "from" words, up to its "to" words (text anchors,
 * matched on spelling-free tokens). → { idx, missed } where missed = an anchor that wasn't found (phrase kept whole).
 */
export function trimPhrase(words, idx, trim) {
  if (!trim || (!trim.from && !trim.to)) return { idx, missed: false };
  const toks = idx.flatMap((wi, k) => expand(words[wi].text).map((t) => ({ t, k })));
  const find = (text, last) => {
    const want = expand(text);
    if (!want.length) return null;
    let hit = null;
    for (let i = 0; i + want.length <= toks.length; i++) {
      if (want.every((w, j) => toks[i + j].t === w)) { hit = i; if (!last) break; }
    }
    return hit === null ? null : { start: toks[hit].k, end: toks[hit + want.length - 1].k };
  };
  const a = trim.from ? find(trim.from, false) : { start: 0 };
  const b = trim.to ? find(trim.to, true) : { end: idx.length - 1 };
  if (!a || !b || b.end < a.start) return { idx, missed: true };
  return { idx: idx.slice(a.start, b.end + 1), missed: false };
}

/**
 * Chosen phrases → cut pieces (per recording, in order), never saying something twice.
 * fine = also the small cuts (pauses, "euh", stammers); without it each run of phrases stays whole.
 * trims = [{ phrase, from, to }] for phrases the take only uses part of.
 */
export function piecesFromPhrases(ids, recordings, fine = false, trims = []) {
  const picks = resolve(ids, recordings);
  const byId = new Map((trims || []).map((t) => [t.phrase, t]));
  const pieces = [], removed = [], text = [];
  let missed = 0;
  // consecutive picks from the same recording are cleaned together
  for (let k = 0; k < picks.length;) {
    const rec = picks[k].rec;
    const group = [];
    while (k < picks.length && picks[k].rec === rec) {
      const pk = picks[k++];
      const t = trimPhrase(rec.words, rec.phrases[pk.phrase], byId.get(`${rec.id}#${pk.phrase}`));
      if (t.missed) missed++;
      group.push(t.idx);
    }
    const nr = noRepeats(rec.words, group);
    const cl = fine ? cleanDisfluencies(rec.words, nr.idx) : { keep: nr.idx, removed: [] };
    removed.push(...nr.removed, ...cl.removed);
    pieces.push(...piecesFor(rec.words, cl.keep, rec.mask, rec.path, fine ? CUT_GAP : BODY_GAP));
    text.push(sayWords(cl.keep.map((i) => rec.words[i].text)));
  }
  return { pieces, removed, text: text.join(' '), missed };
}

/**
 * Everything matched → { [key]: { pieces, text, confidence, note, flags, removed, segments: [{ text, alternatives: [{ pieces, text }] }] } }
 * takes = Claude's parsed reply for the spoken parts; opts.loose = keep a testimonial's own words between quote
 * matches; opts.choices = { [key]: { segmentIndex: attempt } } from the editor's switcher; opts.fine = also make the
 * small cuts (pauses, "euh", stammers), off by default: the app builds the body, the editor polishes.
 */
export function matchParts(script, recordings, takes, opts = {}) {
  const fine = !!opts.fine;
  const byId = new Map((takes?.parts || []).map((p) => [p.id, p]));
  const choices = opts.choices || {};
  const out = {};
  for (const v of script.variants) {
    for (const p of [...v.hooks, ...v.transis, ...v.corps]) {
      const key = `${v.id}|${p.id}`;
      const choice = choices[key] || {}; // { segmentIndex: attempt (0 = chosen take) }
      const res = { pieces: [], text: [], flags: [], removed: [], confidence: 'sure', note: '', segments: [], script: partText(p) };
      let spokenDone = false;
      for (const l of p.lines) {
        if (l.kind === 'quote') {
          const hit = findQuote(l, recordings, opts);
          if (!hit || hit.coverage < 0.5) { res.flags.push(`Citation introuvable : « ${l.text.slice(0, 60)} »`); res.confidence = 'check'; continue; }
          if (hit.coverage < 0.85) { res.flags.push(`Citation trouvée à ${Math.round(hit.coverage * 100)} % : « ${l.text.slice(0, 50)}… »`); res.confidence = 'check'; }
          // words he really said in the middle of the quote that word-for-word matching cut: the editor decides
          const kept = new Set(hit.idx);
          const cut = [];
          for (let i = hit.idx[0]; i <= hit.idx[hit.idx.length - 1]; i++) if (!kept.has(i) && !FILLERS.has(hit.rec.words[i].n)) cut.push(hit.rec.words[i].text);
          if (cut.length >= 3 && !opts.loose) { res.flags.push(`Mot pour mot : j’ai retiré « ${sayWords(cut).slice(0, 80)} » au milieu de la citation`); res.confidence = 'check'; }
          const cl = fine ? cleanDisfluencies(hit.rec.words, hit.idx) : { keep: hit.idx, removed: [] };
          res.removed.push(...cl.removed);
          res.pieces.push(...piecesFor(hit.rec.words, cl.keep, hit.rec.mask, hit.rec.path, fine ? CUT_GAP : BODY_GAP));
          res.text.push(sayWords(cl.keep.map((i) => hit.rec.words[i].text)));
        } else if (!spokenDone) {
          spokenDone = true; // all spoken lines of a part come from one Claude pick
          const t = byId.get(key);
          const segs = (t?.segments || []).filter((g) => g.phrases?.length);
          if (!segs.length) { res.flags.push('Prise introuvable dans les rushes'); res.confidence = 'check'; continue; }
          // each sentence of the take, with the other attempts of it the editor can switch to
          res.segments = segs.map((g) => ({
            phrases: g.phrases,
            text: piecesFromPhrases(g.phrases, recordings, fine, g.trims).text,
            alternatives: (g.alternatives || []).filter((a) => a?.length).map((a) => ({ phrases: a, ...piecesFromPhrases(a, recordings, fine) })).filter((a) => a.pieces.length),
          }));
          const pick = segs.flatMap((g, i) => {
            const c = choice[i] || 0;
            if (c === -1) return []; // sentence removed by the editor
            return c && res.segments[i].alternatives[c - 1] ? res.segments[i].alternatives[c - 1].phrases : g.phrases;
          });
          const trims = segs.flatMap((g, i) => (choice[i] || 0) === 0 ? g.trims || [] : []); // trims belong to the chosen take
          const main = piecesFromPhrases(pick, recordings, fine, trims);
          if (main.missed) { res.confidence = 'check'; res.flags.push('Coupe au milieu d’une phrase introuvable : la phrase est gardée entière'); }
          res.pieces.push(...main.pieces);
          res.text.push(main.text);
          res.removed.push(...main.removed);
          if (t.confidence === 'check') { res.confidence = 'check'; res.flags.push(t.note); } else res.note = t.note;
        }
      }
      res.text = res.text.join(' ');
      out[key] = res;
    }
  }
  return out;
}
