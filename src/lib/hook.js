// Hook finder: transcript lines → the AI (Claude or ChatGPT) picks the hook moment and the body of a Reel →
// checked against the real transcript. The AI answers with line numbers only; every text shown comes from
// our own transcript, so an invented quote can never reach the screen.

import { dropGhostTail } from './transcribe.js';

export const SHORT_MAX_MS = 150_000; // up to 2 min 30 = one Reel; longer = several moments

export const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** Words → numbered lines: a sentence, or a stretch cut at a long pause or after 35 words. */
export function linesFromWords(words) {
  const ws = dropGhostTail((words || []).filter((w) => String(w.text || '').trim()));
  const lines = [];
  let cur = null;
  ws.forEach((w, i) => {
    if (!cur) cur = { words: [] };
    cur.words.push({ text: String(w.text).trim(), start: w.start, end: w.end });
    const next = ws[i + 1];
    const n = cur.words.length;
    const sentenceEnd = /[.!?…]["»”]?$/.test(cur.words[n - 1].text) && n >= 3;
    const pause = next && next.start - w.end > 800 && n >= 3;
    if (!next || sentenceEnd || pause || n >= 35) { lines.push(cur); cur = null; }
  });
  return lines.map((l, i) => ({
    n: i + 1,
    start: l.words[0].start,
    end: l.words[l.words.length - 1].end,
    text: l.words.map((w) => w.text).join(' '),
    words: l.words,
  }));
}

const range = { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'integer' }, to: { type: 'integer' } } };
const score = { type: 'integer', minimum: 1, maximum: 5 };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moments'],
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // order matters: the AI writes the candidates and their scores before it picks the hook
        required: ['title', 'candidates', 'hook', 'body', 'headlines', 'caption'],
        properties: {
          title: { type: 'string', description: 'Sujet du moment en 3 à 6 mots' },
          candidates: {
            type: 'array',
            description: '4 à 6 phrases candidates pour le hook, notées avant de choisir',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'to', 'quote', 'why', 'stop', 'clair', 'court', 'envie'],
              properties: {
                ...range.properties,
                quote: { type: 'string', description: 'Copiée mot pour mot de la transcription' },
                why: { type: 'string', description: 'Pourquoi elle arrête le scroll, une phrase' },
                stop: score, clair: score, court: score, envie: score,
              },
            },
          },
          hook: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to', 'quote'],
            properties: { ...range.properties, quote: { type: 'string', description: 'La candidate gagnante, copiée mot pour mot' } },
          },
          body: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'to', 'summary'],
              properties: { ...range.properties, summary: { type: 'string', description: 'Ce qui est dit dans ce passage, 4 à 10 mots' } },
            },
          },
          headlines: { type: 'array', items: { type: 'string' }, description: '3 titres à afficher à l’écran, 3 angles différents' },
          caption: { type: 'string', description: 'Description du post, 2 à 4 phrases' },
        },
      },
    },
  },
};

