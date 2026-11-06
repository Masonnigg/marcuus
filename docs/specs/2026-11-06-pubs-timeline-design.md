# Pubs: a timeline to trim and swap takes (2026-11-06)

## Why
While checking the parts the AI picked (hooks, transis, corps), the editor can only switch a sentence to another
take the AI listed, or remove it. Small fixes (a hook that starts a word too late, a cut that clips a breath, a better
take the AI missed) wait for Premiere. The editor asked for basic editing in the app, "CapCut timeline style":
trim the start and end, and swap in another take.

## What the editor sees
Selecting a part in the review opens its timeline under its player (one part at a time; a part edited here changes
in every ad that uses it, like a nest in Premiere).
- One clip per continuous stretch of a rush, with thumbnails, the rush name and its first words; the sound wave
  under the clips; a playhead.
- Toolbar: play / pause, current time / length, "Remplacer la prise", "Supprimer", "Revenir à la coupe de l'IA",
  zoom.
- Keys: space plays / pauses, ← → one frame, Delete removes the selected clip, ⌘Z undoes the last edit.
- Clicking the timeline moves the playhead there; the player follows.

## Editing
- **Trim**: drag either edge of any clip. Edges snap to the gaps between words (the transcript's word times);
  ⌘ while dragging moves freely, frame by frame (30 fps). Dragging outward reaches into the rush: the editor can
  take back a word or a breath the AI left out. Limits: a clip keeps at least 100 ms; an edge never goes past the
  neighbouring clip's edge when both come from the same stretch of the same rush (no sound said twice); otherwise
  up to 3 s beyond the AI's cut. "The same stretch" means the next clip continues the same rush later on.
- A clip can hold several sentences (said in one go). Replace and Delete act on sentences: with one sentence in the
  selected clip they act on it directly; with several, the editor first picks which (a short list of the clip's
  sentences).
- **Replace the take**: "Remplacer la prise" opens a list with the other takes the AI found for that sentence, and a
  search box (prefilled with the sentence) that finds the same words anywhere in the rushes. Each result shows its
  words, its rush and time, and plays on its own. Choosing one replaces that sentence's take.
- A sentence can also run over two clips (its first words from one rush, the rest from another). Replace and
  Delete then act on the selected clip's part of it only (the search is prefilled with that part); the rest keeps
  its phrases and cut points. The AI's takes stay offered too, marked "toute la phrase".
- A take found by search keeps only the words that match (stretched over a word said otherwise at either end, such
  as another year); the clip's edges can still be dragged out to the rest of the phrase.
- **Delete**: removes the sentence (what "retirer" does today); undo or "Revenir à la coupe de l'IA" brings it back.
- "C'est bon", the flags and the brief line stay as they are.

## How it is stored (edits on top of the AI's cut)
The cut stays computed from the AI's answer each time (`matchParts`); the editor's edits are applied on top, so
switching a take or going back to the AI's cut stays simple and the analysis itself is never rewritten.
- `job.choices[part][sentence]` keeps today's values (0 = chosen take, n = other take, -1 = removed) and can also be
  `{ phrases: [...], trims: [...] }`, a take changed in the timeline (phrase ids in any rush; `piecesFromPhrases`
  already takes any ids). Its trims are the AI's text anchors for the phrases it kept, or `{ phrase, span: [a, b] }`
  for the exact words a search matched. `kind: 'clip'` marks a take where only one clip's part was replaced or
  removed ("prise retouchée" in the list; "prise trouvée" for a whole sentence found by search).
- `job.edits[part]` = `{ [edge]: ms }`: where an edge of the AI's cut was moved to. `edge` names the edge by what it
  is in the rush, `"<rush id>#<word index>:in"` or `":out"` (the first or last word of a clip), so an edit stays on
  its clip when nothing else changes, and stops applying by itself when that sentence gets another take. Edits that
  no longer match any clip are dropped when the job is saved.
- `applyEdits(pieces, edits, recording words)` turns the AI's pieces into the edited ones; the player, the review and
  "Construire dans Premiere" (`buildJob`) all use the edited pieces.
- ⌘Z keeps the last 30 edits of the open part in memory only (not saved).

## New pieces of code
- `src/lib/ads/edits.js`: edge names, `applyEdits`, word-gap snapping, the limits above, `searchTakes(query,
  recordings)` (phrases ranked by how many of the query's words they hold, in order).
- `src/components/PartTimeline.jsx`: the timeline (clips, thumbnails, sound wave, handles, playhead, keys, zoom).
- `src/components/TakePicker.jsx`: the "Remplacer la prise" list and search.
- `Pubs.jsx`: `PartDetail` shows the timeline; `Player` reports its time and can be moved, so the playhead and the
  player stay together; `job.edits` is saved with the job.
- Thumbnails: IPC `ads:thumbs(file, times)` in the main process: ffmpeg grabs small frames (64 px high, JPEG) and
  keeps them in `<userData>/ads-cache/thumbs`. Sound wave: drawn from the 5 ms level track each rush already has
  (`rec.env`), no new decoding.

## Not included (kept basic)
Splitting a clip, reordering sentences, several tracks, zooms, captions, music: those stay in Premiere.

## Tests
`scripts/test-ads.mjs`, made-up data: edges move and snap to word gaps; ⌘ moves to the frame; limits hold (100 ms,
neighbour in the same rush, 3 s); an edit stops applying when its sentence gets another take; a searched take
replaces a sentence and builds its pieces; `searchTakes` finds a phrase in another rush; `buildJob` uses the edited
pieces. The screen is checked in the beta app (separate data folder) on a real analysis: trim, snap, swap, delete,
undo, reset, then "Construire dans Premiere" in a test project.
