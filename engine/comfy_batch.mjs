#!/usr/bin/env node
// Пакетная генерация клипов серии через HTTP-API ComfyUI.
//
//   node engine/comfy_batch.mjs --id kvartsevanie --host https://<pod>-8188.proxy.runpod.net
//
// Опции:
//   --id <id>          сценарий (compiled/<id>.json); можно повторять
//   --all              все сценарии, кроме снятых с производства
//   --host <url>       адрес ComfyUI (по умолчанию http://127.0.0.1:8188)
//   --api <file>       воркфлоу в API-формате
//                      (по умолчанию engine/wan22_i2v.api.json)
//   --width/--height   размер кадра (по умолчанию 1280x720)
//   --frames <n>       кадров в клипе (по умолчанию из воркфлоу)
//   --only <s1,s2>     только эти сцены
//   --limit <n>        остановиться после n клипов
//   --prompts-en <f>   файл английских промптов по сценам (prompts_en.json).
//                      Wan понимает только английский и китайский: русский
//                      anim из компилята модель фактически не читает.
//   --prompt <текст>   позитив целиком вместо anim+animation_rules
//   --negative <текст> негатив целиком (работает только если cfg>1 или включён NAG)
//   --redo             перегенерировать, даже если дубль уже есть
//   --dry-run          показать план и выйти
//   --show-prompt      напечатать готовые тексты промптов и выйти (бесплатно)
//
// Что делает: сцена — это ЦЕПОЧКА клипов, а не один клип. Wan отдаёт
// 5,06 с за раз, сцена сценария длится тридцать. Поэтому:
//
//   план 1 ← опорный кадр sN_sh1_frame.png
//     клип 1 ← опорный кадр
//     клип 2 ← последний кадр клипа 1
//     клип 3 ← последний кадр клипа 2
//   монтажная склейка (цепочка длиннее трёх звеньев расплывается)
//   план 2 ← опорный кадр sN_sh2_frame.png (другая крупность)
//     ...
//
// Звенья лежат в takes/<id>/_chain/, склеенная сцена — в
// takes/<id>/sN_take1.mp4 полной длины. Сборщику этого достаточно:
// он видит дубль длиной со сцену и берёт его целиком.
//
// Панорамы генерируются наравне со всеми: поле motion в сценарии —
// это подсказка режиссёру, а не признак «этой сцене видео не нужно».
// Раньше здесь стоял фильтр по нему, и 110 сцен из 177 молча
// пропускались.
//
// Готовые звенья пропускаются: прогон можно прерывать и запускать
// заново.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";
import { shotPlan, frameName, clipName, sceneTake, CLIP_SEC } from "./shots.mjs";

