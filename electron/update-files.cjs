// Updates without the 160 MB download. Between two builds only MARCUUS's own code and the small launchers change
// (1.5 MB out of 410 MB): a light update ships exactly those files, so the result is byte-identical to the full
// build, signature included. Electron, ffmpeg and uv only come down when they really change.
// Used by the app (electron/main.cjs) and by the release (scripts/release.mjs).
const crypto = require('node:crypto');
const path = require('node:path');
// inside Electron, plain fs shows app.asar as a folder: fingerprints would walk into it and never match the release
const fs = process.versions.electron ? require('original-fs') : require('node:fs');

const CHUNK = 4 * 1024 * 1024;
const CONNECTIONS = 8; // GitHub's release files can crawl on one connection (~30 KB/s) and add up on several
const ATTEMPTS = 6;

/** The parts of the bundle that differ from one build to the next (paths relative to MARCUUS.app). */
function patchRoots(app) {
  const helpers = fs.readdirSync(path.join(app, 'Contents', 'Frameworks'))
    .filter((n) => / Helper( \(.+\))?\.app$/.test(n))
    .map((n) => `Contents/Frameworks/${n}`);
  return ['Contents/Info.plist', 'Contents/MacOS', 'Contents/_CodeSignature', 'Contents/Resources/app.asar', 'Contents/Resources/app.asar.unpacked', ...helpers];
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    if (name === '.DS_Store') continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** One fingerprint for a folder: names, sizes, contents, symlink targets. */
async function digest(app, skip = []) {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(app)) {
    if (skip.some((r) => rel === r || rel.startsWith(`${r}/`))) continue;
    const abs = path.join(app, rel);
    const st = fs.lstatSync(abs);
    h.update(st.isSymbolicLink() ? `${rel}\0->\0${fs.readlinkSync(abs)}\n` : `${rel}\0${st.size}\0${await sha256File(abs)}\n`);
  }
  return h.digest('hex');
}
const fullDigest = (app) => digest(app);
/** Everything a light update does not ship: must match, or the full app is needed. */
const frozenDigest = (app) => digest(app, patchRoots(app));

/** The current app + the patch's files → a new app in `dest`. `ditto(src, dest)` merges src into dest. */
async function applyPatch(app, patchDir, dest, ditto) {
  await ditto(app, dest);
  for (const r of patchRoots(dest)) fs.rmSync(path.join(dest, r), { recursive: true, force: true });
  await ditto(patchDir, dest);
}

/**
 * Downloads `url` to `dest` over several connections, in chunks kept in `cacheDir`: a slow connection only holds
 * up one chunk, a stalled one is dropped and retried, and starting again resumes where it stopped.
 * `curl(args)` runs curl and rejects on failure.
 */
async function download({ url, size, dest, cacheDir, curl, onProgress = () => {}, chunk = CHUNK, connections = CONNECTIONS, attempts = ATTEMPTS }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const count = Math.max(1, Math.ceil(size / chunk));
  const want = (i) => (i === count - 1 ? size - chunk * (count - 1) : chunk);
  const part = (i) => path.join(cacheDir, `${i}.part`);
  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
  const todo = [];
  for (let i = 0; i < count; i++) if (sizeOf(part(i)) !== want(i)) todo.push(i);

  const report = () => {
    let got = 0;
    for (let i = 0; i < count; i++) got += Math.max(0, sizeOf(part(i)), sizeOf(`${part(i)}.tmp`));
    onProgress(Math.min(got, size));
  };
  const poll = setInterval(report, 250);
  async function fetchChunk(i) {
    const from = chunk * i;
    const tmp = `${part(i)}.tmp`;
    for (let attempt = 1; ; attempt++) {
      try {
        await curl(['-fL', '--connect-timeout', '15', '--speed-limit', '2048', '--speed-time', '20', '-sS', '-r', `${from}-${from + want(i) - 1}`, '-o', tmp, url]);
        if (sizeOf(tmp) !== want(i)) throw new Error('morceau incomplet');
        fs.renameSync(tmp, part(i));
        return;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (attempt >= attempts) throw err;
      }
    }
  }
  let failure = null;
  const worker = async () => {
    while (todo.length && !failure) {
      const i = todo.shift();
      try { await fetchChunk(i); } catch (err) { failure ||= err; }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(connections, count) }, worker));
  } finally {
    clearInterval(poll);
  }
  if (failure) throw failure; // finished chunks stay in cacheDir for the next try
  report();
  fs.rmSync(dest, { force: true });
  for (let i = 0; i < count; i++) await fs.promises.appendFile(dest, await fs.promises.readFile(part(i)));
}

const removeTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });

module.exports = { patchRoots, digest, fullDigest, frozenDigest, applyPatch, download, sha256File, removeTree, CHUNK };
