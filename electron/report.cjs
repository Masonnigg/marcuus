// Error reports: what goes wrong on someone's Mac reaches the developer's Sentry project, with nothing personal in it.
// No SDK (Sentry's would add ~70 MB to every light update): one small JSON event per error, over HTTPS.
//  - sent: the error message and where it happened (cleaned by scrub()), the app and macOS versions, and an
//    anonymous id per installation, so Sentry can count how many Macs it happens on;
//  - never sent: file paths, file names, scripts, transcripts, e-mail addresses;
//  - Réglages › "Rapports d'erreur" turns it off. MARCUUS_SENTRY_DSN points it elsewhere (tests).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The project's DSN. A DSN only lets someone send events to the project, which is why Sentry ships it in apps.
const DSN = '';

const FILES = 'mp4|mov|m4v|mxf|mts|avi|mkv|mp3|wav|m4a|aiff?|srt|prproj|prtextstyle|pdf|docx?|rtf|odt|txt|md|json|png|jpe?g|epr';
const APP_ROOT = path.resolve(__dirname, '..'); // …/app.asar once packaged, the code folder in development

/** Text that may hold paths, file names or quoted words → the same text with them taken out. Over-cleaning is fine. */
function scrub(text, appRoot = APP_ROOT) {
  let t = String(text ?? '');
  // the app's own code keeps its place ("app:///electron/main.cjs:12:3"); anything else on disk is hidden
  t = t.split(appRoot.replace(/\.asar$/, '.asar.unpacked')).join('app://').split(appRoot).join('app://');
  t = t.replace(/(?:file:\/\/)?(?:~|\/(?:Users|Volumes|private|tmp|var|Library|Applications|opt|System|home))\/[^\n'"`«»()[\]]*/g, (m) => {
    const ext = (m.match(new RegExp(`\\.(${FILES})\\b`, 'i')) || [])[1];
    return ext ? `<fichier>.${ext.toLowerCase()}` : '<chemin>';
  });
  // a bare file name, often with a client's name in it: "Interview Paul final.mp4" → "<fichier>.mp4"
  t = t.replace(new RegExp(`(?:[^\\s/«»"'\`:<>]+ ){0,6}[^\\s/«»"'\`:<>]+\\.(${FILES})\\b`, 'gi'), (m, ext) => `<fichier>.${ext.toLowerCase()}`);
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  t = t.replace(/«[^»]*»/g, '«…»').replace(/"[^"\n]{3,}"/g, '"…"'); // quoted words: a style, a part, a script line
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
}

/** A V8 stack → Sentry frames, oldest first, file names cleaned. */
function frames(stack, appRoot = APP_ROOT) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const filename = scrub(m[2], appRoot);
    out.push({ function: m[1] || '?', filename, lineno: +m[3], colno: +m[4], in_app: filename.startsWith('app://') });
  }
  return out.reverse();
}

function parseDsn(dsn) {
  const m = String(dsn || '').match(/^(https?):\/\/([^@/]+)@([^/]+)\/(?:(.*)\/)?(\d+)\/?$/);
  return m ? { url: `${m[1]}://${m[3]}/${m[4] ? `${m[4]}/` : ''}api/${m[5]}/envelope/?sentry_key=${m[2]}&sentry_version=7`, dsn } : null;
}

/** One error → the Sentry event that is sent (also what the tests check). */
function buildEvent({ error, message, where, level = 'error', tags = {}, release, installId, system, appRoot = APP_ROOT }) {
  const event = {
    event_id: crypto.randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node', // not "javascript": Sentry would then keep the sender's IP address
    level,
    logger: where,
    release,
    environment: system.packaged ? 'production' : 'development',
    user: { id: installId },
    tags: { where, ...Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, scrub(v, appRoot).slice(0, 200)])) },
    contexts: {
      os: { name: 'macOS', version: system.macos },
      runtime: { name: 'Electron', version: system.electron },
      device: { arch: system.arch },
    },
  };
  if (error) {
    event.exception = { values: [{ type: scrub(error.name || 'Error', appRoot), value: scrub(error.message ?? error, appRoot), stacktrace: { frames: frames(error.stack, appRoot) } }] };
  } else {
    event.message = { formatted: scrub(message, appRoot) };
  }
  return event;
}

/**
 * The reporter of the running app. enabled() reads Réglages each time; fetch is Electron's net.fetch.
 * A session sends at most 30 reports, and the same error from the same place only once.
 */
function createReporter({ version, dataDir, enabled, fetch, system, dsn = process.env.MARCUUS_SENTRY_DSN || DSN }) {
  const target = parseDsn(dsn);
  const seen = new Set();
  let sent = 0;
  const installId = () => {
    const file = path.join(dataDir(), 'report-id.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).id; } catch {}
    const id = crypto.randomUUID();
    try { fs.writeFileSync(file, JSON.stringify({ id })); } catch {}
    return id;
  };
  async function send(info) {
    if (!target || !enabled()) return false;
    const key = `${info.where}|${info.error ? info.error.message : info.message}`;
    if (seen.has(key) || sent >= 30) return false;
    seen.add(key);
    sent++;
    const event = buildEvent({ ...info, release: `ryacha@${version}`, installId: installId(), system });
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    try {
      const res = await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body });
      return res.ok;
    } catch {
      return false; // offline: the error is simply not reported
    }
  }
  return {
    error: (error, where, tags) => send({ error: error instanceof Error ? error : new Error(String(error)), where, tags }),
    message: (message, where, tags, level = 'warning') => send({ message, where, tags, level }),
    active: () => !!target && enabled(),
  };
}

module.exports = { createReporter, buildEvent, scrub, frames, parseDsn };
