// 4x5 tab: vertical videos → 4:5 (1080×1920 → 1080×1350), cropped in the middle, full width, never upscaled.
// A dropped folder is rebuilt next to it as "<folder> 4x5" with the same subfolders; each video becomes
// "<name> 4x5.mp4". Deliverables trees are the exception: a video under a "9x16" folder goes to the same place
// under "4x5" (S7/9x16/Variante 1/… → S7/4x5/Variante 1/…), so a whole batch folder can be dropped at once. x264 CRF 17 (SSIM 0.997 on a real Reel, about half the original size), audio copied as is.
// "Rapide" uses the Mac's hardware encoder: twice as fast, same quality on most clips, sometimes ~15 % bigger.
const fs = require('node:fs');
const path = require('node:path');

const LABEL = ' 4x5';
const VIDEO_RE = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|m2ts)$/i;
// Premiere's previews and auto-saves live next to the deliverables: never worth converting
const SKIP_DIR_RE = /^(\.|Adobe Premiere Pro |__MACOSX$)/;
const AUDIO_COPY = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3', 'opus']); // can stay as is in an .mp4

const NINE = /^9x16$/i;
const FOUR = /^4x5$/i;
/** "…/S7/9x16/Variante 1" → "…/S7/4x5/Variante 1", or null outside a 9x16 tree. */
function swap916(dir) {
  const parts = dir.split(path.sep);
  const i = parts.map((p) => NINE.test(p)).lastIndexOf(true);
  return i < 0 ? null : [...parts.slice(0, i), '4x5', ...parts.slice(i + 1)].join(path.sep);
}

const isVideo = (name) => VIDEO_RE.test(name) && !name.startsWith('._');
const stem = (name) => name.replace(/\.[^.]+$/, '');

/**
 * Dropped files and folders → [{ src, out, rel, root, done }]. A folder's videos go to "<folder> 4x5/<same subfolders>",
 * a single video next to itself. Outputs of an earlier run (names ending in " 4x5") are not converted again.
 */
function planJobs(paths) {
  const jobs = [];
  const seen = new Set();
  const add = (src, outDir, rel, root) => {
    if (seen.has(src)) return;
    seen.add(src);
    jobs.push({ src, outDir, rel, root });
  };
  const walk = (dir, root, outRoot) => {
    for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))) {
      const p = path.join(dir, name);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) { if (!SKIP_DIR_RE.test(name) && !name.endsWith(LABEL) && !FOUR.test(name)) walk(p, root, outRoot); continue; }
      if (isVideo(name) && !stem(name).endsWith(LABEL)) add(p, swap916(dir) || path.join(outRoot, path.relative(root, dir)), path.relative(root, p), root);
    }
  };
  for (const p of paths) {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, p, `${p}${LABEL}`);
    else if (isVideo(path.basename(p)) && !stem(path.basename(p)).endsWith(LABEL)) add(p, swap916(path.dirname(p)) || path.dirname(p), path.basename(p), null);
  }
  // clip.mp4 and clip.mov in the same folder must not both become "clip 4x5.mp4"
  const count = new Map();
  for (const j of jobs) { const k = path.join(j.outDir, stem(path.basename(j.src))); count.set(k, (count.get(k) || 0) + 1); }
  return jobs.map(({ src, outDir, rel, root }) => {
    const base = stem(path.basename(src));
    const twin = count.get(path.join(outDir, base)) > 1;
    const out = path.join(outDir, `${base}${twin ? ` (${path.extname(src).slice(1).toLowerCase()})` : ''}${LABEL}.mp4`);
    return { src, out, rel, root, paired: !!swap916(path.dirname(src)), done: fs.existsSync(out) };
  });
}

/** ffmpeg's banner → what the conversion needs. */
function parseBanner(text) {
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? ((+d[1] * 60 + +d[2]) * 60 + +d[3]) * 1000 : 0;
  const vl = text.split('\n').find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l)) || '';
  const al = text.split('\n').find((l) => /Stream #.*Audio:/.test(l)) || '';
  const size = vl.match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
  const rot = text.match(/rotation of (-?[\d.]+) degrees/);
  const turned = rot && Math.abs(Math.round(+rot[1])) % 180 === 90; // ffmpeg turns phone footage upright when decoding
  const pix = vl.match(/Video: [^,]+, (\w+)(?:\(([^)]*)\))?/);
  const colors = (pix?.[2] || '').split(',').map((s) => s.trim()).find((s) => s.includes('/')) || '';
  const [colorspace, primaries, trc] = colors.split('/');
  return {
    duration,
    width: size ? +size[turned ? 2 : 1] : 0,
    height: size ? +size[turned ? 1 : 2] : 0,
    tenBit: /p10|p12/.test(pix?.[1] || ''),
    color: colorspace ? { colorspace, primaries: primaries || colorspace, trc: trc || primaries || colorspace } : null,
    audio: al ? (al.match(/Audio: (\w+)/) || [])[1] || '' : null,
  };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
// 4:2:0 video needs even offsets: an odd centre (1920 − 1350 = 570 → 285) goes 1 px up, as ffmpeg itself would
const evenDown = (n) => Math.max(0, Math.floor(n / 2) * 2);
/** The 4:5 window in the middle of the frame, or null when the video is already 4:5. */
function cropFor(width, height) {
  if (!width || !height) return null;
  if (Math.abs(width * 5 - height * 4) <= 10) return null;
  if (width * 5 < height * 4) { // taller than 4:5 (9:16): keep the full width, cut top and bottom
    const h = even(width * 5 / 4);
    return { w: even(width - 1), h, x: 0, y: evenDown((height - h) / 2) };
  }
  const w = even(height * 4 / 5); // wider than 4:5: cut the sides
  return { w, h: even(height - 1), x: evenDown((width - w) / 2), y: 0 };
}

/** The ffmpeg command for one video. `tmp` is renamed to the real name once complete. gpu = Apple's hardware encoder. */
function ffmpegArgs(src, tmp, info, crop, { gpu = false } = {}) {
  const colors = info.color ? ['-colorspace', info.color.colorspace, '-color_primaries', info.color.primaries, '-color_trc', info.color.trc] : [];
  const hw = ['-allow_sw', '1']; // falls back to software where there is no hardware encoder
  const video = info.tenBit
    // HDR / 10-bit phone footage: 8-bit H.264 would wash it out, keep 10 bits and the colour tags
    ? (gpu ? ['-c:v', 'hevc_videotoolbox', '-q:v', '65', '-profile:v', 'main10', '-pix_fmt', 'p010le', ...hw]
      : ['-c:v', 'libx265', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'])
      .concat(['-tag:v', 'hvc1', ...colors])
    : gpu ? ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-pix_fmt', 'yuv420p', ...hw]
    : ['-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
  const audio = info.audio == null ? ['-an'] : AUDIO_COPY.has(info.audio) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '320k'];
  return [
    '-nostdin', '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
    ...video,
    ...audio,
    '-fps_mode', 'passthrough', '-map_metadata', '0', '-movflags', '+faststart',
    tmp,
  ];
}

const tmpFor = (out) => out.replace(/\.mp4$/, '.en-cours.mp4');

module.exports = { planJobs, parseBanner, cropFor, ffmpegArgs, tmpFor, LABEL };
