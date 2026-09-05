#!/usr/bin/env node
// Съёмка планов через WaveSpeed API (Kling / Seedance / Wan, image-to-video
// 720p) вместо ComfyUI на своём или арендованном GPU. Один из трёх моторов
// движения (см. docs/ARCHITECTURE.md, backends.motion: comfy-pod | comfy-local
// | wavespeed) — облачный, дороже за клип, но без пода и без очереди.
//
//   node engine/wavespeed_batch.mjs --id fog-signal-check [--only 1,4] [--no-key]
//        [--out-dir _seedance_test/flf] [--seed 7] [--concurrency 2] [--redo] [--dry]
//
// Читает тот же план-лист workspace/plans/<id>.json, что и flf_batch.mjs, и
// кладёт клипы туда же (takes/<id>/_flf/planN.mp4), так что assemble_video.mjs
// ничего не замечает. Отличия от пода: планы летят параллельно, нет ComfyUI,
// платим за готовый клип (см. MODELS ниже), баланс — жёсткий потолок.
//
//   первый кадр  = мастер плана (plan.master), как и у flf_batch.mjs;
//   последний    = keys/planN_key.png, если он есть, план не i2v, флаг
//                  --no-key не стоит, и в плане "use_key": true (или
//                  --use-keys на весь прогон); иначе чистый i2v — движение
//                  задаёт текст;
//   длительность = 5 с при frames <= 81, иначе 10 с;
//   камера       = camera_fixed: true, если модель это поддерживает.
//
// Книга расходов — reports/wavespeed-spend.json (репозиторий не коммитит
// reports/, см. .gitignore). Ключ — WAVESPEED_API_KEY из engine/.env.local
// (в git не попадает).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";
import { guardPlans, negativePrompt } from "./guard.mjs";

const API = "https://api.wavespeed.ai/api/v3";
// Движки WaveSpeed. Цены — за клип 5 с / 10 с (720p), см. docs/ARCHITECTURE.md.
// extra — параметры, которые модель понимает сверх image/prompt/duration/seed.
const MODELS = {
  "lite":      { path: "bytedance/seedance-v1-lite-i2v-720p",        price: { 5: 0.16, 10: 0.32 }, extra: { camera_fixed: true } },
  "pro":       { path: "bytedance/seedance-v1-pro-i2v-720p",         price: { 5: 0.30, 10: 0.60 }, extra: { camera_fixed: true } },
  "pro15fast": { path: "bytedance/seedance-v1.5-pro/image-to-video-fast", price: { 5: 0.10, 10: 0.20 }, extra: { camera_fixed: true, resolution: "720p", generate_audio: false } },
  "kling-std": { path: "kwaivgi/kling-v2.5-turbo-std/image-to-video", price: { 5: 0.21, 10: 0.42 }, seed: false, extra: { negative_prompt: "extra person, extra hand, disembodied hand, face morphing, changing clothes, text, watermark, camera zoom, camera pan" } },
  "kling-pro": { path: "kwaivgi/kling-v2.5-turbo-pro/image-to-video", price: { 5: 0.35, 10: 0.70 }, seed: false, extra: { negative_prompt: "extra person, extra hand, disembodied hand, face morphing, changing clothes, text, watermark, camera zoom, camera pan" } },
  // Kling 2.6. Pro is the only one of the pair that takes an end frame — the
  // field is `end_image` (NOT `last_image`, which the API silently drops), and
  // it is also the only one that accepts `sound`, which we always turn off:
  // narration is dubbed, a model-invented soundtrack would fight it.
  "kling26-pro": { path: "kwaivgi/kling-v2.6-pro/image-to-video", price: { 5: 0.35, 10: 0.70 }, end: "end_image", seed: false, extra: { negative_prompt: negativePrompt, sound: false } },
  "kling26-std": { path: "kwaivgi/kling-v2.6-std/image-to-video", price: { 5: 0.21, 10: 0.42 }, seed: false, extra: { negative_prompt: negativePrompt } },
  // Kling 2.1 Pro start/end-frame: the older dedicated FLF endpoint, kept as a
  // fallback for a shot 2.6 Pro will not close cleanly.
  "kling21-flf": { path: "kwaivgi/kling-v2.1-i2v-pro/start-end-frame", price: { 5: 0.45, 10: 0.90 }, end: "end_image", needsEnd: true, seed: false, extra: { negative_prompt: negativePrompt } },
  "wan27": { path: "alibaba/wan-2.7/image-to-video", price: { 5: 0.50, 10: 1.00 }, extra: { resolution: "720p", negative_prompt: "extra person, extra hand, disembodied hand, face morphing, changing clothes, text, watermark, camera zoom, camera pan" } },
  // Hailuo умеет только 6 и 10 с: 5-секундный план едет как 6 с.
  "hailuo-fast": { path: "minimax/hailuo-2.3/fast", price: { 6: 0.19, 10: 0.32 }, durations: { 5: 6, 10: 10 }, extra: { enable_prompt_expansion: false } },
};
let MODEL = MODELS.lite.path;
let PRICE = MODELS.lite.price;
let EXTRA = MODELS.lite.extra;
// Name of the end-frame field this model takes, or null when it is i2v-only.
let END_FIELD = null;
// Some endpoints (every Kling 2.x here) have no seed at all: sending one is
// silently dropped, so a "--seed" re-roll would return the same clip. We say so
// instead of pretending.
let HAS_SEED = true;

