// RYACHA panel, plain logic (no Premiere, no files): zooms per cut and where each ad is exported.
// Zooms follow zoomi lia hna la7malidik exactly (its "Moderate" rhythm, Jump style): every shot gets a
// zoom that holds until the next cut, alternating a lighter and a full zoom, so the cut hides the jump.
// The layers carry zoomi's names, so either tool recognises (and replaces) the other's zooms.

const LAYER = 'zoomi zoom'; // name of each zoom on the timeline
const STRENGTH = 0.75; // zoomi "Moderate": the lighter zoom is 75 % of Max zoom

/** zoomi's adjustment layer name for a sequence size (one layer item per size in the project). */
const layerName = (width, height) => `zoomi layer ${width}x${height}`;

/**
 * An adjustment layer only covers its own frame size, so the bundled 1920×1080 template is rewritten
 * to the sequence size (a .prproj is gzipped XML with the size in plain text). Same as zoomi.
 */
function resizeTemplate(xml, width, height) {
  const base = 'Adjustment Layer';
  return xml
    .replace(/<FrameRect>0,0,\d+,\d+<\/FrameRect>/g, `<FrameRect>0,0,${width},${height}</FrameRect>`)
    .replace(/(<MZ\.Sequence\.PreviewFrameSizeWidth>)\d+/g, `$1${width}`)
    .replace(/(<MZ\.Sequence\.PreviewFrameSizeHeight>)\d+/g, `$1${height}`)
    .split(`<Name>${base}</Name>`).join(`<Name>${layerName(width, height)}</Name>`)
    .split(`<ClipName>${base}</ClipName>`).join(`<ClipName>${layerName(width, height)}</ClipName>`);
}

/**
 * Cuts on the footage track → one zoom per shot. clips = [{ start, end }] seconds on V1 (zoomi layers and
 * anything past `end` ignored); end = where zooming stops (the nested corps in an ad, or the sequence end).
 * → [{ start, end, scale }], scale in % (zoomi rounds to 0.1).
 */
function zoomsFor(clips, end, fps, { maxZoom = 138 } = {}) {
  const frame = 1 / fps;
  const snap = (t) => Math.round(t * fps) / fps;
  const times = new Set();
  for (const c of clips) {
    if (c.name === LAYER) continue;
    for (const t of [c.start, c.end]) if (t < end - frame / 2) times.add(snap(Math.max(0, t)));
  }
  const starts = [...times].sort((a, b) => a - b);
  if (!starts.length) return [];
  const light = Math.round((100 + (maxZoom - 100) * STRENGTH) * 10) / 10;
  return starts.map((t, i) => ({
    start: t,
    end: i + 1 < starts.length ? starts[i + 1] : snap(end),
    scale: i % 2 ? maxZoom : light, // zoomi: the first shot light, the next full, and so on
  })).filter((z) => z.end - z.start >= frame / 2);
}

/**
 * Every file step 4 can export → [{ index, name, kind, format, out }], where each ad goes:
 *   9x16  <root>/<script>/9x16/<Variante …>/<Corps …|Transi …>/<ad>.mp4
 *   4x5   <root>/<script>/4x5/<Variante …>/<Corps …|Transi …>/<ad> 4x5.mp4   (its own 1080x1350 sequence)
 * A Full Timeline Review is for the client, not a deliverable: 9x16 only, at <root>/<script>/<review>.mp4.
 * formats = which of '9x16' / '4x5' to plan.
 */
function exportPlan(job, root, formats = ['9x16']) {
  const clean = (s) => String(s).replace(/[/:]/g, '-');
  const out = [];
  job.sequences.forEach((s, index) => {
    const key = String(s.key);
    const kind = key.startsWith('ad:') ? 'ad' : key.startsWith('review:') ? 'review' : null;
    if (!kind) return;
    const [script, ...rest] = s.folder && s.folder.length ? s.folder : [job.script];
    if (kind === 'review') {
      if (formats.includes('9x16')) out.push({ index, name: s.name, kind, format: '9x16', review: true, out: [root, clean(script), `${clean(s.name)}.mp4`].join('/') });
      return;
    }
    for (const format of ['9x16', '4x5']) {
      if (!formats.includes(format)) continue;
      const file = format === '4x5' ? `${clean(s.name)} 4x5.mp4` : `${clean(s.name)}.mp4`;
      out.push({ index, name: s.name, kind, format, review: false, out: [root, clean(script), format, ...rest.map(clean), file].join('/') });
    }
  });
  return out;
}

