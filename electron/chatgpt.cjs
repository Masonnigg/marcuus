// Sign in with ChatGPT (OpenAI's open-source flow): people use their own ChatGPT Plus/Pro plan in MARCUUS,
// no API key. OAuth + PKCE on a 127.0.0.1 loopback port, dynamic client registration, ID token checked
// against OpenAI's keys, tokens kept in a 0600 file in the app's data folder (never in logs or the renderer).
// Contract: https://developers.openai.com/siwc/token-sharing-open-source
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';
const PREFERRED_PORT = 1455;
const DEFAULT_MODEL = 'gpt-6.1-sol';
// refresh errors that mean the session is gone: sign in again (anything else is temporary, keep the tokens)
const DEAD_REFRESH = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const random = () => b64url(crypto.randomBytes(24));

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/** First sign-in registers MARCUUS as a new client (dynamic_agent_client); later ones reuse the issued client ID. */
function authorizeUrl(authBase, p) {
  const q = {
    client_id: p.clientId || 'dynamic_agent_client',
    ...(p.clientId ? {} : { agent_name_hint: 'MARCUUS' }),
    ext_agent_host_id: p.hostId,
    ...(p.clientId && p.idTokenHint ? { id_token_hint: p.idTokenHint } : {}),
    ...(p.clientId && p.loginHint ? { login_hint: p.loginHint } : {}),
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
  };
  return `${authBase}/api/accounts/authorize?` + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** RS256 ID token → its claims, after checking signature, issuer, audience, expiry and nonce. Throws otherwise. */
function verifyIdToken(token, { jwks, issuer, clientId, nonce, now = Date.now() }) {
  const [h, p, s] = String(token || '').split('.');
  if (!s) throw new Error('ID token illisible');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  const jwk = header.alg === 'RS256' && (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('ID token : clé inconnue');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new Error('ID token : signature invalide');
  if (claims.iss !== issuer) throw new Error('ID token : émetteur inattendu');
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId)) throw new Error('ID token : audience inattendue');
  if (!(claims.exp * 1000 > now - 60_000)) throw new Error('ID token expiré');
  if (nonce && claims.nonce !== nonce) throw new Error('ID token : nonce inattendu');
  return claims;
}

/** Server-sent events → parsed JSON events. Feed chunks; returns the events complete so far. */
function sseParser() {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    const events = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
    return events;
  };
}

/** POST that hands back the raw response stream (Electron's fetch has crashed on long streams before). */
function postStream(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, resolve);
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.end(body);
  });
}
const readAll = async (res) => { let s = ''; for await (const c of res) s += c; return s; };

/** OpenAI's plan-usage error codes → what MARCUUS tells the user (code drives the buttons shown). */
function planError(status, err) {
  const code = err?.code || '';
  if (code === 'subscription_sharing_usage_limit_exceeded' || (status === 429 && !code)) {
    return { code: 'limit', error: 'Limite d’usage atteinte pour MARCUUS sur ton forfait ChatGPT. Tu peux la changer dans ChatGPT › Réglages › Usage.' };
  }
  if (code === 'subscription_sharing_user_not_eligible') return { code: 'noteligible', error: 'Ce compte ChatGPT ne peut pas être utilisé dans MARCUUS : il faut un forfait Plus ou Pro.' };
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) {
    return { code: 'unavailable', error: 'ChatGPT est momentanément indisponible. Réessaie dans quelques minutes.' };
  }
  if (code === 'subscription_sharing_invalid_user' || status === 401) return { code: 'signin', error: 'Reconnecte ton compte ChatGPT dans Réglages.' };
  if (code === 'subscription_sharing_unsupported_capability') return { code: 'unsupported', param: err?.param, error: `ChatGPT : option non prise en charge (${err?.param || '?'}).` };
  return { code: code || `http_${status}`, error: `ChatGPT : ${err?.message || code || `erreur ${status}`}` };
}

