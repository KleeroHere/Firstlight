#!/usr/bin/env node
// Renders every brand raster from the SVG sources in docs/brand/.
//
//   node build/make-brand.mjs
//
// Chromium (Playwright, already a devDependency of ui/) is the rasteriser:
// the SVGs use feTurbulence for the paper grain, and a browser is the one
// renderer guaranteed to draw filters the same way the interface will.
//
// Outputs
//   docs/brand/firstlight.png            1024  the mark alone, transparent
//   ui/public/firstlight.png             256   the same mark, for the interface
//   docs/brand/firstlight-wordmark.png   1600  mark + word, transparent
//   docs/brand/social-preview.png        1280x640  GitHub social card
//   docs/brand/logo-concepts-F.png       the F concepts at 512/128/32/16
//   docs/brand/logo-concepts.png         the first round, same treatment
//   docs/brand/palette.png               the palette strip for the docs
//   workspace/brand/title-bg.png         1920x1080 episode card backgrounds
//   workspace/brand/divider-bg.png
//   workspace/brand/memo-bg.png
//
// After this, run `python build/make-icon.py` for the .ico files.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(pathToFileURL(join(ROOT, "ui", "package.json")));
const { chromium } = require("playwright");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const fontUrl = (name) =>
  pathToFileURL(join(ROOT, "ui", "public", "fonts", name)).href;

const browser = await chromium.launch();
const log = (p) => console.log(`[brand] ${p}`);

