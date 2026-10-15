---
name: recording-demo-videos
description: Use when asked to record an automated demo, POC, pitch or walkthrough video of a web app (also "gravar vídeo de demonstração / apresentação de fluxo") — scripted screen recording with Playwright, on-screen captions, optional AI voice-over (TTS narration in English or Portuguese), mp4 output.
argument-hint: "[audio [en|pt] [kokoro|edge]]"
---

# Recording automated demo videos (Playwright)

## Mode (decide FIRST)

Arguments received: `$ARGUMENTS`

| Arguments | Mode | Template |
|---|---|---|
| contain `audio` (or the request asks for voice / voice-over / spoken narration) | **Narrated** — TTS voice + captions | [record-demo-narrated-template.mjs](record-demo-narrated-template.mjs) + [narrate.py](narrate.py) |
| empty / anything else | **Silent** — captions only (default) | [record-demo-template.mjs](record-demo-template.mjs) |

Narrated mode: language `en` (default) or `pt` (Brazilian Portuguese); engine `auto` (default: English → `kokoro` offline; Portuguese → `edge`, falling back to `kokoro` when offline), or force `kokoro` / `edge`. Examples: `audio`, `audio pt`, `audio pt kokoro`, `audio en edge`. Also follow **Narrated mode** below.

Write captions and narration in the language chosen (`en` unless `pt` was given or the user writes in Portuguese).

## Overview

A demo video is **code, not a manual capture**: a Playwright script drives the browser with native recording, overlaid captions and visual highlights. Re-recordable whenever the product changes (`npm run demo:record`), with controlled pacing and story.

**Core principle: the video is a pitch, not an E2E test.** Every scene exists to prove one argument — and the work is only done after you VERIFY the generated video frame by frame.

## When to use / not use

- ✅ Web product POC/demo for investors, customers, stakeholders, onboarding
- ✅ Documenting an end-to-end flow that keeps evolving (re-recordable)
- ✅ With a voice: narrated mode (local/offline TTS) — see above
- ❌ Automated tests (use Playwright Test) · ❌ non-web apps · ❌ capturing the app's own sound (Playwright doesn't record browser audio)

## Process

