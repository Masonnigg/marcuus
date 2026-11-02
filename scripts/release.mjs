// Publish a new MARCUUS version. Every installed copy is locked until it updates to it.
//   1. bump "version" in package.json   2. npm run release -- "Ce qui change dans cette version"
// Steps: tests → build DMGs + update zips + light update zips → GitHub Release in the public releases repo →
// latest.json (last, so no Mac sees a version before its files exist) → tag the code repo.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { patchRoots, frozenDigest, fullDigest } = createRequire(import.meta.url)('../electron/update-files.cjs');

const RELEASES_REPO = 'Masonnigg/marcuus-releases';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const notes = process.argv.slice(2).join(' ').trim() || `MARCUUS ${version}`;
const tag = `v${version}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root }).toString().trim();

// refuse to publish the same version twice
try { out('gh', ['release', 'view', tag, '--repo', RELEASES_REPO]); console.error(`${tag} existe déjà : augmente "version" dans package.json.`); process.exit(1); } catch {}
if (out('git', ['status', '--porcelain'])) { console.error('Des changements ne sont pas commités. Commit d’abord.'); process.exit(1); }

run('npm', ['test']);
run('npm', ['run', 'dist']);

const builds = { arm64: 'release/mac-arm64/MARCUUS.app', x64: 'release/mac/MARCUUS.app' };
const files = [];
const assets = {};
for (const [arch, app] of Object.entries(builds)) {
  const zip = `release/MARCUUS-${version}-${arch}.zip`;
  const dmg = `release/MARCUUS-${version}-${arch}.dmg`;
  rmSync(join(root, zip), { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]); // keeps the app's signature and symlinks
  const buf = readFileSync(join(root, zip));
  const bundle = join(root, app);
  // light update: only the files that change between builds, next to the fingerprints that make it safe
  const stage = join(root, `release/patch-${arch}`);
  const patchZip = `release/MARCUUS-${version}-${arch}.patch.zip`;
  rmSync(stage, { recursive: true, force: true });
  rmSync(join(root, patchZip), { force: true });
  for (const r of patchRoots(bundle)) {
    mkdirSync(dirname(join(stage, r)), { recursive: true });
    run('/usr/bin/ditto', [join(bundle, r), join(stage, r)]);
  }
  run('/usr/bin/ditto', ['-c', '-k', stage, patchZip]);
  const patchBuf = readFileSync(join(root, patchZip));
  assets[arch] = {
    url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/MARCUUS-${version}-${arch}.zip`,
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: statSync(join(root, zip)).size,
    patch: {
      url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/MARCUUS-${version}-${arch}.patch.zip`,
      sha256: createHash('sha256').update(patchBuf).digest('hex'),
      size: patchBuf.length,
      base: await frozenDigest(bundle),
      full: await fullDigest(bundle),
    },
  };
  files.push(zip, patchZip);
  if (existsSync(join(root, dmg))) files.push(dmg);
}

// will Macs on the current version get the light update? (they need the same base: Electron, tools, icon…)
let previous = null;
try { previous = JSON.parse(Buffer.from(out('gh', ['api', `repos/${RELEASES_REPO}/contents/latest.json`, '-q', '.content']), 'base64').toString()); } catch {}
for (const [arch, a] of Object.entries(assets)) {
  const same = previous?.assets?.[arch]?.patch?.base === a.patch.base;
  console.log(`${arch} : ${same ? `mise à jour légère depuis ${previous.version} (${(a.patch.size / 1e6).toFixed(1)} Mo)` : `téléchargement complet (${(a.size / 1e6).toFixed(0)} Mo) : la base a changé`}`);
}

run('gh', ['release', 'create', tag, '--repo', RELEASES_REPO, '--title', `MARCUUS ${version}`, '--notes', notes, ...files]);

// latest.json goes last: installed apps only see the new version once its downloads exist
const latest = { version, notes, date: new Date().toISOString(), assets };
const body = Buffer.from(JSON.stringify(latest, null, 2) + '\n').toString('base64');
let sha = '';
try { sha = out('gh', ['api', `repos/${RELEASES_REPO}/contents/latest.json`, '-q', '.sha']); } catch {}
run('gh', ['api', '-X', 'PUT', `repos/${RELEASES_REPO}/contents/latest.json`, '-f', `message=MARCUUS ${version}`, '-f', `content=${body}`, ...(sha ? ['-f', `sha=${sha}`] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });

run('git', ['tag', '-a', tag, '-m', `MARCUUS ${version}`]);
run('git', ['push', 'origin', 'main', tag]);
console.log(`\n✓ MARCUUS ${version} publiée. Les Macs sur une version plus ancienne sont bloqués jusqu'à la mise à jour.`);
