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

/** req = { system, user, schema, name } → parsed JSON. Claude runs Opus by default: picking takes needs it. */
export async function askAI(req) {
  const s = (await kit.store.get('settings', {})) || {};
  const engine = await adsEngine();
  const long = { ...req, timeoutMs: 15 * 60 * 1000 }; // whole transcripts: give the AI time
  const r = engine === 'chatgpt' ? await kit.chatgpt.ask(long)
    : engine === 'openai' ? await kit.openai.ask(long)
    : await kit.claude.ask(req.user, s.adsModel || 'opus', { system: req.system, schema: req.schema, timeoutMs: 15 * 60 * 1000 });
  if (!r.ok) throw Object.assign(new Error(r.error || 'Erreur de l’IA'), { code: r.code });
  try { return JSON.parse(r.text); } catch { throw new Error('Réponse illisible de l’IA. Relance l’analyse.'); }
}
