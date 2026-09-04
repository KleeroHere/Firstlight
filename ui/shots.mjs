// Screenshots of the interface for the README, and a smoke check of the API
// behind it. Run with the server (:7331) and vite (:1421) up:
//
//   node shots.mjs            # from ui/, with playwright available
//
// Writes ../docs/screenshots/rolls.png and roll.png at README width.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.FL_URL ?? "http://localhost:1421/";
const OUT = "../docs/screenshots";
mkdirSync(OUT, { recursive: true });

const ok = (name, cond, detail = "") => console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 });
page.on("pageerror", (e) => console.log("  [page error] " + e.message));

// API first: the interface can only be as right as the server.
const rolls = await (await fetch("http://localhost:7331/api/rolls")).json();
ok("server lists the example roll", rolls.rolls.some((r) => r.id === "fog-signal-check"), rolls.rolls.map((r) => `${r.id}:${r.stage}`).join(", "));

await page.goto(URL + "#/", { waitUntil: "networkidle" });
await page.locator(".fl-roll").first().waitFor({ timeout: 15000 });
ok("rolls page renders a card", (await page.locator(".fl-roll").count()) > 0);
await page.screenshot({ path: `${OUT}/rolls.png` });

await page.locator(".fl-roll__link").first().click();
await page.locator(".fl-scene").first().waitFor({ timeout: 15000 });
const scenes = await page.locator(".fl-scene").count();
ok("roll page shows the scenes", scenes === 3, `scenes: ${scenes}`);
await page.screenshot({ path: `${OUT}/roll.png` });

await page.getByRole("button", { name: "Episode" }).click();
await page.locator(".fl-verify").waitFor({ timeout: 15000 }).catch(() => {});
ok("episode tab shows the graded cut", (await page.locator(".fl-verify").count()) === 1);
await page.screenshot({ path: `${OUT}/episode.png` });

// exact: the "Synthetic takes" action button would match a substring search too
await page.getByRole("button", { name: "Takes", exact: true }).click();
await page.locator(".fl-take").first().waitFor({ timeout: 15000 }).catch(() => {});
ok("takes tab shows the synthetic takes", (await page.locator(".fl-take").count()) === 3);

await browser.close();
console.log(`Screenshots in ${OUT}/`);
