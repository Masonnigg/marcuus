// Pubs cutting rules. Made-up sentences only: never client material.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pubsLib from '../premiere/lib/pubs.cjs';
import panelCaptions from '../premiere/lib/captions.cjs';
import { trimPhrase, recordingFrom, matchParts } from '../src/lib/ads/takes.js';
import { clipsOf, applyEdits, snapEdge, setEdge, pruneEdits, limits, searchTakes, inClip, swapInClip, FRAME, MIN_CLIP } from '../src/lib/ads/edits.js';
import { expand, prepWords, phrases, speechMask, levelTrack, piecesFor, cleanDisfluencies, quoteWords, noRepeats, BODY_GAP, sayWords } from '../src/lib/ads/cut.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };

// words spaced like real speech: each word 300 ms, `gaps` = pause before word i (ms)
function say(text, { start = 1000, gaps = {} } = {}) {
  let t = start;
  return text.split(' ').map((w, i) => {
    t += gaps[i] || 0;
    const word = { text: w, start: t, end: t + 260, p: 1 };
    t += 300;
    return word;
  });
}
const speechOf = (raw) => raw.map((w) => [w.start, w.end]);

test('expand: elisions, k, €, numbers', () => {
  assert.deepEqual(expand("J'ai fait 100k€"), ['j', 'ai', 'fait', '100', '000', 'euros']);
  assert.deepEqual(expand('C’était 3-4 mois'), ['c', 'etait', '3', '4', 'mois']);
});

test('phrases break at pauses and full stops', () => {
  const w = prepWords(say('On y va. Tout de suite maintenant', { gaps: { 5: 600 } }));
  assert.deepEqual(phrases(w).map((p) => p.length), [3, 2, 2]);
});

test('fillers and stammered repeats go, the last attempt stays', () => {
  const w = prepWords(say("c'était euh un c'était un un partenariat"));
  const { keep, removed } = cleanDisfluencies(w, w.map((_, i) => i));
  assert.equal(keep.map((i) => w[i].text).join(' '), "c'était un partenariat");
  assert.ok(removed.includes('euh'));
});

test('emphasis is not a stammer', () => {
  const w = prepWords(say("ça allait très très vite"));
  assert.equal(cleanDisfluencies(w, w.map((_, i) => i)).keep.length, 5);
});

test('a hesitant first word followed by a pause is dropped', () => {
  const w = prepWords(say('Et... au bout de trois mois', { gaps: { 1: 700 } }));
  const { keep } = cleanDisfluencies(w, w.map((_, i) => i));
  assert.equal(w[keep[0]].text, 'au');
});

test('quote: extra words he says are cut, paraphrase keeps his words', () => {
  const w = prepWords(say("franchement on était à moins de dix mille par mois tu vois et je pensais arrêter"));
  const { idx, coverage } = quoteWords('on était en dessous de dix mille par mois et je pensais arrêter', w);
  const text = idx.map((i) => w[i].text).join(' ');
  assert.ok(!text.includes('franchement'), text);
  assert.ok(text.includes('à moins'), text); // his words where the brief paraphrased
  assert.ok(!text.includes('tu vois'), text); // two inserted words: cut
  assert.ok(coverage > 0.6);
});

test('quote: loose mode keeps everything between the first and last match', () => {
  const w = prepWords(say('on était tu vois vraiment prêts à arrêter'));
  const { idx } = quoteWords('on était prêts à arrêter', w, { loose: true });
  assert.equal(idx.length, w.length);
});

test('pieces: pauses ≥150 ms are removed, shorter ones kept', () => {
  const raw = say('un deux trois quatre', { gaps: { 2: 400 } });
  const w = prepWords(raw);
  const mask = speechMask(speechOf(raw), 5000);
  const p = piecesFor(w, [0, 1, 2, 3], mask, 'clip');
  assert.equal(p.length, 2);
  assert.ok(p[0].out < raw[2].start && p[1].in > raw[1].end);
});

test('pieces, body only: a take stays whole, only dead air ≥1 s is cut', () => {
  const raw = say('un deux trois quatre cinq', { gaps: { 2: 400, 4: 1500 } });
  const w = prepWords(raw);
  const p = piecesFor(w, [0, 1, 2, 3, 4], speechMask(speechOf(raw), 6000), 'clip', BODY_GAP);
  assert.equal(p.length, 2);
  assert.ok(p[0].out > raw[3].end && p[1].in > raw[3].end, JSON.stringify(p));
});

test('pieces: a silence inside one word (stop consonant) is never cut', () => {
  const raw = say('on a fait cinq lancements', { gaps: { 4: 200 } });
  raw[3].end = raw[3].start + 480; // a long "cinq"
  const w = prepWords(raw);
  const runs = speechOf(raw).flatMap(([a, b], i) => (i === 3 ? [[a, a + 80], [a + 250, b]] : [[a, b]])); // 170 ms closure inside it
  const p = piecesFor(w, [0, 1, 2, 3, 4], speechMask(runs, 5000), 'clip');
  assert.ok(p.every((x) => !(x.in > raw[3].start && x.in < raw[3].end)), JSON.stringify(p));
});