/**
 * The ffmpeg filter that shows a source frame the way the clip sits in the sequence (its Motion values), for the
 * anchor picker. Same as zoomi: exporting from Premiere would show zooms already on the timeline.
 * info = { scale, scaleWidth, uniform, x, y, anchorX, anchorY, fit } from pubs_playhead.
 */
function frameFilter(info, width, height) {
  const round = (v) => Math.round(v * 100000) / 100000;
  const fit = info.fit ? `*min(${width}/iw,${height}/ih)` : '';
  const hs = round(info.scale / 100);
  const ws = info.uniform ? hs : round(info.scaleWidth / 100);
  return [
    `color=c=black:s=${width}x${height}[frame]`,
    `[0:v]scale=w='iw*${ws}${fit}':h='ih*${hs}${fit}'[clip]`,
    `[frame][clip]overlay=x='${round(info.x * width)}-${round(info.anchorX)}*overlay_w':y='${round(info.y * height)}-${round(info.anchorY)}*overlay_h':shortest=1,format=yuvj420p`,
  ].join(';');
}

/**
 * Which clips make cuts, and where the zoom layer goes, from the tracks table: tracks = [[clips]] per video track,
 * zoom = indexes of the zoomed tracks, ignored = indexes whose clip edges are not cuts (default: all but V1).
 * → { clips, layerTrack }.
 */
function cutsAndLayer(tracks, zoom, ignored) {
  const z = zoom && zoom.length ? zoom : [0];
  const skip = new Set(ignored || tracks.map((_, i) => i).filter((i) => i > 0));
  const clips = tracks.flatMap((list, i) => (skip.has(i) ? [] : list));
  return { clips, layerTrack: Math.max(...z) + 1 };
}

// ---------- caption style ----------
// Premiere's scripts can't set a caption style, but a saved project says it, in two places:
//  - each caption track: the style's data (CaptionDataTemplateStyle) and a link to the style item (ParentStyle);
//  - each caption: one binary blob = [size][style part][text]. Every caption styled the same way carries the same
//    style part, whatever its words, so one caption Premiere styled is enough to style all the others.
// The .prtextstyle file stores the style in another layout, so the style part is learned from a styled caption.

const unescapeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const BINARY = /<(\w+) Encoding="base64" BinaryHash="([^"]+)"(?:\/>|>\s*([^<]*?)\s*<\/\1>)/g;

/** Every object of a project by ObjectID / ObjectUID → { tag, start, end } (end after its closing tag). */
function indexObjects(xml) {
  const byId = new Map(), byUid = new Map();
  for (const m of xml.matchAll(/<(\w+) (ObjectID|ObjectUID)="([^"]+)"[^>]*>/g)) {
    const close = `</${m[1]}>`;
    const end = xml.indexOf(close, m.index);
    if (end < 0) continue;
    (m[2] === 'ObjectID' ? byId : byUid).set(m[3], { tag: m[1], start: m.index, end: end + close.length });
  }
  return { byId, byUid, text: (o) => (o ? xml.slice(o.start, o.end) : '') };
}

/** Caption tracks of the named sequences → [{ uid, blocks: [Block ObjectID] }]. */
function captionTracks(xml, idx, names) {
  const want = new Set(names);
  const out = [];
  for (const m of xml.matchAll(/<Sequence ObjectUID="[^"]+"[^>]*>([\s\S]*?)<\/Sequence>/g)) {
    const name = (m[1].match(/<Name>([^<]*)<\/Name>/) || [])[1];
    if (name === undefined || !want.has(unescapeXml(name))) continue;
    for (const g of m[1].matchAll(/<Second ObjectRef="(\d+)"\/>/g)) {
      const group = idx.byId.get(g[1]);
      if (!group || group.tag !== 'DataTrackGroup') continue;
      for (const t of idx.text(group).matchAll(/<Track Index="\d+" ObjectURef="([^"]+)"\/>/g)) {
        const track = idx.byUid.get(t[1]);
        if (!track || track.tag !== 'CaptionDataClipTrack') continue;
        const blocks = [];
        for (const it of idx.text(track).matchAll(/<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g)) {
          for (const b of idx.text(idx.byId.get(it[1])).matchAll(/<BlockVectorItem Index="\d+" ObjectRef="(\d+)"\/>/g)) blocks.push(b[1]);
        }
        out.push({ uid: t[1], name: unescapeXml(name), blocks });
      }
    }
  }
  return out;
}

/**
 * A caption blob → where its text starts ([u32 length][utf-8][\0][padding] at the very end, 4-byte aligned), or -1.
 * The shortest text that fits wins: other numbers in the blob can look like a longer one by chance.
 */
