// 4x5: folder plan, centred crop, encoder settings, and real conversions of generated videos.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { planJobs, parseBanner, cropFor, ffmpegArgs, tmpFor } = require('../electron/fourfive.cjs');

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- crop in the middle, full width, never upscaled
check('1080×1920 → 1080×1350, centred', eq(cropFor(1080, 1920), { w: 1080, h: 1350, x: 0, y: 284 }), JSON.stringify(cropFor(1080, 1920)));
check('4K vertical keeps its resolution', eq(cropFor(2160, 3840), { w: 2160, h: 2700, x: 0, y: 570 }));
check('720×1280 → 720×900', eq(cropFor(720, 1280), { w: 720, h: 900, x: 0, y: 190 }));
check('a horizontal video loses its sides instead', eq(cropFor(1920, 1080), { w: 864, h: 1080, x: 528, y: 0 }));
check('already 4:5 → nothing to do', cropFor(1080, 1350) === null && cropFor(1080, 1352) === null);
let inside = true;
for (let w = 360; w <= 2200; w += 38) for (let h = Math.round(w * 0.65) * 2; h <= w * 2.2; h += 42) { // video frames are even
  const c = cropFor(w, h);
  if (c && (c.x + c.w > w || c.y + c.h > h || c.w % 2 || c.h % 2 || Math.abs(c.w / c.h - 0.8) > 0.01 || Math.abs(c.y - (h - c.y - c.h)) > 2)) { inside = false; console.log(w, h, c); }
}
check('any size: inside the frame, even, 4:5, centred', inside);

// ---- what ffmpeg says about a file
const cam = parseBanner(`  Duration: 00:01:14.07, start: 0.000000, bitrate: 12228 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1080x1920, 11900 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 317 kb/s (default)`);
check('a Reel export: size, 8-bit, aac', cam.width === 1080 && cam.height === 1920 && !cam.tenBit && cam.audio === 'aac' && Math.round(cam.duration) === 74070, JSON.stringify(cam));
const phone = parseBanner(`  Duration: 00:00:13.98, start: 0.000000, bitrate: 9497 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 9300 kb/s, 29.98 fps, 30 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: pcm_s16le (lpcm / 0x6D63706C), 48000 Hz, stereo, s16, 1536 kb/s (default)`);
check('iPhone HDR: upright size, 10-bit, its colours', phone.width === 1080 && phone.height === 1920 && phone.tenBit && eq(phone.color, { colorspace: 'bt2020nc', primaries: 'bt2020', trc: 'arib-std-b67' }), JSON.stringify(phone));
const mute = parseBanner(`  Duration: 00:00:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 720x1280, 30 fps`);
check('no audio track', mute.audio === null);

// ---- encoder settings
const a = ffmpegArgs('/in.mp4', '/out.mp4', cam, cropFor(1080, 1920));
const at = (args, k) => args[args.indexOf(k) + 1];
check('8-bit: x264 CRF 17, centred crop, audio copied', at(a, '-c:v') === 'libx264' && at(a, '-crf') === '17' && at(a, '-vf') === 'crop=1080:1350:0:284' && at(a, '-c:a') === 'copy' && a.includes('+faststart'));
const b = ffmpegArgs('/in.mov', '/out.mp4', phone, cropFor(1080, 1920));
check('10-bit HDR: 10-bit HEVC with its colour tags, PCM → AAC 320k', at(b, '-c:v') === 'libx265' && at(b, '-pix_fmt') === 'yuv420p10le' && at(b, '-color_trc') === 'arib-std-b67' && at(b, '-c:a') === 'aac' && at(b, '-b:a') === '320k');
const g = ffmpegArgs('/in.mp4', '/out.mp4', cam, cropFor(1080, 1920), { gpu: true });
check('GPU: Apple hardware H.264, same crop, software fallback allowed', at(g, '-c:v') === 'h264_videotoolbox' && at(g, '-q:v') === '65' && at(g, '-vf') === 'crop=1080:1350:0:284' && at(g, '-allow_sw') === '1');
const gh = ffmpegArgs('/in.mov', '/out.mp4', phone, cropFor(1080, 1920), { gpu: true });
check('GPU + HDR: hardware HEVC 10-bit with its colours', at(gh, '-c:v') === 'hevc_videotoolbox' && at(gh, '-pix_fmt') === 'p010le' && at(gh, '-profile:v') === 'main10' && at(gh, '-color_trc') === 'arib-std-b67');
check('no audio → no audio track', ffmpegArgs('/in', '/out', mute, cropFor(720, 1280)).includes('-an'));
check('written under a temporary name first', tmpFor('/a/clip 4x5.mp4') === '/a/clip 4x5.en-cours.mp4');

