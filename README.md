# MARCUUS

Mac app for editing short-form videos (French captions). It shows as **RYACHA** (menus, Dock, window); the bundle and
the data folder keep their old names (`MARCUUS.app`, `~/Library/Application Support/Edit Kit`) so updates and settings carry over.

- **Transcrire**: video/audio → captions, on-device (Whisper large-v3-turbo on Apple MLX). Caption editor with per-caption playback, doubtful-word review, find & replace, "Affiner avec Claude".
- **SRT Fixer**: rejoins words split by auto-captioners (TurboScribe…) and re-splits captions by grammar (1–2 words per line).
- **B-roll**: Claude suggests shots per moment, searches Pixabay/Pexels videos; Envato / Pexels / Mixkit links.
- **Hook**: an MP3 or a video → the sentence that should open the Reel, the passages to keep, 3 on-screen titles and a caption. The AI scores several candidate hooks and the app keeps the best one; a long recording gives several Reels, each with a different message. **Premiere** button: a vertical sequence already cut (hook, then body) to drag into Premiere.
  Analyses run on the user's own ChatGPT Plus/Pro plan with **Continue with ChatGPT** (OpenAI's Sign in with ChatGPT, no API key), or an OpenAI API key, or Claude Code if it is already set up on the Mac.
- **Pubs**: a client brief + the rushes → every ad of a script built in Premiere. The AI (ChatGPT or Claude, picked in the tab)
  reads the script (hooks, transitions, body, variants only when the script names them) and picks the clean take of each
  part among the rushes, transcribed on the Mac with a double pass. The app cuts the body only (whole takes, dead air over
  1 s); the editor does the small cuts. Cuts sit on the real sound: a 5 ms level track finds the gap between two words said
  in one breath, and a sentence ends where the voice stops, not where Whisper ends its last word.
- **Premiere panel** (`premiere/`, a CEP extension shipped inside the app and installed from Réglages or the Pubs tab):
  four steps on the job the app wrote: 1. import the rushes and build every part and ad as nested 30 fps sequences;
  2. captions on the ticked parts (rendered, transcribed on the Mac, styled from the project or a `.prtextstyle` file);
  3. zooms on the cuts; 4. export through Media Encoder in 9x16 and 4x5, the file list shown before anything is queued.
- **4x5**: drop a folder (or videos) → 4:5 copies cropped in the middle (1080×1920 → 1080×1350), visually lossless and about half the size, in "<folder> 4x5" with the same subfolders. CPU (x264) or the Mac's hardware encoder.
- **Palettes**: click-to-copy colour palettes, extract from an image.

Electron + React (Vite) + Tailwind. UI in French.

## Develop

```bash
npm install
npm run start          # build + run (the app and the panel's caption bundle)
npm test               # SRT fixer, caption splitting, hook, Premiere export, ChatGPT sign-in, update, 4x5 and Pubs tests
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

Updates are light: between two builds only MARCUUS's own code (the Premiere panel included) and the small launchers change (about 0.5 MB zipped), so each
release also ships a `.patch.zip` with just those files (`electron/update-files.cjs`). An installed app uses it when the rest of
its bundle matches the release's fingerprint, and checks that the result is byte-identical to the published build before
restarting. Otherwise, or if anything fails, it downloads the full zip, over 8 connections and resumable.

Installed apps read `latest.json` on launch and every hour. If it lists a newer version, the app is
locked behind a "Mise à jour requise" screen; one click downloads the zip (curl), checks its SHA-256 and
version, swaps the app and restarts. No connection → the app opens normally.

## Licence

MARCUUS is free software under the [GNU General Public License v3.0](LICENSE): you can use, study, share and change it,
and any version you share must stay under the same licence.