function textStart(b) {
  for (const aligned of [true, false]) { // Premiere's own blobs are aligned; an unaligned one is only accepted after
    for (let n = 1; n < b.length - 8; n++) {
      for (let pad = 0; pad < 4; pad++) {
        const nul = b.length - 1 - pad;
        const p = nul - n - 4;
        if (p < 4 || (aligned && p % 4) || b.readUInt32LE(p) !== n) continue;
        if (b.subarray(nul).some((c) => c !== 0) || b.subarray(p + 4, nul).includes(0)) continue;
        return p;
      }
    }
  }
  return -1;
}

/** The font PostScript names written in a style or caption blob ("Montserrat-Bold"). */
const fontsIn = (b) => (b.toString('latin1').match(/[A-Z][A-Za-z0-9]+-[A-Za-z0-9]+/g) || []);
/** The .prtextstyle file → { uid, data (base64), font }. */
function readStyleFile(styleXml) {
  const uid = (styleXml.match(/<StyleProjectItem ObjectUID="([^"]+)"/) || [])[1];
  const data = ((styleXml.match(/<StartKeyframeValue Encoding="base64"[^>]*>([^<]+)</) || [])[1] || '').trim();
  if (!uid || !data) throw new Error('Fichier de style illisible.');
  return { uid, data, font: fontsIn(Buffer.from(data, 'base64'))[0] || null };
}

/**
 * A caption Premiere already styled with this style, in any of the named sequences → its style part (base64) and
 * the track's style data hash, or null. A caption counts when its font is the style's font.
 */
function learnStyle(xml, styleXml, names) {
  const style = readStyleFile(styleXml);
  if (!style.font) return null;
  const idx = indexObjects(xml);
  const blobs = new Map();
  for (const m of xml.matchAll(BINARY)) if (m[3]) blobs.set(m[2], Buffer.from(m[3], 'base64'));
  const seen = new Map();
  for (const t of captionTracks(xml, idx, names)) {
    for (const id of t.blocks) {
      const h = (idx.text(idx.byId.get(id)).match(/BinaryHash="([^"]+)"/) || [])[1];
      const b = h && blobs.get(h);
      const p = b ? textStart(b) : -1;
      if (p < 0 || !fontsIn(b.subarray(0, p)).includes(style.font)) continue;
      const part = b.subarray(4, p).toString('base64');
      seen.set(part, (seen.get(part) || 0) + 1);
    }
  }
  if (!seen.size) return null;
  const part = [...seen].sort((a, b) => b[1] - a[1])[0][0];
  return { uid: style.uid, font: style.font, part };
}

/**
 * A style already in the project, by name → the same text as a .prtextstyle needs here (its id and its data),
 * or null. Its data is a parameter of the style item's component, written once and referenced by hash elsewhere.
 */
function styleFromProject(xml, name) {
  const idx = indexObjects(xml);
  for (const m of xml.matchAll(/<StyleProjectItem ObjectUID="([^"]+)"[^>]*>([\s\S]*?)<\/StyleProjectItem>/g)) {
    const own = (m[2].match(/<Name>([^<]*)<\/Name>/) || [])[1];
    if (own === undefined || unescapeXml(own) !== name) continue;
    const comp = idx.text(idx.byId.get((m[2].match(/<Component ObjectRef="(\d+)"\/>/) || [])[1]));
    for (const r of comp.matchAll(/<Param Index="\d+" ObjectRef="(\d+)"\/>/g)) {
      const h = (idx.text(idx.byId.get(r[1])).match(/<StartKeyframeValue Encoding="base64" BinaryHash="([^"]+)"/) || [])[1];
      if (!h) continue;
      const data = (xml.match(new RegExp(`BinaryHash="${h}">\\s*([^<]+?)\\s*<`)) || [])[1];
      if (data) return `<StyleProjectItem ObjectUID="${m[1]}"/><StartKeyframeValue Encoding="base64" BinaryHash="${h}">${data}</StartKeyframeValue>`;
    }
  }
  return null;
}

/**
 * The caption look straight from the .prtextstyle, with no caption styled by hand: the style's data is the same
 * kind of record as a caption's, with a sample text ("Aa") where a caption has its words. The record is kept as it
 * is and the link that points to the sample is pointed past its end, where each caption's words are added.
 * → { uid, font, part } like learnStyle, or null when the sample text can't be found.
 */