function parseArgs(argv) {
  const a = { ids: [], host: "http://127.0.0.1:8188", width: 1280, height: 720 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.ids.push(argv[++i]);
    else if (v === "--all") a.all = true;
    else if (v === "--host") a.host = argv[++i].replace(/\/$/, "");
    else if (v === "--api") a.api = argv[++i];
    else if (v === "--width") a.width = Number(argv[++i]);
    else if (v === "--height") a.height = Number(argv[++i]);
    else if (v === "--frames") a.frames = Number(argv[++i]);
    else if (v === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--limit") a.limit = Number(argv[++i]);
    else if (v === "--show-prompt") a.showPrompt = true;
    else if (v === "--prompts-en") a.promptsEn = argv[++i];
    else if (v === "--prompt") a.prompt = argv[++i];
    else if (v === "--negative") a.negative = argv[++i];
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
const apiFile = args.api ?? join(ROOT, "engine", "wan22_i2v.api.json");

if (!existsSync(apiFile)) {
  console.error(`Нет воркфлоу в API-формате: ${apiFile}

Взять его так: открыть ComfyUI, загрузить Wan2.2_I2V, меню «Рабочий
процесс» → «Экспортировать (API)». Один пункт меню, узлы трогать не
нужно. Файл положить рядом со скриптом под этим именем.`);
  process.exit(2);
}

// ---------- разбор воркфлоу -------------------------------------------------
// В API-формате граф — плоский словарь узлов: { "3": {class_type, inputs} }.
// Ищем узлы по классу; связи вида [id, slot] ведут к соседним узлам.
function findNodes(g, cls) {
  return Object.entries(g).filter(([, n]) => n.class_type === cls).map(([id]) => id);
}
function only(g, cls, what) {
  const ids = findNodes(g, cls);
  if (ids.length === 0) throw new Error(`В воркфлоу нет узла ${cls} (${what})`);
  if (ids.length > 1) console.warn(`⚠ узлов ${cls} несколько (${ids.join(", ")}), беру первый`);
  return ids[0];
}

function describe(g) {
  const i2v = only(g, "WanImageToVideo", "размер и длина клипа");
  const load = only(g, "LoadImage", "первый кадр");
  const posLink = g[i2v].inputs.positive;
  const positive = Array.isArray(posLink) ? String(posLink[0]) : null;
  if (!positive) throw new Error("У WanImageToVideo не найден вход positive");
  const negLink = g[i2v].inputs.negative;
  const negative = Array.isArray(negLink) ? String(negLink[0]) : null;
  const samplers = findNodes(g, "KSamplerAdvanced").concat(findNodes(g, "KSampler"));
  const combine = findNodes(g, "VHS_VideoCombine").concat(findNodes(g, "SaveWEBM"))
    .concat(findNodes(g, "SaveAnimatedWEBP"));
  return { i2v, load, positive, negative, samplers, combine };
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
    body: JSON.stringify({ prompt: graph, client_id: "aurora-batch" }),
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
      if (st.status_str === "error" || st.completed === false && st.status_str === "error") {
        throw new Error(`ComfyUI вернул ошибку: ${JSON.stringify(st.messages ?? st).slice(0, 400)}`);
      }
      if (st.completed || rec.outputs) return rec;
    }
    await sleep(3000);
  }
}

function pickVideo(rec) {
  for (const out of Object.values(rec.outputs ?? {})) {
    for (const key of ["gifs", "videos", "images"]) {
      for (const f of out[key] ?? []) {
        if (/\.(mp4|webm|mkv)$/i.test(f.filename)) return f;
      }
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

// ---------- ffmpeg: последний кадр и склейка --------------------------------
// Цепочка держится на одном действии: взять последний кадр клипа и
// подать его как первый кадр следующего. reverse на 81 кадре дешевле
// и надёжнее, чем гадать со сдвигом от конца файла.
function ff(argv) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv],
    { encoding: "utf8" });
  if (r.error) throw new Error(`ffmpeg не найден: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr ?? "").slice(-400)}`);
}
function lastFrame(video, dest) {
  ff(["-i", video, "-vf", "reverse,select=eq(n\\,0)", "-frames:v", "1", dest]);
  return dest;
}
function concatScene(files, dest) {
  const list = dest.replace(/\.mp4$/, ".txt");
  writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  try {
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", dest]);
  } catch {
    // Разные параметры у звеньев — пересобираем честно.
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264",
      "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", dest]);
  }
  return dest;
}

// ---------- сборка задания --------------------------------------------------
function buildGraph(tpl, node, sn, sc, imageName, seed, j) {
  const g = structuredClone(tpl);
  g[node.load].inputs.image = imageName;

  const anim = String(sc.anim ?? "").trim();
  const tail = String(sn.animation_rules ?? "").trim();
  // Второе и следующие звенья продолжают начатое движение, а не
  // начинают жест заново — иначе цепочка дёргается на стыках.
  const cont = j > 1 ? "Движение продолжается плавно, без резкой смены позы." : "";
  // Английский пакет перебивает русский anim из компилята: Wan читает
  // только английский и китайский (замер 23.08 — на русском промпт
  // фактически не действует, сцена расползается).
  const pack = promptsEn?.[sn.id];
  const en = pack?.[sc.id];
  const enText = en ? [en, cont, pack?._rules].filter(Boolean).join(" ") : null;
  g[node.positive].inputs.text =
    args.prompt ?? enText ?? [anim, cont, tail].filter(Boolean).join(" ");
  const neg = args.negative ?? pack?._negative;
  if (neg && node.negative) g[node.negative].inputs.text = neg;

  const i2v = g[node.i2v].inputs;
  if (args.width) i2v.width = args.width;
  if (args.height) i2v.height = args.height;
  if (args.frames) i2v.length = args.frames;

  for (const s of node.samplers) {
    const inp = g[s].inputs;
    if ("noise_seed" in inp) inp.noise_seed = seed;
    if ("seed" in inp) inp.seed = seed;
  }
  for (const c of node.combine) {
    if ("filename_prefix" in g[c].inputs) g[c].inputs.filename_prefix = `${sn.id}_${sc.id}`;
  }
  return g;
}

// ---------- основной ход ----------------------------------------------------
const promptsEn = args.promptsEn
  ? JSON.parse(readFileSync(args.promptsEn, "utf8"))
  : null;

const tpl = JSON.parse(readFileSync(apiFile, "utf8"));
const node = describe(tpl);

const ids = args.all
  ? readdirSync(COMPILED).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  : args.ids;

