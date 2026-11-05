// Pubs: the client's brief → scripts → one script's structure (variantes, hooks, transis, corps).
// Claude reads the script; everything it returns is copied text from the brief, never rewritten.

/** PDF (ArrayBuffer) → text, one line per visual line. pdf.js runs in the page, so nothing is installed. */
export async function pdfText(data) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
  }
  return pages.join('\n');
}

/**
 * Script sections in the brief: headings like "S7 : Noter les concurrents" (any "S<number> :" at a line start).
 * → [{ id: 'S7', title, text }]. No heading → the whole brief is one script.
 */
export function findScripts(text, fallbackId = 'Script') {
  const re = /^\s*(S\d{1,3})\s*[:–-]\s*(.+)$/gm;
  const hits = [...text.matchAll(re)];
  if (!hits.length) return [{ id: fallbackId, title: '', text: text.trim() }];
  return hits.map((m, i) => ({
    id: m[1].toUpperCase(),
    title: m[2].trim(),
    text: text.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : text.length).trim(),
  }));
}

const LINE = {
  type: 'object',
  properties: {
    who: { type: 'string', description: 'who says it, as named in the brief: the presenter, "Voix off", "Commentaire", or the testimonial person' },
    kind: { type: 'string', enum: ['spoken', 'quote'], description: 'spoken = read from the script (may be rephrased); quote = exact words to cut from a testimonial video' },
    text: { type: 'string' },
    timecode: { type: 'string', description: 'timecode given by the brief for this quote, else ""' },
  },
  required: ['who', 'kind', 'text', 'timecode'],
  additionalProperties: false,
};
const PART = {
  type: 'object',
  properties: { id: { type: 'string' }, lines: { type: 'array', items: LINE } },
  required: ['id', 'lines'],
  additionalProperties: false,
};
const SCHEMA = {
  type: 'object',
  properties: {
    script: { type: 'string' },
    title: { type: 'string' },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'V1, V2…' },
          name: { type: 'string', description: 'the variant\'s name when the brief gives one (e.g. a person), else ""' },
          hooks: { type: 'array', items: PART, description: 'Acc1, Acc2… as H1, H2…' },
          transis: { type: 'array', items: PART, description: 'transitions between hook and corps, as T1, T2… (often none)' },
          corps: { type: 'array', items: PART, description: '"Corps de pub" as C1, C2…' },
          corps_from: { type: 'string', description: 'id of the variant whose corps this one reuses when the brief says so, else ""' },
        },
        required: ['id', 'name', 'hooks', 'transis', 'corps', 'corps_from'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'instructions for the editor, copied from the brief' },
  },
  required: ['script', 'title', 'variants', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `You read one script from a client's brief for video ads and return its structure.
- Copy every text EXACTLY as written in the brief (spelling, punctuation, line breaks merged into spaces). Never rewrite, summarise or translate.
- A script has one or more variants, but ONLY when the brief writes variant headings ("Variante 1", "Variante 2", "Variante PAUL"…). No variant heading = exactly one variant V1 with name "". Several hooks, a second corps or a "reprise" of another script are never variants.
- Hooks are the "Acc"/"Accroche" items, numbered H1, H2… in the brief's order (an "Acc10 bis" becomes the next number).
- A hook can have several lines: an off-screen voice or a comment the presenter reads ("Voix off : …", "Commentaire : …") then the presenter's answer. Keep each as its own line with who = that label.
- Quotes are exact words from a testimonial video, usually in quote marks, sometimes with a timecode ("1 min 10"). Each quoted piece is its own line, kind = quote. Text after a quote in a transition is the presenter's, kind = spoken.
- "Transition vers le corps de pub" items are transis T1, T2…; "Corps de pub" / "Corps de pub 2" are corps C1, C2….
- If the brief says a variant reuses another variant's corps ("on utilisera ceux de la variante 1"), set corps_from to that variant's id and leave corps empty.
- notes: the brief's instructions to the editor ("Note monteur", "Note team"), copied.`;

/** The request for one script → { system, user, schema, name } (same shape as the Hook tab). */
export function buildBriefRequest(script) {
  return { system: SYSTEM, user: `SCRIPT ${script.id}:\n\n${script.text}`, schema: SCHEMA, name: 'ad_script' };
}

/** Claude's answer → a clean script: ids normalised, empty parts dropped, corps_from resolved. */
export function parseBriefReply(reply, scriptId) {
  const r = typeof reply === 'string' ? JSON.parse(reply) : reply;
  const clean = (parts, prefix) => (parts || [])
    .map((p) => ({ lines: (p.lines || []).filter((l) => String(l.text || '').trim()).map((l) => ({ who: String(l.who || '').trim(), kind: l.kind === 'quote' ? 'quote' : 'spoken', text: String(l.text).trim(), timecode: String(l.timecode || '').trim() })) }))
    .filter((p) => p.lines.length)
    .map((p, i) => ({ id: `${prefix}${i + 1}`, ...p }));
  const variants = (r.variants || []).map((v, i) => ({
    id: `V${i + 1}`,
    name: String(v.name || '').trim(),
    hooks: clean(v.hooks, 'H'),
    transis: clean(v.transis, 'T'),
    corps: clean(v.corps, 'C'),
    corpsFrom: String(v.corps_from || '').trim(),
  }));
  for (const v of variants) {
    if (!v.corps.length && v.corpsFrom) {
      const src = variants.find((x) => x.id === v.corpsFrom.toUpperCase().replace(/^VARIANTE\s*/, 'V')) || variants.find((x) => x.corps.length);
      if (src && src !== v) v.corpsFrom = src.id; else v.corpsFrom = '';
    } else v.corpsFrom = '';
  }
  return { script: scriptId || r.script, title: String(r.title || '').trim(), variants, notes: (r.notes || []).map(String) };
}

/** Plain text of a part, for display and matching. */
export const partText = (part) => part.lines.map((l) => l.text).join(' ');
