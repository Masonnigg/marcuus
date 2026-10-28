"""MARCUUS transcription engine: Whisper large-v3-turbo on Apple's MLX (GPU).
usage: python transcribe_mlx.py <audio.wav> <language> <prompt>
       python transcribe_mlx.py --warmup        (compile everything once, right after install)
Progress goes to stderr: tqdm "NN%|" bars and "[marcuus 1.2s] step" lines. Result JSON goes to stdout.
"""
import json
import os
import sys
import time

T0 = time.time()


def log(msg):
    print(f"[marcuus {time.time() - T0:5.1f}s] {msg}", file=sys.stderr, flush=True)


# mlx-whisper's word timing uses numba, which recompiles in every new process unless told to cache.
# Patch numba.jit before mlx_whisper imports it, so the compile happens once ever (during --warmup).
import numba  # noqa: E402

_jit = numba.jit


def _cached_jit(*args, **kwargs):
    kwargs.setdefault("cache", True)
    return _jit(*args, **kwargs)


numba.jit = _cached_jit

REPO = "mlx-community/whisper-large-v3-turbo"


def model_dir():
    """Local model folder. Never touches the network once the model is downloaded."""
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(REPO, local_files_only=True)
    except Exception as e:  # not downloaded yet (should not happen after Installer)
        log(f"modèle absent du disque ({type(e).__name__}), téléchargement…")
        return snapshot_download(REPO)


def audio_seconds(path):
    import wave

    with wave.open(path) as w:  # ffmpeg's 16 kHz mono wav
        return w.getnframes() / w.getframerate()


def drop_ghost_tail(segments, duration):
    """Whisper works in 30 s windows. When one ends a fraction of a second before the audio does, it
    decodes that scrap on its own and, with nothing left to hear, invents words ("Bonne soirée...",
    "Merci.") squeezed into the last milliseconds. Drop segments from such a final scrap when the decode
    struggled (retried with randomness) or isn't sure, or when the scrap is too short to hold a word."""
    kept = []
    for s in segments:
        left = duration - s["seek"] / 100  # seconds of audio from this window's start to the end
        words = s.get("words") or []
        unsure = words and sum(w["probability"] for w in words) / len(words) < 0.4
        if s["seek"] > 0 and left < 2 and (left < 0.5 or s["temperature"] > 0 or unsure):
            if s["text"].strip():
                log(f"ignoré (fin de l'audio) : {s['text'].strip()}")
            continue
        kept.append(s)
    return kept


def warmup():
    import numpy as np

    log("préparation : modèle")
    path = model_dir()
    log("préparation : moteur")
    import mlx_whisper
    from mlx_whisper.timing import dtw_cpu

    log("préparation : compilation des timings")
    dtw_cpu(np.random.rand(12, 12).astype(np.float32))
    log("préparation : premier passage GPU")
    noise = (np.random.randn(16000 * 2) * 0.01).astype(np.float32)
    mlx_whisper.transcribe(noise, path_or_hf_repo=path, language="fr", word_timestamps=True, verbose=None)
    log("prêt")


def main():
    if sys.argv[1:2] == ["--warmup"]:
        warmup()
        print("{}")
        return
    audio, language, prompt = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""
    log("chargement du modèle")
    path = model_dir()
    import mlx_whisper

    log("transcription")
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=path,
        language=None if language == "auto" else language,
        initial_prompt=prompt or None,
        word_timestamps=True,
        verbose=False,  # shows a tqdm progress bar on stderr
    )
    log("terminé")
    duration = audio_seconds(audio)
    words = [
        {"text": w["word"], "start": round(w["start"] * 1000), "end": round(min(w["end"], duration) * 1000), "p": round(w.get("probability", 1), 3)}
        for seg in drop_ghost_tail(result["segments"], duration)
        for w in seg.get("words", [])
        if w["start"] < duration  # never a word after the end of the audio
    ]
    json.dump({"language": result.get("language"), "duration": round(duration * 1000), "words": words}, sys.stdout, ensure_ascii=False)


main()
