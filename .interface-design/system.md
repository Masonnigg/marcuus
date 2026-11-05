# RYACHA design system

RYACHA is used by a video editor in the middle of a job, inside Premiere Pro (the panel) and next to it
(the desktop app). Everything should feel like part of the editing bench: dense, quiet, fast, and
honest about progress.

## Direction

- **Feel:** a Premiere bench. It is dense like a timeline, calm like a well-kept project, and it never
  shouts.
- **Focal point:** each view has one action (the open step's button, "Construire dans Premiere",
  "Analyser"). It is the only filled accent on screen.
- **Signature: the render bar.** Progress is drawn like Premiere's render bar: one segment per sequence,
  part or stage.
  - States: waiting, running (accent), done (green), skipped (light grey), failed (red).
  - The text log folds under "Détail (N)" and opens by itself when something fails.
  - The panel uses it for every step. The app's Pubs tab uses it for its analysis (script, each rush,
    takes).

## Colour

There is one accent, the playhead orange, shared by the app and the panel: `#ff6a3d`, with `#140802`
text on it.

Use the accent only for:

- the current step's ring and its one action;
- the zoom point and the zoom box;
- the cut marks in the zoom preview;
- the running segment of the render bar.

It is never used for checkboxes, values or decoration. Checkboxes use Premiere's light grey, `#dcdcdc`.

### Status colours

| Status | Panel | App |
|---|---|---|
| Done | `#5fd68a` | `--color-ok` |
| Warning | `#e8b84a` | `--color-warn` |
| Failed | `#ff7b72` | `--color-bad` |

### Panel tokens (`premiere/index.html`)

| Token | Value | Role |
|---|---|---|
| `--timeline` | `#1d1d1d` | panel background, as Premiere's own panels |
| `--track` | `rgba(255,255,255,.03)` | a step at rest |
| `--track-open` | `rgba(255,255,255,.05)` | the open step |
| `--inset` | `rgba(0,0,0,.28)` | lists, fields, previews: set into the panel, darker than the surface |
| `--edge` | `rgba(255,255,255,.08)` | standard edge |
| `--edge-soft` | `rgba(255,255,255,.05)` | separators |
| `--edge-strong` | `rgba(255,255,255,.14)` | open step, hover |
| `--ink` | `#ececec` | text, primary |
| `--ink-2` | `#b6b6b6` | text, secondary |
| `--ink-3` | `#8f8f8f` | text, meta (contrast 4.5:1 or better) |
| `--ink-4` | `#6c6c6c` | text, disabled only |
| `--check` | `#dcdcdc` | checkboxes |
| `--playhead` / `--on-playhead` | `#ff6a3d` / `#140802` | the accent and its text |
| `--render-*` | ok, warn, bad, wait | render bar and status |

The app keeps its own Tailwind tokens (`src/index.css`, `--color-*`), with the same accent and status
roles.

## Depth

- Use borders only, with low-opacity rgba edges. There are no shadows: they don't read on dark.
- Insets are darker than their surroundings.
- Inside Premiere (Chrome 99), dim regions with plain shaded blocks, not huge box-shadows; those don't
  render reliably there.

## Spacing and shape

- Base unit: 4 px.
- Step header: 10 px × 12 px. Step body: `0 12 12 42` (the content lines up with the step title).
- Gap between steps: 6 px. Between sections inside a step: 16 px. Field rows: 8 px.
- Radii: 5 px (fields, small), 7 px (buttons, lists, frame), 10 px (step cards).
- Narrow panels: section headers wrap (`flex-wrap`), so a button drops below its title rather than
  squeezing it. The panel must work at 300 px with no horizontal overflow.

## Type

The typeface is the system UI font (as in Premiere). Hierarchy comes from weight and colour more than
size.

| Role | Size | Weight | Colour | Notes |
|---|---|---|---|---|
| Body | 12.5 px | regular | ink-2 for hints, ink for content | |
| Project name | 15 px | 600 | ink | −0.01em tracking |
| Step title | 12.5 px | 600 | ink-2, ink when open | |
| Section label (`h3`) | 10.5 px | 600 | ink-3 | uppercase, 0.08em tracking, no wrap |
| Meta, states, counts | 11–11.5 px | regular | ink-3 | tabular figures |
| Brand | 11 px | 800 | ink-3 | 0.16em tracking |

Copy is in French. Use a narrow non-breaking space before "%" (`138 %`), "…" for anything in
progress, and counts with plurals ("1 partie", "42 parties").

## Components

| Component | Measurements | States |
|---|---|---|
| Step (panel) | `h2 > button.head` with `aria-expanded`; number circle 20 px | done: green tint + green state text; open: accent ring |
| Main action `.go` | full width, 9 × 12 px padding, radius 7, 600 weight | accent fill only in the open step; press `scale(.985)`; disabled grey with ink-4 text |
| Chip button `.chip` | 4 × 9 px padding, radius 7, 12 px, icon 13 px, transparent with `--edge` | hover: ink + edge-strong; press `scale(.97)` |
| Link `.link` | underlined, ink-2 | used for "Tout cocher", "Appliquer", "Choisir…" |
| Render bar `.render` | 5 px high, 1 px gaps, radius 2, one `<i>` per item | classes `run`, `ok`, `skip`, `bad` |
| Folded log | `details.detail` "Détail (N)" | opens on an error line |
| Zoom frame | 150 px wide, at the sequence's aspect ratio | 4 shaded blocks outside the zoom box; accent box and dot; hint on a dark backing; click or arrow keys move the point |
| Preview strips | 14 px canvas per part | cuts as accent ticks; light zoom 26 % white, full zoom 62 % white |

## Motion

- Only `transform` and `opacity` animate, under 300 ms, easing out.
- Respect `prefers-reduced-motion` (no movement, and the spinner stops).
