Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/lib/srt.js
var L = "A-Za-zÀ-ÖØ-öø-ÿŒœ";
var APOS = "['’]";
function fmtTime(ms) {
	const h = Math.floor(ms / 36e5);
	const m = Math.floor(ms % 36e5 / 6e4);
	const s = Math.floor(ms % 6e4 / 1e3);
	const r = ms % 1e3;
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}
/**
* Make caption timings safe for editing software: every caption lasts at least `minMs`
* (80 ms = 2 frames at 25 fps) and never overlaps the next one. Whisper sometimes gives a word
* zero length ("y a" spoken fast); Premiere merges a 0-second caption with the ones after it.
* Where speech is packed, following captions shift by a few ms and catch up at the next pause.
* closeGapMs > 0 also stretches a caption over a tiny gap so the next one doesn't flicker in.
* maxEnd (end of the speech) stops that shift from running past the end of the audio: the last
* captions are pulled back instead.
*/
function fixTimings(cues, { minMs = 80, closeGapMs = 250, maxEnd = null } = {}) {
	const out = cues.map((c) => ({
		...c,
		start: Math.max(0, Math.round(c.start)),
		end: Math.round(c.end)
	}));
	for (let i = 0; i < out.length; i++) {
		const c = out[i];
		const prev = out[i - 1];
		if (prev && c.start < prev.end) c.start = prev.end;
		if (c.end < c.start + minMs) c.end = c.start + minMs;
	}
	if (maxEnd != null) for (let i = out.length - 1; i >= 0; i--) {
		const c = out[i];
		const limit = i < out.length - 1 ? out[i + 1].start : Math.round(maxEnd);
		if (c.end <= limit) break;
		c.end = limit;
		c.start = Math.max(0, Math.min(c.start, c.end - minMs));
	}
	if (closeGapMs > 0) for (let i = 0; i < out.length - 1; i++) {
		const gap = out[i + 1].start - out[i].end;
		if (gap > 0 && gap < closeGapMs) out[i].end = out[i + 1].start;
	}
	return out;
}
function serializeSrt(cues) {
	return fixTimings(cues, { closeGapMs: 0 }).map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join("\n");
}
var tidy = (s) => s.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "").trim();
function splitLast(text) {
	const m = text.match(/^([\s\S]*?)(\S+)$/);
	return m ? [m[1].trimEnd(), m[2]] : [text, ""];
}
function splitFirst(text, re = /^(\S+)([\s\S]*)$/) {
	const m = text.match(re);
	return m ? [m[1], m[2].trimStart()] : ["", text];
}
var BOUNDARY_RULES = [
	{
		type: "elision",
		name: "Apostrophe (c'est, j'ai…)",
		apply(A, B) {
			if (!new RegExp(`^${APOS}[${L}]`).test(B)) return null;
			const [rest, last] = splitLast(A);
			if (!new RegExp(`^[${L}]{1,8}$`).test(last)) return null;
			return {
				a: rest,
				b: last + B,
				label: `${last} ${B.split(/\s/)[0]}`
			};
		}
	},
	{
		type: "elision",
		name: "Apostrophe (c'est, j'ai…)",
		apply(A, B) {
			const [rest, last] = splitLast(A);
			if (!new RegExp(`^[${L}]{1,8}${APOS}$`).test(last)) return null;
			if (!new RegExp(`^[${L}]`).test(B)) return null;
			return {
				a: rest,
				b: last + B,
				label: `${last} ${B.split(/\s/)[0]}`
			};
		}
	},
	{
		type: "hyphen",
		name: "Trait d’union (moment-là, peut-être…)",
		apply(A, B) {
			const startsWithSuffix = new RegExp(`^-[${L}]`).test(B);
			const endsWithHyphen = new RegExp(`[${L}]-$`).test(A);
			if (!startsWithSuffix && !(endsWithHyphen && new RegExp(`^[${L}]`).test(B))) return null;
			if (!new RegExp(`[${L}]-?$`).test(A)) return null;
			const [first, rest] = splitFirst(B);
			return {
				a: A + first,
				b: rest,
				label: `${splitLast(A)[1]} ${first}`
			};
		}
	},
	{
		type: "number",
		name: "Nombres (10 000, 1 500 000…)",
		apply(A, B) {
			if (!/(^|\s)\d{1,3}$/.test(A)) return null;
			const m = B.match(/^(\d{3}(?:[\s  ]\d{3})*[^\s\d]*)(?=\s|$)([\s\S]*)$/);
			if (!m) return null;
			return {
				a: `${A} ${m[1]}`,
				b: m[2].trimStart(),
				label: `${splitLast(A)[1]} ${m[1]}`
			};
		}
	},
	{
		type: "unit",
		name: "Symboles (1%, 20€…)",
		apply(A, B) {
			if (!/\d$/.test(A)) return null;
			const m = B.match(/^([%€$£][^\s]*)([\s\S]*)$/);
			if (!m) return null;
			return {
				a: A + m[1],
				b: m[2].trimStart(),
				label: `${splitLast(A)[1]} ${m[1]}`
			};
		}
	}
];
var CUE_RULES = [
	{
		type: "watermark",
		name: "Filigrane TurboScribe",
		re: /\(\s*Transcribed by TurboScribe[^)]*\)\s*/gi,
		replace: ""
	},
	{
		type: "elision",
		name: "Apostrophe (c'est, j'ai…)",
		re: new RegExp(`(^|[^${L}])([cdjlmnst]|qu|jusqu|lorsqu|puisqu|aujourd|presqu)(${APOS})\\s+(?=[${L}])`, "gi"),
		replace: "$1$2$3"
	},
	{
		type: "hyphen",
		name: "Trait d’union (moment-là, peut-être…)",
		re: new RegExp(`([${L}])\\s+-(là|ci|ce|moi|toi|lui|nous|vous|les|leur|y|en|on|il|elle|ils|elles|je|tu|être)(?![${L}])`, "g"),
		replace: "$1-$2"
	},
	{
		type: "accent",
		name: "Accent « -la » → « -là »",
		re: new RegExp(`(?<![${L}])(moment|jour|truc|chose|fois|temps|époque|heure|soir|matin|mec|type|gars|personne|année|semaine|mois|façon|manière|histoire|côté|cas|endroit|ville|vidéo|projet|business|celui|celle|ceux|celles|ci|par|au|là)-la(?![${L}])`, "gi"),
		replace: "$1-là"
	}
];
/**
* Fix a list of cues.
* @param {Array} input  parsed cues
* @param {Object} opts  { types: {elision:true,...}, disabled: Set<fixId> }
* @returns {{ cues: Array, fixes: Array }}
*/
function fixCues(input, opts = {}) {
	const types = opts.types || {};
	const disabled = opts.disabled || /* @__PURE__ */ new Set();
	const on = (t) => types[t] !== false;
	const cues = input.map((c) => ({
		...c,
		src: [c.id]
	}));
	const fixMap = /* @__PURE__ */ new Map();
	const record = (f) => {
		if (!fixMap.has(f.id)) fixMap.set(f.id, f);
	};
	const runCueRules = (only) => {
		for (const c of cues) CUE_RULES.forEach((r, ri) => {
			if (only && !only.includes(r.type)) return;
			if (!on(r.type)) return;
			const id = `${r.type}:c${c.id}:${ri}`;
			const next = tidy(c.text.replace(r.re, r.replace));
			if (next === c.text) return;
			record({
				id,
				type: r.type,
				name: r.name,
				cueIds: [c.id],
				before: [c.text],
				after: [next],
				start: c.start
			});
			if (!disabled.has(id)) c.text = next;
		});
	};
	runCueRules(["watermark"]);
	for (let i = 0; i < cues.length - 1; i++) {
		const A = cues[i];
		const B = cues[i + 1];
		for (const r of BOUNDARY_RULES) {
			if (!on(r.type)) continue;
			const res = r.apply(A.text, B.text);
			if (!res) continue;
			const id = `${r.type}:${A.id}-${B.id}`;
			const a = tidy(res.a);
			const b = tidy(res.b);
			record({
				id,
				type: r.type,
				name: r.name,
				label: res.label,
				cueIds: [A.id, B.id],
				before: [A.text, B.text],
				after: [a, b],
				start: A.start
			});
			if (disabled.has(id)) continue;
			A.text = a;
			B.text = b;
			if (!a) {
				B.start = A.start;
				B.src = [...A.src, ...B.src];
				cues.splice(i, 1);
				i = Math.max(-1, i - 2);
				break;
			}
			if (!b) {
				A.end = B.end;
				A.src = [...A.src, ...B.src];
				cues.splice(i + 1, 1);
				i = Math.max(-1, i - 1);
				break;
			}
		}
	}
	runCueRules([
		"elision",
		"hyphen",
		"accent"
	]);
	const fixes = [...fixMap.values()].sort((x, y) => x.start - y.start);
	return {
		cues: cues.filter((c) => c.text.trim()),
		fixes
	};
}
//#endregion
//#region src/lib/segment.js
var DEFAULT_EXPRESSIONS = [
	"de A à Z",
	"en fait",
	"du coup",
	"parce que",
	"tout le monde",
	"en train de",
	"par exemple",
	"c'est-à-dire",
	"à chaque fois",
	"tout le temps",
	"tout de suite",
	"en vrai",
	"au final",
	"au début",
	"à la fin",
	"d'un coup",
	"de toute façon",
	"en même temps",
	"pour la première fois",
	"il y a",
	"il n'y a",
	"qu'est-ce que",
	"est-ce que",
	"à 100 %",
	"à 100%",
	"plus que",
	"moins que",
	"tous les jours",
	"chaque jour",
	"aujourd'hui encore",
	"pas du tout",
	"du tout",
	"à fond",
	"de plus en plus",
	"de moins en moins",
	"petit à petit",
	"peu à peu",
	"au moins",
	"quand même",
	"autour de",
	"en face de",
	"à côté de",
	"grâce à",
	"près de",
	"loin de",
	"au lieu de",
	"à cause de",
	"par rapport à",
	"en dehors de",
	"au niveau de",
	"en moins de",
	"en plus de"
];
var W = {
	det: /* @__PURE__ */ new Set([
		"le",
		"la",
		"les",
		"un",
		"une",
		"des",
		"du",
		"au",
		"aux",
		"ce",
		"cet",
		"cette",
		"ces",
		"mon",
		"ma",
		"mes",
		"ton",
		"ta",
		"tes",
		"son",
		"sa",
		"ses",
		"notre",
		"nos",
		"votre",
		"vos",
		"leurs",
		"quel",
		"quelle",
		"quels",
		"quelles",
		"chaque",
		"plusieurs",
		"quelques",
		"ne"
	]),
	strong: /* @__PURE__ */ new Set([
		"à",
		"de",
		"dans",
		"pour",
		"par",
		"sur",
		"sous",
		"avec",
		"sans",
		"chez",
		"vers",
		"entre",
		"contre",
		"depuis",
		"pendant",
		"jusqu",
		"très",
		"trop",
		"si",
		"plus",
		"moins",
		"ultra",
		"super",
		"hyper",
		"tellement",
		"assez",
		"aussi",
		"parce"
	]),
	pronoun: /* @__PURE__ */ new Set([
		"je",
		"tu",
		"il",
		"elle",
		"on",
		"nous",
		"vous",
		"ils",
		"elles",
		"me",
		"te",
		"se",
		"lui",
		"leur",
		"y",
		"en"
	]),
	link: /* @__PURE__ */ new Set([
		"et",
		"ou",
		"mais",
		"que",
		"quand",
		"dont",
		"où",
		"car",
		"donc",
		"comme",
		"avant",
		"après",
		"tout",
		"toute",
		"tous",
		"toutes"
	]),
	aux: /* @__PURE__ */ new Set([
		"ai",
		"as",
		"a",
		"avons",
		"avez",
		"ont",
		"avais",
		"avait",
		"avaient",
		"suis",
		"es",
		"est",
		"sommes",
		"êtes",
		"sont",
		"étais",
		"était",
		"j'ai",
		"t'as",
		"j'avais",
		"t'avais",
		"j'étais",
		"t'étais",
		"s'est",
		"m'a",
		"t'a"
	]),
	modal: /* @__PURE__ */ new Set([
		"vais",
		"vas",
		"va",
		"allons",
		"allez",
		"vont",
		"peux",
		"peut",
		"pouvez",
		"peuvent",
		"veux",
		"veut",
		"voulez",
		"veulent",
		"dois",
		"doit",
		"devez",
		"doivent",
		"faut",
		"sais",
		"sait",
		"savez",
		"aime",
		"aimes",
		"commence",
		"arrête",
		"essaye",
		"essaie",
		"laisse",
		"fais",
		"fait",
		"j'vais",
		"j'peux"
	]),
	follow: /* @__PURE__ */ new Set([
		"pas",
		"jamais",
		"rien",
		"là",
		"aussi",
		"même"
	])
};
var PEN = {
	det: 12,
	strong: 9,
	pronoun: 11,
	link: 4,
	aux: 6,
	number: 7,
	follow: 4,
	expr: 15,
	sentence: 12,
	comma: 5,
	pause: 6,
	extraWord: 5,
	shortWord: 2
};
var norm = (t) => t.toLowerCase().replace(/[’]/g, "'").replace(/^[«"“(]+|[»"”),.!?;:…]+$/g, "");
var endsSentence$1 = (t) => /[.!?…]["»”]?$/.test(t);
var endsClause$1 = (t) => /[,;:]$/.test(t);
var PARTICIPLE = /(é|ée|és|ées|i|is|ie|it|u|us|ue|ues|ert|erte|eint|aint|oint|ait)$/;
var INFINITIVE = /(er|ir|re|oir)$/;
var SUBJECT_ELIDED = /^(qu|s|j|lorsqu|puisqu)'(il|ils|elle|elles|on)$/;
function glueAfter(word, next = "") {
	const w = norm(word);
	const nx = norm(next);
	if (W.det.has(w)) return PEN.det;
	if (W.strong.has(w)) return PEN.strong;
	if (W.pronoun.has(w) || w === "qui" || SUBJECT_ELIDED.test(w)) return PEN.pronoun;
	if (/^[a-zàâçéèêëîïôûùüÿœ]+'$/.test(w)) return PEN.strong;
	if (W.aux.has(w) && PARTICIPLE.test(nx)) return PEN.aux;
	if (W.modal.has(w) && INFINITIVE.test(nx)) return PEN.aux;
	if (/\d$/.test(w) && /^(euros?|€|%|dollars?|ans?|mois|jours?|fois|heures?|minutes?|secondes?|millions?|milliards?|personnes?|k|m)$/.test(nx)) return PEN.number;
	if (W.link.has(w)) return PEN.link;
	return 0;
}
var isFunctionWord = (t) => {
	const w = norm(t);
	return W.det.has(w) || W.strong.has(w) || W.pronoun.has(w) || W.link.has(w) || w === "qui" || w === "pas" || SUBJECT_ELIDED.test(w) || /^[a-zàâçéèêëîïôûùüÿœ]+'$/.test(w);
};
function findExpressions(units, expressions, maxWords = Infinity) {
	const toks = units.map((u) => norm(u.text));
	const spans = [];
	for (const e of expressions) {
		const ex = e.toLowerCase().replace(/[’]/g, "'").split(/\s+/).filter(Boolean);
		if (ex.length < 2) continue;
		if ((W.strong.has(ex[ex.length - 1]) || W.det.has(ex[ex.length - 1])) && ex.length + 1 > maxWords) continue;
		for (let i = 0; i + ex.length <= toks.length; i++) if (ex.every((t, k) => toks[i + k] === t)) spans.push([i, i + ex.length]);
	}
	return spans;
}
/**
* units: [{ text, start, end }] in order (a unit can hold "200 000" or "c'est").
* opts: { target: 2, maxWords, expressions: [...] } → returns an array of [start, end) unit index groups.
* maxWords = hard cap per caption (default: target, i.e. "1-2 words per line" for target 2).
*/
function segmentUnits(units, opts = {}) {
	const target = Math.max(1, opts.target ?? 2);
	const maxWords = Math.max(1, opts.maxWords ?? target);
	const hardMax = target + 1;
	const maxChars = target <= 2 ? 22 : target * 7 + 6;
	const spans = findExpressions(units, opts.expressions ?? DEFAULT_EXPRESSIONS, maxWords);
	const exprMax = Math.max(hardMax, ...spans.map(([s, e]) => e - s));
	const n = units.length;
	const crossesExpr = (b) => spans.some(([s, e]) => s < b && b < e);
	const breakCost = (b) => {
		if (b <= 0 || b >= n) return 0;
		const last = units[b - 1].text;
		let c = 0;
		if (!endsSentence$1(last) && !endsClause$1(last)) {
			const gap = units[b].start - units[b - 1].end;
			const g = glueAfter(last, units[b].text);
			c += gap > 400 ? g / 2 : g;
			if (W.follow.has(norm(units[b].text))) c += PEN.follow;
		}
		if (crossesExpr(b)) c += PEN.expr;
		if (spans.some(([, e]) => e === b)) c = Math.min(c, PEN.link);
		return c;
	};
	const groupCost = (j, i) => {
		const L = i - j;
		const light = units.slice(j, i).filter((u) => !isFunctionWord(u.text)).length <= 2;
		if (L > Math.min(maxWords, Math.max(spans.some(([s, e]) => s >= j && e <= i && e - s >= L - 1) ? exprMax : hardMax, light ? hardMax + 1 : 0))) return Infinity;
		let c = 0;
		if (L > target && light) c -= 2 * (L - target);
		const lastText = units[i - 1].text;
		const closesThought = i >= n || endsSentence$1(lastText) || endsClause$1(lastText) || units[i].start - units[i - 1].end > 400;
		if (L > target) c += PEN.extraWord * (L - target);
		if (L < target) c += PEN.shortWord * (target - L) * (closesThought ? .25 : 1);
		const chars = units.slice(j, i).reduce((s, u) => s + u.text.length + 1, -1);
		if (chars > maxChars) c += (chars - maxChars) * 1.5;
		for (let k = j; k < i - 1; k++) {
			const t = units[k].text;
			if (endsSentence$1(t)) c += PEN.sentence;
			else if (endsClause$1(t)) c += PEN.comma;
			if (units[k + 1].start - units[k].end > 500) c += PEN.pause;
		}
		return c;
	};
	const best = new Array(n + 1).fill(Infinity);
	const from = new Array(n + 1).fill(-1);
	best[0] = 0;
	for (let i = 1; i <= n; i++) for (let L = 1; L <= Math.min(exprMax, maxWords) && L <= i; L++) {
		const j = i - L;
		if (best[j] === Infinity) continue;
		const c = best[j] + groupCost(j, i) + breakCost(i);
		if (c < best[i]) {
			best[i] = c;
			from[i] = j;
		}
	}
	const groups = [];
	for (let i = n; i > 0; i = from[i]) groups.unshift([from[i], i]);
	return groups;
}
function groupsToCues(units, groups) {
	return fixTimings(groups.map(([j, i]) => ({
		start: units[j].start,
		end: units[i - 1].end,
		text: units.slice(j, i).map((u) => u.text).join(" "),
		doubt: units.slice(j, i).flatMap((u) => u.doubt || [])
	})), { maxEnd: units.length ? units[units.length - 1].end : null });
}
var isDoubtful = (u) => (u.p ?? 1) < .7 && !/^[\d\s%€$£.,:;!?…-]+$/.test(u.text);
function wordsFromWhisper(result) {
	const words = [];
	const duration = result?.duration;
	for (const w of result?.words || []) {
		const text = String(w.text || "").trim();
		if (!text || duration && w.start >= duration) continue;
		const prev = words[words.length - 1];
		if (prev && (/^[?!:;…»”"]+$/.test(text) || /^[-'’][\p{L}]/u.test(text))) {
			prev.text += text;
			prev.end = w.end;
			prev.p = Math.min(prev.p, w.p ?? 1);
			continue;
		}
		words.push({
			text,
			start: w.start,
			end: w.end,
			p: w.p ?? 1
		});
	}
	for (let i = 1; i < words.length; i++) {
		if (/^["«“]/.test(words[i].text)) {
			if (/^:$/.test(words[i - 1].text)) {
				words[i - 2] && (words[i - 2].text += ",");
				words.splice(i - 1, 1);
				i--;
			} else words[i - 1].text = words[i - 1].text.replace(/\s*:$/, ",");
		}
		if (words[i].text.match(/^["«“]\s*(.)/) && !/[.!?…]["»”]?$/.test(words[i - 1].text) && !/^(Je|I)\b/.test(words[i].text.slice(1))) words[i].text = words[i].text.replace(/^(["«“]\s*)(.)/, (_, q, c) => q + c.toLocaleLowerCase("fr-FR"));
	}
	for (let i = 2; i < words.length; i++) if (/^là[.,!?…]*$/i.test(words[i].text) && /^(ce|cet|cette|ces)$/i.test(words[i - 2].text)) {
		words[i - 1].text += "-" + words[i].text;
		words[i - 1].end = words[i].end;
		words[i - 1].p = Math.min(words[i - 1].p ?? 1, words[i].p ?? 1);
		words.splice(i, 1);
	}
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
function dropGhostTail(words) {
	let i = words.length - 1;
	while (i > 0 && words[i].start - words[i - 1].start <= 60) i--;
	const burst = words.length - i;
	return burst >= 3 && words[words.length - 1].end - words[i].start < burst * 80 ? words.slice(0, i) : words;
}
var isNumberChunk = (prev, w) => /(^|\s)\d{1,3}$/.test(prev) && /^\d{3}\b/.test(w);
var endsSentence = (t) => /[.!?…]$/.test(t);
var endsClause = (t) => /[,;:]$/.test(t);
/**
* Group words into cues.
* opts: { wordsPerCue: 2, maxChars: 18, minGapMs: 0, caps: false, punctuation: true }
*/
/** Words → caption units: number groups ("10" "000") and symbols ("1" "%") become one unit. */
function unitsFromWords(words) {
	const units = [];
	for (const w of words) {
		const prev = units[units.length - 1];
		if (prev && (isNumberChunk(prev.text, w.text) || /\d$/.test(prev.text) && /^[%€$£]/.test(w.text))) {
			prev.text += (w.text.startsWith("%") ? "" : " ") + w.text;
			prev.end = w.end;
			prev.p = Math.min(prev.p ?? 1, w.p ?? 1);
		} else units.push({ ...w });
	}
	for (const u of units) u.doubt = isDoubtful(u) ? [u.text.replace(/[.,!?;:…"«»“”]+$/g, "").replace(/^["«“]/, "")] : [];
	return units;
}
/**
* Group words into cues.
* opts: { wordsPerCue: 2, maxChars: 18, caps, punctuation, smart: true, expressions, groups }
* smart = grammar-aware splitting (segment.js); groups = explicit split (from "Affiner avec Claude").
*/
function cuesFromWords(words, opts = {}) {
	const { wordsPerCue = 2, maxChars = 18, caps = false, punctuation = true, smart = true } = opts;
	words = dropGhostTail(words);
	const units = unitsFromWords(words);
	let cues;
	if (opts.groups || smart) cues = groupsToCues(units, opts.groups || segmentUnits(units, {
		target: wordsPerCue,
		expressions: opts.expressions
	}));
	else {
		cues = [];
		let cur = null;
		const flush = () => {
			if (cur) cues.push(cur);
			cur = null;
		};
		for (const u of units) {
			const gap = cur ? u.start - cur.end : 0;
			if (cur && (cur.count >= wordsPerCue || (cur.text + " " + u.text).length > maxChars || gap > 700)) flush();
			if (!cur) cur = {
				start: u.start,
				end: u.end,
				text: u.text,
				count: 1,
				doubt: [...u.doubt]
			};
			else {
				cur.text += " " + u.text;
				cur.end = u.end;
				cur.count++;
				cur.doubt.push(...u.doubt);
			}
			if (endsSentence(u.text) || endsClause(u.text) && cur.count > 1) flush();
		}
		flush();
	}
	for (let i = 0; i < cues.length; i++) {
		const c = cues[i];
		let t = c.text.replace(/["«»“”]/g, "").replace(/\s+/g, " ").trim();
		if (!punctuation) t = t.replace(/[.,!?;:…]+(?=\s|$)/g, "");
		if (caps) t = t.toLocaleUpperCase("fr-FR");
		c.text = t;
	}
	const withIds = cues.map((c, i) => ({
		id: i + 1,
		start: Math.round(c.start),
		end: Math.round(c.end),
		text: c.text,
		doubt: c.doubt
	}));
	const speechEnd = words.length ? Math.max(...words.map((w) => w.end)) : null;
	return fixTimings(fixCues(withIds).cues.map(({ src, ...c }) => c), { maxEnd: speechEnd });
}
//#endregion
//#region src/lib/panelCaptions.js
/** The engine's transcription of a part's audio → SRT text ('' when nothing is said). opts = Transcrire's options. */
function srtFromEngine(result, opts = {}) {
	const words = wordsFromWhisper(result);
	if (!words.length) return "";
	return serializeSrt(cuesFromWords(words, opts));
}
//#endregion
exports.srtFromEngine = srtFromEngine;
