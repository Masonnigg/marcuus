# Hook tab — design

Approved 2026-10-27.

## Goal
Drop an MP3 (or video) → get, for a Reel:
- **Hook moment**: the line actually spoken that should open the Reel (timestamps + why it works).
- **Body**: the passages to keep after the hook, in edit order (timestamps), each with a short label.
- **Written hook**: 3 on-screen title options (French).
- **Caption**: a short post description of what the person talks about.

Short clip (≤ 2 min 30) → 1 moment. Long recording → 2 to 5 moments, best first, each a separate Reel.

## How
1. Transcribe locally with the existing engine (`kit.whisper.transcribe`), same language/vocab as Transcrire.
   A file already transcribed in Transcrire is sent with its words ("Hook" button) — no second transcription.
2. Split words into numbered lines (sentence end, pause > 0.8 s, or 35 words). Send `L12 [0:42] text` lines to
   ChatGPT (OpenAI Responses API, strict JSON schema). It answers with **line numbers**, never timestamps.
3. Validate: line ranges must exist; the hook quote is located in the real words to narrow its timing. Everything
   displayed is our transcript text — an invented quote can never appear. Body passages inside the hook are dropped.

## Pieces
- `src/lib/hook.js` — pure: `linesFromWords`, `buildHookRequest`, `parseHookReply`, `momentToText`. Tested by `scripts/test-hook.mjs`.
- `electron/main.cjs` — `openai:ask` (key + model read from settings in the main process), `openai:cancel`, `openai:status`.
  Base URL overridable with `MARCUUS_OPENAI_URL` for tests. French error messages (no key, bad key, no credit, model, network, timeout, refusal).
- `src/pages/Hook.jsx` — file list + queue (transcribe → analyse), progress, result cards with ▶ playback, copy buttons, "Relancer l'analyse". Session saved in `hookSession`. Stays mounted like Transcrire.
- Réglages — OpenAI key, model (Rapide `gpt-6-luna` · Équilibré `gpt-6.1-sol` default · Le meilleur `gpt-6-astra`), "Tester".
- Transcrire — "Hook" button sends the current file (edited captions if any).

## Out of scope
Exporting markers to Premiere, hashtags, analysing tone/energy from the audio itself.