/** Screenshot one HTML fragment at an exact pixel size. */
async function shoot(html, { width, height, out, transparent = true, scale = 1, fullPage = false }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:${transparent ? "transparent" : "#fff"};}
       @font-face{font-family:Unbounded;font-weight:600;src:url("${fontUrl("unbounded-600-latin.woff2")}") format("woff2");}
       @font-face{font-family:Onest;font-weight:400;src:url("${fontUrl("onest-400-latin.woff2")}") format("woff2");}
       @font-face{font-family:Onest;font-weight:500;src:url("${fontUrl("onest-500-latin.woff2")}") format("woff2");}
     </style>${html}`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(join(ROOT, out)), { recursive: true });
  await page.screenshot({ path: join(ROOT, out), omitBackground: transparent, fullPage });
  await page.close();
  log(out);
}

const svg = (p, size) =>
  `<div style="width:${size}px;height:${size}px">${read(p).replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</div>`;

// --- 1. the mark ------------------------------------------------------------
await shoot(svg("docs/brand/firstlight.svg", 1024), {
  width: 1024,
  height: 1024,
  out: "docs/brand/firstlight.png",
});

// The interface loads the mark as a plain <img> in the header and as the PNG
// favicon, so it gets its own small copy rather than the 1024 print one.
await shoot(svg("docs/brand/firstlight.svg", 256), {
  width: 256,
  height: 256,
  out: "ui/public/firstlight.png",
});

// --- 2. the wordmark (its own aspect: make-wordmark.py sizes it to the word) -
{
  const src = read("docs/brand/firstlight-wordmark.svg");
  const [, w, h] = src.match(/viewBox="0 0 (\d+) (\d+)"/);
  const width = 1600;
  const height = Math.round((width * +h) / +w);
  await shoot(
    `<div style="width:${width}px;height:${height}px">${src.replace(/width="\d+" height="\d+"/, `width="${width}" height="${height}"`)}</div>`,
    { width, height, out: "docs/brand/firstlight-wordmark.png" },
  );
}

// --- 3. the concept contact sheets ------------------------------------------
// Both rounds, kept: the owner asked for a mark with an F in it after the
// first four were drawn, and the earlier sheet is still the record of why.
async function contactSheet(out, title, lead, concepts) {
  const col = concepts
    .map(([file, name, note]) => {
      const s = (n) => svg(`docs/brand/concepts/${file}.svg`, n);
      return `<section>
        <div class="row">${s(512)}
          <div class="small">${s(128)}<div class="cap">128</div></div>
          <div class="small">${s(32)}<div class="cap">32</div></div>
          <div class="small">${s(16)}<div class="cap">16</div></div>
          <div class="small dark">${s(32)}<div class="cap">32</div></div>
          <div class="small dark">${s(16)}<div class="cap">16</div></div>
        </div>
        <h2>${name}</h2><p>${note}</p>
      </section>`;
    })
    .join("");
  await shoot(
    `<style>
      body{background:#F7EFE2;font-family:Onest,system-ui,sans-serif;color:#10302D;padding:56px 64px;}
      h1{font-family:Unbounded,system-ui;font-size:38px;margin:0 0 6px;}
      .lead{margin:0 0 44px;color:#4A625D;font-size:18px;max-width:900px;line-height:1.45;}
      section{display:flex;flex-direction:column;gap:14px;margin-bottom:52px;}
      .row{display:flex;align-items:flex-end;gap:36px;}
      .small{display:flex;flex-direction:column;align-items:center;gap:8px;}
      .small.dark{background:#0C2422;padding:14px 18px;border-radius:12px;}
      .small.dark .cap{color:#A9C4BB;}
      .cap{font-size:13px;color:#4A625D;}
      h2{font-family:Unbounded,system-ui;font-size:24px;margin:0;}
      p{margin:0;color:#4A625D;font-size:17px;}
     </style>
     <h1>${title}</h1>
     <p class="lead">${lead}</p>
     ${col}`,
    { width: 1280, height: 800, out, transparent: false, fullPage: true },
  );
}

await contactSheet(
  "docs/brand/logo-concepts-F.png",
  "Firstlight — logo concepts, with an F",
  "Four marks built on the letter F, with the harbour in the detail. Shown at 512, 128, 32 and 16 pixels, on paper and on teal: the F has to survive the last two.",
  [
    ["F1-beacon", "F as a lighthouse", "the stem is the tower, the arms are the beam and the gallery"],
    ["F2-horizon", "F as light over the horizon", "the top arm is the ray, the middle arm is the horizon, the stem stands in the water"],
    ["F3-signal-flags", "F as signal flags", "the stem is the mast, the arms are two flags flying to starboard"],
    ["F4-lens", "F with the sun as its arm", "the top arm ends in the sun, with the rings of the lens behind it"],
  ],
);

await contactSheet(
  "docs/brand/logo-concepts.png",
  "Firstlight — logo concepts, first round",
  "The first four marks: pictures of the harbour rather than letterforms. Kept as the record of what was tried before the F.",
  [
    ["01-daybreak-beam", "Daybreak beam", "the sun on the horizon, and the fan it throws"],
    ["02-fresnel-lens", "Fresnel lens", "the rings of the lantern, lit at the core"],
    ["03-lantern-window", "Lantern window", "the pane you watch the first light through"],
    ["04-first-frame", "First frame", "a frame of film with the sunrise held in it"],
  ],
);

// --- 4. the social preview --------------------------------------------------
// The same dawn the episodes open on: the title card, cropped to 2:1, with a
// scrim on the reading side so the wordmark keeps its contrast.
await shoot(
  `<style>
     body{width:1280px;height:640px;overflow:hidden;font-family:Onest,system-ui,sans-serif;}
     .card{position:relative;width:1280px;height:640px;background:#0C2422;overflow:hidden;}
     .art{position:absolute;left:0;top:-40px;width:1280px;height:720px;}
     .scrim{position:absolute;inset:0;background:linear-gradient(100deg,
        rgba(8,32,30,.97) 0%, rgba(8,32,30,.92) 34%, rgba(8,32,30,.55) 58%, rgba(8,32,30,.10) 82%);}
     .body{position:relative;height:100%;display:flex;flex-direction:column;
           justify-content:center;padding:0 88px;box-sizing:border-box;color:#F2E7D6;}
     .row{display:flex;align-items:center;gap:26px;margin-bottom:24px;}
     .name{font-family:Unbounded,system-ui;font-weight:600;font-size:72px;letter-spacing:-.01em;}
     .tag{font-size:29px;color:#C4B9A6;max-width:600px;line-height:1.36;}
     .bar{display:flex;height:13px;width:392px;margin-top:40px;border-radius:7px;overflow:hidden;
          box-shadow:0 0 0 1px rgba(247,239,226,.22);}
     .bar i{flex:1;}
   </style>
   <div class="card">
     <div class="art">${read("docs/brand/cards/title-bg.svg").replace(/width="1920" height="1080"/, 'width="1280" height="720"')}</div>
     <div class="scrim"></div>
     <div class="body">
       <div class="row">${svg("docs/brand/firstlight.svg", 116)}<div class="name">Firstlight</div></div>
       <div class="tag">A workshop for short animated episodes — the first frame, and everything after it.</div>
       <div class="bar">
         <i style="background:#E04E14"></i><i style="background:#F7C77E"></i><i style="background:#C9A26A"></i>
         <i style="background:#1F5551"></i><i style="background:#0B384E"></i><i style="background:#F7EFE2"></i>
       </div>
     </div>
   </div>`,
  { width: 1280, height: 640, out: "docs/brand/social-preview.png", transparent: false },
);

// --- 5. the palette strip for the README and docs/BRAND.md ------------------
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
      `<div class="sw" style="background:${hex}">
         <b class="${on}">${hex}</b><i class="${on}">${name}</i>
       </div>`)
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

// --- 5. the episode card backgrounds ---------------------------------------
for (const name of ["title-bg", "divider-bg", "memo-bg"]) {
  const src = read(`docs/brand/cards/${name}.svg`);
  await shoot(`<div style="width:1920px;height:1080px">${src}</div>`, {
    width: 1920,
    height: 1080,
    out: `workspace/brand/${name}.png`,
    transparent: false,
  });
}

await browser.close();
console.log("[brand] done — now run: python build/make-icon.py");