function createChatGPT({ dataDir, openExternal, settings, authBase = 'https://auth.openai.com', apiBase = RESOURCE, log = () => {} }) {
  const file = () => path.join(dataDir(), 'chatgpt-auth.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
  const save = (a) => { fs.writeFileSync(file(), JSON.stringify(a), { mode: 0o600 }); fs.chmodSync(file(), 0o600); };
  const hasPlan = (a) => String(a.scopes || '').split(' ').includes(PLAN_SCOPE);
  const form = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
  let pending = null;
  let refreshing = null;

  function listen() {
    const start = (port) => new Promise((resolve, reject) => {
      const srv = http.createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    return start(PREFERRED_PORT).catch(() => start(0)); // only the port may change between sign-ins
  }

  async function signIn() {
    pending?.cancel('Nouvelle connexion lancée.');
    const a = load();
    // one stable ID per Mac, in the URN form OpenAI expects (a bare UUID is refused)
    const hostId = /^urn:uuid:/.test(a.hostId || '') ? a.hostId : `urn:uuid:${crypto.randomUUID()}`;
    const reauth = a.clientId && a.lost; // session expired: re-authorise the same registration
    const { verifier, challenge } = pkce();
    const state = random();
    const nonce = random();
    const srv = await listen();
    const redirectUri = `http://127.0.0.1:${srv.address().port}${CALLBACK_PATH}`;
    const callback = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connexion expirée : réessaie.')), 5 * 60_000);
      pending = { cancel: (why) => reject(new Error(why || 'Connexion annulée.')) };
      srv.on('request', (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
        const q = Object.fromEntries(u.searchParams);
        const ok = q.state === state && q.code && !q.error;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(ok));
        if (q.state !== state) return; // not our request: ignore it, keep waiting
        clearTimeout(timer);
        if (q.error) reject(new Error(q.error === 'access_denied' ? 'Connexion refusée dans ChatGPT.' : `Connexion impossible (${q.error}).`));
        else resolve(q);
      });
    }).finally(() => { pending = null; srv.close(); });

    await openExternal(authorizeUrl(authBase, { clientId: reauth ? a.clientId : null, hostId, redirectUri, state, nonce, challenge, idTokenHint: a.idToken, loginHint: a.email }));
    const q = await callback;
    const clientId = reauth ? a.clientId : q.client_id;
    if (!clientId || (reauth && q.client_id && q.client_id !== a.clientId)) throw new Error('Réponse de connexion inattendue : réessaie.');

    const r = await form(`${authBase}/api/accounts/oauth/token`, { grant_type: 'authorization_code', client_id: clientId, code: q.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error(`Connexion impossible (${t.error || r.status}) : réessaie.`);
    const jwks = await (await fetch(`${authBase}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) })).json();
    const claims = verifyIdToken(t.id_token, { jwks, issuer: authBase, clientId, nonce });
    const next = {
      hostId, clientId, sub: claims.sub, email: claims.email || '', idToken: t.id_token,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
      scopes: t.scope || q.scope || '',
    };
    save(next);
    log(`chatgpt: connecté (${hasPlan(next) ? 'forfait autorisé' : 'sans usage du forfait'})`);
    return status();
  }

  async function refresh() {
    const a = load();
    const r = await form(`${authBase}/api/accounts/oauth/token`, { grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE });
    const t = await r.json().catch(() => ({}));
    if (r.ok && t.access_token) {
      save({ ...a, accessToken: t.access_token, refreshToken: t.refresh_token || a.refreshToken, idToken: t.id_token || a.idToken, expiresAt: Date.now() + (t.expires_in || 3600) * 1000, scopes: t.scope || a.scopes });
      return load();
    }
    if (DEAD_REFRESH.includes(t.error) || t.error === 'invalid_client') {
      save({ hostId: a.hostId, clientId: a.clientId, email: a.email, idToken: a.idToken, lost: true });
      throw Object.assign(new Error('Ta connexion ChatGPT a expiré : reconnecte-toi dans Réglages.'), { code: 'signin' });
    }
    throw Object.assign(new Error('ChatGPT ne répond pas, réessaie dans un instant.'), { code: 'unavailable' });
  }

  // one refresh at a time; the refresh token rotates, so two in parallel would invalidate each other
  async function session({ force = false } = {}) {
    const a = load();
    if (!a.refreshToken) throw Object.assign(new Error('Connecte ton compte ChatGPT dans Réglages.'), { code: 'signin' });
    if (!force && a.accessToken && a.expiresAt - Date.now() > 60_000) return a;
    refreshing ||= refresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  function status() {
    const a = load();
    return { signedIn: !!a.refreshToken, lost: !!a.lost, email: a.email || '', planUsage: hasPlan(a), model: settings().chatgptModel || DEFAULT_MODEL };
  }

  async function signOut() {
    pending?.cancel();
    const a = load();
    if (a.refreshToken) {
      await form(`${authBase}/api/accounts/oauth/revoke`, { token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }).catch(() => {});
    }
    save({ hostId: a.hostId }); // next sign-in = a fresh registration (lets people switch account)
    return status();
  }

  async function models() {
    const a = await session();
    const r = await fetch(`${apiBase}/models`, { headers: { Authorization: `Bearer ${a.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(planError(r.status, j.error).error), planError(r.status, j.error));
    return (j.models || []).filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
  }

  /** { system, user, schema, name } → { ok, text, model } | { ok: false, code, error }. Streams, as the plan route requires. */
  async function ask({ system, user, schema, name }, signal) {
    const model = settings().chatgptModel || DEFAULT_MODEL;
    let structured = true;
    let retried401 = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let a;
      try { a = await session(); } catch (e) { return { ok: false, code: e.code || 'signin', error: e.message }; }
      if (!hasPlan(a)) return { ok: false, code: 'noplan', error: 'L’usage de ton forfait ChatGPT n’est pas autorisé pour MARCUUS. Reconnecte-toi dans Réglages et accepte l’accès.' };
      const body = {
        model,
        instructions: structured ? system : `${system}\n\nRéponds uniquement avec un objet JSON valide qui respecte ce schéma :\n${JSON.stringify(schema)}`,
        input: [{ role: 'user', content: user }],
        store: false,
        stream: true,
        ...(structured ? { text: { format: { type: 'json_schema', name, schema, strict: true } } } : {}),
      };
      let r;
      try {
        r = await postStream(`${apiBase}/responses`, { Authorization: `Bearer ${a.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, JSON.stringify(body), signal);
      } catch {
        if (signal?.aborted) return { ok: false, code: 'aborted', error: signal.reason === 'timeout' ? 'ChatGPT ne répond pas (délai dépassé). Réessaie.' : 'Analyse annulée.' };
        return { ok: false, error: 'Pas de connexion à ChatGPT. Vérifie ta connexion internet.' };
      }
      let failure = null;
      if (r.statusCode >= 400) {
        let j = {};
        try { j = JSON.parse(await readAll(r)); } catch {}
        failure = planError(r.statusCode, j.error);
      } else {
        const parse = sseParser();
        const dec = new TextDecoder();
        let text = '';
        let end = null;
        try {
          for await (const chunk of r) {
            for (const ev of parse(dec.decode(chunk, { stream: true }))) {
              if (ev.type === 'response.output_text.delta') text += ev.delta || '';
              else if (ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.incomplete') end = ev;
            }
          }
        } catch {
          if (signal?.aborted) return { ok: false, code: 'aborted', error: signal.reason === 'timeout' ? 'ChatGPT ne répond pas (délai dépassé). Réessaie.' : 'Analyse annulée.' };
          return { ok: false, error: 'La connexion à ChatGPT a été coupée. Réessaie.' };
        }
        if (end?.type === 'response.completed') {
          if (!text) text = (end.response?.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
          return text ? { ok: true, text, model } : { ok: false, error: 'ChatGPT n’a rien renvoyé. Réessaie.' };
        }
        if (end?.type === 'response.incomplete') return { ok: false, error: 'La réponse de ChatGPT a été coupée. Réessaie.' };
        failure = end ? planError(0, end.response?.error) : { code: 'cut', error: 'La réponse de ChatGPT s’est arrêtée avant la fin. Réessaie.' };
      }
      if (failure.code === 'unsupported' && String(failure.param || '').startsWith('text') && structured) { structured = false; continue; }
      if (failure.code === 'signin' && !retried401) {
        retried401 = true;
        try { await session({ force: true }); continue; } catch (e) { return { ok: false, code: e.code || 'signin', error: e.message }; }
      }
      if (failure.code === 'unavailable' && attempt < 2) { await new Promise((res) => setTimeout(res, [2000, 6000][attempt])); continue; }
      return { ok: false, ...failure };
    }
    return { ok: false, error: 'ChatGPT ne répond pas. Réessaie dans quelques minutes.' };
  }

  return { signIn, signOut, status, models, ask, cancelSignIn: () => pending?.cancel() };
}

function page(ok) {
  const msg = ok ? 'MARCUUS est connecté à ton compte ChatGPT. Tu peux fermer cet onglet et revenir dans l’app.' : 'La connexion n’a pas abouti. Reviens dans MARCUUS et réessaie.';
  return `<!doctype html><meta charset="utf-8"><title>MARCUUS</title><body style="font:16px -apple-system,sans-serif;background:#0d0d10;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p style="max-width:28em;text-align:center">${msg}</p></body>`;
}

module.exports = { createChatGPT, authorizeUrl, verifyIdToken, sseParser, planError, pkce, SCOPES, PLAN_SCOPE };