function styleFromFile(styleXml) {
  const style = readStyleFile(styleXml);
  const b = Buffer.from(style.data, 'base64');
  if (b.length % 4 || b.length < 16) return null;
  // the sample: a [u32 length]["Aa"][\0] string, with exactly one link (a forward offset) pointing at it
  let link = -1;
  for (let p = 12; p + 7 <= b.length; p += 4) {
    if (b.readUInt32LE(p) !== 2 || b.toString('latin1', p + 4, p + 6) !== 'Aa' || b[p + 6] !== 0) continue;
    const from = [];
    for (let q = 12; q + 4 < p; q += 4) if (q + b.readUInt32LE(q) === p) from.push(q); // (the word right before can read 4 by chance)
    if (from.length === 1) { link = from[0]; break; }
  }
  if (link < 0) return null;
  const base = Buffer.from(b);
  base.writeUInt32LE(base.length - link, link); // the words go right after the record
  return { uid: style.uid, font: style.font, part: base.subarray(4).toString('base64'), fromFile: true };
}

/** A hash in Premiere's shape for new binary data (Premiere computes its own when it saves). */
function newHash(buf) {
  const h = require('crypto').createHash('md5').update(buf).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 24)}${buf.length.toString(16).padStart(8, '0')}`;
}

/**
 * Styles the captions of the named sequences: their tracks get the style link and data, and when the style part is
 * known (learned from a caption Premiere styled), every caption gets it too, with its own words kept.
 * → { xml, tracks, captions }. Binary data stays the way Premiere writes it: the first use carries it, later
 * ones point to it by hash.
 */
function styleCaptionTracks(xml, styleXml, names, learned) {
  const style = readStyleFile(styleXml);
  if (!xml.includes(`<StyleProjectItem ObjectUID="${style.uid}"`)) throw new Error('Le style n’est pas encore dans le projet.');
  const idx = indexObjects(xml);
  const blobs = new Map();
  for (const m of xml.matchAll(BINARY)) if (m[3]) blobs.set(m[2], Buffer.from(m[3], 'base64'));
  const tracks = captionTracks(xml, idx, names);
  const trackIds = new Set(tracks.map((t) => t.uid));
  const blockIds = new Set(tracks.flatMap((t) => t.blocks));
  const part = learned && learned.uid === style.uid ? Buffer.from(learned.part, 'base64') : null;
  const tplHash = newHash(Buffer.from(style.data, 'base64'));
  blobs.set(tplHash, Buffer.from(style.data, 'base64'));
  let captions = 0;
  // rewrite the objects in place, from the end so earlier positions stay valid
  const edits = [];
  for (const uid of trackIds) {
    const o = idx.byUid.get(uid);
    const t = idx.text(o)
      .replace(/\s*<ParentStyle ObjectURef="[^"]+"\/>/, '')
      .replace(/<CaptionDataTemplateStyle Encoding="base64" BinaryHash="[^"]+"(?:\/>|>[^<]*<\/CaptionDataTemplateStyle>)/,
        `<CaptionDataTemplateStyle Encoding="base64" BinaryHash="${tplHash}"/>\n\t\t<ParentStyle ObjectURef="${style.uid}"/>`);
    edits.push([o.start, o.end, t]);
  }
  if (part) {
    for (const id of blockIds) {
      const o = idx.byId.get(id);
      const t = idx.text(o);
      const h = (t.match(/<FormattedTextData Encoding="base64" BinaryHash="([^"]+)"/) || [])[1];
      const b = h && blobs.get(h);
      const p = b ? textStart(b) : -1;
      if (p < 0) continue;
      const tail = b.subarray(p);
      const nb = Buffer.alloc(4 + part.length + tail.length);
      nb.writeUInt32LE(nb.length - 12, 0);
      part.copy(nb, 4);
      tail.copy(nb, 4 + part.length);
      const nh = newHash(nb);
      blobs.set(nh, nb);
      edits.push([o.start, o.end, t.replace(/<FormattedTextData Encoding="base64" BinaryHash="[^"]+"(?:\/>|>[^<]*<\/FormattedTextData>)/, `<FormattedTextData Encoding="base64" BinaryHash="${nh}"/>`)]);
      captions++;
    }
  }
  let out = xml;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + t + out.slice(b);
  // the first element of each hash carries the data, the others point to it
  const written = new Set();
  out = out.replace(BINARY, (all, tag, h) => {
    const data = blobs.get(h);
    if (!data) return all;
    if (written.has(h)) return `<${tag} Encoding="base64" BinaryHash="${h}"/>`;
    written.add(h);
    return `<${tag} Encoding="base64" BinaryHash="${h}">${data.toString('base64')}</${tag}>`;
  });
  return { xml: out, tracks: tracks.length, captions };
}

module.exports = { LAYER, STRENGTH, layerName, resizeTemplate, zoomsFor, frameFilter, cutsAndLayer, exportPlan, styleCaptionTracks, learnStyle, styleFromFile, styleFromProject, readStyleFile, textStart };
