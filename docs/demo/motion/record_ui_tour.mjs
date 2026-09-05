// docs/demo/motion/ui-tour.mp4 — a real screen recording of the Firstlight
// interface for the "How Firstlight works" explainer.
//
// Why it exists: the first cut of the explainer was still screenshots. This
// records the interface actually being driven — a visible cursor, real clicks,
// real navigation — and the acceptance decisions it makes are written by the
// real server to a real acceptance.json, not mocked in the browser.
//
// What it does, in order:
//   1. mirrors engine/, workspace/, reports/ and ui/dist into a throwaway
//      sandbox root under the system temp folder, so nothing in the repository
//      is ever written to (the acceptance screen writes files);
//   2. stages that sandbox so the tour has something to do — see stageSandbox();
//   3. starts ui/server/server.mjs against the sandbox on its own port;
//   4. drives Chromium through the tour with playwright's recordVideo at
//      1920x1080, drawing a synthetic cursor (Chromium's screencast does not
//      capture the pointer);
//   5. transcodes the .webm playwright writes to the explainer's spec —
//      H.264 / yuv420p / 1920x1080 / 30 fps / crf 18 / no audio.
//
// Re-runnable and idempotent: the sandbox is rebuilt from the repository every
// time and the mp4 is overwritten in place.
//
//   node docs/demo/motion/record_ui_tour.mjs
//   node docs/demo/motion/record_ui_tour.mjs --port 7345 --keep-sandbox
//
// Needs: ui/node_modules (playwright, already a devDependency) and ffmpeg on
// PATH. No network, no paid API.
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// playwright lives in ui/node_modules; this script is two folders below the
// repository root, so resolve from there rather than from the script folder.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const require = createRequire(join(ROOT, "ui", "package.json"));
const { chromium } = require("playwright");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", 7345));
const KEEP = process.argv.includes("--keep-sandbox");
const SANDBOX = join(tmpdir(), "firstlight-ui-tour");
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_MP4 = join(HERE, "ui-tour.mp4");
// Kept outside the sandbox: a sandbox that refuses to delete (Windows holds
// handles for a moment after the server exits) must never cost the recording.
const VIDEO_DIR = join(tmpdir(), "firstlight-ui-tour-video");

// The roll whose Keyframes and Takes tabs the tour opens, and the roll whose
// acceptance board it makes two decisions on. Two rolls, because the example
// workspace keeps its scene keyframes on one and its full plan-list on the other.
const KEYS_ROLL = { id: "fog-signal-check", title: "Fog signal check" };
const ACCEPT_ROLL = { id: "handover-at-the-pier", title: "Handover at the pier" };

const log = (...a) => console.log("·", ...a);

// --- sandbox -----------------------------------------------------------------

function wipe(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 350 });
}

function buildSandbox() {
  wipe(SANDBOX);
  wipe(VIDEO_DIR);
  mkdirSync(join(SANDBOX, "ui"), { recursive: true });
  for (const d of ["engine", "reports"]) cpSync(join(ROOT, d), join(SANDBOX, d), { recursive: true });
  cpSync(join(ROOT, "ui", "dist"), join(SANDBOX, "ui", "dist"), { recursive: true });
  // workspace/build is generated intermediates the interface never shows.
  const ws = join(ROOT, "workspace");
  mkdirSync(join(SANDBOX, "workspace"), { recursive: true });
  for (const d of readdirSync(ws)) {
    if (d === "build") continue;
    cpSync(join(ws, d), join(SANDBOX, "workspace", d), { recursive: true });
  }
  log(`sandbox at ${SANDBOX}`);
}

/**
 * A later pass of the example series moved the media of the two finished rolls
 * into takes/<roll>/_old/ and left the interface reading empty tabs. Nothing
 * here invents a file: every file put back is one that roll actually produced,
 * copied from its own archive to the name the server looks for.
 *
 *   _old/frames/*.png            -> takes/<roll>/            (scene keyframes,
 *                                                             plan start frames)
 *   _old/keys_old/*.png          -> takes/<roll>/keys/       (end keyframes)
 *   _old/_flf_plan<N>.mp4        -> takes/<roll>/_flf/       (the clips)
 *   _old/<roll>_s<N>_take<M>.mp4 -> takes/<roll>/s<N>_take<M>.mp4
 *
 * Only ever into the sandbox copy — the repository's workspace is never touched.
 */
