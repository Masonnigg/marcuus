import { readFileSync } from 'node:fs';
import { fixSrtText, parseSrt, fixCues } from '../src/lib/srt.js';

const file = process.argv[2];
if (file) {
  const r = fixSrtText(readFileSync(file, 'utf8'));
  console.log(`${r.parsed.length} cues -> ${r.cues.length} cues, ${r.fixes.length} fixes\n`);
  for (const f of r.fixes) console.log(`[${f.type}] ${f.before.map(t=>JSON.stringify(t)).join(' | ')}  =>  ${f.after.map(t=>JSON.stringify(t)).join(' | ')}`);
  console.log('\n' + r.cues.map((c) => c.text).join(' / '));
}

// unit cases
const mk = (...texts) => texts.map((text, i) => ({ id: i + 1, start: i * 1000, end: i * 1000 + 900, text }));
const cases = [
  [['vont t', "'encourager à"], ['vont', "t'encourager à"]],
  [["c'", 'est bien'], ["c'est bien"]],
  [['ce truc', '-là.'], ['ce truc-là.']],
  [['peut-', 'être pas'], ['peut-être', 'pas']],
  [['le 1', '% du'], ['le 1%', 'du']],
  [['il a 10', '000 abonnés'], ['il a 10 000', 'abonnés']],
  [['il a 1', '500 000 vues'], ['il a 1 500 000', 'vues']],
  [['en 2020', '300 personnes'], ['en 2020', '300 personnes']],
  [['t', "'es sûr"], ["t'es sûr"]],
  [["c' est le moment-la"], ["c'est le moment-là"]],
  [['moment -là'], ['moment-là']],
  [['donne-la moi'], ['donne-la moi']],
  [['moi aujourd', "'hui j", "'ai envie"], ['moi', "aujourd'hui", "j'ai envie"]],
  [['(Transcribed by TurboScribe. Go Unlimited to remove this message.) Essayez vraiment'], ['Essayez vraiment']],
];
let fail = 0;
for (const [input, expected] of cases) {
  const out = fixCues(mk(...input)).cues.map((c) => c.text);
  const ok = JSON.stringify(out) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(out)}${ok ? '' : '  expected ' + JSON.stringify(expected)}`);
}
// timing: merged cue keeps first start + last end
const t = fixCues(mk('ce truc', '-là.')).cues[0];
console.log(t.start === 0 && t.end === 1900 ? 'ok   timing' : 'FAIL timing ' + JSON.stringify(t)); if (!(t.start===0&&t.end===1900)) fail++;
// disabling a fix
const d = fixCues(mk('vont t', "'encourager"), { disabled: new Set(['elision:1-2']) }).cues.map(c=>c.text);
console.log(JSON.stringify(d) === JSON.stringify(['vont t', "'encourager"]) ? 'ok   disable' : 'FAIL disable ' + JSON.stringify(d));
// export safety: zero-length / overlapping captions (Whisper "y a" spoken fast) must never reach Premiere
{
  const { serializeSrt: ser, parseSrt: par } = await import('../src/lib/srt.js');
  const out = par(ser([
    { start: 4140, end: 4320, text: "S'il" }, { start: 4320, end: 4320, text: 'y' }, { start: 4320, end: 4440, text: 'a' },
    { start: 4960, end: 4960, text: 'tu' }, { start: 4960, end: 5140, text: 'avais' },
  ]));
  const ok = out.every((c, i) => c.end - c.start >= 80 && (i === 0 || c.start >= out[i - 1].end));
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} export never has captions under 80 ms or overlapping → ${out.map((c) => `${c.text} ${c.end - c.start}ms`).join(', ')}`);
}
// end of audio: Whisper invents words after the speech and squeezes them into the last milliseconds
// (a real case: "Bonne soirée..." ×5 between 38.94 and 39.12 s of a 39.14 s clip). No caption may outlive the audio.
{
  const { fixTimings } = await import('../src/lib/srt.js');
  const { wordsFromWhisper, cuesFromWords } = await import('../src/lib/transcribe.js');
  const check = (name, ok, detail) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };

  const packed = fixTimings([{ start: 38660, end: 38940, text: 'non?' }, ...Array.from({ length: 6 }, (_, i) => ({ start: 39000 + i * 20, end: 39000 + i * 20, text: 'x' }))], { maxEnd: 39144 });
  check('captions pulled back inside the audio, still ≥ 80 ms, no overlap',
    packed.every((c, i) => c.end <= 39144 && c.end - c.start >= 80 && (i === 0 || c.start >= packed[i - 1].end)),
    JSON.stringify(packed.map((c) => [c.start, c.end])));

  const real = [['de', 38160, 38300], ['le', 38300, 38380], ['mettre,', 38380, 38540], ['non', 38660, 38660], ['?', 38660, 38940]];
  const ghost = [['Bonne', 38940, 38980], ['soirée...', 38980, 38980], ['Bonne', 38980, 38980], ['soirée...', 38980, 39000], ['Bonne', 39000, 39000],
    ['soirée...', 39000, 39040], ['Bonne', 39040, 39100], ['soirée...', 39100, 39100], ['Bonne', 39100, 39120], ['soirée...', 39120, 39120]];
  const asWhisper = (list, extra = {}) => ({ ...extra, words: list.map(([text, start, end]) => ({ text, start, end, p: 0.9 })) });
  const cues = cuesFromWords(wordsFromWhisper(asWhisper([...real, ...ghost])), { wordsPerCue: 1 });
  check('invented words squeezed at the end are dropped', !cues.some((c) => /soirée/i.test(c.text)) && cues.at(-1).text === 'non?', cues.map((c) => c.text).join(' / '));
  check('last caption ends with the speech', cues.at(-1).end <= 38940, JSON.stringify(cues.at(-1)));

  const after = wordsFromWhisper(asWhisper([...real, ['Merci.', 39440, 39440]], { duration: 39144 }));
  check('words after the end of the audio are dropped', after.at(-1).text === 'non?', after.map((w) => w.text).join(' '));

  // a real fast ending must stay: "s'il y a des questions."
  const fast = [["s'il", 42600, 42900], ['y', 42900, 42920], ['a', 42920, 42960], ['des', 42960, 43080], ['questions.', 43080, 43480]];
  const kept = cuesFromWords(wordsFromWhisper(asWhisper(fast)), { wordsPerCue: 2 });
  check('a real fast ending is kept', kept.map((c) => c.text).join(' ') === "s'il y a des questions.", kept.map((c) => c.text).join(' / '));
}
process.exit(fail ? 1 : 0);
