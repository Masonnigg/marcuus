// Hook finder: lines, request, and ChatGPT replies checked against the real transcript.
import { linesFromWords, buildHookRequest, parseHookReply, momentToText, fmtClock } from '../src/lib/hook.js';

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };

// words with timings: 250 ms each, a 1.2 s pause after "argent."
const say = (text, t0) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * 250, end: t0 + i * 250 + 220, p: 0.95 }));
const words = [
  ...say("Bon, aujourd'hui je vais vous parler de mon parcours.", 0),
  ...say("J'ai commencé avec zéro euro et zéro contact.", 2600),
  ...say('Personne ne croyait en moi, même pas ma famille.', 5000),
  ...say("Et l'année dernière j'ai fait 2 millions de chiffre d'affaires.", 7500),
  ...say("Le secret, c'est pas l'argent.", 10500),
  ...say("C'est la régularité, tous les jours.", 13000), // after a 1.2 s pause
];

const lines = linesFromWords(words);
check('one line per sentence', lines.length === 6, lines.map((l) => l.text).join(' | '));
check('line timings come from the words', lines[3].start === 7500 && lines[3].end === 7500 + 9 * 250 + 220, JSON.stringify(lines[3]));
check('a long run without punctuation is cut at 35 words', linesFromWords(say(Array(80).fill('mot').join(' '), 0)).every((l) => l.words.length <= 35));

const req = buildHookRequest(lines, 15000);
check('short audio asks for exactly 1 moment', /exactement 1 moment/.test(req.system));
check('lines are numbered with their time', req.user.includes('L4 [0:08] Et l\'année dernière'), req.user);
const longReq = buildHookRequest(lines, 40 * 60_000);
check('long audio asks for several different moments', /jusqu’à 5 moments/.test(longReq.system) && /jusqu’à 2 moments/.test(buildHookRequest(lines, 160_000).system)
  && /VRAIMENT DIFFÉRENTS/.test(longReq.system) && !/VRAIMENT DIFFÉRENTS/.test(req.system));
check('schema is strict-ready (no extra fields, all required)', JSON.stringify(req.schema).includes('"additionalProperties":false'));

const reply = {
  moments: [{
    title: 'De zéro à 2 millions',
    hook: { from: 4, to: 4, quote: "l'année dernière j'ai fait 2 millions de chiffre d'affaires", why: 'Un chiffre fort.' },
    body: [
      { from: 2, to: 3, summary: 'Il part de rien' },
      { from: 4, to: 4, summary: 'le hook encore' }, // dropped: it is the hook
      { from: 5, to: 6, summary: 'Le secret : la régularité' },
      { from: 40, to: 50, summary: 'lignes qui n’existent pas' }, // dropped
    ],
    headlines: ['De 0 à 2 millions', 'Personne ne croyait en lui', 'Le vrai secret', 'en trop'],
    caption: 'Il raconte comment il est passé de zéro à 2 millions.',
  }, { title: 'second moment ignored for a short clip', hook: { from: 1, to: 1, quote: 'Bon', why: '' }, body: [], headlines: [], caption: '' }],
};
const [m, extra] = parseHookReply(JSON.stringify(reply), lines, { durationMs: 15000 });
check('short clip keeps 1 moment', m && !extra);
check('hook narrowed to the quoted words', m.hook.exact && m.hook.text === "l'année dernière j'ai fait 2 millions de chiffre d'affaires." && m.hook.start === 7750, JSON.stringify(m.hook));
check('body keeps real passages in order, drops the hook and bad lines', m.body.map((b) => `${b.from}-${b.to}`).join(',') === '2-3,5-6', JSON.stringify(m.body.map((b) => [b.from, b.to])));
check('body text is the transcript, not ChatGPT', m.body[0].text.startsWith("J'ai commencé avec zéro euro") && m.body[0].label === 'Il part de rien');
check('3 headlines max', m.headlines.length === 3);
check('moment duration adds hook + body', Math.abs(m.durationMs - (m.hook.end - m.hook.start + m.body.reduce((t, b) => t + b.end - b.start, 0))) < 1);

// ChatGPT puts the hook on the wrong line: found where it really is
const moved = parseHookReply({ moments: [{ ...reply.moments[0], hook: { from: 1, to: 1, quote: "Le secret, c'est pas l'argent", why: 'x' } }] }, lines)[0];
check('hook found on its real line when line numbers are wrong', moved.hook.exact && moved.hook.from === 5, JSON.stringify(moved.hook));

// ChatGPT invents a quote: what is shown is still the real line
const invented = parseHookReply({ moments: [{ ...reply.moments[0], hook: { from: 3, to: 3, quote: 'Je suis devenu milliardaire en une nuit', why: 'x' } }] }, lines)[0];
check('invented quote never shown: real line text instead', !invented.hook.exact && invented.hook.text === 'Personne ne croyait en moi, même pas ma famille.', invented.hook.text);

check('reversed and out-of-range hook dropped', parseHookReply({ moments: [{ ...reply.moments[0], hook: { from: 90, to: 80, quote: 'x', why: '' } }] }, lines).length === 0);

