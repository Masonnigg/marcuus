import { fmtTime } from './srt.js';

const short = (ms) => fmtTime(ms).slice(3, 8); // mm:ss

export function transcriptForPrompt(cues) {
  // Group cues into lines of ~sentence length so the prompt stays compact.
  const lines = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) cur = { start: c.start, end: c.end, text: [] };
    cur.text.push(c.text.replace(/\s+/g, ' '));
    cur.end = c.end;
    if (/[.!?…]$/.test(c.text) || cur.end - cur.start > 6000) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `[${fmtTime(l.start)} → ${fmtTime(l.end)}] ${l.text.join(' ')}`).join('\n');
}

export function buildBrollPrompt(cues, opts = {}) {
  const { style = '', beatSeconds = 6, orientation = 'vertical' } = opts;
  return `Tu es un monteur vidéo expert en B-roll pour des vidéos courtes (Reels / TikTok / YouTube).
Voici la transcription horodatée d'une vidéo (souvent en français).

Découpe-la en "beats" d'environ ${beatSeconds} secondes (respecte le sens des phrases), et pour chaque beat propose un plan de B-roll concret et filmable, trouvable en VIDÉO sur des banques de stock (Pexels, Pixabay, Envato Elements). Uniquement des plans vidéo animés, pas de photos.

Règles :
- Les requêtes de recherche doivent être EN ANGLAIS, courtes (2 à 5 mots), visuelles et concrètes (sujet + action + lieu/ambiance). Pas de concepts abstraits seuls : traduis l'idée en image (ex. "succès" → "man celebrating on rooftop at sunset").
- 3 requêtes par beat, de la plus précise à la plus large.
- Format ${orientation === 'vertical' ? 'vertical 9:16' : orientation === 'horizontal' ? 'horizontal 16:9' : 'quelconque'}.
${style ? `- Direction artistique souhaitée : ${style}\n` : ''}- Réponds UNIQUEMENT avec du JSON valide, sans texte autour, avec exactement cette forme :
{"beats":[{"start":"00:00:00,140","end":"00:00:06,000","text":"phrase(s) du beat","idea":"description courte du plan en français","queries":["query one","query two","query three"]}]}

Transcription :
${transcriptForPrompt(cues)}`;
}

export function parseBrollResponse(text) {
  const raw = String(text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Aucun JSON trouvé dans la réponse.');
  const j = JSON.parse(raw.slice(start, end + 1));
  const beats = Array.isArray(j) ? j : j.beats;
  if (!Array.isArray(beats) || !beats.length) throw new Error('Le JSON ne contient pas de "beats".');
  return beats.map((b, i) => ({
    n: i + 1,
    start: String(b.start || ''),
    end: String(b.end || ''),
    text: String(b.text || ''),
    idea: String(b.idea || ''),
    queries: (b.queries || b.keywords || []).map(String).filter(Boolean).slice(0, 5),
  }));
}

export function shotListMarkdown(title, beats, picks) {
  const out = [`# Shot list B-roll — ${title}`, ''];
  for (const b of beats) {
    out.push(`## Beat ${b.n} · ${b.start.slice(3, 8)} → ${b.end.slice(3, 8)}`);
    out.push(`> ${b.text}`, '');
    out.push(`**Plan :** ${b.idea}`);
    out.push(`**Recherches :** ${b.queries.join(' · ')}`);
    const p = picks[b.n] || [];
    if (p.length) {
      out.push('', '**Sélection :**');
      for (const it of p) out.push(`- [${it.source} ${it.type}${it.duration ? ` ${it.duration}s` : ''}](${it.page}) — ${it.author || ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export { short };
