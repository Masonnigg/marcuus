// Pubs: a parsed script → every ad to build (hook × transi × corps), with the editor's naming, bins and
// export folders. Names follow the editor's own projects (one script without variants, one with):
//   bins       Imports (rushes) · S2 / Hooks · S2 / Export         · S1 / S1 V1 / Hooks · S1 / S1 V1 / Export
//   hooks      S2H1                                                 · S1V1 - H1
//   corps      S2 - Corps de Pub                                    · Variante 1 - Corps de pub
//   ads        S2 - H1 (nests S2H1 then the corps)                  · S1 - V1 - H1
//   review     S2 - Full Timeline Review (every hook, then the corps) · S1V1 - Full Timeline Review
//   exports    <deliverables>/S7/9x16/Variante 1/Corps 1/<ad>.mp4  (the 4x5 tab fills S7/4x5/… from it)
import { expand } from './cut.js';

const cap = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1).toLowerCase()}`;
const num = (id) => id.replace(/^\D+/, '');
const vtag = (v) => (v.name ? cap(v.name) : v.id); // "V1", or the person's name for a testimonial variant
const variantFolder = (v) => (v.name ? `Variante ${cap(v.name)}` : `Variante ${v.id.slice(1)}`);
const several = (script) => script.variants.length > 1;
/** The script's bin, and one sub-bin per variant when there are several ("S1 / S1 V1"). */
const homeBin = (script, v) => (several(script) ? [script.script, `${script.script} ${vtag(v)}`] : [script.script]);

/** The corps a variant uses: its own, or the ones of the variant it borrows from. */
export const corpsOf = (script, v) => (v.corps.length ? v.corps : script.variants.find((x) => x.id === v.corpsFrom)?.corps || []);

/**
 * Hook + transi pairs that say the same sentence twice (a hook quote reused as the start of a transi):
 * those ads are skipped by default. → Set of `${variantId}|${hookId}|${transiId}`.
 */
export function repeatedPairs(script) {
  const out = new Set();
  for (const v of script.variants) {
    for (const t of v.transis) {
      const tq = t.lines.filter((l) => l.kind === 'quote').map((l) => new Set(expand(l.text)));
      for (const h of v.hooks) {
        const hq = h.lines.filter((l) => l.kind === 'quote').map((l) => new Set(expand(l.text)));
        const same = hq.some((a) => tq.some((b) => {
          const common = [...a].filter((x) => b.has(x)).length;
          return a.size && b.size && common / Math.min(a.size, b.size) >= 0.6;
        }));
        if (same) out.add(`${v.id}|${h.id}|${t.id}`);
      }
    }
  }
  return out;
}

/**
 * Every ad of the script → [{ name, variant, hook, transi, corps, bin, folder, skip }]
 * skip = reason when the ad would repeat a sentence (shown, can be turned back on).
 */
export function planAds(script) {
  const repeats = repeatedPairs(script);
  const ads = [];
  for (const v of script.variants) {
    const corps = corpsOf(script, v);
    const transis = v.transis.length ? v.transis : [null];
    const cs = corps.length ? corps : [null];
    for (const t of transis) {
      for (const c of cs) {
        for (const h of v.hooks) {
          const tail = [t && `T${num(t.id)}`, c && cs.length > 1 && `C${num(c.id)}`].filter(Boolean);
          const name = [script.script, ...(several(script) ? [vtag(v)] : []), `H${num(h.id)}`, ...tail].join(' - ');
          // with several transis or corps, each combination gets its own sub-bin and export folder
          const group = t && transis.length > 1 ? `Transi ${num(t.id)}` : c && cs.length > 1 ? `Corps ${num(c.id)}` : '';
          ads.push({
            name,
            variant: v.id,
            hook: h.id,
            transi: t?.id || null,
            corps: c?.id || null,
            corpsVariant: c ? (v.corps.length ? v.id : v.corpsFrom) : null,
            bin: [...homeBin(script, v), 'Export', group].filter(Boolean),
            folder: [script.script, ...(several(script) ? [variantFolder(v)] : []), group].filter(Boolean), // under <deliverables>/<format>/…
            skip: t && repeats.has(`${v.id}|${h.id}|${t.id}`) ? `${h.id} et ${t.id} disent la même phrase` : null,
          });
        }
      }
    }
  }
  return ads;
}

/**
 * Part sequences built once and nested in every ad: hooks ("S2H1", "S1V1 - H1"), transis, corps
 * ("S2 - Corps de Pub", "Variante 1 - Corps de pub"). Captions and zooms go inside them, once.
 */
export function partSequences(script) {
  const out = [];
  const S = script.script;
  for (const v of script.variants) {
    const home = homeBin(script, v);
    const prefix = several(script) ? variantFolder(v) : S;
    for (const h of v.hooks) {
      const name = several(script) ? `${S}${vtag(v)} - H${num(h.id)}` : `${S}H${num(h.id)}`;
      out.push({ key: `${v.id}|${h.id}`, name, bin: [...home, 'Hooks'], variant: v.id, part: h.id, kind: 'hook' });
    }
    for (const t of v.transis) {
      out.push({ key: `${v.id}|${t.id}`, name: `${prefix} - Transi ${num(t.id)}`, bin: home, variant: v.id, part: t.id, kind: 'transi' });
    }
    for (const c of v.corps) {
      const name = `${prefix} - ${several(script) ? 'Corps de pub' : 'Corps de Pub'}${v.corps.length > 1 ? ` ${num(c.id)}` : ''}`;
      out.push({ key: `${v.id}|${c.id}`, name, bin: home, variant: v.id, part: c.id, kind: 'corps' });
    }
  }
  return out;
}

/** The client review sequence of a variant: every hook back to back, then each transi, then the corps. */
const reviewName = (script, v) => (several(script) ? `${script.script}${vtag(v)} - Full Timeline Review` : `${script.script} - Full Timeline Review`);

/**
 * Everything Premiere needs to build the project → the job file the RYACHA panel reads.
 * parts = matched parts (the editor's take choices already applied); live = the ads to build.
 * Clips are in seconds on each recording; a clip { seq } nests a part sequence.
 */
export function buildJob({ script, parts, live, media }) {
  const mediaIds = new Map(media.map((m, i) => [m.path, `M${i + 1}`]));
  const clipsOf = (key) => (parts[key]?.pieces || []).map((p) => ({ media: mediaIds.get(p.media), in: p.in / 1000, out: p.out / 1000 }));
  const used = new Set(live.flatMap((a) => [`${a.variant}|${a.hook}`, a.transi && `${a.variant}|${a.transi}`, a.corps && `${a.corpsVariant}|${a.corps}`]).filter(Boolean));
  const partsUsed = partSequences(script).filter((s) => used.has(s.key));
  const sequences = partsUsed.map((s) => ({ key: s.key, name: s.name, bin: s.bin, kind: s.kind, clips: clipsOf(s.key) }));
  for (const v of script.variants) {
    const mine = live.filter((a) => a.variant === v.id);
    if (!mine.length) continue;
    const keys = [...new Set([
      ...mine.map((a) => `${v.id}|${a.hook}`),
      ...mine.map((a) => a.transi && `${v.id}|${a.transi}`),
      ...mine.map((a) => a.corps && `${a.corpsVariant}|${a.corps}`),
    ].filter(Boolean))];
    sequences.push({ key: `review:${v.id}`, name: reviewName(script, v), bin: homeBin(script, v), kind: 'review', folder: [script.script], clips: keys.map((k) => ({ seq: k })) });
  }
  for (const a of live) {
    // an ad is only its parts, nested: hook, then transi and/or corps
    const clips = [{ seq: `${a.variant}|${a.hook}` }];
    if (a.transi) clips.push({ seq: `${a.variant}|${a.transi}` });
    if (a.corps) clips.push({ seq: `${a.corpsVariant}|${a.corps}` });
    sequences.push({ key: `ad:${a.name}`, name: a.name, bin: a.bin, folder: a.folder, kind: 'ad', clips });
  }
  return {
    version: 2,
    script: script.script,
    title: script.title,
    created: new Date().toISOString(),
    importBin: ['Imports'],
    media: media.map((m) => ({ id: mediaIds.get(m.path), path: m.path, name: m.name })),
    sequences,
  };
}
