# Continue with ChatGPT (2026-10-28)

## Goal
People analyse with their own ChatGPT Plus/Pro plan, with no API key. MARCUUS went open source (GPL-3.0) so it can use
OpenAI's plan usage for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source).
Anthropic does not allow third-party apps to offer claude.ai login to other people, so Claude stays only where
Claude Code is already connected on the Mac, and MARCUUS no longer explains how to install or log into it.

## Flow (electron/chatgpt.cjs)
- Authorize in the system browser: `client_id=dynamic_agent_client` + `agent_name_hint=MARCUUS` the first time,
  the issued `oaiapp_…` client later (with id_token/login hints when a session expired). `ext_agent_host_id` =
  one `urn:uuid:…` per Mac (a bare UUID is refused). PKCE S256, state, nonce, loopback
  `http://127.0.0.1:1455/auth/callback` (another port if busy), scopes
  `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`.
- Token exchange, ID token verified (RS256 against the JWKS, iss, aud = issued client, exp, nonce).
- Tokens in `<userData>/chatgpt-auth.json`, mode 0600, never in logs or the renderer.
- Refresh 60 s before expiry, one at a time (refresh tokens rotate); dead refresh → "reconnecte-toi", keeps the
  client for re-authorisation. Sign out revokes the refresh token and forgets the registration.
- Inference: `POST /v1/responses`, `store:false`, `stream:true`, `instructions` (no system message, no
  max_output_tokens/temperature), json_schema output; if refused, JSON asked in the instructions.
- Errors: usage limit → stop + "Gérer l'usage"; not eligible; unavailable → 2 retries with backoff; 401 → one refresh.

## UI
- Réglages: OpenAI's "Continue with ChatGPT" button (official white logo), account, "Gérer l'usage", model list from
  `/v1/models`, first-run "You're using your ChatGPT plan" notice. Hook engine: ChatGPT (ton forfait) / Claude Code
  (only if connected) / Clé API OpenAI; default = Claude Code if connected on this Mac, else ChatGPT.
- Hook: "Ton forfait ChatGPT · Gérer l'usage" next to the analysis and results.

## Verified
- `scripts/test-chatgpt.mjs` against a fake OpenAI (contract, ID token checks, refresh rotation, errors, sign out).
- Real account (ChatGPT Plus): sign-in, 9 analyses on gpt-6.1-sol; same hooks as Claude on 3 of 4 clips, stable
  across runs; ~30 s per analysis.
