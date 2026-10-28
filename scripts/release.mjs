// Publish a new MARCUUS version. Every installed copy is locked until it updates to it.
//   1. bump "version" in package.json   2. npm run release -- "Ce qui change dans cette version"
// Steps: tests → build DMGs + update zips → GitHub Release in the public releases repo →
// latest.json (last, so no Mac sees a version before its files exist) → tag the code repo.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assets[arch] = {
    url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/MARCUUS-${version}-${arch}.zip`,
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: statSync(join(root, zip)).size,
  };
  files.push(zip);
  if (existsSync(join(root, dmg))) files.push(dmg);
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
