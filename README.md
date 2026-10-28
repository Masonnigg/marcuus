# MARCUUS

Mac app for editing short-form videos (French captions):

- **Transcrire**: video/audio → captions, on-device (Whisper large-v3-turbo on Apple MLX). Caption editor with per-caption playback, doubtful-word review, find & replace, "Affiner avec Claude".
- **SRT Fixer**: rejoins words split by auto-captioners (TurboScribe…) and re-splits captions by grammar (1–2 words per line).
- **B-roll**: Claude suggests shots per moment, searches Pixabay/Pexels videos; Envato / Pexels / Mixkit links.
- **Hook**: an MP3 or a video → the sentence that should open the Reel, the passages to keep, 3 on-screen titles and a caption. The AI scores several candidate hooks and the app keeps the best one; a long recording gives several Reels, each with a different message. **Premiere** button: a vertical sequence already cut (hook, then body) to drag into Premiere.
  Analyses run on the user's own ChatGPT Plus/Pro plan with **Continue with ChatGPT** (OpenAI's Sign in with ChatGPT, no API key), or an OpenAI API key, or Claude Code if it is already set up on the Mac.
- **Palettes**: click-to-copy colour palettes, extract from an image.

Electron + React (Vite) + Tailwind. UI in French.

## Develop

```bash
npm install
npm run start          # build + run
npm test               # SRT fixer, caption splitting, hook and Premiere export tests
```

## Build installers

```bash
npm run dist           # → release/MARCUUS-<version>-arm64.dmg and -x64.dmg
```

`predist` fetches the tools bundled inside the app (ffmpeg, uv) into `vendor/arm64/bin`.
The app is ad-hoc signed (no Apple Developer ID), so on first launch other Macs need
*Réglages Système → Confidentialité et sécurité → Ouvrir quand même* (see `build/LISEZ-MOI.txt`).

## Release a new version (every version is mandatory)

```bash
# 1. bump "version" in package.json, commit
npm run release -- "Ce qui change dans cette version"
```

`scripts/release.mjs` runs the tests, builds both DMGs and update zips, publishes them as a
GitHub Release in the public repo [Masonnigg/marcuus-releases](https://github.com/Masonnigg/marcuus-releases),
then updates `latest.json` there (last, so no Mac sees a version before its files exist) and tags this repo.

Installed apps read `latest.json` on launch and every hour. If it lists a newer version, the app is
locked behind a "Mise à jour requise" screen; one click downloads the zip (curl), checks its SHA-256 and
version, swaps the app and restarts. No connection → the app opens normally.

## Licence

MARCUUS is free software under the [GNU General Public License v3.0](LICENSE): you can use, study, share and change it,
and any version you share must stay under the same licence.
