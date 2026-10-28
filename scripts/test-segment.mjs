// Regression tests for smart caption splitting.  usage: node scripts/test-segment.mjs [srt files...]
import { readFileSync } from 'node:fs';
import { fixSrtText } from '../src/lib/srt.js';
import { unitsFromCues, segmentUnits, groupsToCues, enforceLimits, joinNumberTokens, DEFAULT_EXPRESSIONS } from '../src/lib/segment.js';

// words as a reader sees them: "toi ?" = 1, "1 000 €" = 1
const wordCount = (t) => joinNumberTokens(t.split(/\s+/).filter((w) => !/^[?!:;»…]+$/.test(w))).length;

let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const split = (text, target = 2) => {
  const units = unitsFromCues([{ start: 0, end: text.split(' ').length * 300, text }]);
  return groupsToCues(units, segmentUnits(units, { target })).map((c) => c.text);
};
const has = (out, piece) => out.includes(piece);

const cases = [ // strict 1-2 words per line
  ['Je veux savoir le truc qui a vraiment changé ma vie,', ['Je veux', 'le truc', 'ma vie,']],
  ['mais tu as deux solutions.', ['tu as', 'deux solutions.']],
  ["Je dis pas qu'il change négativement,", ["qu'il change"]],
  ['passer de 13 000 euros par mois', ['13 000 euros', 'par mois']],
  ['les gens autour de moi', ['les gens', 'de moi']],
  ["j'ai arrêté de me trouver des excuses.", ["j'ai arrêté", 'des excuses.']],
];
for (const [text, pieces] of cases) {
  const out = split(text);
  check(pieces.every((p) => has(out, p)) && out.every((t) => wordCount(t) <= 2 || /\d (euros?|millions?)/.test(t)), `${JSON.stringify(text)} → ${out.join(' / ')}`);
}
// Claude-style over-long group gets re-split
const u = unitsFromCues([{ start: 0, end: 3000, text: 'le truc qui a vraiment changé' }]);
const enforced = groupsToCues(u, enforceLimits(u, [[0, u.length]], { target: 2 })).map((c) => c.text);
check(enforced.every((t) => t.split(' ').length <= 2), `enforceLimits → ${enforced.join(' / ')}`);

// stranded at the end of a line = real problem (a lone preposition line "dans / ma chambre" is the intended trade-off)
const STRONG = /^(le|la|les|un|une|des|du|au|aux|mon|ma|mes|ton|ta|tes|son|sa|ses|ne|je|tu|il|elle|on|ils|elles)$/i;
for (const f of process.argv.slice(2)) {
  const { cues } = fixSrtText(readFileSync(f, 'utf8'));
  const units = unitsFromCues(cues);
  const out = groupsToCues(units, segmentUnits(units, { target: 2 }));
  const words = (cs) => cs.map((c) => c.text).join(' ').split(/\s+/).join(' ');
  check(words(cues) === words(out), `same words · ${f.split('/').pop()}`);
  const endsOnExpression = (t) => DEFAULT_EXPRESSIONS.some((e) => t.toLowerCase().endsWith(e.toLowerCase()));
  const dangling = out.slice(0, -1).filter((c) => c.text.includes(' ') && STRONG.test(c.text.split(' ').pop()) && !endsOnExpression(c.text));
  check(!out.some((c) => /^[?!:;»…]+$/.test(c.text)), 'no line made only of punctuation');
  // with 2 words max a few dangling words are unavoidable ("et je / me rappelle"): keep them rare
  check(dangling.length <= Math.ceil(out.length * 0.08), `dangling article/preposition/subject ≤ 8% (${dangling.length}/${out.length}: ${dangling.map((c) => c.text).join(' | ') || 'none'})`);
  const over = out.filter((c) => wordCount(c.text) > 2 && !/\d (euros?|millions?)/.test(c.text));
  check(over.length === 0, `max 2 words per line (${over.map((c) => c.text).join(' | ') || 'ok'})`);
  check(out.every((c, i) => c.end > c.start && (i === 0 || c.start >= out[i - 1].start)), 'timings increase');
}
process.exit(fail ? 1 : 0);