/** The request for the AI: { system, user, schema, name }. */
export function buildHookRequest(lines, durationMs) {
  const short = durationMs <= SHORT_MAX_MS;
  const max = Math.min(5, Math.max(2, Math.round(durationMs / 180_000))); // ~1 Reel per 3 min of audio
  const count = short ? 'exactement 1 moment : cet audio est déjà un seul Reel, le body garde l’essentiel du clip'
    : `${max === 2 ? '2' : `entre 2 et ${max}`} moments : cet audio est long, chaque moment devient un Reel séparé de 30 à 90 secondes, sur un seul sujet, sans chevauchement entre moments, classés du hook le plus fort au moins fort`;
  const system = `Tu es le monteur d’un créateur francophone qui publie des Reels et des TikTok parlés (face caméra, business, entrepreneuriat, e-commerce, mindset). Ton travail : transformer un audio brut en Reel qui retient l’audience. Tu reçois la transcription horodatée en lignes numérotées (L1, L2…). Trouve ${count}.

MÉTHODE, à suivre dans cet ordre pour chaque moment :
1. Lis toute la transcription. Repère le résultat, le chiffre ou l’idée la plus forte.
2. candidates : relève 4 à 6 phrases réellement prononcées qui pourraient ouvrir la vidéo, chacune déjà débarrassée du superflu du début (voir 3), avec en une phrase pourquoi elle arrête le scroll. Note chacune avec ces grilles, sans arrondir à ton goût :
   - stop (arrête le scroll) : 5 = résultat impressionnant chiffré (gros montant, chiffre que peu de gens atteignent, contraste avant/après), ou détail insolite qui fait dire « quoi ? ». 4 = chiffre plus modeste ou technique (pourcentage, visites), affirmation qui contredit une idée reçue, aveu d’une erreur personnelle, avertissement direct (« tu vas te planter »). 3 = conseil clair ou opinion tranchée. 2 = constat général attendu. 1 = intro, transition, politesse.
   - clair : 5 = compréhensible seule, sujet explicite. 3 = un mot renvoie à avant (« il », « ce site », « ça ») mais l’idée se comprend. 1 = incompréhensible sans ce qui précède.
   - court : compte les mots de la citation. 6 à 15 mots = 5, 16 à 22 = 4, 23 à 30 = 3, 31 à 40 = 2, plus = 1.
   - envie : 5 = ouvre une question précise (comment ? pourquoi ? lequel ?) à laquelle la suite de l’audio répond. 3 = intéressante mais se suffit à elle-même. 1 = rien à découvrir ensuite.
3. hook : calcule pour chaque candidate total = 2 × stop + clair + court + envie, et prends le plus haut total. Égalité : la meilleure note stop, puis la plus courte, puis la plus tard dans l’audio (le résultat vient en général après le point de départ). La citation peut commencer ou finir au milieu d’une ligne pour enlever le superflu du début (« Bon », « Alors », « Ok », « Les gars », « En fait », « Du coup », « Mais en vrai », « Je ne sais pas si vous vous rendez compte ») : coupe-les, mais copie le reste mot pour mot. Le hook peut venir du milieu ou de la fin de l’audio.
4. body : les passages à garder après le hook, en plages de lignes (from, to), dans l’ordre du montage (en général l’ordre chronologique). Le body raconte une histoire complète qui tient la promesse du hook : contexte, développement, puis une fin forte (leçon, chiffre, punchline). Ne termine jamais au milieu d’une idée. Retire les répétitions, faux départs, hésitations, digressions et ce qui redit le hook. Ne remets pas les lignes du hook dans le body.
5. headlines : 3 titres à afficher à l’écran au début, chacun sous un angle différent : (a) le chiffre ou le résultat, (b) la curiosité, (c) le conseil ou l’erreur à éviter. 3 à 8 mots, français parlé, sans emoji, sans hashtag, sans point final, majuscule seulement au début. Uniquement des faits dits dans l’audio : aucune promesse inventée. Évite les mots creux (« incroyable », « secret », « astuce », « choquant ») sauf s’ils sont dits.
6. caption : 2 à 4 phrases. La première accroche dans le fil, la suivante résume ce qu’on apprend, la dernière pose une question qui donne envie de commenter. Ton naturel, sans hashtag.
7. title : le sujet du moment en 3 à 6 mots.

EXEMPLES DE HOOKS
Fort : « Il y a trois ans je vendais des coques depuis ma chambre. Aujourd’hui j’ai un entrepôt de 2 000 mètres carrés. » (avant/après + chiffre, clair seul)
Fort : « J’ai perdu 40 000 euros sur ma première boutique. » (erreur coûteuse, chiffre)
Fort : « Si tu lances ta boutique sur dix pays en même temps, tu vas te planter. » (avertissement direct)
Fort : « Pendant deux ans j’ai fait l’erreur de copier les pubs des autres. » (aveu d’erreur, envie de savoir laquelle)
Faible : « Bon, aujourd’hui je vais vous parler de mon parcours. » (intro, rien ne se passe)
Faible : « Et ça, franchement, c’est vraiment important. » (dépend du contexte, aucune info)

RÈGLES
Applique les grilles et le calcul strictement : à transcription identique, mêmes notes et même choix. Utilise uniquement les numéros de lignes fournis. N’invente aucune parole. Réponds en français.`;
  const user = `Durée : ${fmtClock(durationMs)}\n\n` + lines.map((l) => `L${l.n} [${fmtClock(l.start)}] ${l.text}`).join('\n');
  return { system, user, schema: SCHEMA, name: 'reel_hooks' };
}

// ---- reply → moments ------------------------------------------------------

