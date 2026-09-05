#!/usr/bin/env node
// Every brand raster, composed from the mark.
//
//   python build/make-mark.py     # first: cut and re-ink the chosen logo
//   node build/make-brand.mjs     # this: the lockups, the card and the strip
//   python build/make-icon.py     # last: the .ico files
//
// The mark is a PNG, not a drawing: docs/brand/firstlight.png comes out of
// make-mark.py. Chromium composes everything else, so the wordmark is set in
// the real font the repository ships and the card artwork keeps its grain.
//
// Outputs
//   docs/brand/firstlight-wordmark.png          mark beside the word
//   docs/brand/firstlight-wordmark-stacked.png  mark above the word
//   docs/brand/social-preview.png               1280x640, the GitHub card
//   docs/brand/palette.png                      the palette strip for the docs
//   workspace/brand/title-bg.png                1920x1080 episode card art
//   workspace/brand/divider-bg.png
//   workspace/brand/memo-bg.png
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(pathToFileURL(join(ROOT, "ui", "package.json")));
const { chromium } = require("playwright");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const dataUri = (p, mime) => `data:${mime};base64,` + readFileSync(join(ROOT, p)).toString("base64");
const font = (name) => dataUri(`ui/public/fonts/${name}`, "font/woff2");
const MARK = dataUri("docs/brand/firstlight.png", "image/png");

const browser = await chromium.launch();
const log = (p) => console.log(`[brand] ${p}`);

// The word is set in Manrope 700 — the cleanest of the candidates at interface
// size, and the one that does not compete with a busy round badge.
const FACE = `@font-face{font-family:Manrope;font-weight:700;src:url("${font("manrope-700-latin.woff2")}") format("woff2");}
  @font-face{font-family:Onest;font-weight:400;src:url("${font("onest-400-latin.woff2")}") format("woff2");}`;

async function shoot(html, { width, height, out, transparent = true, fullPage = false }) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:${transparent ? "transparent" : "#fff"};}
       ${FACE}
     </style>${html}`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(join(ROOT, out)), { recursive: true });
  await page.screenshot({ path: join(ROOT, out), omitBackground: transparent, fullPage });
  await page.close();
  log(out);
}

const WORD = (size) =>
  `<span style="font-family:Manrope,system-ui,sans-serif;font-weight:700;font-size:${size}px;` +
  `letter-spacing:-0.028em;line-height:1;color:#12312E;">Firstlight</span>`;

// --- 1. the two lockups -----------------------------------------------------
await shoot(
  `<div style="display:inline-flex;align-items:center;gap:60px;padding:40px 44px;">
     <img src="${MARK}" width="240" height="240">${WORD(150)}
   </div>`,
  { width: 1100, height: 320, out: "docs/brand/firstlight-wordmark.png", fullPage: true },
);

await shoot(
  `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:34px;padding:40px 44px;">
     <img src="${MARK}" width="300" height="300">${WORD(112)}
   </div>`,
  { width: 700, height: 520, out: "docs/brand/firstlight-wordmark-stacked.png", fullPage: true },
);

// --- 2. the social preview --------------------------------------------------
// The dawn the episodes open on — the title card, cropped to 2:1 — with a
// scrim on the reading side so the wordmark keeps its contrast.
await shoot(
  `<style>
     body{width:1280px;height:640px;overflow:hidden;font-family:Onest,system-ui,sans-serif;}
     .card{position:relative;width:1280px;height:640px;background:#0C2422;overflow:hidden;}
     .art{position:absolute;left:0;top:-40px;width:1280px;height:720px;}
     .scrim{position:absolute;inset:0;background:linear-gradient(100deg,
        rgba(8,32,30,.97) 0%, rgba(8,32,30,.93) 34%, rgba(8,32,30,.58) 58%, rgba(8,32,30,.10) 82%);}
     .body{position:relative;height:100%;display:flex;flex-direction:column;
           justify-content:center;padding:0 88px;box-sizing:border-box;color:#F2E7D6;}
     .row{display:flex;align-items:center;gap:26px;margin-bottom:24px;}
     .name{font-family:Manrope,system-ui,sans-serif;font-weight:700;font-size:76px;letter-spacing:-.028em;}
     .tag{font-size:29px;color:#C4B9A6;max-width:600px;line-height:1.36;}
     .bar{display:flex;height:13px;width:392px;margin-top:40px;border-radius:7px;overflow:hidden;
          box-shadow:0 0 0 1px rgba(247,239,226,.22);}
     .bar i{flex:1;}
   </style>
   <div class="card">
     <div class="art">${read("docs/brand/cards/title-bg.svg").replace(/width="1920" height="1080"/, 'width="1280" height="720"')}</div>
     <div class="scrim"></div>
     <div class="body">
       <div class="row"><img src="${MARK}" width="124" height="124"><div class="name">Firstlight</div></div>
       <div class="tag">A workshop for short animated episodes — the first frame, and everything after it.</div>
       <div class="bar">
         <i style="background:#E04E14"></i><i style="background:#F7C77E"></i><i style="background:#C9A26A"></i>
         <i style="background:#1F5551"></i><i style="background:#0B384E"></i><i style="background:#F7EFE2"></i>
       </div>
     </div>
   </div>`,
  { width: 1280, height: 640, out: "docs/brand/social-preview.png", transparent: false },
);

// --- 3. the palette strip ---------------------------------------------------
{
  const swatches = [
    ["#E04E14", "storm orange", "dark"],
    ["#C2410C", "orange, deep", "dark"],
    ["#F7C77E", "sun", "light"],
    ["#C9A26A", "brass", "light"],
    ["#F7EFE2", "paper", "light"],
    ["#3E7A72", "sea", "dark"],
    ["#1F5551", "teal, mid", "dark"],
    ["#12312E", "teal", "dark"],
    ["#0C2422", "teal, deep", "dark"],
    ["#0B384E", "indigo", "dark"],
  ];
  const cells = swatches
    .map(([hex, name, on]) =>
      `<div class="sw" style="background:${hex}"><b class="${on}">${hex}</b><i class="${on}">${name}</i></div>`)
    .join("");
  await shoot(
    `<style>
       body{margin:0;font-family:Onest,system-ui,sans-serif;}
       .strip{display:flex;width:1200px;height:180px;}
       .sw{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;padding:0 0 16px 16px;}
       b{font-size:15px;font-weight:600;letter-spacing:.02em;}
       i{font-size:13px;font-style:normal;opacity:.8;}
       .dark{color:#F7EFE2;} .light{color:#10302D;}
     </style>
     <div class="strip">${cells}</div>`,
    { width: 1200, height: 180, out: "docs/brand/palette.png", transparent: false },
  );
}

// --- 4. the episode card backgrounds ---------------------------------------
for (const name of ["title-bg", "divider-bg", "memo-bg"]) {
  await shoot(`<div style="width:1920px;height:1080px">${read(`docs/brand/cards/${name}.svg`)}</div>`, {
    width: 1920,
    height: 1080,
    out: `workspace/brand/${name}.png`,
    transparent: false,
  });
}

await browser.close();
console.log("[brand] done — now run: python build/make-icon.py");
