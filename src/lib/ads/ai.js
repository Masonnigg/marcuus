// Pubs: one AI request with the engine picked in the Pubs tab (adsEngine), else the one set in Réglages.
import { kit } from '../kit.js';
import { hookEngineOf } from '../hook.js';

const ENGINES = { claude: 'Claude', chatgpt: 'ChatGPT', openai: 'Clé OpenAI' };
export const engineLabel = (id) => ENGINES[id] || id;

/** Which AIs this Mac can use right now → ['claude', 'chatgpt', 'openai'] (connected ones only). */
export async function availableEngines() {
  const s = (await kit.store.get('settings', {})) || {};
  const [claude, chatgpt] = await Promise.all([kit.claude.status().catch(() => null), kit.chatgpt.status().catch(() => null)]);
  return [
    claude?.loggedIn && 'claude',
    chatgpt?.signedIn && chatgpt.planUsage !== false && 'chatgpt',
    s?.keys?.openai?.trim() && 'openai',
  ].filter(Boolean);
}

/** The engine Pubs will use: the tab's own pick when it is still connected, else Réglages' choice. */
export async function adsEngine() {
  const s = (await kit.store.get('settings', {})) || {};
  const ok = await availableEngines();
  if (s.adsEngine && ok.includes(s.adsEngine)) return s.adsEngine;
  return hookEngineOf(s, ok.includes('claude'));
}

/** One request to one engine → { ok, text } | { ok: false, code, error }. Claude runs Opus by default: picking takes needs it. */
function ask(engine, req, s) {
  const long = { ...req, timeoutMs: 15 * 60 * 1000 }; // whole transcripts: give the AI time
  return engine === 'chatgpt' ? kit.chatgpt.ask(long)
    : engine === 'openai' ? kit.openai.ask(long)
    : kit.claude.ask(req.user, s.adsModel || 'opus', { system: req.system, schema: req.schema, timeoutMs: 15 * 60 * 1000 });
}

/**
 * req = { system, user, schema, name } → parsed JSON. When the engine's login turns out to be gone (Claude Code's
 * session expired, ChatGPT signed out), another AI connected on this Mac takes over; onNote says so.
 */
export async function askAI(req, { onNote } = {}) {
  const s = (await kit.store.get('settings', {})) || {};
  const engine = await adsEngine();
  let r = await ask(engine, req, s);
  if (!r.ok && (r.code === 'claude-signin' || r.code === 'signin')) {
    const other = (await availableEngines()).find((e) => e !== engine);
    if (other) {
      onNote?.(`${engineLabel(engine)} est déconnecté : ${engineLabel(other)} prend le relais`);
      r = await ask(other, req, s);
    }
  }
  if (!r.ok) throw Object.assign(new Error(r.error || 'Erreur de l’IA'), { code: r.code });
  try { return JSON.parse(r.text); } catch { throw new Error('Réponse illisible de l’IA. Relance l’analyse.'); }
}
