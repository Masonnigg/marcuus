// Hook moment → Premiere sequence. Written as Final Cut Pro 7 XML (xmeml), which Premiere imports natively
// (Fichier › Importer, or drag the .xml into the Project panel): hook first, then the body, already cut.

export const PAD_IN = 150; // ms kept before the first word of a passage…
export const PAD_OUT = 200; // …and after its last word (word ends from Whisper tend to be early)
export const SEQ_W = 1080; // vertical Reel
export const SEQ_H = 1920;

const RATES = [[23.976, 24, true], [24, 24, false], [25, 25, false], [29.97, 30, true], [30, 30, false], [50, 50, false], [59.94, 60, true], [60, 60, false]];

/** fps read from the file (29.97, 25, 60.01…) → the nearest standard rate. No video = 25. */
export function frameRate(fps) {
  const [real, timebase, ntsc] = fps > 0 ? RATES.reduce((a, r) => (Math.abs(r[0] - fps) < Math.abs(a[0] - fps) ? r : a)) : RATES[2];
  return { timebase, ntsc, fps: ntsc ? (timebase * 1000) / 1001 : real };
}

/**
 * The moment's passages in montage order → clips in frames, back to back on the timeline.
 * Each passage keeps a margin around its words, never more than half the silence to the neighbouring word,
 * so no word is clipped and no neighbouring word sneaks in. Passages that touch in the source become one clip.
 * → { clips: [{ in, out, start, end }], frames }
 */
