"""MARCUUS ads engine: a transcript you can cut ads from.

usage: python ads_prepare.py <audio.wav> <out.json>

Plain Whisper isn't safe for picking takes from a long raw recording, so on top of it:
  1. Short chunks cut at real silences (Whisper skips whole stretches of a long file).
  2. Any speech the audio has but the text doesn't is transcribed again on its own.
  3. Invented text is dropped: looping phrases, impossibly fast words, words lying on silence.
  4. A "word" Whisper stretched over seconds of real speech is treated as a gap and re-transcribed.
  5. A second pass with a hesitant-sounding prompt writes stammers, "euh" and restarts down. It is used
     only where it says the same thing as the normal pass (it sometimes drifts into nonsense).
Output (ms): {"duration", "words": [{text, start, end, p}], "chunks": [[a, b]], "speech": [[a, b]]}.
Progress goes to stderr as "[marcuus ...] step" lines and "NN%|" bars.
"""
import json
import os
import sys
import time
import wave
from collections import Counter
from difflib import SequenceMatcher

T0 = time.time()


def log(msg):
    print(f"[marcuus {time.time() - T0:5.1f}s] {msg}", file=sys.stderr, flush=True)


def progress(pct):
    print(f"{int(pct)}%|", file=sys.stderr, flush=True)


import numba  # noqa: E402  (cache the word-timing compile, like transcribe_mlx.py)

_jit = numba.jit


def _cached_jit(*args, **kwargs):
    kwargs.setdefault("cache", True)
    return _jit(*args, **kwargs)


numba.jit = _cached_jit
import numpy as np  # noqa: E402

REPO = "mlx-community/whisper-large-v3-turbo"
PROMPT = "Ouais, t'as vu, c'est ça."
PROMPT_HESITANT = "Euh, bon, je... je pense que, euh, c'est c'est vrai, hum, en fait en fait."
FILLERS = {"euh", "heu", "hum", "hmm", "mmh", "bah", "ben", "euhm"}
HOP = 160  # 10 ms frames at 16 kHz


def model_dir():
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(REPO, local_files_only=True)
    except Exception:
        return snapshot_download(REPO)


# ---------- sound ----------
def load(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def frame_db(x):
    n = len(x) // HOP
    fr = x[: n * HOP].reshape(n, HOP)
    return 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-6)


def speech_mask(x):
    """Any sound above the room tone: where transcription looks for words."""
    db = frame_db(x)
    floor, loud = np.percentile(db, 10), np.percentile(db, 90)
    return db > floor + max(10.0, (loud - floor) * 0.30)


def voice_mask(x, drop=26.0):
    """Where the voice really is, for cutting: breaths and room noise between sentences sit ~30 dB under
    the nearby speech, while a fixed threshold lands right in them. So a frame is voice only when it is
    also within `drop` dB of the local speech level (80th percentile over 3 s)."""
    db = frame_db(x)
    n = len(db)
    centers = np.arange(0, n, 25)
    level = np.interp(np.arange(n), centers, [np.percentile(db[max(0, c - 150):c + 150], 80) for c in centers])
    return speech_mask(x) & (db > level - drop)


def runs(mask, merge=5):
    """Frames → [[start, end]] runs of True, joined across gaps under `merge` frames."""
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if out and i - out[-1][1] < merge:
                out[-1][1] = j
            else:
                out.append([i, j])
            i = j
        else:
            i += 1
    return out