// План работы: сцена → планы → звенья. Считается заранее и целиком,
// чтобы бюджет ночи был известен до первого клипа, а не после.
const scenes = [];
for (const id of ids) {
  const sn = JSON.parse(readFileSync(join(COMPILED, `${id}.json`), "utf8"));
  if (sn.retired) continue;
  const takesDir = join(TAKES, id);
  const chainDir = join(takesDir, "_chain");
  for (const sc of sn.scenes) {
    if ((sc.kind ?? "scene") !== "scene") continue;
    if (args.only && !args.only.includes(sc.id)) continue;
    const take = join(takesDir, sceneTake(sc.id));
    if (!args.redo && existsSync(take)) continue;         // сцена уже собрана
    const plan = shotPlan(sc);
    const missing = plan
      .map((sh) => join(takesDir, frameName(sc.id, sh.k)))
      .filter((f) => !existsSync(f));
    if (missing.length) {
      scenes.push({ id, sn, sc, skip: `нет опорных кадров: ${missing.length} из ${plan.length}` });
      continue;
    }
    scenes.push({ id, sn, sc, plan, takesDir, chainDir, take });
  }
}

const ready = scenes.filter((j) => !j.skip);
const blocked = scenes.filter((j) => j.skip);
const totalClips = ready.reduce((a, j) => a + j.plan.reduce((b, sh) => b + sh.clips, 0), 0);
console.log(`К генерации: ${ready.length} сцен, ${totalClips} звеньев, ${args.width}x${args.height}`);
if (blocked.length) console.log(`Без опорных кадров, пропускаю: ${blocked.length} сцен`);
if (args.showPrompt) {
  for (const j of ready) {
    const g = buildGraph(tpl, node, j.sn, j.sc, "frame.png", 1, 1);
    console.log(`
=== ${j.id} / ${j.sc.id} ===`);
    console.log("ПОЗИТИВ:  " + g[node.positive].inputs.text);
    if (node.negative) console.log("НЕГАТИВ:  " + g[node.negative].inputs.text);
  }
  process.exit(0);
}

if (args.dryRun) {
  for (const j of ready) {
    console.log(`  ${j.id} / ${j.sc.id}  ${j.plan.length} план(ов), ` +
      `${j.plan.map((sh) => sh.clips).join("+")} звеньев`);
  }
  for (const j of blocked) console.log(`  ⏭ ${j.id} / ${j.sc.id} — ${j.skip}`);
  process.exit(0);
}

const times = [];
let done = 0;
outer:
for (const j of ready) {
  mkdirSync(j.chainDir, { recursive: true });
  const chain = [];
  for (const sh of j.plan) {
    // Первое звено плана стартует с нарисованного опорного кадра,
    // каждое следующее — с последнего кадра предыдущего.
    let src = join(j.takesDir, frameName(j.sc.id, sh.k));
    for (let c = 1; c <= sh.clips; c++) {
      if (args.limit && done >= args.limit) break outer;
      const dest = join(j.chainDir, clipName(j.sc.id, sh.k, c));
      if (!args.redo && existsSync(dest)) {
        chain.push(dest);
        src = lastFrame(dest, dest.replace(/\.mp4$/, "_last.png"));
        continue;
      }
      const t0 = Date.now();
      try {
        const imageName = await uploadImage(src);
        const seed = Math.floor((t0 % 1e9) + done * 7919);
        const promptId = await queue(buildGraph(tpl, node, j.sn, j.sc, imageName, seed, c));
        const rec = await waitFor(promptId);
        const f = pickVideo(rec);
        if (!f) throw new Error("ComfyUI не отдал видео");
        await download(f, dest);
      } catch (e) {
        console.error(`✗ ${j.id}/${j.sc.id} план ${sh.k} звено ${c}: ${String(e.message).slice(0, 200)}`);
        continue outer;                                   // сцену добьём следующим прогоном
      }
      chain.push(dest);
      src = lastFrame(dest, dest.replace(/\.mp4$/, "_last.png"));
      const sec = (Date.now() - t0) / 1000;
      times.push(sec);
      done += 1;
      console.log(`✓ ${j.id}/${j.sc.id} план ${sh.k} звено ${c}/${sh.clips}  ` +
        `${sec.toFixed(0)} с  (${done}/${totalClips})`);
    }
  }
  if (chain.length) {
    concatScene(chain, j.take);
    console.log(`  → сцена собрана: ${basename(j.take)}  ` +
      `${(chain.length * CLIP_SEC).toFixed(1)} с из ${(j.sc.t[1] - j.sc.t[0])} с`);
  }
}

for (const j of blocked) console.log(`⏭ ${j.id}/${j.sc.id} — ${j.skip}`);

if (times.length) {
  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  const rate = Number(process.env.POD_USD_PER_HOUR ?? 0.74);
  console.log(`\nЗвеньев: ${times.length}   всего ${(sum / 60).toFixed(1)} мин   ` +
    `среднее ${avg.toFixed(0)} с/звено`);
  console.log(`При $${rate}/час это $${(sum / 3600 * rate).toFixed(2)} за прогон, ` +
    `$${(avg * 1068 / 3600 * rate).toFixed(2)} за все 1068 звеньев серии.`);
}
