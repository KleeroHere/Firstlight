// Screenshots of the live interface for the explainer video.
//   node docs/demo/shots.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:7331";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, "rolls.png") });

await page.goto(`${BASE}/#/roll/handover-at-the-pier`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, "roll-episode.png") });

for (const tab of ["Scenario", "Frames", "Takes", "Acceptance"]) {
  const btn = page.locator(".fl-tab", { hasText: tab }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `roll-${tab.toLowerCase()}.png`) });
  } else {
    console.log(`tab not found: ${tab}`);
  }
}

await browser.close();
console.log("done ->", OUT);
