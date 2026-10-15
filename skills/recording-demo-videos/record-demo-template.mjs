/**
 * TEMPLATE — automated demo video recording (Playwright + Chromium), captions only.
 * Adapt: CONFIG, brand colors and the SCENES.
 *
 * Prerequisites:
 *   npm i -D playwright && npx playwright install chromium
 *   app running (production build or warmed-up dev) + seeded demo data
 * Output: OUT_DIR/demo.webm (+ .mp4 if ffmpeg is on PATH)
 *
 * Golden rules:
 *   - recordVideo.size === viewport
 *   - call caption() again after EVERY navigation (the DOM is recreated)
 *   - pause 3–5s on key screens; slowMo sets the base rhythm
 *   - VERIFY the result: ffprobe (duration) + ffmpeg frames + visual inspection
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = resolve(import.meta.dirname, "..", "docs", "demo");
const VIEWPORT = { width: 1280, height: 800 };
const BRAND = { bg: "#1f2937", accent: "#f59e0b", fg: "#f9fafb" }; // brand colors
const VIDEO_NAME = "demo";
const LOCALE = process.env.DEMO_LANG === "pt" ? "pt-BR" : "en-US";

// ─── Scene helpers ───────────────────────────────────────────────────────────

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

/** Login with visible typing. Adjust the selectors to your app. */
async function login(page, { email, password }, captionArgs) {
  await goto(page, "/login");
  if (captionArgs) await caption(page, ...captionArgs);
  await pause(page, 1200);
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

  const browser = await chromium.launch({ slowMo: 120 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT }, // size === viewport!
    locale: LOCALE,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // ══ ACT 1 — THE VISION: open with the product's core argument ══
  await goto(page, "/");
  await caption(page, "PRODUCT NAME — the core argument", "subtext: pitch context");
  await pause(page, 3500);

  // ══ ACT 2 — HOW IT WORKS: the differentiator, inside ══
  await login(page, { email: "demo@example.dev", password: "demo-password" }, [
    "Persona X signs in", "what this proves",
  ]);
  // ... walk through key screens; for each one:
  //   await goto(page, "/route"); await caption(page, "Argument", "detail"); await pause(page, 4000);
  // Interactions: await highlight(loc); await loc.click(); await page.waitForLoadState("networkidle");
  // Visible typing: await input.pressSequentially("text", { delay: 50 });
  // Reading scroll: await page.mouse.wheel(0, 600); await pause(page, 2000);

  // ══ ACT 3 — THE EXPERIENCE: switch persona if the product has two sides ══
  // await context.clearCookies();  // hard logout between personas
  // await login(page, { email: "user@example.dev", password: "..." }, ["The end-user experience"]);

  // ══ ACT 4 — THE PROOF: metrics/result; close by returning to the vision ══
  await goto(page, "/");
  await caption(page, "Close by repeating the vision.", "the pitch's last line");
  await pause(page, 4000);

  // ─── Finish: grab video BEFORE closing, path AFTER context.close ───
  const video = page.video();
  await context.close();
  await browser.close();

  const rawPath = await video.path(); // random name generated by Playwright
  const webm = join(OUT_DIR, `${VIDEO_NAME}.webm`);
  renameSync(rawPath, webm);
  console.log(`[demo] Recorded: ${webm}`);

  try {
    const mp4 = join(OUT_DIR, `${VIDEO_NAME}.mp4`);
    execFileSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", mp4], { stdio: "ignore" });
    if (existsSync(mp4)) console.log(`[demo] Converted: ${mp4}`);
  } catch {
    console.log("[demo] No ffmpeg — kept the .webm (opens in a browser).");
  }

  console.log("[demo] NOW VERIFY: ffprobe (duration) + extract one frame per scene and inspect it.");
}

main().catch((err) => {
  console.error("[demo] Recording failed:", err);
  process.exitCode = 1;
});