function restoreArchived(id) {
  const takes = join(SANDBOX, "workspace", "takes", id);
  const old = join(takes, "_old");
  if (!existsSync(old)) return;
  let n = 0;
  const put = (from, to) => {
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    n++;
  };
  const frames = join(old, "frames");
  if (existsSync(frames)) for (const f of readdirSync(frames)) put(join(frames, f), join(takes, f));
  const keys = join(old, "keys_old");
  if (existsSync(keys)) for (const f of readdirSync(keys)) put(join(keys, f), join(takes, "keys", f));
  for (const f of readdirSync(old)) {
    let m = /^_flf_(plan\d+(?:_[A-Za-z0-9]+)?\.mp4)$/.exec(f);
    if (m) put(join(old, f), join(takes, "_flf", m[1]));
    m = new RegExp(`^${id}_(s\\d+_take\\d+\\.mp4)$`).exec(f);
    if (m) put(join(old, f), join(takes, m[1]));
  }
  if (n) log(`${id}: ${n} archived files put back where the interface reads them`);
}

/**
 * The acceptance board is only worth filming if there is something left to
 * decide, so two plans of the toured roll lose their recorded decision and go
 * back to "awaiting review". The tour then decides them for real, through the
 * server, which writes the file back.
 *
 * The two are picked from the plans that actually have a clip on disk after
 * restoreArchived(). The plan-list grows as the series is worked on, and its
 * newest plans are the ones not shot yet — an undecided plan with no clip has
 * no Accept button to press.
 */
