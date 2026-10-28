// "Affiner avec Claude": Claude only moves caption breaks. The reply is rejected if a single
// word or punctuation mark differs from the original.

export function buildRefinePrompt(lines, target = 2) {
  return `Tu es sous-titreur professionnel pour des vidéos courtes (Reels / TikTok).
Voici des sous-titres en français, un par ligne. Re-découpe-les pour que chaque sous-titre forme un groupe de sens qui se lit d'un coup d'œil :
- ne sépare jamais un sujet de son verbe (« je veux », « qu'il change »), ni un pronom de son verbe (« je me lance »)
- ne laisse jamais en fin de ligne un article, une préposition, un possessif ou « ne » (« le / truc » est interdit)
- garde ensemble un auxiliaire et son participe (« a fait »), un verbe et son infinitif (« vais réussir »)
- garde ensemble les expressions courtes (« du coup », « parce que ») quand elles tiennent sur la ligne
- coupe de préférence après la ponctuation
- STRICTEMENT 1 à ${target} mot${target > 1 ? 's' : ''} par ligne, jamais plus (un nombre comme « 200 000 » compte pour un mot) ; si un groupe est trop long, coupe-le à l'endroit le plus naturel

RÈGLE ABSOLUE : recopie le texte à l'identique. Ne change, n'ajoute, ne supprime, ne corrige et ne déplace AUCUN mot ni aucun signe de ponctuation, même s'il y a une faute. Seuls les retours à la ligne changent.

Réponds uniquement avec les sous-titres, un par ligne, sans numéros ni texte autour.

${lines.join('\n')}`;
}

/**
 * Map Claude's lines back onto the units. Returns [start, end) groups, or throws if any word changed.
 * units: [{ text }] in order; a unit may contain spaces ("200 000"), breaks inside a unit are ignored.
 */
export function parseRefine(reply, units) {
  const lines = String(reply)
    .replace(/```[a-z]*\n?|```/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)-]\s+|[-•]\s+)/, '').trim())
    .filter(Boolean);
  const want = units.flatMap((u) => u.text.split(/\s+/));
  const got = lines.flatMap((l) => l.split(/\s+/));
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) {
    const i = want.findIndex((t, k) => t !== got[k]);
    const at = i === -1 ? Math.min(want.length, got.length) : i;
    throw new Error(`Claude a modifié le texte (« ${want.slice(at, at + 3).join(' ')} » → « ${got.slice(at, at + 3).join(' ')} »). Résultat refusé, rien n’a changé.`);
  }
  // token index → unit index, and which token positions end a unit
  const unitEnds = new Set();
  let tok = 0;
  units.forEach((u) => { tok += u.text.split(/\s+/).length; unitEnds.add(tok); });
  const breaks = [];
  tok = 0;
  for (const l of lines) { tok += l.split(/\s+/).length; if (unitEnds.has(tok)) breaks.push(tok); }
  // convert token breaks into unit groups
  const groups = [];
  let startUnit = 0;
  let t = 0;
  let breakIdx = 0;
  units.forEach((u, ui) => {
    t += u.text.split(/\s+/).length;
    if (t === breaks[breakIdx]) { groups.push([startUnit, ui + 1]); startUnit = ui + 1; breakIdx++; }
  });
  if (startUnit < units.length) groups.push([startUnit, units.length]);
  return groups;
}