test('pieces: sound no word accounts for (a stammer) is cut', () => {
  const raw = say('je devais les payer', { gaps: { 1: 1200 } });
  const w = prepWords(raw);
  w[0].e = raw[1].start - 20; // Whisper stretched "je" over the stammer
  const runs = [...speechOf(raw), [raw[0].end + 300, raw[0].end + 600]]; // the stammer itself
  const p = piecesFor(w, [0, 1, 2, 3], speechMask(runs, 6000), 'clip');
  assert.ok(!p.some((x) => x.in <= raw[0].end + 450 && x.out >= raw[0].end + 450), JSON.stringify(p));
});

// a 5 ms level track like the engine's: [fromMs, toMs, dB, zero crossings] segments over a quiet floor
function track(ms, segs) {
  const db = new Uint8Array(ms / 5).fill(12), zcr = new Uint8Array(ms / 5).fill(4);
  for (const [a, b, d, z] of segs) { db.fill(d, a / 5, b / 5); zcr.fill(z, a / 5, b / 5); }
  return levelTrack({ hop: 5, db: Buffer.from(db).toString('base64'), zcr: Buffer.from(zcr).toString('base64') });
}
// "…sept‿et demi" said in one breath: the vowel of "sept", its t (closure, then burst), a weak "et", "demi".
// Whisper puts the sept/et boundary 220 ms early, the speech mask sees no pause.
const breath = [[2000, 2250, 65, 5], [2250, 2280, 25, 6], [2280, 2320, 55, 45], [2320, 2400, 52, 12], [2440, 2800, 66, 5]];
const breathMask = speechMask([[1900, 2400], [2440, 2800]], 4000);

test('join in one breath: the kept word starts at the real gap, not where Whisper put it', () => {
  const w = prepWords([{ text: 'sept', start: 1900, end: 2100 }, { text: 'et', start: 2100, end: 2450 }, { text: 'demi', start: 2450, end: 2800 }]);
  const p = piecesFor(w, [1, 2], breathMask, 'clip', BODY_GAP, track(4000, breath));
  assert.equal(p[0].in, 2320, JSON.stringify(p)); // after the t: "et" starts with a vowel, the t belongs to "sept"
  assert.equal(piecesFor(w, [1, 2], breathMask, 'clip', BODY_GAP)[0].in, 2080); // no level track: as before
});

test('join in one breath: a word starting with a consonant keeps its burst', () => {
  const w = prepWords([{ text: 'sept', start: 1900, end: 2100 }, { text: 'trop', start: 2100, end: 2450 }, { text: 'demi', start: 2450, end: 2800 }]);
  assert.equal(piecesFor(w, [1, 2], breathMask, 'clip', BODY_GAP, track(4000, breath))[0].in, 2280);
});

test('the last word ends with the voice when Whisper ends it early (a year\'s last syllable after a short gap)', () => {
  const raw = say('on part en douze', { start: 1000 });
  raw.push({ text: 'ensuite', start: 4000, end: 4400, p: 1 }); // the next sentence, after a real pause
  const w = prepWords(raw);
  const last = raw[3].end; // Whisper's end; the voice goes on: 60 ms gap, then 250 ms more
  const mask = speechMask([...speechOf(raw.slice(0, 3)), [raw[3].start, last + 100], [last + 160, last + 410], [4000, 4400]], 5000);
  const p = piecesFor(w, [0, 1, 2, 3], mask, 'clip', BODY_GAP);
  assert.ok(p.at(-1).out >= last + 410, JSON.stringify(p));
  assert.ok(p.at(-1).out < 4000);
});

test('a number Whisper wrote twice ("1974." then "74..") is kept whole', () => {
  const raw = say('on part en 1974. 74..', { start: 1000 });
  raw[4].start = raw[3].end; // the tail follows with no gap
  const w = prepWords(raw);
  assert.deepEqual(phrases(w).map((p) => p.length), [4, 1]); // the split falls inside the number
  const p = piecesFor(w, phrases(w)[0], speechMask([[1000, raw[4].end]], 4000), 'clip', BODY_GAP);
  assert.ok(p.at(-1).out >= raw[4].end, JSON.stringify(p));
});

test('no sentence twice: a false start is trimmed, a full retake dropped', () => {
  const w = prepWords(say("il peut le faire d'ailleurs vous pouvez prendre rendez-vous d'ailleurs vous pouvez prendre rendez-vous sur mon agenda"));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const ph = [range(0, 8), range(9, 16)];
  const { idx, removed } = noRepeats(w, ph);
  assert.equal(idx.map((i) => w[i].text).join(' '), "il peut le faire d'ailleurs vous pouvez prendre rendez-vous sur mon agenda");
  assert.ok(removed[0].startsWith('faux départ'));
  const r2 = noRepeats(w, [range(4, 8), range(9, 16)]);
  assert.ok(r2.removed[0].startsWith('prise répétée'));
});


