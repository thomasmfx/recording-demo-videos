/**
 * NARRATED TEMPLATE — demo video with TTS voice-over (the skill's `audio` mode).
 * Same flow as record-demo-template.mjs, but every scene has a synthesized line
 * and THE PACING COMES FROM THE AUDIO: a scene lasts as long as its speech (never cut off).
 *
 * Prerequisites:
 *   npm i -D playwright && npx playwright install chromium
 *   uv (https://docs.astral.sh/uv/) + ffmpeg on PATH
 *   narrate.py copied into the SAME folder as this script
 * Output (OUT_DIR): demo.mp4 (narrated, the DELIVERABLE) · demo.srt · timeline.json
 *                   demo.raw.webm (raw, silent) · audio/ (speech clips + cache)
 *
 * Flow: 1) synthesize all lines (before the browser) → 2) record, noting when each line
 * starts → 3) ffmpeg places every line at its moment and produces the mp4.
 *
 * Golden rules (on top of the silent template's):
 *   - every key scene = await narrate(page, "id") — shows the caption, plays the line, waits
 *   - narrate(page, id, { wait: false }) to talk DURING interactions (login, typing);
 *     the next narrate() waits for the previous line to end — lines never overlap
 *   - 1–2 sentences per scene; the spoken text can be more natural than the caption
 *   - call caption() again after navigations made in the middle of a long line
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = resolve(import.meta.dirname, "..", "docs", "demo");
const VIEWPORT = { width: 1280, height: 800 };
const BRAND = { bg: "#1f2937", accent: "#f59e0b", fg: "#f9fafb" }; // brand colors
const VIDEO_NAME = "demo";
const NARRATION = {
  lang: process.env.DEMO_LANG ?? "en", // en | pt
  engine: process.env.DEMO_TTS ?? "auto", // auto (en→kokoro offline, pt→edge) | kokoro | edge
  voice: process.env.DEMO_VOICE, // optional; default: af_heart (en, kokoro) / pt-BR-FranciscaNeural (pt, edge)
  speed: 1.0,
  gapMs: 700, // breathing room between the end of a line and the next scene
  offsetMs: Number(process.env.DEMO_AUDIO_OFFSET_MS ?? 0), // manual fine-tuning (normally 0)
};

// ─── SCRIPT: caption (screen) + say (voice) per scene ────────────────────────
const SCRIPT = {
  vision: {
    caption: ["PRODUCT NAME — the core argument", "subtext: pitch context"],
    say: "This is Product X. In ninety seconds, you'll see how it turns a manual process into a single click.",
  },
  login: {
    caption: ["Persona X signs in", "what this proves"],
    say: "The operations team signs in with their own role, and sees only what they're allowed to.",
  },
  closing: {
    caption: ["Close by repeating the vision.", "the pitch's last line"],
    say: "That's Product X. Less manual work, and every step accounted for.",
  },
};

// ─── Narration ───────────────────────────────────────────────────────────────
let clips = {};
let t0 = 0;
let busyUntil = 0;
const timeline = [];
const now = () => performance.now() - t0;

/** Synthesizes every line BEFORE opening the browser (cached: only redoes what changed). */
function synthesize() {
  const audioDir = join(OUT_DIR, "audio");
  mkdirSync(audioDir, { recursive: true });
  const scenesJson = join(audioDir, "scenes.json");
  writeFileSync(scenesJson, JSON.stringify(Object.fromEntries(Object.entries(SCRIPT).map(([id, s]) => [id, s.say]))));
  const args = ["run", resolve(import.meta.dirname, "narrate.py"), scenesJson, audioDir,
    "--lang", NARRATION.lang, "--engine", NARRATION.engine, "--speed", String(NARRATION.speed)];
  if (NARRATION.voice) args.push("--voice", NARRATION.voice);
  execFileSync("uv", args, { stdio: ["ignore", "ignore", "inherit"] });
  clips = JSON.parse(readFileSync(join(audioDir, "manifest.json"), "utf8"));
  const total = Object.values(clips).reduce((s, c) => s + c.duration, 0);
  console.log(`[demo] ${Object.keys(clips).length} lines synthesized, ${total.toFixed(1)}s of voice`);
}

