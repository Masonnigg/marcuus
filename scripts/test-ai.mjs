// Pubs: which AI answers. A login that turns out to be gone (Claude Code's session expired) hands over to another
// AI connected on the Mac, and says so; with none, the error says how to reconnect.
import assert from 'node:assert/strict';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✓', name); };

const EXPIRED = { ok: false, code: 'claude-signin', error: 'Ta connexion Claude Code a expiré. Reconnecte-la.' };
const calls = [];
const fake = { claude: null, chatgptOn: true };
globalThis.window = {
  kit: {
    store: { get: async () => ({}) },
    claude: {
      status: async () => ({ installed: true, loggedIn: true }), // what Claude Code says even when its session is dead
      ask: async () => { calls.push('claude'); return fake.claude; },
    },
    chatgpt: {
      status: async () => ({ signedIn: fake.chatgptOn, planUsage: true }),
      ask: async () => { calls.push('chatgpt'); return { ok: true, text: '{"from":"chatgpt"}' }; },
    },
    openai: { ask: async () => ({ ok: false, code: 'nokey' }) },
  },
};
const { askAI } = await import('../src/lib/ads/ai.js');
const req = { system: 's', user: 'u', schema: { type: 'object' }, name: 'n' };

await test('Claude Code answers: nothing else is asked', async () => {
  calls.length = 0; fake.claude = { ok: true, text: '{"from":"claude"}' };
  const notes = [];
  assert.deepEqual(await askAI(req, { onNote: (x) => notes.push(x) }), { from: 'claude' });
  assert.deepEqual(calls, ['claude']);
  assert.deepEqual(notes, []);
});

await test('Claude Code’s session expired, ChatGPT connected: ChatGPT takes over and the bar says so', async () => {
  calls.length = 0; fake.claude = EXPIRED; fake.chatgptOn = true;
  const notes = [];
  assert.deepEqual(await askAI(req, { onNote: (x) => notes.push(x) }), { from: 'chatgpt' });
  assert.deepEqual(calls, ['claude', 'chatgpt']);
  assert.deepEqual(notes, ['Claude est déconnecté : ChatGPT prend le relais']);
});

await test('Claude Code’s session expired, nothing else connected: the error says how to reconnect', async () => {
  calls.length = 0; fake.claude = EXPIRED; fake.chatgptOn = false;
  await assert.rejects(askAI(req), (e) => e.code === 'claude-signin' && /expiré/.test(e.message));
  assert.deepEqual(calls, ['claude']);
});

console.log(`ai: ${n} tests OK`);