// candidates: the hook is picked here from the scores, the same way every time
const cand = (from, quote, stop, clair, envie, why = '') => ({ from, to: from, quote, why, stop, clair, court: 5, envie });
const scored = (cands, hook = { from: 1, to: 1, quote: 'Bon' }, body = []) => parseHookReply({ moments: [{ ...reply.moments[0], candidates: cands, hook, body }] }, lines)[0];
const best = scored([
  cand(2, "J'ai commencé avec zéro euro et zéro contact.", 4, 5, 4), //               2×4+5+5+4 = 22
  cand(4, "l'année dernière j'ai fait 2 millions de chiffre d'affaires", 5, 4, 4, 'Gros chiffre.'), // 23
  cand(6, "C'est la régularité, tous les jours.", 3, 5, 3), //                       19
]);
check('hook = best total, not what the AI put in hook', best.hook.from === 4 && best.hook.why === 'Gros chiffre.' && best.hook.text.startsWith("l'année dernière"), JSON.stringify(best.hook));
const tie = (order) => scored(order).hook.from;
const a = cand(2, "J'ai commencé avec zéro euro et zéro contact.", 4, 4, 4); // 8 words → 2×4+4+5+4 = 21
const b = cand(5, "Le secret, c'est pas l'argent.", 4, 4, 4); //                5 words → 21, shorter
check('tie → shorter wins, whatever the order', tie([a, b]) === 5 && tie([b, a]) === 5);
const c1 = cand(2, "J'ai commencé avec zéro euro", 4, 4, 4); //            same length, earlier
const c2 = cand(3, 'Personne ne croyait en moi', 4, 4, 4); //               same length, later
check('full tie → later in the audio wins', tie([c1, c2]) === 3 && tie([c2, c1]) === 3);
check('length is counted here, not trusted from the AI', scored([
  { ...cand(2, "J'ai commencé avec zéro euro et zéro contact.", 4, 4, 4), court: 1 }, // 8 words → 5 here → 21
  cand(6, "C'est la régularité, tous les jours.", 4, 4, 3), //                          20
]).hook.from === 2);
check('a quote not in the transcript is never the hook', scored([
  cand(1, 'Je suis devenu milliardaire en une nuit', 5, 5, 5),
  cand(3, 'Personne ne croyait en moi, même pas ma famille.', 3, 5, 3),
]).hook.from === 3);
const split = scored([cand(4, "j'ai fait 2 millions", 5, 5, 5)], undefined, [{ from: 2, to: 6, summary: 'tout' }]);
check('body never repeats the hook lines', split.body.map((x) => `${x.from}-${x.to}`).join(',') === '2-3,5-6', JSON.stringify(split.body.map((x) => [x.from, x.to])));
// long audio: an earlier (better) moment owns its lines
const L = 40 * 60_000;
const mom = (cands, body, title) => ({ message: title, title, candidates: cands, hook: { from: 1, to: 1, quote: 'Bon' }, body, headlines: [], caption: '' });
const two = parseHookReply({ moments: [
  mom([cand(4, "l'année dernière j'ai fait 2 millions de chiffre d'affaires", 5, 5, 5)], [{ from: 2, to: 3, summary: 'a' }], 'A'),
  mom([cand(4, "l'année dernière j'ai fait 2 millions de chiffre d'affaires", 5, 5, 5)], [{ from: 5, to: 6, summary: 'b' }], 'B'), // same hook again
] }, lines, { durationMs: L });
check('a second moment with the same hook is dropped', two.length === 1 && two[0].title === 'A', two.map((x) => x.title).join(','));
const next = parseHookReply({ moments: [
  mom([cand(4, "l'année dernière j'ai fait 2 millions de chiffre d'affaires", 5, 5, 5)], [{ from: 2, to: 3, summary: 'a' }], 'A'),
  mom([cand(4, "l'année dernière j'ai fait 2 millions", 5, 5, 5), cand(5, "Le secret, c'est pas l'argent.", 4, 4, 4)], [{ from: 3, to: 6, summary: 'b' }], 'B'),
] }, lines, { durationMs: L });
check('a used candidate is skipped, the next best becomes the hook', next.length === 2 && next[1].hook.from === 5, JSON.stringify(next.map((x) => x.hook.from)));
check('a moment never takes lines from another one', next[1].body.map((x) => `${x.from}-${x.to}`).join(',') === '6-6', JSON.stringify(next[1].body.map((x) => [x.from, x.to])));
check('schema asks for scored candidates before the hook', JSON.stringify(req.schema).indexOf('"message"') < JSON.stringify(req.schema).indexOf('"candidates"') && JSON.stringify(req.schema).indexOf('"candidates"') < JSON.stringify(req.schema).indexOf('"hook"') && /total = 2 × stop/.test(req.system));

const txt = momentToText(m, 0);
check('copy text has hook, body, titles and caption', /HOOK \(0:08 → 0:10\)/.test(txt) && txt.includes('BODY') && txt.includes('- Le vrai secret') && txt.includes('LÉGENDE'), txt);
check('clock format', fmtClock(65_000) === '1:05' && fmtClock(3_725_000) === '1:02:05');

process.exit(fail ? 1 : 0);