/** Caption + line for the scene. Waits for the previous line; with wait:true also waits for this one. */
async function narrate(page, id, { wait = true, hold = 0 } = {}) {
  const scene = SCRIPT[id];
  const clip = clips[id];
  if (!scene || !clip) throw new Error(`Scene "${id}" has no synthesized line`);
  if (busyUntil > now()) await page.waitForTimeout(busyUntil - now());
  const at = now(); // BEFORE caption(): slowMo delays the evaluate's return
  await caption(page, ...scene.caption);
  timeline.push({ id, at, ...clip, text: scene.caption.filter(Boolean).join(" — ") });
  busyUntil = at + clip.duration * 1000 + NARRATION.gapMs;
  if (wait) await page.waitForTimeout(busyUntil - now() + hold);
}

/**
 * Sync marker: Playwright's video starts 0.2–1s+ AFTER the page opens (varies per run and
 * version) and only records repaints. After an animated pre-roll, a magenta flash measured
 * on the clock and found in the video gives the exact offset; the mux trims it all away.
 */
let syncMark = 0;
async function syncMarker(page) {
  // Pre-roll: an animated page makes the recorder emit frames continuously (it only records
  // repaints and may start 1s+ late), so it is surely rolling when the flash appears.
  await page.setContent("<style>@keyframes k{from{background:#111}to{background:#222}}" +
    "body{margin:0;height:100vh;animation:k .2s infinite alternate}</style>");
  await page.waitForTimeout(2500);
  syncMark = now(); // clock time of the flash START (same mechanism as caption(): an evaluate)
  await page.evaluate(() => { document.body.style.animation = "none"; document.body.style.background = "#ff00ff"; });
  await page.waitForTimeout(500);
}

/** Finds the magenta flash in the video → { offsetMs (video − clock), trimS (end of flash) }. */
function findSyncMarker(webm) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-t", "8", "-i", webm, "-vf",
    "crop=iw/2:ih/2:iw/4:ih/4,signalstats,metadata=print:file=-",
    "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // magenta ≈ U 202 / V 222; red (U~104) and blue (V~88) don't pass
  const frames = [...out.matchAll(/pts_time:([\d.]+)[\s\S]*?UAVG=([\d.]+)[\s\S]*?VAVG=([\d.]+)/g)]
    .map((m) => ({ t: Number(m[1]), magenta: Number(m[2]) > 185 && Number(m[3]) > 205 }));
  const start = frames.find((f) => f.magenta);
  if (!start) {
    console.warn("[demo] Sync marker not found — audio may be out of sync.");
    return { offsetMs: 0, trimS: 0 };
  }
  const end = frames.find((f) => f.t > start.t && !f.magenta);
  return { offsetMs: start.t * 1000 - syncMark, trimS: end ? end.t : start.t + 0.5 };
}

/** Places every line at its recorded moment and produces the narrated mp4 + .srt. */
function mux(webm) {
  const mp4 = join(OUT_DIR, `${VIDEO_NAME}.mp4`);
  const { offsetMs, trimS } = findSyncMarker(webm);
  const shift = offsetMs - trimS * 1000 + NARRATION.offsetMs; // clock → time in the mp4
  timeline.forEach((t) => { t.atVideo = Math.max(0, Math.round(t.at + shift)); });
  console.log(`[demo] Sync: video ${Math.round(offsetMs)}ms vs clock; flash trimmed (${trimS}s)`);

  const args = ["-y", "-v", "error", "-ss", String(trimS), "-i", webm];
  timeline.forEach((t) => args.push("-i", t.file));
  const chains = timeline.map((t, i) => `[${i + 1}:a]aresample=48000,adelay=${t.atVideo}:all=1[a${i}]`);
  const mix = `${timeline.map((_, i) => `[a${i}]`).join("")}amix=inputs=${timeline.length}:normalize=0:duration=longest,` +
    "loudnorm=I=-16:TP=-1.5,aresample=48000,apad[aout]";
  args.push("-filter_complex", [...chains, mix].join(";"), "-map", "0:v", "-map", "[aout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-shortest", mp4);
  execFileSync("ffmpeg", args, { stdio: "inherit" });

  const ts = (ms) => new Date(Math.max(0, ms)).toISOString().slice(11, 23).replace(".", ",");
  const srt = timeline.map((t, i) =>
    `${i + 1}\n${ts(t.atVideo)} --> ${ts(t.atVideo + t.duration * 1000)}\n${t.text}\n`).join("\n");
  writeFileSync(join(OUT_DIR, `${VIDEO_NAME}.srt`), srt);
  writeFileSync(join(OUT_DIR, "timeline.json"), JSON.stringify(timeline, null, 2));
  return mp4;
}

