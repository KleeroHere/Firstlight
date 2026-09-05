#!/usr/bin/env node
// Text-to-image / image-edit stills through WaveSpeed (bytedance/seedream-v4),
// for the one-off assets the pipeline itself does not generate: a character's
// first reference sheet, and background plates. Klein (engine/klein_keys.py)
// stays the free local path for per-shot keyframes once those references
// exist — this script is only for the references themselves.
//
//   node engine/wavespeed_stills.mjs --prompt "..." --out workspace/refs/mara/base.png [--size 1280*1600]
//   node engine/wavespeed_stills.mjs --prompt "..." --out workspace/refs/mara/fullbody.png --edit workspace/refs/mara/base.png
//
// --edit <path[,path...]>  switches to bytedance/seedream-v4/edit: the listed
//                          local images are uploaded and passed as `images`,
//                          keeping the same face/clothes while changing pose
//                          or shot type. Without --edit it is plain
//                          text-to-image (bytedance/seedream-v4).
// --ledger <path>          spend ledger to update (default: reports/wavespeed-spend.json
//                          next to this repo). Both modes are $0.027/image flat.
// --tag <id>               short id recorded in the ledger for this image
//                          (defaults to the --out basename without extension).
// --dry                    print the planned request and price, do nothing.
//
// Reads WAVESPEED_API_KEY from the environment only (export it yourself,
// e.g. `source path/to/.env.local && node engine/wavespeed_stills.mjs ...`) —
// this script never reads or writes a secret file, so it stays usable from
// any workspace, not just this one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ROOT } from "./lib.mjs";

const API = "https://api.wavespeed.ai/api/v3";
const PRICE = 0.027; // both seedream-v4 and seedream-v4/edit, flat per image

function parseArgs(argv) {
  const a = { size: "1280*1600", ledger: join(ROOT, "reports", "wavespeed-spend.json") };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--prompt") a.prompt = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--edit") a.edit = argv[++i].split(",");
    else if (v === "--size") a.size = argv[++i];
    else if (v === "--ledger") a.ledger = resolve(argv[++i]);
    else if (v === "--tag") a.tag = argv[++i];
    else if (v === "--dry") a.dry = true;
    else throw new Error(`Unknown argument: ${v}`);
  }
  if (!a.prompt || !a.out) throw new Error("Need --prompt and --out");
  a.tag = a.tag ?? basename(a.out).replace(/\.[^.]+$/, "");
  return a;
}
const args = parseArgs(process.argv);
const KEY = process.env.WAVESPEED_API_KEY;

async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) } });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${path}: not JSON (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok || (j.code && j.code !== 200)) throw new Error(`${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function upload(filePath) {
  const buf = readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf]), basename(filePath));
  const j = await api("/media/upload/binary", { method: "POST", body: fd });
  return j.data.download_url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ledger(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { spent_usd: 0, runs: [] };
}
function bookRun(path, entry) {
  const L = ledger(path);
  L.spent_usd = Math.round((L.spent_usd + entry.usd) * 1000) / 1000;
  L.runs.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(L, null, 2));
  return L.spent_usd;
}

console.log(`${args.tag}: ${args.edit ? "seedream-v4/edit" : "seedream-v4"} ${args.size}, $${PRICE.toFixed(3)} -> ${args.out}`);
if (!/^\d+\*\d+$/.test(args.size)) throw new Error(`--size must look like 2560*1440, got "${args.size}"`);
if (args.dry) process.exit(0);
if (!KEY) { console.error("No WAVESPEED_API_KEY in the environment"); process.exit(2); }

const body = { prompt: args.prompt, enable_base64_output: false, enable_sync_mode: false };
let path;
// `size` goes with BOTH modes. Seedream's edit endpoint does not inherit the
// aspect ratio of the images it is given: omit `size` and a 16:9 background
// plus a portrait character sheet came back portrait — which is how this
// series once shot a 1792x2240 "master" that the assembler then pillarboxed
// into a 1920x1080 frame. Always say the shape you want.
body.size = args.size;
if (args.edit) {
  path = "/bytedance/seedream-v4/edit";
  body.images = await Promise.all(args.edit.map((p) => upload(p)));
} else {
  path = "/bytedance/seedream-v4";
}

const t0 = Date.now();
const sub = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const id = sub.data.id;
let res;
for (;;) {
  await sleep(2000);
  res = await api(`/predictions/${id}/result`);
  const st = res.data.status;
  if (st === "completed") break;
  if (["failed", "cancelled", "timeout", "deleted"].includes(st)) throw new Error(`${args.tag}: ${st} ${res.data.error ?? ""}`);
  if (Date.now() - t0 > 5 * 60 * 1000) throw new Error(`${args.tag}: not done after 5 minutes`);
}
const url = res.data.outputs?.[0];
if (!url) throw new Error(`${args.tag}: no output in response`);
const img = Buffer.from(await (await fetch(url)).arrayBuffer());
mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(args.out, img);
const spent = bookRun(args.ledger, {
  date: new Date().toISOString().slice(0, 10),
  id: args.tag,
  mode: args.edit ? "seedream-v4-edit" : "seedream-v4-t2i",
  usd: PRICE,
  out: args.out,
  project: "firstlight",
});
console.log(`${args.tag} ... ${Math.round((Date.now() - t0) / 1000)}s, $${PRICE.toFixed(3)} (ledger total $${spent.toFixed(3)})`);