// ---- the folder: same tree next to it, " 4x5" names, nothing else touched
const dir = mkdtempSync(join(tmpdir(), 'fourfive-test-'));
const root = join(dir, 'DAY 5');
const put = (rel, content = 'x') => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), content); };
['A.mp4', 'B.MOV', 'notes.txt', '._A.mp4', 'sub/C.mp4', 'sub/deeper/D.mov', 'Adobe Premiere Pro Video Previews/prev.mov', '.cache/y.mp4', 'E 4x5.mp4', 'twin.mp4', 'twin.mov', 'Delivrables/clip 1.mp4'].forEach((r) => put(r));
const jobs = planJobs([root]);
const outs = jobs.map((j) => j.out.slice(dir.length + 1)).sort();
check('folder rebuilt next to it with the same subfolders', eq(outs, [
  'DAY 5 4x5/A 4x5.mp4', 'DAY 5 4x5/B 4x5.mp4', 'DAY 5 4x5/Delivrables/clip 1 4x5.mp4', 'DAY 5 4x5/sub/C 4x5.mp4',
  'DAY 5 4x5/sub/deeper/D 4x5.mp4', 'DAY 5 4x5/twin (mov) 4x5.mp4', 'DAY 5 4x5/twin (mp4) 4x5.mp4',
].sort()), outs.join(' | '));
check('Premiere previews, hidden files, text files and earlier 4x5 outputs are skipped', !jobs.some((j) => /prev|notes|\._|\.cache|E 4x5/.test(j.src)));
check('relative path shown for each video', jobs.find((j) => j.src.endsWith('D.mov')).rel === 'sub/deeper/D.mov');
mkdirSync(join(dir, 'DAY 5 4x5'), { recursive: true });
writeFileSync(join(dir, 'DAY 5 4x5', 'A 4x5.mp4'), 'done before');
check('an existing output is marked done (never overwritten)', planJobs([root]).find((j) => j.src.endsWith('A.mp4')).done);
check('dropping the output folder converts nothing', planJobs([join(dir, 'DAY 5 4x5')]).length === 0);
const single = planJobs([join(root, 'sub', 'C.mp4')]);
check('a single video: copy next to it', single.length === 1 && single[0].out === join(root, 'sub', 'C 4x5.mp4') && single[0].root === null);

// ---- real conversions
const ffmpeg = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', process.arch, 'bin', 'ffmpeg');
if (existsSync(ffmpeg)) {
  const ff = (args) => execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args]);
  const probe = (f) => parseBanner((() => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', f], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); } })());
  const convert = (src, out, opts) => { const info = probe(src); ff(ffmpegArgs(src, out, info, cropFor(info.width, info.height), opts).filter((x) => !['-nostdin', '-y'].includes(x))); return probe(out); };
  // green middle, red band above it, blue band below: after the crop only green may remain
  const src = join(dir, 'bands.mp4');
  ff(['-f', 'lavfi', '-i', 'color=green:s=1080x1920:d=1:r=30', '-f', 'lavfi', '-i', 'sine=d=1', '-vf', 'drawbox=0:0:1080:284:red:t=fill,drawbox=0:1634:1080:286:blue:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const out = join(dir, 'bands 4x5.mp4');
  const info = convert(src, out);
  check('real file: 1080×1350 with its sound', info.width === 1080 && info.height === 1350 && info.audio === 'aac', JSON.stringify(info));
  const px = execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const rgb = (row) => [...px.subarray((row * 1080 + 540) * 3, (row * 1080 + 540) * 3 + 3)];
  const green = ([r, g, bl]) => g > 100 && r < 60 && bl < 60;
  check('cropped in the exact middle: no red at the top, no blue at the bottom', green(rgb(0)) && green(rgb(675)) && green(rgb(1349)), JSON.stringify([rgb(0), rgb(1349)]));
  const gout = join(dir, 'bands gpu 4x5.mp4');
  const gi = convert(src, gout, { gpu: true });
  const gpx = execFileSync(ffmpeg, ['-v', 'error', '-i', gout, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const grgb = (row) => [...gpx.subarray((row * 1080 + 540) * 3, (row * 1080 + 540) * 3 + 3)];
  check('GPU: real file, 1080×1350, same exact middle', gi.width === 1080 && gi.height === 1350 && green(grgb(0)) && green(grgb(1349)), JSON.stringify([gi.width, gi.height, grgb(0), grgb(1349)]));
  const pcm = join(dir, 'pcm.mov');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=1:r=25', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', pcm]);
  const p2 = convert(pcm, join(dir, 'pcm 4x5.mp4'));
  check('a .mov with PCM sound → .mp4 with AAC', p2.width === 720 && p2.height === 900 && p2.audio === 'aac', JSON.stringify(p2));
  const hdr = join(dir, 'hdr.mov');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=1:r=25', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', hdr]);
  const p3 = convert(hdr, join(dir, 'hdr 4x5.mp4'));
  check('10-bit HDR stays 10-bit with its colours', p3.width === 360 && p3.height === 450 && p3.tenBit && p3.color?.trc === 'arib-std-b67', JSON.stringify(p3));
  const p4 = convert(hdr, join(dir, 'hdr gpu 4x5.mp4'), { gpu: true });
  check('GPU: 10-bit HDR stays 10-bit with its colours', p4.width === 360 && p4.height === 450 && p4.tenBit && p4.color?.trc === 'arib-std-b67', JSON.stringify(p4));
}

process.exit(fail ? 1 : 0);
