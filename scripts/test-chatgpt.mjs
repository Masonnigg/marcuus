// Sign in with ChatGPT: the OAuth contract, ID-token checks, streaming, refresh and errors, against a fake OpenAI.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createChatGPT, authorizeUrl, verifyIdToken, sseParser, planError, pkce, SCOPES } = require('../electron/chatgpt.cjs');

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

// ---- pure parts
const { verifier, challenge } = pkce();
check('PKCE: challenge = base64url(sha256(verifier)), no padding', challenge === createHash('sha256').update(verifier).digest('base64url') && !challenge.includes('='));
const first = new URL(authorizeUrl('https://auth.openai.com', { hostId: 'h1', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', challenge: 'c', idTokenHint: 'old', loginHint: 'a@b.c' }));
const q = Object.fromEntries(first.searchParams);
check('first sign-in registers MARCUUS', q.client_id === 'dynamic_agent_client' && q.agent_name_hint === 'MARCUUS' && !q.id_token_hint && !q.login_hint, JSON.stringify(q));
check('authorize: OpenAI’s exact scopes, resource, S256, loopback', q.scope === SCOPES && SCOPES.includes('chatgpt.tokens.use.direct') && q.resource === 'https://api.openai.com/v1'
  && q.code_challenge_method === 'S256' && q.response_type === 'code' && q.redirect_uri === 'http://127.0.0.1:1455/auth/callback' && first.pathname === '/api/accounts/authorize');
check('values are percent-encoded (spaces as %20)', first.search.includes('scope=openid%20profile') && !first.search.includes('+'));
const again = Object.fromEntries(new URL(authorizeUrl('https://x', { clientId: 'oaiapp_1', hostId: 'h1', redirectUri: 'r', state: 's', nonce: 'n', challenge: 'c', idTokenHint: 'old', loginHint: 'a@b.c' })).searchParams);
check('re-authorisation reuses the issued client, with hints, no name hint', again.client_id === 'oaiapp_1' && !again.agent_name_hint && again.id_token_hint === 'old' && again.login_hint === 'a@b.c');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const sign = (claims, key = privateKey, kid = 'k1') => {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')}`;
};
const good = { iss: 'https://auth.test', aud: 'oaiapp_1', exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'n1', sub: 'user-1', email: 'test@example.com' };
const opts = { jwks: { keys: [jwk] }, issuer: 'https://auth.test', clientId: 'oaiapp_1', nonce: 'n1' };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check('valid ID token accepted', verifyIdToken(sign(good), opts).email === 'test@example.com');
check('ID token: wrong audience, nonce, issuer, expired → refused', throws(() => verifyIdToken(sign({ ...good, aud: 'other' }), opts)) && throws(() => verifyIdToken(sign({ ...good, nonce: 'x' }), opts))
  && throws(() => verifyIdToken(sign({ ...good, iss: 'https://evil' }), opts)) && throws(() => verifyIdToken(sign({ ...good, exp: 1000 }), opts)));
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
check('ID token signed by another key → refused', throws(() => verifyIdToken(sign(good, other), opts)) && throws(() => verifyIdToken(sign(good, privateKey, 'unknown'), opts)));

const parse = sseParser();
const evs = [...parse('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Bon"}\n\ndata: {"type":"response.output_text.de'), ...parse('lta","delta":"jour"}\n\n')];
check('stream events split across chunks', evs.map((e) => e.delta).join('') === 'Bonjour', JSON.stringify(evs));
check('plan errors → clear messages', planError(429, { code: 'subscription_sharing_usage_limit_exceeded' }).code === 'limit' && planError(403, { code: 'subscription_sharing_user_not_eligible' }).code === 'noteligible'
  && planError(503, {}).code === 'unavailable' && planError(401, {}).code === 'signin');

// ---- the whole flow against a fake OpenAI
const keys = { k1: privateKey };
const st = { codes: new Map(), refresh: null, oldRefresh: new Set(), access: null, revoked: null, mode: 'ok', bodies: [], refreshes: 0 };
const srv = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const u = new URL(req.url, base);
  let body = '';
  for await (const c of req) body += c;
  const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const tokens = (clientId, nonce) => {
    st.access = randomUUID(); if (st.refresh) st.oldRefresh.add(st.refresh); st.refresh = randomUUID();
    return { access_token: st.access, refresh_token: st.refresh, token_type: 'Bearer', expires_in: 3600, scope: SCOPES,
      id_token: sign({ iss: base, aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'user-1', email: 'test@example.com', ...(nonce ? { nonce } : {}) }) };
  };
  if (u.pathname === '/api/accounts/authorize') {
    const p = Object.fromEntries(u.searchParams);
    const code = randomUUID();
    st.codes.set(code, p);
    st.lastAuthorize = p;
    res.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state)}${p.client_id === 'dynamic_agent_client' ? '&client_id=oaiapp_test' : ''}&scope=${encodeURIComponent(p.scope)}` });
    return res.end();
  }
  if (u.pathname === '/.well-known/jwks.json') return send(200, { keys: [jwk] });
  if (u.pathname === '/api/accounts/oauth/token') {
    const f = Object.fromEntries(new URLSearchParams(body));
    if (f.grant_type === 'authorization_code') {
      const p = st.codes.get(f.code);
      st.codes.delete(f.code);
      const okPkce = p && createHash('sha256').update(f.code_verifier).digest('base64url') === p.code_challenge;
      if (!p || !okPkce || f.redirect_uri !== p.redirect_uri || f.resource !== 'https://api.openai.com/v1' || f.client_id !== 'oaiapp_test') return send(400, { error: 'invalid_grant' });
      return send(200, tokens(f.client_id, p.nonce));
    }
    if (f.grant_type === 'refresh_token') {
      st.refreshes++;
      if (st.oldRefresh.has(f.refresh_token)) return send(400, { error: 'refresh_token_reused' });
      if (f.refresh_token !== st.refresh || f.client_id !== 'oaiapp_test' || f.scope) return send(400, { error: 'invalid_grant' });
      return send(200, tokens(f.client_id));
    }
  }
  if (u.pathname === '/api/accounts/oauth/revoke') { st.revoked = Object.fromEntries(new URLSearchParams(body)); res.writeHead(200); return res.end(); }
  const authed = req.headers.authorization === `Bearer ${st.access}`;
  if (u.pathname === '/models') return authed ? send(200, { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }] }) : send(401, {});
  if (u.pathname === '/responses') {
    const b = JSON.parse(body);
    st.bodies.push(b);
    if (!authed) return send(401, { error: { code: 'subscription_sharing_invalid_user' } });
    if (st.mode === 'notext' && b.text) return send(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'text.format' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    if (st.mode === 'limit') { ev({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }); return res.end(); }
    for (const piece of ['{"moments":', '[]}']) ev({ type: 'response.output_text.delta', delta: piece });
    ev({ type: 'response.completed', response: { status: 'completed' } });
    return res.end();
  }
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'chatgpt-test-'));
let model = null;
const cg = createChatGPT({ dataDir: () => dir, settings: () => (model ? { chatgptModel: model } : {}), openExternal: (url) => fetch(url).then(() => {}), authBase: base, apiBase: base });
const authFile = join(dir, 'chatgpt-auth.json');

const s1 = await cg.signIn();
check('sign-in: connected, email from the verified ID token, plan usage granted', s1.signedIn && s1.email === 'test@example.com' && s1.planUsage, JSON.stringify(s1));
check('loopback redirect on 127.0.0.1:1455 (never localhost)', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(st.lastAuthorize.redirect_uri) && !st.lastAuthorize.redirect_uri.includes('localhost'), st.lastAuthorize.redirect_uri);
const saved = JSON.parse(readFileSync(authFile, 'utf8'));
check('tokens saved only for this user (file 0600), issued client kept', (statSync(authFile).mode & 0o777) === 0o600 && saved.clientId === 'oaiapp_test' && saved.hostId === st.lastAuthorize.ext_agent_host_id);

check('models: only the listed ones', JSON.stringify(await cg.models()) === JSON.stringify([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]));

const req = { system: 'SYS', user: 'USER', schema: { type: 'object' }, name: 'reel_hooks' };
const r1 = await cg.ask(req);
const b1 = st.bodies.at(-1);
check('analysis streamed and assembled', r1.ok && r1.text === '{"moments":[]}' && r1.model === 'gpt-6.1-sol', JSON.stringify(r1));
check('request follows the plan route rules', b1.store === false && b1.stream === true && b1.instructions === 'SYS' && !('max_output_tokens' in b1) && !('temperature' in b1)
  && b1.input.every((m) => m.role !== 'system') && b1.text.format.type === 'json_schema', JSON.stringify(b1));

// expired access token → one refresh, the rotated refresh token is saved
writeFileSync(authFile, JSON.stringify({ ...JSON.parse(readFileSync(authFile, 'utf8')), expiresAt: Date.now() - 1000 }));
const before = JSON.parse(readFileSync(authFile, 'utf8')).refreshToken;
const [ra, rb] = await Promise.all([cg.ask(req), cg.ask(req)]);
const after = JSON.parse(readFileSync(authFile, 'utf8'));
check('expired token: refreshed once for parallel requests, new refresh token kept', ra.ok && rb.ok && st.refreshes === 1 && after.refreshToken !== before && after.refreshToken === st.refresh, `refreshes=${st.refreshes}`);

st.mode = 'notext';
const r2 = await cg.ask(req);
check('structured output refused → asks for JSON in the instructions instead', r2.ok && !st.bodies.at(-1).text && st.bodies.at(-1).instructions.includes('JSON valide'));

st.mode = 'limit';
const r3 = await cg.ask(req);
check('usage limit → stops with the “Gérer l’usage” error', !r3.ok && r3.code === 'limit' && /Usage/.test(r3.error), JSON.stringify(r3));
st.mode = 'ok';

model = 'gpt-6-luna';
await cg.ask(req);
check('model chosen in Réglages is used', st.bodies.at(-1).model === 'gpt-6-luna');
model = null;

// refresh token revoked elsewhere → sign in again, then re-authorisation reuses the same client
st.oldRefresh.add(st.refresh); st.refresh = 'gone';
writeFileSync(authFile, JSON.stringify({ ...JSON.parse(readFileSync(authFile, 'utf8')), expiresAt: 0 }));
const r4 = await cg.ask(req);
const lost = cg.status();
check('dead refresh token → “reconnecte-toi”, account remembered for the hint', !r4.ok && r4.code === 'signin' && !lost.signedIn && lost.lost && lost.email === 'test@example.com', JSON.stringify({ r4, lost }));
const s2 = await cg.signIn();
check('re-sign-in reuses the issued client with id_token/login hints', s2.signedIn && st.lastAuthorize.client_id === 'oaiapp_test' && st.lastAuthorize.login_hint === 'test@example.com' && !!st.lastAuthorize.id_token_hint, JSON.stringify(st.lastAuthorize));

const rt = JSON.parse(readFileSync(authFile, 'utf8')).refreshToken;
const s3 = await cg.signOut();
check('sign-out revokes the refresh token and forgets the account', !s3.signedIn && st.revoked?.token === rt && st.revoked?.token_type_hint === 'refresh_token' && st.revoked?.client_id === 'oaiapp_test'
  && !JSON.parse(readFileSync(authFile, 'utf8')).email);
check('signed out → asking says to connect', (await cg.ask(req)).code === 'signin');

srv.close();
process.exit(fail ? 1 : 0);