// ---- brief + plan (made-up brief) ----
const { findScripts, parseBriefReply } = await import('../src/lib/ads/brief.js');
const { planAds, partSequences } = await import('../src/lib/ads/plan.js');

test('brief: scripts found by their "S<n> :" headings', () => {
  const s = findScripts('Intro\nS1 : Un essai\nAcc1 : bonjour\nS2 – Autre chose\nAcc1 : salut');
  assert.deepEqual(s.map((x) => [x.id, x.title]), [['S1', 'Un essai'], ['S2', 'Autre chose']]);
  assert.ok(s[0].text.includes('bonjour') && !s[0].text.includes('salut'));
});

const line = (text, kind = 'spoken') => ({ who: 'x', kind, text, timecode: '' });
const part = (...texts) => ({ id: '?', lines: texts.map((t) => (typeof t === 'string' ? line(t) : t)) });

test('plan: two variants, the second borrows the corps → names, bins, folders', () => {
  const sc = parseBriefReply({ script: 'S9', title: 't', notes: [], variants: [
    { id: 'V1', name: '', hooks: [part('a'), part('b')], transis: [], corps: [part('c1'), part('c2')], corps_from: '' },
    { id: 'V2', name: '', hooks: [part('d')], transis: [], corps: [], corps_from: 'V1' },
  ] }, 'S9');
  const ads = planAds(sc);
  assert.equal(ads.length, 2 * 2 + 1 * 2);
  assert.equal(ads[0].name, 'S9 - V1 - H1 - C1');
  assert.deepEqual(ads[0].bin, ['S9', 'S9 V1', 'Export', 'Corps 1']);
  assert.deepEqual(ads[0].folder, ['S9', 'Variante 1', 'Corps 1']);
  assert.equal(ads.at(-1).name, 'S9 - V2 - H1 - C2');
  assert.equal(ads.at(-1).corpsVariant, 'V1');
  const ps = partSequences(sc);
  assert.deepEqual(ps.map((p) => p.name), ['S9V1 - H1', 'S9V1 - H2', 'Variante 1 - Corps de pub 1', 'Variante 1 - Corps de pub 2', 'S9V2 - H1']);
  assert.deepEqual(ps[0].bin, ['S9', 'S9 V1', 'Hooks']);
});

test('plan: testimonial variant with transis, a repeated quote is skipped', () => {
  const q = (t) => line(t, 'quote');
  const sc = parseBriefReply({ script: 'S20', title: 't', notes: [], variants: [
    { id: 'V1', name: 'paul', corps: [part('le corps')], corps_from: '',
      hooks: [part(q('je pensais tout arrêter cette année')), part(q('on a doublé en trois mois'))],
      transis: [part(q('on a doublé en trois mois'), 'et toi aussi'), part('autre transition')] },
  ] }, 'S20');
  const ads = planAds(sc);
  assert.equal(ads.length, 4);
  // one variant in the script (even a named one): no "Variante" anywhere
  assert.equal(ads[0].name, 'S20 - H1 - T1');
  assert.deepEqual(ads[0].bin, ['S20', 'Export', 'Transi 1']);
  assert.deepEqual(ads[0].folder, ['S20', 'Transi 1']);
  assert.ok(ads.find((a) => a.hook === 'H2' && a.transi === 'T1').skip);
  assert.ok(!ads.find((a) => a.hook === 'H1' && a.transi === 'T1').skip);
  assert.equal(partSequences(sc).find((p) => p.key === 'V1|H2').name, 'S20H2');
  assert.equal(partSequences(sc).find((p) => p.key === 'V1|T2').name, 'S20 - Transi 2');
});


const { buildJob } = await import('../src/lib/ads/plan.js');
test('job: part sequences first (hooks too), ads only nest them', () => {
  const sc = parseBriefReply({ script: 'S9', title: 't', notes: [], variants: [
    { id: 'V1', name: '', hooks: [part('a')], transis: [], corps: [part('c1')], corps_from: '' },
  ] }, 'S9');
  const ads = planAds(sc);
  const pc = (a, b) => ({ media: '/x/rec.mov', in: a, out: b });
  const parts = { 'V1|H1': { pieces: [pc(5000, 6500)] }, 'V1|C1': { pieces: [pc(10000, 20000)] } };
  const job = buildJob({ script: sc, parts, live: ads, media: [{ path: '/x/rec.mov', name: 'rec.mov' }] });
  assert.deepEqual(job.sequences.map((s) => s.name), ['S9H1', 'S9 - Corps de Pub', 'S9 - Full Timeline Review', 'S9 - H1']);
  assert.deepEqual(job.sequences.map((s) => s.kind), ['hook', 'corps', 'review', 'ad']);
  assert.deepEqual(job.sequences[0].clips, [{ media: 'M1', in: 5, out: 6.5 }]);
  assert.deepEqual(job.sequences[0].bin, ['S9', 'Hooks']);
  assert.deepEqual(job.sequences[2].clips, [{ seq: 'V1|H1' }, { seq: 'V1|C1' }]);
  assert.deepEqual(job.sequences[3].clips, [{ seq: 'V1|H1' }, { seq: 'V1|C1' }]);
  assert.deepEqual(job.sequences[3].bin, ['S9', 'Export']);
  assert.deepEqual(job.importBin, ['Imports']);
});