def chunk_plan(sp):
    """Chunks of 8–28 s, cut in the middle of silences."""
    n, cuts, i = len(sp), [], 0
    while i < n:
        if not sp[i]:
            j = i
            while j < n and not sp[j]:
                j += 1
            if j - i >= 35:
                cuts.append(((i + j) // 2, j - i))
            i = j
        else:
            i += 1
    chunks, start = [], 0
    while start < n:
        cand = [(c, L) for c, L in cuts if start + 800 <= c <= start + 2800]
        if start + 2800 >= n:
            end = n
        elif cand:
            late = [cl for cl in cand if cl[0] >= start + 1500]
            end = max(late or cand, key=lambda cl: cl[1])[0]
        else:
            end = start + 2800
        chunks.append((start, end))
        start = end
    return chunks


# ---------- whisper ----------
def transcribe(mlx_whisper, model, x, lo, hi, prompt):
    """Frames lo..hi → words with absolute ms times."""
    r = mlx_whisper.transcribe(x[lo * HOP: hi * HOP], path_or_hf_repo=model, language="fr", initial_prompt=prompt,
                               word_timestamps=True, verbose=None, condition_on_previous_text=False)
    out = []
    for s in r["segments"]:
        for w in s.get("words", []):
            st, en = w["start"] + lo / 100, min(w["end"] + lo / 100, hi / 100)
            if st < hi / 100:
                out.append({"text": w["word"], "start": round(st * 1000), "end": round(en * 1000), "p": round(w.get("probability", 1), 3)})
    return out


def missing(sp, words):
    """Stretches with speech but no word on them (a word over 1.5 s only covers its two ends)."""
    cov = np.zeros(len(sp), bool)
    for w in words:
        a, b = int(w["start"] / 10), int(w["end"] / 10)
        if b - a > 150:
            cov[max(0, a - 30): a + 75] = True
            cov[b - 75: b + 30] = True
        else:
            cov[max(0, a - 30): b + 30] = True
    out = []
    for a, b in runs(sp & ~cov, merge=50):
        if (sp[a:b] & ~cov[a:b]).sum() >= 40:
            out.append((a, b))
    return out


def fill_gaps(mlx_whisper, model, x, sp, words, prompt):
    for _ in range(2):
        added = []
        for a, b in missing(sp, words):
            lo, hi = max(0, a - 60), min(len(sp), b + 60)
            prev_end = max([w["end"] for w in words if w["end"] <= a * 10] or [0])
            next_start = min([w["start"] for w in words if w["start"] >= b * 10] or [len(sp) * 10])
            lo, hi = max(lo, int(prev_end / 10)), min(hi, int(next_start / 10))
            if hi - lo < 20:
                continue
            for w in transcribe(mlx_whisper, model, x, lo, hi, prompt):
                w["fill"] = 1
                added.append(w)
        if not added:
            break
        words = sorted(words + added, key=lambda w: w["start"])
    return words


def drop_invented(words, sp):
    # gap-fill text that loops or is impossibly fast
    groups, cur = [], []
    for i, w in enumerate(words):
        if w.get("fill"):
            if cur and w["start"] - words[cur[-1]]["end"] < 1500:
                cur.append(i)
            else:
                if cur:
                    groups.append(cur)
                cur = [i]
    if cur:
        groups.append(cur)
    drop = set()
    for g in groups:
        dur = max(0.3, (words[g[-1]]["end"] - words[g[0]]["start"]) / 1000)
        toks = [words[i]["text"].strip().lower() for i in g]
        loop = Counter(zip(toks, toks[1:])).most_common(1)
        if len(g) / dur > 9 or (loop and loop[0][1] >= 4):
            drop.update(g)
            log(f"texte inventé ignoré ({len(g)} mots à {words[g[0]]['start'] / 1000:.1f} s)")
    words = [w for i, w in enumerate(words) if i not in drop]
    # words lying entirely on silence
    words = [w for w in words if sp[max(0, int(w["start"] / 10) - 5): int(w["end"] / 10) + 5].any()]
    # a word overlapping words found inside it ends where the first of them starts
    words.sort(key=lambda w: w["start"])
    for i, w in enumerate(words):
        inner = [y["start"] for y in words[i + 1:i + 400] if w["start"] + 300 < y["start"] < w["end"] - 100]
        if inner:
            w["end"] = min(inner)
    return words


def norm(t):
    import unicodedata
    t = unicodedata.normalize("NFD", t.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return "".join(c for c in t if c.isalnum())


def content(ws):
    seq = [x for x in (norm(w["text"]) for w in ws) if x and x not in FILLERS]
    out = []
    for x in seq:
        if not out or out[-1] != x:
            out.append(x)
    return out


def merge(normal, hesitant, chunks):
    """Per chunk: the hesitant pass only where it says the same thing as the normal one."""
    words = []
    for c0, c1 in chunks:
        lo, hi = c0 * 10, c1 * 10
        wa = [w for w in normal if lo <= w["start"] < hi]
        wb = [w for w in hesitant if lo <= w["start"] < hi]
        r = SequenceMatcher(None, content(wa), content(wb), autojunk=False).ratio() if (wa or wb) else 1
        words += wb if r >= 0.85 else wa
    return sorted(words, key=lambda w: w["start"])


def main():
    wav, out_path = sys.argv[1], sys.argv[2]
    log("chargement du modèle")
    model = model_dir()
    import mlx_whisper
    x = load(wav)
    sp = speech_mask(x)
    chunks = chunk_plan(sp)
    steps = [c for c in chunks if sp[c[0]:c[1]].any()]
    total = 2 * len(steps) + 2
    done = 0
    passes = {}
    for name, prompt in (("normale", PROMPT), ("hésitations", PROMPT_HESITANT)):
        log(f"transcription ({name})")
        words = []
        for a, b in steps:
            words += transcribe(mlx_whisper, model, x, a, b, prompt)
            done += 1
            progress(done / total * 100)
        log(f"trous ({name})")
        words = fill_gaps(mlx_whisper, model, x, sp, words, prompt)
        words = drop_invented(words, sp)
        done += 1
        progress(done / total * 100)
        passes[name] = words
    words = merge(passes["normale"], passes["hésitations"], chunks)
    for w in words:
        w.pop("fill", None)
    out = {
        "duration": round(len(x) / 16),
        "words": words,
        "chunks": [[a * 10, b * 10] for a, b in chunks],
        "speech": [[a * 10, b * 10] for a, b in runs(voice_mask(x))],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    log("terminé")
    print("{}")


if __name__ == "__main__":
    main()
