# Light updates (2026-11-01)

## Why
Every update downloaded the whole app (163 MB) from GitHub's release files, over one connection. Those files can
slow to ~30 KB/s for a while, which made an update take 1.5 h. Comparing real builds, only 12 files out of 283 change
between two versions: `app.asar`, `Info.plist`, the code seal and the small launchers (1.5 MB, 0.5 MB zipped).

## How (electron/update-files.cjs)
- Each release adds `RYACHA-<v>-<arch>.patch.zip` with those files, and `patch: { url, sha256, size, base, full }`
  in latest.json. Older apps ignore `patch` and use the full zip.
- `base` = fingerprint of everything the patch does not contain. `full` = fingerprint of the whole bundle.
- Installed app: same `base` → download the patch, copy itself, swap the patched parts, check the result has the
  `full` fingerprint (byte-identical to the published build, signature included), then the usual swap and restart.
- Different `base` (Electron, ffmpeg, uv or the icon changed) or any failure → full zip. A Mac can't get stuck.
- Full zip and patch: 4 MB chunks over 8 connections; a stalled connection is dropped and its chunk retried; chunks
  stay in `<userData>/update-cache` so a restart resumes.

## Gotcha
Inside Electron plain `fs` shows `app.asar` as a folder, so fingerprints must use `original-fs`.

## Verified
Real 1.0.10 → 1.0.11 builds on this Mac: 1.7 s, one 0.5 MB request, signature valid, byte-identical, restarted.
Different base → full zip. Corrupted patch → full zip. Real GitHub file over 8 connections: checksum OK.
