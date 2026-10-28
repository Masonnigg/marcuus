// Puts the tools MARCUUS ships inside the app into vendor/arm64/bin (run automatically before `npm run dist`):
//   ffmpeg  – static build from the ffmpeg-static npm package (no Homebrew needed on the user's Mac)
//   uv      – official Astral release, used to install the transcription engine
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
console.log('vendor: ready');