const norm = (s) => s.toLocaleLowerCase('fr-FR').replace(/[’`]/g, "'").replace(/[.,!?;:…«»"“”()[\]]/g, ' ');
const tokens = (s) => norm(s).split(/[\s']+/).filter(Boolean);

/** Find the quote among the words of lines[a..b] (0-based, inclusive). → { a, i, b, j } word span, or null */
function locate(quote, lines, a, b) {
  const q = tokens(quote);
  if (!q.length) return null;
  const flat = []; // one entry per token: [line index, word index]
  for (let li = a; li <= b; li++) {
    lines[li].words.forEach((w, wi) => tokens(w.text).forEach((t) => flat.push({ t, li, wi })));
  }
  let best = null;
  for (let s = 0; s + q.length <= flat.length; s++) {
    let hit = 0;
    for (let k = 0; k < q.length; k++) if (flat[s + k].t === q[k]) hit++;
    if (!best || hit > best.hit) best = { hit, s };
  }
  if (!best || best.hit / q.length < 0.75) return null;
  const first = flat[best.s];
  const last = flat[best.s + q.length - 1];
  return { a: first.li, i: first.wi, b: last.li, j: last.wi };
}

function spanOf(lines, a, i, b, j) {
  const words = [];
  for (let li = a; li <= b; li++) {
    const ws = lines[li].words;
    words.push(...ws.slice(li === a ? i : 0, li === b ? j + 1 : ws.length));
  }
  return { from: a + 1, to: b + 1, start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.text).join(' ') };
}

const fixRange = (r, n) => {
  let from = Number(r?.from);
  let to = Number(r?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from > to) [from, to] = [to, from];
  if (to < 1 || from > n) return null;
  return { from: Math.max(1, from), to: Math.min(n, to) };
};

const countWords = (s) => tokens(s).length;
const shortScore = (n) => (n <= 15 ? 5 : n <= 22 ? 4 : n <= 30 ? 3 : n <= 40 ? 2 : 1);
const clampScore = (x) => Math.min(5, Math.max(1, Math.round(Number(x) || 1)));

/**
 * The final hook = the best-scored candidate, picked here rather than by the AI so the same scores always give
 * the same hook: total = 2 × stop + clair + court + envie (court from our own word count); ties → better stop,
 * then shorter, then later in the audio. → { ...span, exact, why } or null
 */
function bestCandidate(cands, lines) {
  const n = lines.length;
  const scored = [];
  for (const c of cands || []) {
    const r = fixRange(c, n);
    const at = r && (locate(c.quote || '', lines, r.from - 1, r.to - 1) || locate(c.quote || '', lines, 0, n - 1));
    if (!at) continue;
    const span = spanOf(lines, at.a, at.i, at.b, at.j);
    const words = countWords(span.text);
    const stop = clampScore(c.stop);
    scored.push({ span, why: String(c.why || '').trim(), stop, words, total: 2 * stop + clampScore(c.clair) + shortScore(words) + clampScore(c.envie) });
  }
  scored.sort((x, y) => y.total - x.total || y.stop - x.stop || x.words - y.words || y.span.start - x.span.start);
  return scored.length ? { ...scored[0].span, exact: true, why: scored[0].why } : null;
}

/**
 * The AI's JSON → [{ title, hook: {from,to,start,end,text,why,exact}, body: [{from,to,start,end,text,label}],
 * headlines, caption, durationMs }]. Bad line numbers are dropped; texts always come from the transcript.
 */
export function parseHookReply(reply, lines, { durationMs = Infinity } = {}) {
  const data = typeof reply === 'string' ? JSON.parse(reply) : reply;
  const n = lines.length;
  const moments = [];
  for (const m of data?.moments || []) {
    let hook = bestCandidate(m.candidates, lines);
    if (!hook) {
      const hr = fixRange(m.hook, n);
      if (!hr) continue;
      // narrow the hook to the quoted words; look elsewhere if the AI got the line numbers wrong
      const at = locate(m.hook.quote || '', lines, hr.from - 1, hr.to - 1) || locate(m.hook.quote || '', lines, 0, n - 1);
      hook = at
        ? { ...spanOf(lines, at.a, at.i, at.b, at.j), exact: true }
        : { ...spanOf(lines, hr.from - 1, 0, hr.to - 1, lines[hr.to - 1].words.length - 1), exact: false };
      hook.why = String(m.hook.why || '').trim();
    }
    const body = [];
    for (const b of m.body || []) {
      const r = fixRange(b, n);
      if (!r) continue;
      // never play the hook's lines twice: cut them out of the passage
      const parts = r.to < hook.from || r.from > hook.to ? [r] : [{ from: r.from, to: hook.from - 1 }, { from: hook.to + 1, to: r.to }];
      for (const p of parts.filter((x) => x.from <= x.to)) {
        body.push({ ...spanOf(lines, p.from - 1, 0, p.to - 1, lines[p.to - 1].words.length - 1), label: String(b.summary || '').trim() });
      }
    }
    moments.push({
      title: String(m.title || '').trim(),
      hook,
      body,
      headlines: (m.headlines || []).map((h) => String(h).trim()).filter(Boolean).slice(0, 3),
      caption: String(m.caption || '').trim(),
      durationMs: [hook, ...body].reduce((t, s) => t + (s.end - s.start), 0),
    });
  }
  return durationMs <= SHORT_MAX_MS ? moments.slice(0, 1) : moments.slice(0, 5);
}

/** A moment as plain text, for "Tout copier". */
export function momentToText(m, i) {
  const span = (s) => `${fmtClock(s.start)} → ${fmtClock(s.end)}`;
  return [
    `#${i + 1}${m.title ? ` · ${m.title}` : ''} (≈ ${Math.round(m.durationMs / 1000)} s)`,
    '',
    `HOOK (${span(m.hook)})`,
    `« ${m.hook.text} »`,
    m.hook.why ? `→ ${m.hook.why}` : null,
    '',
    'BODY',
    ...m.body.map((b, k) => `${k + 1}. ${span(b)}${b.label ? ` · ${b.label}` : ''}\n   « ${b.text} »`),
    '',
    'TITRES À L’ÉCRAN',
    ...m.headlines.map((h) => `- ${h}`),
    '',
    'LÉGENDE',
    m.caption,
  ].filter((l) => l != null).join('\n');
}
