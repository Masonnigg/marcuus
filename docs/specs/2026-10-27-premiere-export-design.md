# Hook → Premiere export (2026-10-27)

## Goal
From a Hook result, get a Premiere sequence already cut: the hook first, then the body passages, from the file that was analysed.

## Decisions (with the user)
- Premiere Final Cut Pro 7 XML (`xmeml`), imported with Fichier › Importer or by dragging the .xml into the Project panel. No Premiere plugin.
- Only the file that was dropped (no second camera angle).
- No captions file for the cut.
- No markers.
- Cuts are only valid on the analysed file itself: analyse the raw video, not an MP3 exported from an edited sequence.

## Behaviour
- "Premiere" button on each moment card → save dialog (default: next to the source, `<name> - Hook N.xml`) → toast with "Afficher".
- Sequence `<name> - Hook N`, vertical 1080×1920, at the source frame rate (nearest of 23.976/24/25/29.97/30/50/59.94/60; no video → 25).
- Clips back to back: hook, then body passages in order. Each passage keeps 150 ms before its first word and 200 ms after its last word, never more than half of the silence to the neighbouring word, never past the end of the file. In point floored, out point ceiled to frames. Passages that touch in the source become one clip.
- Horizontal video is scaled to fill (Basic Motion scale = max(1080/w, 1920/h)); phone footage stored sideways (rotation ±90) counts as vertical.
- Audio: like Premiere's own XML export, a stereo source is written as two linked half-tracks (source channels 1 and 2, `premiereTrackType="Stereo"`, exploded track index 0/1); mono = one track. MP3/WAV → audio-only sequence.

## Code
- `src/lib/premiere.js`: `frameRate`, `planCuts`, `premiereXml`, `parseProbe` (pure, tested in `scripts/test-premiere.mjs`).
- `media:probe` IPC: `ffmpeg -i` banner (bundled ffmpeg).
- `src/pages/Hook.jsx`: button + save via `kit.saveText(…, 'xml')`.