// ─── Scene helpers (same as the silent template) ─────────────────────────────

/** Narrated caption pinned to the bottom. Call again after every navigation. */
async function caption(page, text, subtext = "") {
  await page.evaluate(
    ([t, s, brand]) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText = [
          "position:fixed", "left:50%", "bottom:24px", "transform:translateX(-50%)",
          "z-index:2147483647", `background:${brand.bg}`, `color:${brand.fg}`,
          "padding:14px 22px", "border-radius:10px",
          "font-family:ui-sans-serif,system-ui,sans-serif", "font-size:17px",
          "line-height:1.35", "max-width:860px", "text-align:center",
          "box-shadow:0 8px 30px rgba(0,0,0,.45)",
          `border-left:5px solid ${brand.accent}`,
          "pointer-events:none", "transition:opacity .3s",
        ].join(";");
        document.body.appendChild(el);
      }
      const strong = document.createElement("strong");
      strong.textContent = t;
      el.replaceChildren(strong);
      if (s) {
        const sub = document.createElement("span");
        sub.style.cssText = "display:block;font-size:14px;opacity:.85";
        sub.textContent = s;
        el.append(sub);
      }
      el.style.opacity = "1";
    },
    [text, subtext, BRAND],
  );
}

/** Temporary amber highlight on the element before interacting — guides the eye. */
async function highlight(locator) {
  try {
    await locator.evaluate((el, accent) => {
      const prev = el.style.boxShadow;
      el.style.boxShadow = `0 0 0 4px ${accent}e6`;
      el.style.borderRadius = el.style.borderRadius || "8px";
      setTimeout(() => { el.style.boxShadow = prev; }, 900);
    }, BRAND.accent);
  } catch { /* cosmetic — never fail the recording */ }
  await locator.page().waitForTimeout(950);
}

const pause = (page, ms) => page.waitForTimeout(ms);
const goto = (page, path) => page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });

/** Login with visible typing, narrated on top (wait:false). Adjust the selectors. */
async function login(page, { email, password }, sceneId) {
  await goto(page, "/login");
  if (sceneId) await narrate(page, sceneId, { wait: false });
  await pause(page, 800);
  const emailInput = page.locator("#email"); // ADJUST
  await highlight(emailInput);
  await emailInput.pressSequentially(email, { delay: 45 });
  await page.locator("#password").pressSequentially(password, { delay: 30 }); // ADJUST
  const signIn = page.getByRole("button", { name: "Sign in", exact: true }); // ADJUST
  await highlight(signIn);
  await signIn.click();
  await page.waitForLoadState("networkidle");
}

// ─── Script ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  synthesize(); // a failure here = no uv/network to download the model; nothing recorded yet

  const browser = await chromium.launch({ slowMo: 120 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT }, // size === viewport!
    locale: NARRATION.lang === "pt" ? "pt-BR" : "en-US",
  });
  const page = await context.newPage();
  t0 = performance.now();
  page.setDefaultTimeout(30000);
  await syncMarker(page); // ALWAYS the first action — the mux measures and trims this flash

  // ══ ACT 1 — THE VISION ══
  await goto(page, "/");
  await narrate(page, "vision");

  // ══ ACT 2 — HOW IT WORKS ══
  await login(page, { email: "demo@example.dev", password: "demo-password" }, "login");
  // Key screens: await goto(page, "/route"); await narrate(page, "scene");
  // Talk during interaction: await narrate(page, "scene", { wait: false }); ...clicks...
  // Scene without speech: await caption(page, "...", "..."); await pause(page, 3000);

  // ══ ACT 3 — THE EXPERIENCE (switch persona if there is one) ══
  // await context.clearCookies();

  // ══ ACT 4 — THE PROOF; close on the vision ══
  await goto(page, "/");
  await narrate(page, "closing", { hold: 1000 });

  // ─── Finish ───
  const video = page.video();
  await context.close();
  await browser.close();

  const webm = join(OUT_DIR, `${VIDEO_NAME}.raw.webm`); // raw, silent, includes the flash
  renameSync(await video.path(), webm);
  const mp4 = mux(webm);
  if (existsSync(mp4)) console.log(`[demo] Narrated: ${mp4} (+ ${VIDEO_NAME}.srt, timeline.json)`);
  console.log("[demo] NOW VERIFY: one frame per scene + voice sync (silencedetect vs timeline.json).");
}

main().catch((err) => {
  console.error("[demo] Recording failed:", err);
  process.exitCode = 1;
});