// a made-up rush for the timeline: words spaced like say(), phrases split at full stops
const rush = (id, text, start = 1000) => {
  const raw = say(text, { start });
  return recordingFrom(id, { path: `/x/${id}.mov`, name: `${id}.mov` }, { words: raw, speech: speechOf(raw), duration: start + raw.length * 300 + 5000 });
};

test('timeline: edges are named by their word, an edit moves one and goes when it is back', () => {
  const r = rush('R1', 'on part demain matin. et on rentre le soir.');
  const pieces = [{ media: '/x/R1.mov', in: 980, out: 2190 }, { media: '/x/R1.mov', in: 2180, out: 3690 }];
  const clips = clipsOf(pieces, [r]);
  assert.equal(clips[0].keyIn, 'R1#0:in');
  assert.equal(clips[0].keyOut, 'R1#3:out');
  assert.equal(clips[1].keyIn, 'R1#4:in');
  let edits = setEdge({}, clips[0], 'in', 1580); // start a word later
  assert.deepEqual(edits, { 'R1#0:in': 1580 });
  assert.equal(applyEdits(pieces, edits, [r])[0].in, 1580);
  edits = setEdge(edits, clips[0], 'in', 980);
  assert.deepEqual(edits, {});
});

test('timeline: an edge snaps to the gap between words, or to the frame when moved freely', () => {
  const r = rush('R1', 'un deux trois quatre');
  assert.equal(snapEdge(1640, 'in', r), r.words[2].s - 20); // "trois" starts at 1600
  assert.equal(snapEdge(1640, 'in', r, { free: true }), Math.round(1640 / FRAME) * FRAME);
  assert.equal(snapEdge(1900, 'out', r), r.words[2].e + 30);
});

test('timeline: limits — a clip stays 100 ms long, reaches 3 s at most, never repeats the next stretch of its rush', () => {
  const r = rush('R1', 'un deux trois quatre cinq six sept huit');
  const pieces = [{ media: '/x/R1.mov', in: 1580, out: 2290 }, { media: '/x/R1.mov', in: 2780, out: 3290 }];
  assert.equal(applyEdits(pieces, { 'R1#2:in': 2250 }, [r])[0].in, 2290 - MIN_CLIP); // dragged past its own end
  assert.equal(applyEdits(pieces, { 'R1#4:out': 9000 }, [r])[0].out, 2780); // the next clip continues the same rush
  assert.equal(applyEdits(pieces, { 'R1#7:out': 99999 }, [r])[1].out, 3290 + 3000); // 3 s past the AI's cut at most
  const L = limits(applyEdits(pieces, {}, [r]), 0, [r]);
  assert.equal(L.maxOut, 2780);
  assert.equal(L.minIn, 0); // 3 s back from 1580 is before the rush starts
});

test('timeline: an edit stops applying when its sentence gets another take', () => {
  const r = rush('R1', 'on part demain matin. on part demain matin.');
  const first = [{ media: '/x/R1.mov', in: 980, out: 2190 }];
  const second = [{ media: '/x/R1.mov', in: 2180, out: 3490 }];
  const edits = setEdge({}, clipsOf(first, [r])[0], 'out', 2000);
  assert.equal(applyEdits(second, edits, [r])[0].out, 3490); // other take: untouched
  assert.deepEqual(pruneEdits(edits, second, [r]), {});
  assert.deepEqual(pruneEdits(edits, first, [r]), edits);
});

test('timeline: search finds the same words in another rush, best first', () => {
  const a = rush('R1', 'bonjour à tous. on commence.');
  const b = rush('R2', 'alors. aujourd’hui on commence tout doucement. merci.');
  const hits = searchTakes('on commence', [a, b]);
  assert.ok(hits.length >= 2);
  assert.deepEqual(hits[0].phrases, ['R1#1']);
  assert.ok(hits.some((h) => h.rec === 'R2' && /commence/.test(h.text)));
  assert.deepEqual(searchTakes('rien à voir ici', [a, b]), []);
});

test('timeline: a take found by search replaces the sentence, words and text included', () => {
  const sc = parseBriefReply({ script: 'S9', title: 't', notes: [], variants: [
    { id: 'V1', name: '', hooks: [part('a')], transis: [], corps: [], corps_from: '' },
  ] }, 'S9');
  const a = rush('R1', 'bonjour à tous. on commence.');
  const b = rush('R2', 'alors. on commence vraiment.');
  const takes = { parts: [{ id: 'V1|H1', segments: [{ phrases: ['R1#1'], alternatives: [], trims: [] }], confidence: 'sure', note: '' }] };
  const auto = matchParts(sc, [a, b], takes, {})['V1|H1'];
  assert.equal(auto.pieces[0].media, '/x/R1.mov');
  const swapped = matchParts(sc, [a, b], takes, { choices: { 'V1|H1': { 0: { phrases: ['R2#1'] } } } })['V1|H1'];
  assert.equal(swapped.pieces[0].media, '/x/R2.mov');
  assert.equal(swapped.segments[0].custom.text, 'on commence vraiment.');
  assert.deepEqual(swapped.segments[0].words, [{ rec: 'R2', from: 1, to: 3 }]);
});

