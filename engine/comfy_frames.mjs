#!/usr/bin/env node
// Звено 3 конвейера: генерация стартовых кадров сцен.
//
//   node engine/comfy_frames.mjs --id fog-signal-check \
//        --host https://<pod>-8188.proxy.runpod.net
//
// Опции:
//   --id <id>        сценарий (compiled/<id>.json); можно повторять
//   --all            все сценарии, кроме снятых с производства
//   --host <url>     адрес ComfyUI
//   --api <file>     воркфлоу в API-формате
//                    (по умолчанию engine/flux_scene.api.json)
//   --width/--height размер кадра (по умолчанию 1280x720)
//   --denoise <0..1> сила переписывания фона (по умолчанию 0.65)
//   --steps <n>      шагов сэмплера
//   --only <s1,s2>   только эти сцены
//   --limit <n>      остановиться после n кадров
//   --redo           перегенерировать поверх готового
//   --dry-run        показать план и выйти
//
// Как устроено. Фон сцены уже нарисован и утверждён — его нельзя
// пересобирать словами, иначе комната в каждой сцене будет другой.
// Поэтому кадр строится как img2img поверх файла фона: композиция,
// мебель и палитра остаются, модель дорисовывает в них персонажей.
// Персонажи держатся триггер-токенами обученной LoRA.
//
// Результат — takes/<ролик>/<сцена>_frame.png, ровно то, что ждёт на
// вход comfy_batch.mjs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, loadConfig } from "./lib.mjs";
import { shotPlan, frameName, framingHint } from "./shots.mjs";

