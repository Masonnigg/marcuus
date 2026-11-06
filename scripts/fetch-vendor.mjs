// Puts the tools RYACHA ships inside the app into vendor/<arch>/bin (run automatically before `npm run dist`):
//   ffmpeg  – static build from the ffmpeg-static npm package (no Homebrew needed on the user's Mac); the Intel
//             build gets the Intel file of the same ffmpeg-static release (4x5, Pubs thumbnails, panel zooms)
//   uv      – official Astral release, used to install the transcription engine (Apple chips only: MLX)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UV_VERSION = '0.13.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'vendor', 'arm64', 'bin');
mkdirSync(bin, { recursive: true });

const ffmpeg = join(bin, 'ffmpeg');
if (!existsSync(ffmpeg)) {
  const src = createRequire(import.meta.url)('ffmpeg-static');
  const arch = execFileSync('/usr/bin/file', [src]).toString();
  if (!/arm64/.test(arch)) throw new Error(`ffmpeg-static is not arm64 (${arch.trim()}). Run npm install on an Apple Silicon Mac.`);
  copyFileSync(src, ffmpeg);
  chmodSync(ffmpeg, 0o755);
  console.log('vendor: ffmpeg copied');
}

const uv = join(bin, 'uv');
if (!existsSync(uv)) {
  const tmp = mkdtempSync(join(tmpdir(), 'uv-'));
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`;
  execFileSync('/usr/bin/curl', ['-fsSL', '-o', join(tmp, 'uv.tgz'), url]);
  execFileSync('/usr/bin/tar', ['-xzf', join(tmp, 'uv.tgz'), '-C', tmp]);
  copyFileSync(join(tmp, 'uv-aarch64-apple-darwin', 'uv'), uv);
  chmodSync(uv, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`vendor: uv ${UV_VERSION} downloaded`);
}
// Intel: ffmpeg from the release ffmpeg-static downloads from (its arm64 file is the one above, byte for byte)
const FFMPEG_X64_SHA256 = 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894';
const binX64 = join(root, 'vendor', 'x64', 'bin');
mkdirSync(binX64, { recursive: true });
const ffmpegX64 = join(binX64, 'ffmpeg');
if (!existsSync(ffmpegX64)) {
  const pkg = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('ffmpeg-static/package.json'), 'utf8'));
  const tag = pkg['ffmpeg-static']['binary-release-tag'];
  const tmp = mkdtempSync(join(tmpdir(), 'ffmpeg-x64-'));
  execFileSync('/usr/bin/curl', ['-fsSL', '-o', join(tmp, 'ffmpeg.gz'), `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-darwin-x64.gz`]);
  const buf = gunzipSync(readFileSync(join(tmp, 'ffmpeg.gz')));
  rmSync(tmp, { recursive: true, force: true });
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== FFMPEG_X64_SHA256) throw new Error(`ffmpeg Intel inattendu (${tag}, sha256 ${sha}). Vérifie-le puis mets à jour FFMPEG_X64_SHA256.`);
  writeFileSync(ffmpegX64, buf);
  chmodSync(ffmpegX64, 0o755);
  console.log(`vendor: ffmpeg Intel (${tag}) downloaded`);
}
console.log('vendor: ready');