1. **Deterministic state first.** The video performs real actions (logins, clicks, DB writes). Ensure idempotent seed/demo data and dedicated accounts before recording. Run the server in production mode (`build && start`) or warm up routes in dev — lazy compilation shows up as a white screen in the video.
2. **Write the script BEFORE coding.** A 4-act pitch arc: *the vision* (opening) → *how it works* (the differentiator, inside) → *the end-user experience* → *the proof/result* (close on the vision). Each scene = 1 argument + 1 caption (strong headline + explanatory subtext). Target: **60–120s total, 3–5s on each key screen**.
3. **Adapt the template** — ready-made helpers for captions, highlights, login, pacing and conversion. Use the project's brand colors for the caption.
4. **Record**, and treat selector failures as a broken script (fix it, don't work around it).
5. **VERIFY the video — mandatory.** Duration and scenes:
   ```bash
   ffprobe -v error -show_entries format=duration -of csv=p=0 demo.mp4
   # grab 1 frame per scene and LOOK at each one (right caption? right screen? nothing broken?)
   ffmpeg -y -ss <t> -i demo.mp4 -frames:v 1 -vf scale=800:-1 frame_<t>.png
   ```
   Only deliver after inspecting the frames. If a scene failed, re-record.
6. **Deliver `.mp4`** (works in PowerPoint/Slack/WhatsApp) besides the `.webm`. Leave an npm script (`demo:record`) and gitignore the output (it's regenerable).

## Narrated mode (`audio`)

Same process as above, with these differences:

- **Prerequisites:** `uv` and `ffmpeg` on PATH (`uv --version`, `ffmpeg -version`). Copy `narrate.py` into the SAME folder as the recording script. The first run downloads the Kokoro model (~120 MB, cached in `~/.cache/recording-demo-videos`).
- **Pacing comes from the audio.** Each scene in `SCRIPT` has `caption` (screen) + `say` (speech, 1–2 sentences, pitch tone). `await narrate(page, "id")` shows the caption, places the speech and waits for it to finish — don't use a fixed `pause()` on spoken scenes. Speaking during an interaction: `narrate(page, id, { wait: false })`; the next `narrate()` waits for the previous speech (no overlap).
- **Language/voice via env:** `DEMO_LANG=en|pt`, `DEMO_TTS=auto|kokoro|edge`, `DEMO_VOICE=<voice>` (Kokoro: `af_heart`, `am_michael`, `bf_emma`, `pf_dora`, `pm_alex`; edge: `en-US-AvaMultilingualNeural`, `pt-BR-FranciscaNeural`…). `kokoro` = offline, Apache-2.0, default for English; its Portuguese is noticeably less natural. `edge` = default for Portuguese, best voices, but online via an unofficial Microsoft endpoint — fine for internal demos; for commercial use prefer `kokoro` or an official TTS.
- **Sync is automatic:** the template opens with a magenta flash (`syncMarker`), measures the real video start delay and trims the flash. Keep `syncMarker` as the first action; if the log says "Sync marker not found", the voice will be out of sync — check that `syncMarker` is the first action and nothing covers the screen in the first second, then re-record.
- **Output:** `demo.mp4` (narrated — the deliverable), `demo.srt`, `timeline.json`, `demo.raw.webm` (raw, silent), `audio/` (cache: re-recording only re-synthesizes changed lines).
- **Extra verification (mandatory):** besides the frames, confirm the voice lands in the right place:
  ```bash
  ffprobe -v error -show_entries stream=codec_type,duration -of csv=p=0 demo.mp4   # must have video AND audio
  ffmpeg -i demo.mp4 -af silencedetect=n=-45dB:d=0.6 -f null - 2>&1 | grep silence_end
  # each silence_end ≈ a scene's atVideo in timeline.json (±0.2s); grab the frame at that time and check the caption
  ```

## Pitfalls (learned the hard way)

| Pitfall | Fix |
|---------|-----|
| Video gets a random file name | Grab `page.video()` BEFORE closing; `await video.path()` AFTER `context.close()`; rename |
| Caption disappears on navigation | Re-inject the caption after every `goto` (`caption()` helper), or `addInitScript` + sessionStorage |
| Video too fast for humans | `slowMo: 100–150` + explicit 3–5s pauses per scene + `pressSequentially({ delay: 40–60 })` for visible typing |
| mp4 won't open in PowerPoint/players | `ffmpeg -c:v libx264 -pix_fmt yuv420p` |
| Video smaller/cropped | `recordVideo.size` MUST equal `viewport` |
| White/pending screen in the video | `waitUntil: "networkidle"` + `waitForURL` after actions; warm up routes in dev |
| Viewer doesn't know where to look | Amber highlight (box-shadow) on the element before clicking, or an injected fake cursor |
| Re-recording duplicates data | Idempotent actions or a seed that tolerates re-runs (suffixed slugs, upserts) |
| Login leaks between personas | `context.clearCookies()` between user switches |
| (narrated) Voice out of sync with the screen | Playwright's video starts 0.2–1.5s after the page (varies per run/version) — use the template's `syncMarker`, never a fixed offset |
| (narrated) Voice cut off or scenes rushed | Fixed `pause()` on a spoken scene — replace with `narrate()`, which waits for the speech |
| (narrated) Acronym/brand mispronounced | Spell it phonetically in `say` (e.g. "S Q L" or "sequel"); the caption stays correct |

## Common mistakes

- Skipping frame verification ("it ran without errors" ≠ "the video is good") — **always look**.
- Captions describing the UI ("login screen") instead of narrating the argument ("the team signs in — fine-grained role control").
- Recording without a written script: you get a long screencast with no story.
- Real credentials hardcoded — use demo/seed accounts, inject via env if sensitive.