function stageSandbox() {
  for (const id of [KEYS_ROLL.id, ACCEPT_ROLL.id]) restoreArchived(id);

  const accPath = join(SANDBOX, "workspace", ACCEPT_ROLL.id, "acceptance.json");
  const specPath = join(SANDBOX, "workspace", "plans", `${ACCEPT_ROLL.id}.json`);
  if (!existsSync(accPath) || !existsSync(specPath)) throw new Error(`${ACCEPT_ROLL.id} has no plan-list or no acceptance.json`);

  const flf = join(SANDBOX, "workspace", "takes", ACCEPT_ROLL.id, "_flf");
  const shot = new Set(
    (existsSync(flf) ? readdirSync(flf) : [])
      .map((f) => /^(plan\d+)(?:_[A-Za-z0-9]+)?\.mp4$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const decidable = spec.plans.map((p) => `plan${p.plan}`).filter((k) => shot.has(k));
  if (decidable.length < 2) {
    throw new Error(`${ACCEPT_ROLL.id} has ${decidable.length} plan(s) with a clip under takes/<roll>/_flf/ — the tour needs two to decide`);
  }
  const doc = JSON.parse(readFileSync(accPath, "utf8"));
  const picked = decidable.slice(-2);
  for (const key of picked) delete doc.plans[key];
  writeFileSync(accPath, JSON.stringify(doc, null, 2));
  log(`${picked.join(" and ")} put back to "awaiting review" on ${ACCEPT_ROLL.id}`);
}

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, "ui", "server", "server.mjs"), "--workspace", SANDBOX, "--serve", "dist"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/rolls`);
      if (r.ok) {
        log(`server up on ${BASE}`);
        return child;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`server did not answer on ${BASE}`);
}

// --- the synthetic cursor ------------------------------------------------------

// Chromium's screencast (what recordVideo captures) never contains the mouse
// pointer, so the interface has to draw one. The overlay lives inside <html>,
// which the tour zooms to 1.5 so a 1280-wide layout fills a 1920 frame — that
// zoom scales the overlay too, which is exactly why event coordinates (layout
// pixels) can be used unscaled here.
const CURSOR = `
(() => {
  const install = () => {
    if (document.getElementById("__fl_cursor")) return;
    const cur = document.createElement("div");
    cur.id = "__fl_cursor";
    cur.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));";
    cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15.2 L12.2 22 L15.3 20.6 L12.2 14 L19 14 Z" fill="#2B2320" stroke="#F7EFE2" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement("div");
    ring.id = "__fl_ring";
    ring.style.cssText = "position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#D96A5F;opacity:0;z-index:2147483646;pointer-events:none;";
    document.documentElement.append(cur, ring);
    let x = 0, y = 0;
    addEventListener("mousemove", (e) => {
      x = e.clientX; y = e.clientY;
      cur.style.transform = "translate(" + x + "px," + y + "px)";
    }, true);
    addEventListener("mousedown", () => {
      ring.style.transform = "translate(" + x + "px," + y + "px)";
      ring.animate(
        [{ opacity: 0.75, scale: "0.35" }, { opacity: 0, scale: "3.2" }],
        { duration: 500, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
`;

const ZOOM = `
(() => {
  const apply = () => { document.documentElement.style.zoom = "1.5"; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
`;

// --- driving -------------------------------------------------------------------

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

class Tour {
  constructor(page) {
    this.page = page;
    this.x = 960;
    this.y = 620;
  }
  async pause(ms) {
    await this.page.waitForTimeout(ms);
  }
  /** A human-looking glide: ~60 steps, eased, ~16 ms apart. */
  async moveTo(x, y, ms = 620) {
    const steps = Math.max(8, Math.round(ms / 16));
    const [x0, y0] = [this.x, this.y];
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      await this.page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t);
      await this.page.waitForTimeout(16);
    }
    this.x = x;
    this.y = y;
  }
  async moveToLocator(loc, ms) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error("no bounding box for " + loc);
    await this.moveTo(b.x + b.width / 2, b.y + b.height / 2, ms);
    return b;
  }
  /** Glide to the thing, settle, then click it where the cursor already is. */
  async click(loc, { settle = 260, after = 0, ms } = {}) {
    await this.moveToLocator(loc, ms);
    await this.pause(settle);
    await this.page.mouse.down();
    await this.pause(90);
    await this.page.mouse.up();
    if (after) await this.pause(after);
  }
  /** Wheel-scroll in small steps so the picture moves instead of jumping. */
  async scroll(dy, ms = 700) {
    const steps = Math.max(6, Math.round(ms / 16));
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await this.page.waitForTimeout(16);
    }
  }
  /**
   * Scroll the page so a locator sits comfortably in frame. A long way is
   * covered in one jump minus the last 700 px, which is then wheeled smoothly:
   * a 5000 px smooth scroll is a blur nobody can read, a hard jump reads as a
   * broken cut, and this reads as a person arriving at the card.
   */
  async bring(loc, targetY = 260) {
    const b = await loc.boundingBox();
    if (!b) return;
    let delta = b.y - targetY;
    if (Math.abs(delta) > 1400) {
      const jump = delta - Math.sign(delta) * 700;
      await this.page.evaluate((d) => window.scrollBy(0, d), jump);
      await this.pause(250);
      delta -= jump;
    }
    await this.scroll(delta, Math.max(420, Math.min(1100, Math.abs(delta) * 1.1)));
  }
  /** Back to the tab bar, the same way: jump most of it, wheel the last bit. */
  async toTop() {
    const y = await this.page.evaluate(() => window.scrollY);
    if (y <= 0) return;
    if (y > 700) {
      await this.page.evaluate(() => window.scrollTo(0, 700));
      await this.pause(220);
    }
    await this.scroll(-Math.min(y, 700), 700);
  }
  tab(name) {
    return this.page.locator(".fl-tab", { hasText: new RegExp(`^${name}$`) }).first();
  }
}

async function record() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1920, height: 1080 } },
    reducedMotion: "no-preference",
  });
  await ctx.addInitScript(ZOOM);
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [page error]", e.message));
  const t = new Tour(page);

  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.locator(".fl-roll").first().waitFor({ timeout: 20000 });
  await page.mouse.move(960, 640);
  await t.pause(1100);

  // 1 — the rolls list: three rolls, their stage, and what has been spent.
  await t.moveTo(300, 590, 620);
  await t.pause(700);
  await t.moveTo(1180, 600, 620);
  await t.pause(1000);

  // 2 — a roll that has been shot: its keyframes.
  await t.click(page.getByRole("link", { name: KEYS_ROLL.title }), { after: 900 });
  await t.tab("Keyframes").waitFor({ timeout: 10000 });
  await t.click(t.tab("Keyframes"), { after: 1000 });
  await page.locator(".fl-frame__img").first().waitFor({ timeout: 15000 }).catch(() => {});
  await t.pause(700);
  await t.scroll(700, 900);
  await t.pause(1500);

  // 3 — the clips shot from those keyframes.
  await t.toTop();
  await t.click(t.tab("Takes"), { after: 1000 });
  await t.scroll(420, 650);
  await t.pause(1400);

  // 4 — back out, into the roll with the full plan-list.
  await t.toTop();
  await t.click(page.getByRole("link", { name: "← Rolls" }), { after: 900 });
  await t.click(page.getByRole("link", { name: ACCEPT_ROLL.title }), { after: 800 });

  // 5 — the acceptance board: first and last keyframe, the clip, the defects.
  await t.click(t.tab("Acceptance"), { after: 1100 });
  await page.locator(".fl-plan").first().waitFor({ timeout: 20000 });
  await t.pause(1000);

  // A plan card that has a clip but no decision badge — the two stageSandbox()
  // put back to "awaiting review".
  const pending = page.locator(".fl-plan", { has: page.locator(".fl-variant") }).filter({
    hasNot: page.locator(".fl-decision"),
  });
  const waiting = await pending.count();
  if (waiting < 2) {
    throw new Error(
      `the acceptance board shows ${waiting} plan(s) awaiting review, expected 2 — ` +
        "the sandbox has no clips under takes/<roll>/_flf/, so there is nothing to decide",
    );
  }
  const first = pending.first();

  // 6 — accept one. The server writes workspace/<roll>/acceptance.json.
  await t.bring(first, 200);
  await t.pause(900);
  await t.click(first.getByRole("button", { name: "Accept" }), { after: 1700 });

  // 7 — reject the other, with a defect ticked and a note for the reshoot.
  //     The accepted card now carries a decision badge, so "first pending"
  //     resolves to the next one down.
  const secondCard = page.locator(".fl-plan", { has: page.locator(".fl-variant") }).filter({ hasNot: page.locator(".fl-decision") }).first();
  await t.bring(secondCard, 200);
  await t.pause(600);
  await t.click(secondCard.locator(".fl-defect", { hasText: "cut jump" }).first(), { after: 600 });
  await t.click(secondCard.locator("textarea").first(), { settle: 180 });
  await page.keyboard.type("Reshoot: the hand jumps between frame 40 and 44.", { delay: 26 });
  await t.pause(700);
  await t.click(secondCard.getByRole("button", { name: "Reject" }), { after: 1800 });

  // 8 — the finished episode and its verify report.
  await t.toTop();
  await t.click(t.tab("Episode"), { after: 900 });
  const video = page.locator(".fl-episode__video");
  await video.waitFor({ timeout: 15000 });
  await t.moveToLocator(video, 600);
  await page.evaluate(() => {
    const v = document.querySelector(".fl-episode__video");
    if (v) {
      v.muted = true;
      v.currentTime = 2;
      v.play();
    }
  });
  await t.pause(3200);
  await t.scroll(760, 800);
  await t.pause(1700);

  // 9 — the scenario: the text every one of those frames was made from.
  await t.toTop();
  await t.click(t.tab("Scenario"), { after: 1200 });
  await t.scroll(520, 800);
  await t.pause(1500);

  // 10 — back to the list, which has refetched: the roll now reads
  //      "7 accepted · 1 in reshoot queue". The two decisions the tour made
  //      are on disk, and the list is reading them back.
  await t.toTop();
  await t.click(page.getByRole("link", { name: "← Rolls" }), { after: 1400 });
  await t.pause(1800);

  const path = await page.video().path();
  await ctx.close();
  await browser.close();
  return path;
}

// --- transcode ------------------------------------------------------------------

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr?.slice(-2500)}`);
}

function probeDuration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number(r.stdout.trim()) || 0;
}

/**
 * The explainer's cut has room for 45–70 s. The tour is written to land inside
 * that, but browser start-up and page loads vary by a few seconds per run, so
 * anything over MAX_SEC is nudged back with one uniform setpts rather than by
 * padding or by cutting a screen out. The nudge is capped: past ~1.35x the tour
 * stops reading as someone using the interface and starts reading as fast
 * forward, and at that point the right fix is to shorten the tour itself.
 */
const MAX_SEC = 70;
const AIM_SEC = 64;

function transcode(webm) {
  const raw = probeDuration(webm);
  let speed = 1;
  if (raw > MAX_SEC) {
    speed = Math.min(1.35, raw / AIM_SEC);
    log(`raw is ${raw.toFixed(1)} s — playing back at ${speed.toFixed(3)}x to land near ${AIM_SEC} s`);
  }
  const filters = [
    speed === 1 ? null : `setpts=PTS/${speed}`,
    "fps=30",
    "scale=1920:1080:flags=lanczos",
    "format=yuv420p",
  ].filter(Boolean);
  const tmp = OUT_MP4 + ".tmp.mp4";
  ffmpeg([
    "-y", "-i", webm,
    "-an",
    "-vf", filters.join(","),
    "-r", "30",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18",
    "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    tmp,
  ]);
  rmSync(OUT_MP4, { force: true });
  renameSync(tmp, OUT_MP4);
}

// --- main -------------------------------------------------------------------------

let server;
try {
  buildSandbox();
  stageSandbox();
  server = await startServer();
  log("recording…");
  const webm = await record();
  log(`raw video: ${webm}`);
  transcode(webm);
  log(`wrote ${OUT_MP4}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  // Windows keeps the server's handles on the sandbox for a beat after the
  // process goes; wipe() retries rather than failing the run over a temp folder.
  await new Promise((r) => setTimeout(r, 800));
  if (!KEEP) {
    try {
      wipe(SANDBOX);
      wipe(VIDEO_DIR);
    } catch (e) {
      log(`sandbox left behind (${e.code}): ${SANDBOX}`);
    }
  }
}
if (process.exitCode) process.exit(process.exitCode);

const probe = spawnSync(
  "ffprobe",
  ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration,pix_fmt,codec_name", "-of", "default=nw=1", OUT_MP4],
  { encoding: "utf8" },
);
console.log(probe.stdout.trim());
