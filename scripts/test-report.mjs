// Error reports: nothing personal leaves the Mac. Made-up names and paths only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createReporter, buildEvent, scrub, frames, parseDsn } = createRequire(import.meta.url)('../electron/report.cjs');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✓', name); };
const ROOT = '/Applications/MARCUUS.app/Contents/Resources/app.asar';
const leaks = (s) => /Users|Volumes|Paul|Studio|Lune|dupont|\/tmp\//i.test(s);

await test('paths and file names are taken out, the app’s own code keeps its place', () => {
  const t = scrub(`ENOENT: no such file or directory, open '/Users/paul/Desktop/Studio Lune/S3 - Interview Paul final.mp4'`, ROOT);
  assert.equal(t, `ENOENT: no such file or directory, open '<fichier>.mp4'`);
  assert.equal(scrub('Pas le droit de modifier /Volumes/Studio Lune/Rushes', ROOT), 'Pas le droit de modifier <chemin>');
  assert.equal(scrub(`${ROOT}/electron/main.cjs:12:3`, ROOT), 'app:///electron/main.cjs:12:3');
  assert.equal(scrub(`${ROOT}.unpacked/premiere/panel.js`, ROOT), 'app:///premiere/panel.js');
  assert.equal(scrub('✗ Interview Paul final.mp4 : Media Encoder ne l’a pas reçu', ROOT), '<fichier>.mp4 : Media Encoder ne l’a pas reçu'); // cleaning too much is fine
  assert.equal(scrub('Réponse de paul.dupont@studio.fr', ROOT), 'Réponse de <email>');
  assert.equal(scrub('Citation introuvable : « Le soleil se couche sur la mer et on rentre »', ROOT), 'Citation introuvable : «…»');
  assert.equal(scrub('Le style « Lune titres » n’est pas dans le projet', ROOT), 'Le style «…» n’est pas dans le projet');
  assert.ok(scrub('x'.repeat(900)).length <= 501);
});

await test('a stack → Sentry frames, oldest first, only the app’s files in clear', () => {
  const f = frames(`Error: boom\n    at readJob (${ROOT}/electron/main.cjs:40:9)\n    at /Users/paul/Studio Lune/tool.js:3:1\n    at async Promise.all (index 0)`, ROOT);
  assert.deepEqual(f.map((x) => [x.filename, x.function, x.in_app]), [['<chemin>', '?', false], ['app:///electron/main.cjs', 'readJob', true]]);
});

await test('the event: error, where, versions, an anonymous id — nothing from the files', () => {
  const err = new Error(`Brief illisible : /Users/paul/Studio Lune/brief Paul.pdf`);
  err.stack = `Error: Brief illisible : /Users/paul/Studio Lune/brief Paul.pdf\n    at load (${ROOT}/electron/main.cjs:5:1)`;
  const e = buildEvent({ error: err, where: 'ads:readBrief', tags: { tab: 'pubs' }, release: 'ryacha@9.9.9', installId: 'abc', system: { macos: '15.1', electron: '44.7.0', arch: 'arm64', packaged: true }, appRoot: ROOT });
  assert.equal(e.exception.values[0].value, 'Brief illisible : <fichier>.pdf');
  assert.equal(e.platform, 'node'); // a "javascript" event would make Sentry keep the sender's IP address
  assert.deepEqual(e.user, { id: 'abc' });
  assert.equal(e.tags.where, 'ads:readBrief');
  assert.ok(!leaks(JSON.stringify(e)), JSON.stringify(e));
});

await test('DSN → envelope URL (sentry.io and a self-hosted path)', () => {
  assert.equal(parseDsn('https://k3y@o12.ingest.sentry.io/345').url, 'https://o12.ingest.sentry.io/api/345/envelope/?sentry_key=k3y&sentry_version=7');
  assert.equal(parseDsn('http://k@127.0.0.1:9911/sub/7').url, 'http://127.0.0.1:9911/sub/api/7/envelope/?sentry_key=k&sentry_version=7');
  assert.equal(parseDsn(''), null);
});

await test('sending: off in Réglages = nothing sent; the same error once; a stable id per installation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryacha-report-'));
  const posts = [];
  let on = false;
  const r = createReporter({
    version: '9.9.9', dataDir: () => dir, enabled: () => on, dsn: 'https://k@o1.ingest.sentry.io/2',
    fetch: async (url, opts) => { posts.push({ url, body: opts.body }); return { ok: true }; },
    system: { macos: '15.1', electron: '44.7.0', arch: 'arm64', packaged: true },
  });
  await r.error(new Error('un'), 'app');
  assert.equal(posts.length, 0);
  on = true;
  await r.error(new Error('un'), 'app');
  await r.error(new Error('un'), 'app');
  await r.message('deux', 'écran:pubs');
  assert.equal(posts.length, 2);
  const [head, item, event] = posts[0].body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(item.type, 'event');
  assert.equal(head.event_id, event.event_id);
  assert.equal(event.release, 'ryacha@9.9.9');
  assert.equal(JSON.parse(posts[1].body.trim().split('\n')[2]).user.id, event.user.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`report: ${n} tests OK`);
