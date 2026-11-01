// Light updates and the multi-connection download, with real ditto and curl against a local server.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { patchRoots, frozenDigest, fullDigest, applyPatch, download, sha256File } = require('../electron/update-files.cjs');
const run = promisify(execFile);

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };
const dir = mkdtempSync(join(tmpdir(), 'update-test-'));

// ---- a small fake MARCUUS.app
const put = (root, rel, content) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), content); };
function makeApp(name, version, { framework = 'electron-1', asar = `code ${version}` } = {}) {
  const app = join(dir, name, 'MARCUUS.app');
  put(app, 'Contents/Info.plist', `plist ${version}`);
  put(app, 'Contents/MacOS/MARCUUS', `exe ${version}`);
  put(app, 'Contents/_CodeSignature/CodeResources', `seal ${version}`);
  put(app, 'Contents/Resources/app.asar', asar);
  put(app, `Contents/Resources/app.asar.unpacked/electron/engine/${version}.py`, 'print()');
  put(app, 'Contents/Resources/bin/ffmpeg', 'ffmpeg');
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', framework);
  symlinkSync('Versions/A/Electron Framework', join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  put(app, 'Contents/Frameworks/MARCUUS Helper.app/Contents/Info.plist', `helper ${version}`);
  put(app, 'Contents/Frameworks/MARCUUS Helper (GPU).app/Contents/MacOS/MARCUUS Helper (GPU)', `gpu ${version}`);
  return app;
}
const dittoMerge = (src, dest) => run('/usr/bin/ditto', [src, dest]);

const oldApp = makeApp('old', '1.0.10');
const newApp = makeApp('new', '1.0.11');
check('the files that change between builds are in the patch, Electron and tools are not', (() => {
  const r = patchRoots(oldApp);
  return r.includes('Contents/Resources/app.asar') && r.includes('Contents/MacOS') && r.includes('Contents/Frameworks/MARCUUS Helper (GPU).app')
    && !r.some((x) => x.includes('Electron Framework') || x.includes('/bin'));
})(), patchRoots(oldApp).join(' | '));
check('two builds with the same Electron and tools have the same base', await frozenDigest(oldApp) === await frozenDigest(newApp));
check('but not the same content', await fullDigest(oldApp) !== await fullDigest(newApp));
const otherElectron = makeApp('other', '1.0.11', { framework: 'electron-2' });
check('another Electron → another base (the full app is needed)', await frozenDigest(oldApp) !== await frozenDigest(otherElectron));

const stage = join(dir, 'stage');
for (const r of patchRoots(newApp)) { mkdirSync(dirname(join(stage, r)), { recursive: true }); await run('/usr/bin/ditto', [join(newApp, r), join(stage, r)]); }
const result = join(dir, 'result', 'MARCUUS.app');
await applyPatch(oldApp, stage, result, dittoMerge);
check('old app + patch = byte-identical to the new build', await fullDigest(result) === await fullDigest(newApp));
check('files gone from the new version are gone', !existsSync(join(result, 'Contents/Resources/app.asar.unpacked/electron/engine/1.0.10.py')) && existsSync(join(result, 'Contents/Resources/app.asar.unpacked/electron/engine/1.0.11.py')));
check('the app it was made from is untouched', readFileSync(join(oldApp, 'Contents/Info.plist'), 'utf8') === 'plist 1.0.10');

// ---- the download, against a server with byte ranges
const file = randomBytes(23 * 1024 * 1024 + 321);
const sha = createHash('sha256').update(file).digest('hex');
const srv = { active: 0, peak: 0, requests: 0, failNext: 0, ignoreRange: false, stall: null };
const server = createServer((req, res) => {
  srv.requests++;
  srv.active++; srv.peak = Math.max(srv.peak, srv.active);
  res.on('close', () => { srv.active--; });
  if (srv.failNext > 0) { srv.failNext--; res.writeHead(503); res.end(); return; }
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (!m || srv.ignoreRange) { res.writeHead(200, { 'Content-Length': file.length }); res.end(file); return; }
  const [from, to] = [+m[1], +m[2]];
  if (srv.stall === from) { srv.stall = null; res.writeHead(206); res.write(file.subarray(from, from + 10)); return; } // hangs up on nobody: a dead connection
  setTimeout(() => { res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${file.length}`, 'Content-Length': to - from + 1 }); res.end(file.subarray(from, to + 1)); }, 30);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/MARCUUS.zip`;
const curl = (args) => run('/usr/bin/curl', args, { maxBuffer: 1 << 20 });
const seen = [];
const dest = join(dir, 'a.zip');
const cacheDir = join(dir, 'cache');
await download({ url, size: file.length, dest, cacheDir, curl, onProgress: (g) => seen.push(g) });
check('all the bytes, in order', await sha256File(dest) === sha);
check('several connections at once', srv.peak >= 4 && srv.peak <= 8, `peak ${srv.peak}`);
check('progress ends at 100 %', seen.at(-1) === file.length, seen.at(-1));

srv.failNext = 3;
const dest2 = join(dir, 'b.zip');
await download({ url, size: file.length, dest: dest2, cacheDir: join(dir, 'cache2'), curl });
check('server errors are retried', await sha256File(dest2) === sha);

// resume: stop half way, start again, only the rest is fetched
const cache3 = join(dir, 'cache3');
srv.failNext = 1e9;
let stopped = false;
try { await download({ url, size: file.length, dest: join(dir, 'c.zip'), cacheDir: cache3, curl, attempts: 1 }); } catch { stopped = true; }
srv.failNext = 0;
mkdirSync(cache3, { recursive: true });
writeFileSync(join(cache3, '0.part'), file.subarray(0, 4 * 1024 * 1024));
writeFileSync(join(cache3, '1.part'), file.subarray(4 * 1024 * 1024, 8 * 1024 * 1024));
srv.requests = 0;
await download({ url, size: file.length, dest: join(dir, 'c.zip'), cacheDir: cache3, curl });
check('a failed download stops, then resumes without the chunks it has', stopped && srv.requests === 4 && await sha256File(join(dir, 'c.zip')) === sha, `requests ${srv.requests}`);

// a server that ignores byte ranges must not produce a wrong file
srv.ignoreRange = true;
let refused = false;
try { await download({ url, size: file.length, dest: join(dir, 'd.zip'), cacheDir: join(dir, 'cache4'), curl, attempts: 1 }); } catch { refused = true; }
srv.ignoreRange = false;
check('a chunk of the wrong size is refused', refused && !existsSync(join(dir, 'd.zip')));

check('a small file is one chunk', await (async () => {
  const small = join(dir, 'small');
  await download({ url, size: 1000, dest: small, cacheDir: join(dir, 'cache5'), curl });
  return statSync(small).size === 1000 && readdirSync(join(dir, 'cache5')).length === 1;
})());

server.closeAllConnections();
server.close();
process.exit(fail ? 1 : 0);
