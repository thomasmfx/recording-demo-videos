/**
 * EXAMPLE — the narrated demo in this repo's README. It records "Launch Checklist", a
 * fictional sample app in ./app (served locally by this script), using the narrated
 * template with a real SCRIPT filled in.
 *
 * Run (from the repo root):
 *   npm install && npx playwright install chromium            # plus uv + ffmpeg on PATH
 *   node examples/sample-app/record-demo.mjs                  # English (Kokoro, offline)
 *   DEMO_LANG=pt node examples/sample-app/record-demo.mjs     # Portuguese (edge voice)
 * Output: examples/sample-app/out/demo.mp4 (+ demo.srt, timeline.json)
 */
import { chromium } from "playwright";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
let BASE = ""; // set when the local sample app server starts (see serveSampleApp)
const OUT_DIR = resolve(import.meta.dirname, "out");
const NARRATE_PY = resolve(import.meta.dirname, "..", "..", "skills", "recording-demo-videos", "narrate.py");
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
const PT = process.env.DEMO_LANG === "pt";
const SCRIPT = PT ? {
  intro: {
    caption: ["recording-demo-videos — uma skill do Claude Code", "este vídeo foi roteirizado, gravado e narrado por IA"],
    say: "Este vídeo foi roteirizado, gravado e narrado automaticamente, por uma skill do Claude Code. Sem gravador de tela, sem microfone.",
  },
  typing: {
    caption: ["Interações reais, digitadas na tela", "o Playwright controla um navegador de verdade"],
    say: "Cada clique e cada tecla são reais. O Playwright controla o navegador, digitando em ritmo humano para quem assiste acompanhar.",
  },
  highlight: {
    caption: ["Realces guiam o olhar", "contorno âmbar antes de cada clique"],
    say: "Antes de cada clique, um realce âmbar mostra exatamente para onde olhar.",
  },
  pacing: {
    caption: ["A voz dita o ritmo", "cada cena dura exatamente o tempo da sua fala"],
    say: "A narração define o ritmo. Cada cena dura exatamente o tempo da sua fala, então a voz nunca é cortada.",
  },
  closing: {
    caption: ["Um comando: /recording-demo-videos audio pt", "inglês ou português · voz offline · mp4 + legendas"],
    say: "Um comando, e a sua demo está pronta para compartilhar. Em inglês ou em português.",
  },
} : {
  intro: {
    caption: ["recording-demo-videos — a Claude Code skill", "this whole video was scripted, recorded and narrated by AI"],
    say: "This video was scripted, recorded and narrated automatically, by a Claude Code skill. No screen recorder, no microphone.",
  },
  typing: {
    caption: ["Real interactions, typed on screen", "Playwright drives a real browser"],
    say: "Every click and keystroke is real. Playwright drives the browser, typing at a human pace so viewers can follow along.",
  },
  highlight: {
    caption: ["Highlights guide the viewer's eye", "an amber outline before every click"],
    say: "Before each click, an amber highlight shows the viewer exactly where to look.",
  },
  pacing: {
    caption: ["The voice sets the pace", "each scene lasts exactly as long as its narration"],
    say: "The narration sets the pacing. Each scene lasts exactly as long as its line, so the voice is never cut off.",
  },
  closing: {
    caption: ["One command: /recording-demo-videos audio", "English or Portuguese · offline voice · mp4 + subtitles"],
    say: "One command, and your demo is ready to share. In English, or in Portuguese.",
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
  const args = ["run", NARRATE_PY, scenesJson, audioDir,
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

const TASKS = PT
  ? ["Escrever o roteiro da demo", "Gravar com /recording-demo-videos", "Compartilhar com o time"]
  : ["Write the demo script", "Record it with /recording-demo-videos", "Share it with the team"];

/** Serves ./app/index.html on a free local port — the demo needs no external site. */
async function serveSampleApp() {
  const html = readFileSync(join(import.meta.dirname, "app", "index.html"));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  BASE = `http://127.0.0.1:${server.address().port}`;
  return server;
}

// ─── Script ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  synthesize(); // a failure here = no uv/network to download the model; nothing recorded yet
  const server = await serveSampleApp();

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
  await goto(page, PT ? "/?lang=pt" : "/");
  await narrate(page, "intro");

  // ══ ACT 2 — HOW IT WORKS: real typing, narrated on top ══
  await narrate(page, "typing", { wait: false });
  const input = page.locator("#new-task");
  await highlight(input);
  for (const task of TASKS) {
    await input.pressSequentially(task, { delay: 45 });
    await input.press("Enter");
    await pause(page, 300);
  }

  // ══ ACT 3 — THE EXPERIENCE: highlight before every click ══
  await narrate(page, "highlight", { wait: false });
  for (const i of [0, 1]) {
    const toggle = page.locator("#list li input[type=checkbox]").nth(i);
    await highlight(toggle);
    await toggle.click();
  }

  // ══ ACT 4 — THE PROOF: the voice paces the filters; close on the vision ══
  await narrate(page, "pacing", { wait: false });
  for (const filter of ["done", "active", "all"]) {
    const tab = page.locator(`[data-filter="${filter}"]`);
    await highlight(tab);
    await tab.click();
    await pause(page, 900);
  }
  await narrate(page, "closing", { hold: 1500 });

  // ─── Finish ───
  const video = page.video();
  await context.close();
  await browser.close();
  server.close();

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