function parseArgs(argv) {
  const a = { ids: [], host: "http://127.0.0.1:8188", width: 1280, height: 720, denoise: 0.65 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.ids.push(argv[++i]);
    else if (v === "--all") a.all = true;
    else if (v === "--host") a.host = argv[++i].replace(/\/$/, "");
    else if (v === "--api") a.api = argv[++i];
    else if (v === "--width") a.width = Number(argv[++i]);
    else if (v === "--height") a.height = Number(argv[++i]);
    else if (v === "--denoise") a.denoise = Number(argv[++i]);
    else if (v === "--steps") a.steps = Number(argv[++i]);
    else if (v === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--limit") a.limit = Number(argv[++i]);
    else if (v === "--redo") a.redo = true;
    else if (v === "--dry-run") a.dryRun = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.all && a.ids.length === 0) throw new Error("Нужен --id <сценарий> или --all");
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const COMPILED = join(ROOT, cfg.paths.compiled);
const TAKES = join(ROOT, cfg.paths.takes);
const apiFile = args.api ?? join(ROOT, "engine", "flux_scene.api.json");

if (!existsSync(apiFile)) {
  console.error(`Нет воркфлоу в API-формате: ${apiFile}

Собрать его так: в ComfyUI открыть граф Flux img2img с LoraLoader,
проверить одной генерацией и сохранить через меню «Рабочий процесс» →
«Экспортировать (API)». Требования к графу — в docs/tz-agent-konveier.md,
раздел «Воркфлоу кадра».`);
  process.exit(2);
}

// ---------- разбор воркфлоу -------------------------------------------------
function findNodes(g, cls) {
  return Object.entries(g).filter(([, n]) => n.class_type === cls).map(([id]) => id);
}
function one(g, classes, what, required = true) {
  for (const cls of [].concat(classes)) {
    const ids = findNodes(g, cls);
    if (ids.length) {
      if (ids.length > 1) console.warn(`⚠ узлов ${cls} несколько (${ids.join(", ")}), беру первый`);
      return ids[0];
    }
  }
  if (required) throw new Error(`В воркфлоу нет узла ${[].concat(classes).join("/")} (${what})`);
  return null;
}

// Позитив и негатив различаем по тому, куда они подключены у сэмплера,
// а не по порядку узлов: порядок в экспорте не гарантирован.
function describe(g) {
  const sampler = one(g, ["KSampler", "KSamplerAdvanced", "SamplerCustomAdvanced"], "сэмплер");
  const load = one(g, "LoadImage", "фон сцены");
  const encode = one(g, ["VAEEncode", "VAEEncodeForInpaint"], "кодирование фона в латент");
  const save = one(g, ["SaveImage", "PreviewImage"], "сохранение кадра");
  const inp = g[sampler].inputs;

  const linkTo = (name) => (Array.isArray(inp[name]) ? String(inp[name][0]) : null);
  let positive = linkTo("positive");
  let negative = linkTo("negative");

  // У FluxGuidance и подобных обёрток текст лежит на узел глубже.
  const textNode = (id) => {
    let cur = id, guard = 0;
    while (cur && guard++ < 6) {
      if (g[cur]?.inputs && typeof g[cur].inputs.text === "string") return cur;
      const next = g[cur]?.inputs?.conditioning;
      cur = Array.isArray(next) ? String(next[0]) : null;
    }
    return null;
  };
  positive = positive && textNode(positive);
  negative = negative && textNode(negative);
  if (!positive) throw new Error("Не нашла узел с текстом позитивного промпта");

  const denoiseHost = "denoise" in inp ? sampler : null;
  return { sampler, load, encode, save, positive, negative, denoiseHost };
}

// ---------- сеть ------------------------------------------------------------
async function jfetch(path, init) {
  const r = await fetch(args.host + path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

async function uploadImage(file) {
  const fd = new FormData();
  fd.append("image", new Blob([readFileSync(file)]), basename(file));
  fd.append("overwrite", "true");
  const j = await jfetch("/upload/image", { method: "POST", body: fd });
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

async function queue(graph) {
  const j = await jfetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "aurora-frames" }),
  });
  return j.prompt_id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(promptId) {
  for (;;) {
    const h = await jfetch(`/history/${promptId}`);
    const rec = h[promptId];
    if (rec) {
      const st = rec.status ?? {};
      if (st.status_str === "error") {
        throw new Error(`ComfyUI вернул ошибку: ${JSON.stringify(st.messages ?? st).slice(0, 400)}`);
      }
      if (st.completed || rec.outputs) return rec;
    }
    await sleep(2000);
  }
}

function pickImage(rec) {
  for (const out of Object.values(rec.outputs ?? {})) {
    for (const f of out.images ?? []) {
      if (/\.(png|jpe?g|webp)$/i.test(f.filename)) return f;
    }
  }
  return null;
}

async function download(f, dest) {
  const q = new URLSearchParams({
    filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output",
  });
  const r = await fetch(`${args.host}/view?${q}`);
  if (!r.ok) throw new Error(`Скачивание ${f.filename}: ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

// ---------- промпт кадра ----------------------------------------------------
// Порядок частей неслучаен: сначала кто в кадре (триггеры — самое важное
// для узнаваемости лиц), потом что происходит, потом где, и только потом
// стиль. Модель взвешивает начало промпта сильнее.
function framePrompt(sn, sc, k = 1) {
  const parts = [];

  const chars = (sc.chars ?? []).map((c) => sn.characters?.[c]).filter(Boolean);
  if (chars.length) {
    parts.push(chars.map((c) => `${c.trigger} (${c.name})`).join(", "));
  }
  parts.push(String(sc.img ?? "").trim());
  const hint = framingHint(k);
  if (hint) parts.push(hint);

  const bg = sn.backgrounds?.[sc.bg];
  if (bg?.desc) parts.push(bg.desc);

  parts.push(String(sn.style ?? "").trim());
  parts.push("в кадре нет текста, надписей, букв и цифр");

  return parts.filter(Boolean).join(". ");
}

function buildGraph(tpl, node, sn, sc, bgName, seed, k = 1) {
  const g = structuredClone(tpl);
  g[node.load].inputs.image = bgName;
  g[node.positive].inputs.text = framePrompt(sn, sc, k);
  if (node.negative) g[node.negative].inputs.text = String(sn.negative ?? "").trim();

  const inp = g[node.sampler].inputs;
  if ("denoise" in inp) inp.denoise = args.denoise;
  if (args.steps && "steps" in inp) inp.steps = args.steps;
  if ("noise_seed" in inp) inp.noise_seed = seed;
  if ("seed" in inp) inp.seed = seed;

  if ("width" in g[node.save].inputs) g[node.save].inputs.width = args.width;
  if ("filename_prefix" in g[node.save].inputs) {
    g[node.save].inputs.filename_prefix = `${sn.id}_${sc.id}_sh${k}`;
  }
  return g;
}

// ---------- основной ход ----------------------------------------------------
const tpl = JSON.parse(readFileSync(apiFile, "utf8"));
const node = describe(tpl);

const ids = args.all
  ? readdirSync(COMPILED).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  : args.ids;

const jobs = [];
for (const id of ids) {
  const sn = JSON.parse(readFileSync(join(COMPILED, `${id}.json`), "utf8"));
  if (sn.retired) continue;
  const takesDir = join(TAKES, id);
  for (const sc of sn.scenes) {
    if ((sc.kind ?? "scene") !== "scene") continue;
    if (args.only && !args.only.includes(sc.id)) continue;

    const bg = sn.backgrounds?.[sc.bg];
    const bgFile = bg?.file ? join(ROOT, bg.file) : null;
    if (!bgFile || !existsSync(bgFile)) {
      jobs.push({ id, sn, sc, skip: `нет файла фона «${sc.bg}»` });
      continue;
    }
    const unknown = (sc.chars ?? []).filter((c) => !sn.characters?.[c]?.trigger);
    if (unknown.length) {
      jobs.push({ id, sn, sc, skip: `нет триггера у: ${unknown.join(", ")}` });
      continue;
    }
    // Сцена длиной 30 с — это не один кадр, а два плана по 15 с.
    // Раскадровка живёт в shots.mjs, здесь только исполнение.
    for (const shot of shotPlan(sc)) {
      const dest = join(takesDir, frameName(sc.id, shot.k));
      if (!args.redo && existsSync(dest)) continue;
      jobs.push({ id, sn, sc, k: shot.k, bgFile, takesDir, dest });
    }
  }
}

const ready = jobs.filter((j) => !j.skip);
const blocked = jobs.filter((j) => j.skip);
console.log(`К генерации кадров: ${ready.length}, ${args.width}x${args.height}, denoise ${args.denoise}`);
if (blocked.length) console.log(`Заблокировано: ${blocked.length}`);
if (args.dryRun) {
  for (const j of ready.slice(0, args.limit ?? 1e9)) {
    console.log(`  ${j.id} / ${j.sc.id} план ${j.k}  [${(j.sc.chars ?? []).join(", ") || "без людей"}]  фон ${j.sc.bg}`);
  }
  for (const j of blocked) console.log(`  ⏭ ${j.id} / ${j.sc.id} — ${j.skip}`);
  if (ready.length) {
    console.log(`\nПример промпта:\n${framePrompt(ready[0].sn, ready[0].sc, ready[0].k).slice(0, 600)}`);
  }
  process.exit(0);
}

// Один и тот же фон грузим в ComfyUI один раз за прогон.
const uploaded = new Map();
const times = [];
let done = 0;

for (const j of ready) {
  if (args.limit && done >= args.limit) break;
  mkdirSync(j.takesDir, { recursive: true });
  const t0 = Date.now();
  if (!uploaded.has(j.bgFile)) uploaded.set(j.bgFile, await uploadImage(j.bgFile));
  const seed = Math.floor((t0 % 1e9) + done * 7919);
  const promptId = await queue(buildGraph(tpl, node, j.sn, j.sc, uploaded.get(j.bgFile), seed, j.k));
  const rec = await waitFor(promptId);
  const f = pickImage(rec);
  if (!f) { console.error(`✗ ${j.id}/${j.sc.id}: ComfyUI не отдал картинку`); continue; }
  await download(f, j.dest);
  const sec = (Date.now() - t0) / 1000;
  times.push(sec);
  done += 1;
  console.log(`✓ ${j.id}/${j.sc.id} план ${j.k} → ${basename(j.dest)}  ${sec.toFixed(0)} с (${done}/${args.limit ?? ready.length})`);
}

for (const j of blocked) console.log(`⏭ ${j.id}/${j.sc.id} — ${j.skip}`);

if (times.length) {
  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  const rate = Number(process.env.POD_USD_PER_HOUR ?? 0.74);
  console.log(`\nКадров: ${times.length}   всего ${(sum / 60).toFixed(1)} мин   среднее ${avg.toFixed(0)} с/кадр`);
  console.log(`При $${rate}/час это $${(sum / 3600 * rate).toFixed(2)} за прогон, ` +
    `$${(avg * 374 / 3600 * rate).toFixed(2)} за все 374 плана серии.`);
}