export function planCuts(moment, words, durationMs, rate) {
  const ws = (words || []).filter((w) => String(w.text || '').trim()).sort((a, b) => a.start - b.start);
  const total = Math.floor((durationMs / 1000) * rate.fps);
  const frame = (ms) => (ms / 1000) * rate.fps;
  const pad = (s) => {
    const first = ws.findIndex((w) => w.start >= s.start - 1);
    const last = first < 0 ? -1 : ws.findIndex((w, k) => k >= first && w.end >= s.end - 1);
    const prev = first > 0 ? ws[first - 1] : null;
    const next = last >= 0 ? ws[last + 1] : null;
    const before = Math.min(PAD_IN, prev ? Math.max(0, (s.start - prev.end) / 2) : PAD_IN);
    const after = Math.min(PAD_OUT, next ? Math.max(0, (next.start - s.end) / 2) : PAD_OUT);
    return { a: Math.max(0, s.start - before), b: Math.min(durationMs, s.end + after) };
  };
  const clips = [];
  let cursor = 0;
  for (const s of [moment.hook, ...moment.body]) {
    const { a, b } = pad(s);
    let i = Math.floor(frame(a) + 1e-6);
    const o = Math.min(total, Math.ceil(frame(b) - 1e-6));
    const last = clips.at(-1);
    if (last && i < last.out && i >= last.out - 1) i = last.out; // rounding overlap with the passage just before
    if (o <= i) continue;
    if (last && i === last.out) { last.out = o; last.end += o - i; } // continues the clip before: one clip
    else clips.push({ in: i, out: o, start: cursor, end: cursor + o - i });
    cursor += o - i;
  }
  return { clips, frames: cursor };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pathUrl = (p) => 'file://localhost' + p.split('/').map(encodeURIComponent).join('/');

/**
 * → the .xml text. media = what ffmpeg read from the file:
 * { duration (ms), video: { width, height, fps, rotation } | null, audio: { rate, channels } | null }
 */
export function premiereXml({ moment, index, words, media, path, name }) {
  const rate = frameRate(media.video?.fps);
  const { clips, frames } = planCuts(moment, words, media.duration, rate);
  const fileName = name || path.split('/').pop();
  const seqName = `${fileName.replace(/\.[^.]+$/, '')} - Hook ${index + 1}`;
  const total = Math.floor((media.duration / 1000) * rate.fps);
  const R = `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const v = media.video;
  const turned = v && Math.abs(Math.round(v.rotation || 0)) % 180 === 90; // phone footage stored sideways
  const w = v && (turned ? v.height : v.width);
  const h = v && (turned ? v.width : v.height);
  const scale = v ? Math.max(SEQ_W / w, SEQ_H / h) * 100 : 100; // fill the vertical frame
  const channels = Math.min(2, media.audio?.channels || 0);
  const sampleRate = media.audio?.rate || 48000;
  const audioChars = `<samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics>`;

  const file = `<file id="file-1"><name>${esc(fileName)}</name><pathurl>${esc(pathUrl(path))}</pathurl>${R}<duration>${total}</duration>`
    + `<media>${v ? `<video><samplecharacteristics>${R}<width>${w}</width><height>${h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : ''}`
    + `${channels ? `<audio>${audioChars}<channelcount>${channels}</channelcount></audio>` : ''}</media></file>`;
  const fileRef = (k) => (k === 0 ? file : '<file id="file-1"/>');
  const vid = (k) => `clipitem-v${k + 1}`;
  const aud = (k, t) => `clipitem-a${t + 1}-${k + 1}`;
  const links = (k) => [
    v && `<link><linkclipref>${vid(k)}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${k + 1}</clipindex></link>`,
    ...Array.from({ length: channels }, (_, t) => `<link><linkclipref>${aud(k, t)}</linkclipref><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex><clipindex>${k + 1}</clipindex><groupindex>1</groupindex></link>`),
  ].filter(Boolean).join('');
  const item = (id, c, k, extra) => `<clipitem id="${id}"${extra.attr || ''}><masterclipid>masterclip-1</masterclipid><name>${esc(fileName)}</name><enabled>TRUE</enabled>`
    + `<duration>${total}</duration>${R}<start>${c.start}</start><end>${c.end}</end><in>${c.in}</in><out>${c.out}</out>${extra.body}${links(k)}</clipitem>`;

  const motion = `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
    + `<parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale.toFixed(4)}</value></parameter></effect></filter>`;
  const videoTrack = v ? `<track>${clips.map((c, k) => item(vid(k), c, k, { body: `<alphatype>none</alphatype>${fileRef(k)}${motion}` })).join('')}</track>` : '';
  // Like Premiere's own XML export: a stereo track is written as two linked half-tracks (channel 1, channel 2)
  // that Premiere merges back into one stereo track. Without video the first audio clip carries the file definition.
  const kind = channels === 2 ? 'stereo' : 'mono';
  const audioTracks = Array.from({ length: channels }, (_, t) => `<track currentExplodedTrackIndex="${t}" totalExplodedTrackCount="${channels}" premiereTrackType="${kind === 'stereo' ? 'Stereo' : 'Mono'}">`
    + clips.map((c, k) => item(aud(k, t), c, k, {
      attr: ` premiereChannelType="${kind}"`,
      body: `${!v && t === 0 ? fileRef(k) : '<file id="file-1"/>'}<sourcetrack><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex></sourcetrack>`,
    })).join('')
    + `<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${t + 1}</outputchannelindex></track>`).join('');
  const outputs = '<outputs>' + [1, 2].map((n) => `<group><index>${n}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${n}</index></channel></group>`).join('') + '</outputs>';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    `<sequence id="sequence-1"><name>${esc(seqName)}</name><duration>${frames}</duration>${R}`,
    `<timecode>${R}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    '<media>',
    `<video><format><samplecharacteristics>${R}<width>${SEQ_W}</width><height>${SEQ_H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${videoTrack}</video>`,
    `<audio><numOutputChannels>2</numOutputChannels><format>${audioChars}</format>${outputs}${audioTracks}</audio>`,
    '</media>',
    '</sequence>',
    '</xmeml>',
    '',
  ].join('\n');
}

/** ffmpeg's banner (`ffmpeg -i file`) → { duration, video, audio } as premiereXml wants it. */
export function parseProbe(text) {
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Math.round(((+d[1] * 60 + +d[2]) * 60 + +d[3]) * 1000) : 0;
  const vl = text.split('\n').find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  const al = text.split('\n').find((l) => /Stream #.*Audio:/.test(l));
  let video = null;
  if (vl) {
    const size = vl.match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
    const fps = vl.match(/([\d.]+)\s*fps/) || vl.match(/([\d.]+)\s*tbr/);
    const rot = text.match(/rotation of (-?[\d.]+) degrees/);
    if (size) video = { width: +size[1], height: +size[2], fps: fps ? +fps[1] : 0, rotation: rot ? +rot[1] : 0 };
  }
  let audio = null;
  if (al) {
    const hz = al.match(/(\d+)\s*Hz/);
    const ch = /\bmono\b/.test(al) ? 1 : /(\d+)\s*channels/.test(al) ? +al.match(/(\d+)\s*channels/)[1] : 2;
    audio = { rate: hz ? +hz[1] : 48000, channels: ch };
  }
  return { duration, video, audio };
}
