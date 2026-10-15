# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.4", "soundfile>=0.12", "edge-tts>=7"]
# ///
"""
Per-scene TTS narration for the demo video (the skill's `audio` mode).

Usage (uv installs the dependencies on first run):
  uv run narrate.py scenes.json OUT_DIR [--lang en|pt] [--engine auto|kokoro|edge] [--voice V] [--speed 1.0]

scenes.json: {"<scene id>": "spoken text", ...}
Output: OUT_DIR/<id>.wav|.mp3 + OUT_DIR/manifest.json {"<id>": {"file", "duration"}}
Re-runs only re-synthesize scenes whose text/voice changed (hash cache).

Engines:
  auto (default) — English → kokoro; Portuguese → edge (falls back to kokoro when offline).
  kokoro         — Kokoro-82M, Apache-2.0, offline, CPU. Excellent English; Portuguese is usable
                   but noticeably less natural. Model (~120 MB) downloaded once to
                   ~/.cache/recording-demo-videos/kokoro.
  edge           — Microsoft neural voices via edge-tts. Best Portuguese quality, but needs
                   internet and uses an unofficial endpoint. Internal/draft use.
"""
import argparse
import asyncio
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import soundfile as sf

AUTO_ENGINE = {"en": "kokoro", "pt": "edge"}
DEFAULT_VOICES = {
    "kokoro": {"en": "af_heart", "pt": "pf_dora"},
    "edge": {"en": "en-US-AvaMultilingualNeural", "pt": "pt-BR-FranciscaNeural"},
}
# Kokoro voice prefix → phonemizer language code
KOKORO_LANG = {"a": "en-us", "b": "en-gb", "p": "pt-br"}
KOKORO_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin")
CACHE = Path.home() / ".cache" / "recording-demo-videos" / "kokoro"


def kokoro_engine():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in KOKORO_FILES:
        dest = CACHE / name
        if not dest.exists():
            print(f"[narrate] Downloading {name} (one time)...", file=sys.stderr)
            urllib.request.urlretrieve(KOKORO_URL + name, dest.with_suffix(".part"))
            dest.with_suffix(".part").rename(dest)
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(CACHE / KOKORO_FILES[0]), str(CACHE / KOKORO_FILES[1]))

    def synth(text, voice, speed, out_base):
        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=KOKORO_LANG[voice[0]])
        out = out_base.with_suffix(".wav")
        sf.write(str(out), samples, sr)
        return out

    return synth


def edge_engine():
    import edge_tts

    def synth(text, voice, speed, out_base):
        out = out_base.with_suffix(".mp3")
        rate = f"{round((speed - 1) * 100):+d}%"
        asyncio.run(edge_tts.Communicate(text, voice, rate=rate).save(str(out)))
        return out

    return synth


def edge_reachable():
    try:
        urllib.request.urlopen("https://speech.platform.bing.com", timeout=4)
        return True
    except urllib.error.HTTPError:
        return True  # the host answered — reachable
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenes")
    ap.add_argument("out_dir")
    ap.add_argument("--lang", choices=["en", "pt"], default="en")
    ap.add_argument("--engine", choices=["auto", "kokoro", "edge"], default="auto")
    ap.add_argument("--voice")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    scenes = json.loads(Path(args.scenes).read_text(encoding="utf-8"))
    engine = AUTO_ENGINE[args.lang] if args.engine == "auto" else args.engine
    if engine == "edge" and args.engine == "auto" and not edge_reachable():
        print("[narrate] edge-tts unreachable (offline?) — falling back to kokoro.", file=sys.stderr)
        engine = "kokoro"
    voice = args.voice or DEFAULT_VOICES[engine][args.lang]
    print(f"[narrate] engine={engine} voice={voice}", file=sys.stderr)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    synth = None
    manifest = {}
    for scene_id, text in scenes.items():
        key = hashlib.sha1(f"{engine}|{voice}|{args.speed}|{text}".encode()).hexdigest()
        prev = old.get(scene_id)
        if prev and prev.get("hash") == key and Path(prev["file"]).exists():
            manifest[scene_id] = prev
            continue
        synth = synth or (kokoro_engine() if engine == "kokoro" else edge_engine())
        out = synth(text, voice, args.speed, out_dir / scene_id)
        manifest[scene_id] = {
            "file": str(out.resolve()),
            "duration": round(sf.info(str(out)).duration, 3),
            "hash": key,
        }
        print(f"[narrate] {scene_id}: {manifest[scene_id]['duration']}s", file=sys.stderr)

    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