test('timeline: a found take keeps the words that match, a differing number included', () => {
  const a = rush('R1', 'pour les gens nés en 1985.');
  const c = rush('R3', 'prise deux. pour les gens nés en 1986 et qui aiment la mer.');
  const hit = searchTakes('pour les gens nés en 1985', [a, c]).find((h) => h.rec === 'R3');
  assert.deepEqual(hit.phrases, ['R3#1']);
  assert.deepEqual(hit.trims, [{ phrase: 'R3#1', span: [0, 5] }]);
  assert.equal(hit.text, 'pour les gens nés en 1986');
});

test('timeline: a sentence over two clips — replace or delete acts on the selected clip only', () => {
  const sc = parseBriefReply({ script: 'S9', title: 't', notes: [], variants: [
    { id: 'V1', name: '', hooks: [part('a')], transis: [], corps: [], corps_from: '' },
  ] }, 'S9');
  const a = rush('R1', 'pour les gens nés en 1985.');
  const b = rush('R2', 'et qui adorent courir.');
  const c = rush('R3', 'pour les gens nés en 1986 et qui aiment la mer.');
  const recs = [a, b, c];
  const takes = { parts: [{ id: 'V1|H1', segments: [{ phrases: ['R1#0', 'R2#0'], alternatives: [], trims: [] }], confidence: 'sure', note: '' }] };
  const auto = matchParts(sc, recs, takes, {})['V1|H1'];
  const sg = auto.segments[0];
  const clips = clipsOf(auto.pieces, recs);
  assert.equal(clips.length, 2);
  const mine = inClip(sg.now, sg.nowTrims, clips[0], recs);
  assert.deepEqual(mine, { ids: ['R1#0'], text: 'pour les gens nés en 1985.', whole: false });
  const hit = searchTakes(mine.text, recs).find((h) => h.rec === 'R3');
  const take = swapInClip(sg.now, sg.nowTrims, clips[0], recs, { phrases: hit.phrases, trims: hit.trims });
  assert.deepEqual(take, { phrases: ['R3#0', 'R2#0'], trims: [{ phrase: 'R3#0', span: [0, 5] }], kind: 'clip' });
  const swapped = matchParts(sc, recs, takes, { choices: { 'V1|H1': { 0: take } } })['V1|H1'];
  assert.deepEqual(swapped.pieces.map((p) => p.media), ['/x/R3.mov', '/x/R2.mov']);
  assert.equal(swapped.text, 'pour les gens nés en 1986 et qui adorent courir.');
  assert.deepEqual(swapped.segments[0].words, [{ rec: 'R3', from: 0, to: 5 }, { rec: 'R2', from: 0, to: 3 }]);
  // delete from the first clip: the rest of the sentence stays
  assert.deepEqual(swapInClip(sg.now, sg.nowTrims, clips[0], recs), { phrases: ['R2#0'], trims: [], kind: 'clip' });
  // a sentence wholly in one clip is replaced or removed whole
  assert.equal(inClip(['R2#0'], [], clipsOf([auto.pieces[1]], recs)[0], recs).whole, true);
});

test('timeline: Premiere gets the edited cut', () => {
  const sc = parseBriefReply({ script: 'S9', title: 't', notes: [], variants: [
    { id: 'V1', name: '', hooks: [part('a')], transis: [], corps: [part('c1')], corps_from: '' },
  ] }, 'S9');
  const r = rush('R1', 'un deux trois quatre cinq six');
  const auto = [{ media: '/x/R1.mov', in: 980, out: 2290 }];
  const edited = applyEdits(auto, setEdge({}, clipsOf(auto, [r])[0], 'out', 1990), [r]);
  const parts = { 'V1|H1': { pieces: edited }, 'V1|C1': { pieces: [{ media: '/x/R1.mov', in: 3000, out: 4000 }] } };
  const job = buildJob({ script: sc, parts, live: planAds(sc), media: [{ path: '/x/R1.mov', name: 'R1.mov' }] });
  assert.deepEqual(job.sequences[0].clips, [{ media: 'M1', in: 0.98, out: 1.99 }]);
});

test('trim inside a phrase: a shared continuation glued to another hook’s first sentence', () => {
  const w = prepWords(say('pour les gens nés en 1985 et qui adorent courir le matin'));
  const all = w.map((_, i) => i);
  const t = trimPhrase(w, all, { phrase: 'R1#1', from: 'et qui adorent', to: '' });
  assert.equal(t.idx.map((i) => w[i].text).join(' '), 'et qui adorent courir le matin');
  assert.ok(!t.missed);
  assert.equal(trimPhrase(w, all, { from: 'pour les gens', to: 'nés en 1985' }).idx.length, 6);
  const miss = trimPhrase(w, all, { from: 'pas dans la phrase', to: '' });
  assert.ok(miss.missed && miss.idx.length === all.length); // never cut on a guess
});