function loadEnv() {
  const p = join(ROOT, "engine", ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const KEY = process.env.WAVESPEED_API_KEY;

function parseArgs(argv) {
  const a = { concurrency: 2, seed: 7, outDir: "_flf" };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--only") a.only = argv[++i].split(",").map(Number);
    else if (v === "--no-key") a.noKey = true;
    else if (v === "--use-keys") a.useKeys = true;
    else if (v === "--model") a.model = argv[++i];
    // Стилизация «ограниченной анимации»: --stretch 1.6 → кадры 24 к/с
    // растягиваются в 1,6 раза и прореживаются до 15 уникальных к/с на
    // таймлайне 30 к/с («на двойках»); --stretch 2.4 → 10 к/с («на тройках»).
    // 5-секундный клип покрывает 8 или 12 с экрана. Бесплатно (ffmpeg).
    else if (v === "--stretch") a.stretch = Number(argv[++i]);
    else if (v === "--out-dir") a.outDir = argv[++i];
    else if (v === "--ledger") a.ledger = argv[++i];
    else if (v === "--seed") a.seed = Number(argv[++i]);
    else if (v === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (v === "--redo") a.redo = true;
    else if (v === "--dry") a.dry = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id");
  return a;
}
const args = parseArgs(process.argv);
if (args.model && args.model !== "auto") {
  if (!MODELS[args.model]) throw new Error(`Неизвестная модель ${args.model}; есть: auto, ${Object.keys(MODELS).join(", ")}`);
  ({ path: MODEL, price: PRICE, extra: EXTRA } = MODELS[args.model]);
  END_FIELD = MODELS[args.model].end ?? null;
  HAS_SEED = MODELS[args.model].seed !== false;
}
// `--model auto` (the default for a roll storyboarded by auto_storyboard.py):
// every plan carries its own `model`, because the wide of a scene needs an end
// frame (Kling 2.6 Pro) while its solo shots do not (Kling 2.6 Std, same
// generation, 60% of the price). One command shoots the whole roll correctly
// instead of two commands with two --only lists.
function modelFor(p) {
  const name = args.model === "auto" || !args.model ? (p.model ?? (args.model === "auto" ? "kling26-std" : null)) : args.model;
  if (!name) return { name: "lite", ...MODELS.lite, end: null, seed: true };
  const m = MODELS[name];
  if (!m) throw new Error(`план ${p.plan}: неизвестная модель ${name}; есть: ${Object.keys(MODELS).join(", ")}`);
  return { name, path: m.path, price: m.price, extra: m.extra, end: m.end ?? null, seed: m.seed !== false };
}

const cfg = loadConfig();
const takesDir = join(ROOT, cfg.paths.takes, args.id);
const outDir = join(takesDir, args.outDir);
const planFile = join(ROOT, "workspace", "plans", `${args.id}.json`);
if (!existsSync(planFile)) throw new Error(`Нет план-листа ${planFile}`);
const spec = JSON.parse(readFileSync(planFile, "utf8"));
// GUARD: no motion prompt leaves this script without the head-count /
// closed-door / locked-camera clauses, and none goes out carrying a phrase
// that is known to produce a defect ("breathes", "walks off", "turns to
// camera" — see engine/pipeline.config.json production.guard.banned and
// docs/PRODUCTION-RULES.md). A plan that cannot be fixed by prepending the
// guard stops the whole run before it spends anything.
spec.plans = guardPlans(spec.plans, { strict: true });
let plans = spec.plans;
if (args.only) plans = plans.filter((p) => args.only.includes(p.plan));

// Акцептация: планы, уже принятые человеком, эта съёмка не трогает без
// --redo — тот же файл и та же конвенция ключей, что читает flf_batch.mjs.
const acceptancePath = join(ROOT, "workspace", args.id, "acceptance.json");
const acceptance = existsSync(acceptancePath) ? JSON.parse(readFileSync(acceptancePath, "utf8")) : { plans: {} };
function decisionFor(plan, seed) {
  const key = `plan${plan}${seed !== args.seed ? `_s${seed}` : ""}`;
  return acceptance.plans?.[key]?.decision ?? null;
}

const LEDGER = args.ledger ?? join(ROOT, "reports", "wavespeed-spend.json");
function ledger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { spent_usd: 0, runs: [] };
}
function bookRun(entry) {
  const L = ledger();
  L.spent_usd = Math.round((L.spent_usd + entry.usd) * 1000) / 1000;
  L.runs.push(entry);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(L, null, 2));
  return L.spent_usd;
}

const durationFor = (p) => {
  const d = p.frames <= 81 ? 5 : 10;
  const map = MODELS[modelFor(p).name]?.durations;
  return map ? map[d] : d;
};
const priceFor = (p) => modelFor(p).price[durationFor(p)];

async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${path}: не JSON (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok || (j.code && j.code !== 200)) throw new Error(`${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function balance() {
  const j = await api("/balance");
  return j.data.balance;
}

const uploadCache = new Map();
async function upload(filePath) {
  if (uploadCache.has(filePath)) return uploadCache.get(filePath);
  const buf = readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "image/png" }), basename(filePath));
  const j = await api("/media/upload/binary", { method: "POST", body: fd });
  const url = j.data.download_url;
  uploadCache.set(filePath, url);
  return url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Цепочка: стартовый кадр плана = последний кадр клипа другого плана.
// Задаётся явно ("master": "chain:plan3") либо автоматически, когда мастер —
// keys/planK_key.png, а такого ключа нет: тогда берём хвост клипа K. Так
// вторая половина сцены продолжает первую без нового ключевого кадра. Если
// клип K ещё снимается в соседнем воркере — ждём его.
async function resolveMaster(p) {
  let chainOf = null;
  const m = p.master.match(/^chain:plan(\d+)$/);
  if (m) chainOf = Number(m[1]);
  else {
    const k = p.master.match(/^keys\/plan(\d+)_key\.png$/);
    if (k && !existsSync(join(takesDir, p.master))) chainOf = Number(k[1]);
  }
  if (chainOf === null) {
    const masterPath = join(takesDir, p.master);
    if (!existsSync(masterPath)) throw new Error(`план ${p.plan}: нет мастера ${p.master}`);
    return masterPath;
  }
  const srcClip = join(outDir, `plan${chainOf}.mp4`);
  const t0 = Date.now();
  while (!existsSync(srcClip)) {
    if (Date.now() - t0 > 25 * 60 * 1000) throw new Error(`план ${p.plan}: не дождался клипа plan${chainOf} для цепочки`);
    await sleep(5000);
  }
  const chainDir = join(takesDir, "_chain");
  mkdirSync(chainDir, { recursive: true });
  const last = join(chainDir, `plan${chainOf}_last.png`);
  execFileSync("ffmpeg", ["-y", "-sseof", "-0.05", "-i", srcClip, "-frames:v", "1", "-update", "1", last, "-loglevel", "error"]);
  return last;
}

async function genClip(p) {
  const out = join(outDir, `plan${p.plan}.mp4`);
  const decision = decisionFor(p.plan, args.seed);
  if (decision === "accepted" && !args.redo) { console.log(`план ${p.plan}: принят приёмкой, пропускаю`); return null; }
  const forceRedo = args.redo || decision === "rejected" || decision === "redo";
  if (existsSync(out) && !forceRedo) { console.log(`план ${p.plan}: клип уже есть`); return null; }
  const M = modelFor(p);
  const masterPath = await resolveMaster(p);
  const keyPath = join(takesDir, "keys", `plan${p.plan}_key.png`);
  // Ключи делают движение жёстким, но модель держит персонажей и без них —
  // по умолчанию i2v. Ключ подключается только если в плане стоит
  // "use_key": true (или флаг --use-keys на весь прогон).
  const wantsKey = !p.i2v && !args.noKey && (p.use_key || args.useKeys) && existsSync(keyPath);
  if (wantsKey && !M.end) {
    throw new Error(`план ${p.plan}: модели ${M.path} нельзя передать конечный кадр — сними план через --model kling26-pro (или kling21-flf), либо помечай его "i2v": true`);
  }
  const useKey = wantsKey && !!M.end;
  const duration = durationFor(p);
  const label = `план ${p.plan} (${M.name}, ${duration} с, ${useKey ? "ключ" : "i2v"}${basename(masterPath).endsWith("_last.png") ? ", цепочка" : ""})`;

  const image = await upload(masterPath);
  const body = {
    image,
    prompt: p.motion,
    duration,
    ...(M.seed ? { seed: args.seed + p.plan } : {}),
    ...M.extra,
  };
  if (useKey) body[M.end] = await upload(keyPath);

  const t0 = Date.now();
  const sub = await api(`/${M.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = sub.data.id;
  let res;
  for (;;) {
    await sleep(3000);
    res = await api(`/predictions/${id}/result`);
    const st = res.data.status;
    if (st === "completed") break;
    if (["failed", "cancelled", "timeout", "deleted"].includes(st)) {
      throw new Error(`${label}: ${st} ${res.data.error ?? ""}`);
    }
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error(`${label}: не дождался за 15 минут`);
  }
  const url = res.data.outputs?.[0];
  if (!url) throw new Error(`${label}: нет выхода в ответе`);
  const vid = Buffer.from(await (await fetch(url)).arrayBuffer());
  mkdirSync(dirname(out), { recursive: true });
  if (args.stretch && args.stretch > 1) {
    // оригинал сохраняем рядом (_raw), в planN.mp4 кладём стилизованную версию
    const raw = join(dirname(out), "_raw"); mkdirSync(raw, { recursive: true });
    const rawFile = join(raw, basename(out)); writeFileSync(rawFile, vid);
    const uniqueFps = Math.round(24 / args.stretch);   // 1.6 → 15, 2.4 → 10
    execFileSync("ffmpeg", ["-y", "-i", rawFile, "-vf", `setpts=${args.stretch}*PTS,fps=${uniqueFps}`, "-r", "30",
      "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-an", out, "-loglevel", "error"]);
  } else {
    writeFileSync(out, vid);
  }
  const usd = M.price[duration];
  const spent = bookRun({ date: new Date().toISOString().slice(0, 10), id: args.id, plan: p.plan, model: M.name, mode: useKey ? "flf" : "i2v", duration, usd, out: args.outDir, project: "firstlight" });
  console.log(`${label} ... ${Math.round((Date.now() - t0) / 1000)} с, $${usd.toFixed(2)} (всего по книге $${spent.toFixed(2)})`);
  return out;
}

// ---- смета и предполёт ----
// Что снимать: чего ещё нет — и то, что приёмка ЗАВЕРНУЛА. Второе легко
// потерять: клип отклонённого плана лежит на диске, и наивная проверка
// «файл есть — значит снято» тихо превращает пересдачу в пустой прогон
// («к съёмке 0»), хотя решение о браке уже записано в acceptance.json.
const needsRedo = (p) => ["rejected", "redo"].includes(decisionFor(p.plan, args.seed));
const todo = plans.filter((p) => args.redo || needsRedo(p) || !existsSync(join(outDir, `plan${p.plan}.mp4`)));
const est = todo.reduce((s, p) => s + priceFor(p), 0);
const byModel = todo.reduce((acc, p) => { const n = modelFor(p).name; acc[n] = (acc[n] ?? 0) + 1; return acc; }, {});
console.log(`${args.id}: планов ${plans.length}, к съёмке ${todo.length} (${Object.entries(byModel).map(([k, v]) => `${k}×${v}`).join(", ")}), смета $${est.toFixed(2)}, выход → ${args.outDir}`);
if (args.dry) process.exit(0);
if (!KEY) { console.error("Нет WAVESPEED_API_KEY"); process.exit(2); }
const bal = await balance();
console.log(`баланс WaveSpeed: $${bal.toFixed(2)}`);
if (bal < est) { console.error(`Баланса не хватает на смету ($${est.toFixed(2)}) — пополнить или сузить --only`); process.exit(3); }

// ---- параллельная съёмка с ограничением ----
let idx = 0;
const failed = [];
async function worker() {
  while (idx < todo.length) {
    const p = todo[idx++];
    try { await genClip(p); }
    catch (e) { failed.push(p.plan); console.log(`план ${p.plan}: ✗ ${e.message.slice(0, 300)}`); }
  }
}
await Promise.all(Array.from({ length: Math.min(args.concurrency, todo.length) }, worker));
console.log(`готово. баланс: $${(await balance()).toFixed(2)}${failed.length ? `; не сняты: ${failed.join(", ")}` : ""}`);

// ---- склейка сцен в takes/<id>/<scene>_take1.mp4 (как в flf_batch) ----
// С перекодированием: клипы с пода — 16 fps, с WaveSpeed — 24 fps, в одной
// сцене могут встретиться оба; -c copy на таком списке даёт битый файл.
if (args.outDir === "_flf") {
  for (const sc of [...new Set(spec.plans.map((p) => p.scene))]) {
    const parts = spec.plans.filter((p) => p.scene === sc).map((p) => join(outDir, `plan${p.plan}.mp4`));
    if (!parts.every((f) => existsSync(f))) { console.log(`${sc}: не все планы готовы, склейку пропускаю`); continue; }
    const list = join(outDir, `${sc}_list.txt`);
    writeFileSync(list, parts.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const take = join(takesDir, `${sc}_take1.mp4`);
    execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-r", "24", "-c:v", "libx264", "-crf", "16",
      "-preset", "medium", "-pix_fmt", "yuv420p", "-an", take, "-loglevel", "error"]);
    console.log(`${sc}_take1.mp4 ← ${parts.map((f) => basename(f)).join(" + ")}`);
  }
}