test('review text: elisions Whisper split are glued back', () => {
  const words = prepWords(say("c 'est d 'accord", { start: 0 }));
  assert.equal(sayWords(words.map((w) => w.text)), "c'est d'accord");
});

test('panel captions: the Transcrire rules, bundled for Premiere', () => {
  const srt = panelCaptions.srtFromEngine({ words: [{ text: ' C', start: 0, end: 200 }, { text: "'est", start: 200, end: 400 }, { text: ' parti.', start: 400, end: 900 }] }, { wordsPerCue: 2, maxChars: 18 });
  assert.ok(srt.includes("C'est parti."), srt);
  assert.equal(panelCaptions.srtFromEngine({ words: [] }), '');
});

test('panel captions: the part’s sound made by ffmpeg from its clips, each at its place, Premiere left free', () => {
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryacha-cut-'));
  const tone = (name, hz) => { const f = path.join(dir, name); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=4:sample_rate=48000`, '-ac', '2', f]); return f; };
  const a = tone('a.wav', 300), b = tone('b.wav', 1200);
  // A from 1.0 s placed at 0, a gap, B from 0.5 s placed at 1.5; B also on a second track (dual mono)
  const cut = { end: 3, clips: [
    { media: a, track: 0, start: 0, end: 1, inPoint: 1 },
    { media: b, track: 0, start: 1.5, end: 2.5, inPoint: 0.5 },
    { media: b, track: 1, start: 1.5, end: 2.5, inPoint: 0.5 },
  ] };
  const out = path.join(dir, 'part.wav');
  execFileSync(ffmpeg, pubsLib.audioCutArgs(cut, out));
  const wav = fs.readFileSync(out);
  const pcm = wav.subarray(wav.indexOf('data') + 8); // 16 kHz mono s16
  const s = (i) => pcm.readInt16LE(i * 2);
  const at = (from, to) => { // zero crossings per second and peak level, in a window of the result
    let z = 0, peak = 0;
    for (let i = from * 16000 + 1; i < to * 16000; i++) { if ((s(i - 1) < 0) !== (s(i) < 0)) z++; peak = Math.max(peak, Math.abs(s(i))); }
    return { hz: Math.round(z / 2 / (to - from)), peak };
  };
  assert.equal(pcm.length / 2, 3 * 16000); // the part's length
  assert.ok(Math.abs(at(0.1, 0.9).hz - 300) < 10);
  assert.equal(at(1.1, 1.4).peak, 0); // the gap stays silent
  assert.ok(Math.abs(at(1.6, 2.4).hz - 1200) < 15);
  assert.ok(Math.abs(at(1.6, 2.4).peak - at(0.1, 0.9).peak) < 300); // the same sound on two tracks: not louder
  assert.equal(at(2.6, 2.9).peak, 0);
  assert.equal(pubsLib.audioCutArgs({ clips: [] }, out), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('panel zooms: one per shot on V1, light then full like zoomi, up to the nested corps', () => {
  const clips = [{ start: 0, end: 0.9 }, { start: 0.9, end: 2.2333 }, { name: 'zoomi zoom', start: 1, end: 2 }, { start: 2.2333, end: 5.4333 }, { start: 5.4333, end: 60 }];
  const z = pubsLib.zoomsFor(clips, 5.4333, 30, { maxZoom: 138 });
  assert.deepEqual(z.map((x) => x.scale), [128.5, 138, 128.5]);
  assert.equal(z[0].start, 0);
  assert.ok(Math.abs(z[2].end - 5.4333) < 0.02 && Math.abs(z[1].start - 0.9) < 1e-9, JSON.stringify(z));
  assert.deepEqual(pubsLib.zoomsFor([], 10, 30), []);
});

test('panel export: ads into <root>/<script>/9x16/<variante>/<corps>, reviews next to them', () => {
  const job = { script: 'S7', sequences: [
    { key: 'V1|C1', name: 'S7 - CORPS DE PUB 1', bin: ['2.ADS', 'S7'] },
    { key: 'ad:S7 - V1 - H1 - C1', name: 'S7 - V1 - H1 - C1', folder: ['S7', 'Variante 1', 'Corps 1'] },
    { key: 'ad:x', name: 'S15 - Paul - H1 - T1', folder: ['S15', 'Variante Paul', 'Transi 1'] },
    { key: 'review:V1', name: 'S7 - Full Timeline Review', folder: ['S7'] },
  ] };
  assert.deepEqual(pubsLib.exportPlan(job, '/L/Batch').map((p) => p.out), [
    '/L/Batch/S7/9x16/Variante 1/Corps 1/S7 - V1 - H1 - C1.mp4',
    '/L/Batch/S15/9x16/Variante Paul/Transi 1/S15 - Paul - H1 - T1.mp4',
    '/L/Batch/S7/S7 - Full Timeline Review.mp4',
  ]);
});

test('panel template: the adjustment layer is resized to the sequence', () => {
  const xml = '<FrameRect>0,0,1920,1080</FrameRect><Name>Adjustment Layer</Name><MZ.Sequence.PreviewFrameSizeWidth>1920';
  const out = pubsLib.resizeTemplate(xml, 1080, 1920);
  assert.ok(out.includes('<FrameRect>0,0,1080,1920</FrameRect>') && out.includes('<Name>zoomi layer 1080x1920</Name>') && out.includes('Width>1080'), out);
});

test('panel caption style: learned from one styled part, copied to the others, words kept', () => {
  // a caption blob: [size][style part][u32 length][text][\0][padding]
  const blob = (part, text) => {
    const t = Buffer.from(text, 'utf8');
    const tail = Buffer.alloc(4 + Math.ceil((t.length + 1) / 4) * 4);
    tail.writeUInt32LE(t.length, 0); t.copy(tail, 4);
    const b = Buffer.concat([Buffer.alloc(4), part, tail]);
    b.writeUInt32LE(b.length - 12, 0);
    return b.toString('base64');
  };
  const styled = Buffer.from('..Montserrat-Bold..\0'), plain = Buffer.from('..Monaco....\0\0\0\0');
  let id = 100;
  const seq = (name, captions) => {
    const g = id++, uid = `track-${g}`;
    const items = captions.map((c) => { const it = id++, bl = id++; return { it, bl, c }; });
    return [
      `<Sequence ObjectUID="seq-${g}" Version="1"><TrackGroups><TrackGroup Version="1" Index="0"><First>x</First><Second ObjectRef="${g}"/></TrackGroup></TrackGroups><Name>${name}</Name></Sequence>`,
      `<DataTrackGroup ObjectID="${g}" Version="1"><Tracks Version="1"><Track Index="0" ObjectURef="${uid}"/></Tracks></DataTrackGroup>`,
      `<CaptionDataClipTrack ObjectUID="${uid}" Version="1"><ClipItems><TrackItems>${items.map((x, i) => `<TrackItem Index="${i}" ObjectRef="${x.it}"/>`).join('')}</TrackItems></ClipItems><CaptionDataTemplateStyle Encoding="base64" BinaryHash="tpl-0"/></CaptionDataClipTrack>`,
      ...items.map((x) => `<CaptionDataClipTrackItem ObjectID="${x.it}" Version="3"><BlockVector Version="1"><BlockVectorItem Index="0" ObjectRef="${x.bl}"/></BlockVector></CaptionDataClipTrackItem>`),
      ...items.map((x) => `<Block ObjectID="${x.bl}" Version="1"><FormattedTextData Encoding="base64" BinaryHash="h-${x.bl}">${blob(x.c[0], x.c[1])}</FormattedTextData></Block>`),
    ].join('\n');
  };
  const project = ['<StyleProjectItem ObjectUID="style-9" Version="1"/>', '<X><CaptionDataTemplateStyle Encoding="base64" BinaryHash="tpl-0">AAAA</CaptionDataTemplateStyle></X>',
    seq('S2H1', [[styled, 'Si tu'], [styled, 'es coach']]), seq('S2H2', [[plain, 'Moi je'], [plain, 'suis thérapeute']]), seq('Autre', [[plain, 'à garder']])].join('\n');
  const style = `<StyleProjectItem ObjectUID="style-9" Version="1"/><StartKeyframeValue Encoding="base64" BinaryHash="h">${Buffer.from('..Montserrat-Bold..').toString('base64')}</StartKeyframeValue>`;
  const learned = pubsLib.learnStyle(project, style, ['S2H1', 'S2H2']);
  assert.equal(learned.font, 'Montserrat-Bold');
  const r = pubsLib.styleCaptionTracks(project, style, ['S2H1', 'S2H2'], learned);
  assert.equal(r.tracks, 2);
  assert.equal(r.captions, 4);
  const texts = (xml, name) => {
    const out = [];
    for (const m of xml.matchAll(/<Block ObjectID="\d+" Version="1"><FormattedTextData Encoding="base64" BinaryHash="([^"]+)"(?:\/>|>([^<]+)<)/g)) {
      const data = m[2] || (xml.match(new RegExp(`BinaryHash="${m[1]}">([^<]+)<`)) || [])[1];
      const b = Buffer.from(data, 'base64'), p = pubsLib.textStart(b);
      out.push([b.subarray(0, p).toString('latin1').includes(name), b.subarray(p + 4, p + 4 + b.readUInt32LE(p)).toString('utf8')]);
    }
    return out;
  };
  assert.deepEqual(texts(r.xml, 'Montserrat-Bold'), [[true, 'Si tu'], [true, 'es coach'], [true, 'Moi je'], [true, 'suis thérapeute'], [false, 'à garder']]);
  assert.equal((r.xml.match(/<ParentStyle ObjectURef="style-9"\/>/g) || []).length, 2);
  for (const h of r.xml.matchAll(/BinaryHash="([^"]+)"/g)) assert.ok(r.xml.includes(`BinaryHash="${h[1]}">`), `data for ${h[1]}`);
  assert.throws(() => pubsLib.styleCaptionTracks(project.replace('style-9', 'other'), style, ['S2H1']), /pas encore dans le projet/);
});

test('panel caption style straight from the file: the sample text link is pointed at each caption’s words', () => {
  // a style record: header, a link at 20 to the "Aa" sample at 32, then more style data after it
  const b = Buffer.alloc(56);
  b.writeUInt32LE(b.length - 12, 0); b.writeUInt32LE(0x11223344, 8);
  b.writeUInt32LE(32 - 20, 20);
  b.writeUInt32LE(2, 32); b.write('Aa', 36, 'latin1');
  b.write('Inter-Bold', 40, 'latin1');
  const style = `<StyleProjectItem ObjectUID="style-1" Version="1"/><StartKeyframeValue Encoding="base64" BinaryHash="h">${b.toString('base64')}</StartKeyframeValue>`;
  const r = pubsLib.styleFromFile(style);
  assert.equal(r.font, 'Inter-Bold');
  const part = Buffer.from(r.part, 'base64');
  const tail = Buffer.alloc(12); tail.writeUInt32LE(5, 0); tail.write('Salut', 4, 'utf8');
  const caption = Buffer.concat([Buffer.alloc(4), part, tail]);
  caption.writeUInt32LE(caption.length - 12, 0);
  const at = pubsLib.textStart(caption);
  assert.equal(at, 56);
  assert.equal(20 + caption.readUInt32LE(20), at); // the link now reaches the caption's words
  assert.equal(pubsLib.styleFromFile(style.replace(b.toString('base64'), Buffer.alloc(56).toString('base64'))), null); // no sample: no guess
});

test('panel caption style: Premiere names an imported style with the name written inside the file', () => {
  const file = '<Project/><StyleProjectItem ObjectUID="aaaa-1" ClassID="x" Version="1"><ProjectItem Version="1"><Name>Studio &amp; Co</Name></ProjectItem></StyleProjectItem>';
  assert.equal(pubsLib.styleName(file), 'Studio & Co'); // the file itself could be called "Studio Co final.prtextstyle"
  assert.equal(pubsLib.styleName('<Project/>'), null);
});

test('Media Encoder log: what it finished, ok or not, read from its UTF-16 log', () => {
  const log = [
    '01/02/2030 10:00:00 AM : Queue Started', '',
    ' - Source File: /tmp/a.prproj', ' - Output File: /L/S1/9x16/S1 - H1.mp4', ' - Preset Used: Match Source', '01/02/2030 10:00:20 AM : File Successfully Encoded', '',
    ' - Source File: /tmp/a.prproj', ' - Output File: /L/S1/4x5/S1 - H1 4x5.mp4', '01/02/2030 10:00:30 AM : Encoding Failed', 'The Operation was interrupted by user', '',
    ' - Output File: /L/S1/9x16/S1 - H2.mp4', ' - Preset Used: Match Source', // still rendering: no status yet
  ].join('\r\n');
  const r = pubsLib.ameRecords(pubsLib.decodeLog(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(log, 'utf16le')])));
  assert.deepEqual([...r.keys()], ['/L/S1/9x16/S1 - H1.mp4', '/L/S1/4x5/S1 - H1 4x5.mp4']);
  assert.equal(r.get('/L/S1/9x16/S1 - H1.mp4').failed, false);
  assert.equal(r.get('/L/S1/4x5/S1 - H1 4x5.mp4').failed, true);
});

test('caption text is found even when another number looks like a longer text', () => {
  // [size][style... a 0x18 that could pass for a 24-byte text ending at the blob's last byte...][5]["tu es"][\0\0\0]
  const b = Buffer.alloc(48);
  b.writeUInt32LE(b.length - 12, 0);
  b.writeUInt32LE(24, 20); // 20 + 4 + 24 = 48: a fake "text" running to the end
  b.writeUInt32LE(5, 36); b.write('tu es', 40, 'utf8');
  assert.equal(pubsLib.textStart(b), 36);
});

test('panel export: 9x16 and 4x5 trees side by side, reviews in 9x16 only', () => {
  const job = { script: 'S7', sequences: [
    { key: 'ad:a', name: 'S7 - V1 - H1 - C1', folder: ['S7', 'Variante 1', 'Corps 1'] },
    { key: 'review:V1', name: 'S7 - Full Timeline Review', folder: ['S7'] },
    { key: 'V1|H1', name: 'S7V1 - H1' },
  ] };
  assert.deepEqual(pubsLib.exportPlan(job, '/L', ['9x16', '4x5']).map((p) => [p.format, p.out]), [
    ['9x16', '/L/S7/9x16/Variante 1/Corps 1/S7 - V1 - H1 - C1.mp4'],
    ['4x5', '/L/S7/4x5/Variante 1/Corps 1/S7 - V1 - H1 - C1 4x5.mp4'],
    ['9x16', '/L/S7/S7 - Full Timeline Review.mp4'],
  ]);
  assert.deepEqual(pubsLib.exportPlan(job, '/L', ['4x5']).map((p) => p.format), ['4x5']);
});

console.log(`ads: ${n} tests OK`);
