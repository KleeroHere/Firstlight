#!/usr/bin/env node
// Генерация ОПОРНЫХ кадров серии через Gemini API.
//
//   $env:GEMINI_API_KEY="..."
//   node engine/gemini_shots.mjs --id proverka-kachestva-pischi --check
//   node engine/gemini_shots.mjs --id proverka-kachestva-pischi --show-prompt
//   node engine/gemini_shots.mjs --id proverka-kachestva-pischi
//   node engine/gemini_shots.mjs --id proverka-kachestva-pischi --sheet
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ gemini_frames.mjs (и почему написан заново)
//
// Ночь 23.08 показала: 12 дефектов из 25 кадров, и 8 из них — это ВТОРЫЕ
// планы сцены (зеркальные рассадки, съехавший масштаб, двойники, чужие
// люди). Вторые планы — это 204 кадра из 393, то есть 52% бюджета,
// потраченные на самую бракованную половину работы.
//
// Поэтому здесь генерируется РОВНО ОДИН опорный кадр на сцену. Второй план
// («камера ближе») получается кропом из первого — см. --crop. Кроп бесплатен
// и физически не может разъехаться с оригиналом: это те же пиксели.
// Ради запаса на кроп кадр генерируется в 2K и сохраняется дважды:
// мастер 2K в _masters/ и рабочий 1280x720 для Wan.
//
// ПРАВИЛА ПРОМПТА (из официальной документации Google и практики, 23.08):
//  1. Негативы модель игнорирует архитектурно. Только позитивные
//     формулировки: не «без текста», а «надписи — нечитаемые штрихи».
//  2. У каждого референса — явная роль и номер.
//  3. Лист персонажа помечается как СПРАВОЧНИК, иначе позы с листа
//     попадают в кадр отдельными людьми (так на практике задваивался
//     персонаж — лист с двумя позами читался как два человека).
//  4. Явный счёт людей и их места слева направо — иначе рассадка
//     зеркалится между кадрами.
//  5. Паспорт персонажа — дословно из компилята, одинаковый в каждом
//     кадре. Переформулировка = дрейф одежды.
//  6. Не более 3 персонажей с листами: документированный предел
//     консистентности NB2 — 4, практический — 3.
//  7. Никакого edit-of-edit: каждый кадр генерируется от мастер-листов,
//     а не от предыдущего результата (иначе стиль вырождается в шарж).
//  8. Промпт короткий и структурный: длинные размытые простыни
//     ухудшают следование инструкции.
//  9. thinking_level high — официально улучшает следование промпту.
//
// СОГЛАШЕНИЕ: порядок в поле chars сцены = порядок персонажей СЛЕВА
// НАПРАВО в кадре. Скрипт пишет это в промпт явно.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig, loadScenario } from "./lib.mjs";
import { MAX_SHEETS, MAX_REFS, buildPrompt as buildShotPrompt, refFiles as shotRefFiles } from "./shot_prompt.mjs";

// Замер 23.08: 61 вызов = ~€4.5 (~$4.9) в 1K. 2K по прайсу в 1.5 раза дороже.
const PRICE_1K = 0.08;
const PRICE_2K = 0.12;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Лимиты и сам промпт живут в shot_prompt.mjs — один источник правды на
// генерацию и на сборку рабочего документа владельца.

function parseArgs(argv) {
  const a = { sleep: 7000, maxUsd: 5, model: "gemini-3.1-flash-image", size: "2K", retries: 2 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--max-usd") a.maxUsd = Number(argv[++i]);
    else if (v === "--sleep") a.sleep = Number(argv[++i]);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--size") a.size = argv[++i];
    else if (v === "--retries") a.retries = Number(argv[++i]);
    else if (v === "--redo") a.redo = true;
    else if (v === "--check") a.check = true;
    else if (v === "--show-prompt") a.showPrompt = true;
    else if (v === "--sheet") a.sheet = true;
    else if (v === "--no-thinking") a.noThinking = true; // thinkingConfig сбивает imageSize в 1K (js-genai#1461)
    else if (v === "--crop") a.crop = argv[++i];   // sceneId:W:H:X:Y (из мастера 2K)
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id <сценарий>");
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const TAKES = join(ROOT, cfg.paths.takes);
const REFS = JSON.parse(
  readFileSync(join(ROOT, "workspace", "prompts", "gemini_refs.json"), "utf8"),
).characters;
const j = loadScenario(cfg, args.id);
const OUT = join(TAKES, args.id);
const MASTERS = join(OUT, "_masters");
const STATE_FILE = join(ROOT, "reports", "night", `shots-${args.id}.json`);

const frameFile = (sceneId) => `${sceneId}_sh1_frame.png`;

// ---------- сцены -----------------------------------------------------------
const scenes = j.scenes.filter((s) => {
  if (s.kind === "title" || s.kind === "memo" || !s.img) return false;
  if (args.only && !args.only.includes(s.id)) return false;
  return true;
});

// ---------- промпт ----------------------------------------------------------
// Текст промпта и список вложений строит shot_prompt.mjs.
const buildPrompt = (sc) => buildShotPrompt(j, sc, REFS);
const refFiles = (sc) => shotRefFiles(j, sc, REFS);

// ---------- предполётная проверка (бесплатно) --------------------------------
function preflight() {
  const problems = [];
  for (const sc of scenes) {
    const chars = sc.chars ?? [];
    const bg = j.backgrounds?.[sc.bg];
    if (!bg) { problems.push(`${sc.id}: нет фона «${sc.bg}» в компиляте`); continue; }
    if (!existsSync(join(ROOT, bg.file))) problems.push(`${sc.id}: нет файла фона ${bg.file}`);
    for (const c of chars) {
      if (!j.characters[c]) { problems.push(`${sc.id}: нет паспорта персонажа ${c}`); continue; }
      if (!j.characters[c].passport) problems.push(`${sc.id}: пустой паспорт ${c}`);
      if (!REFS[c]) problems.push(`${sc.id}: ${c} без листа в gemini_refs.json — пойдёт только текстом`);
      else if (!existsSync(join(ROOT, REFS[c][0]))) problems.push(`${sc.id}: нет файла листа ${REFS[c][0]}`);
    }
    if (chars.length > MAX_SHEETS) {
      problems.push(`${sc.id}: ${chars.length} персонажей — листов подадим ${MAX_SHEETS}, остальные текстом (риск)`);
    }
  }
  return problems;
}

// ---------- сеть ------------------------------------------------------------
const KEY = process.env.GEMINI_API_KEY;
const mime = (f) => (extname(f).toLowerCase() === ".png" ? "image/png" : "image/jpeg");

async function callApi(prompt, files) {
  const parts = [{ text: prompt }];
  for (const f of files) {
    parts.push({ inline_data: { mime_type: mime(f), data: readFileSync(join(ROOT, f)).toString("base64") } });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: args.size },
      ...(args.noThinking ? {} : { thinkingConfig: { thinkingLevel: "high" } }),
    },
  };
  const send = () => fetch(`${API_BASE}/${args.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  let r = await send();
  if (r.status === 400) {
    const t = await r.text();
    // Старые ревизии API не знают thinkingConfig/imageSize — снимаем и повторяем.
    if (/thinking|imageSize|image_size/i.test(t)) {
      delete body.generationConfig.thinkingConfig;
      delete body.generationConfig.imageConfig.imageSize;
      r = await send();
    } else return { error: `400 ${t.slice(0, 300)}` };
  }
  if (r.status === 429) return { retryable: true, error: "429 лимит запросов" };
  if (r.status >= 500) return { retryable: true, error: `${r.status} сервер` };
  const jr = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `${r.status} ${JSON.stringify(jr).slice(0, 300)}` };
  if (jr.promptFeedback?.blockReason) return { blocked: true, error: `фильтр: ${jr.promptFeedback.blockReason}` };
  const img = jr.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!img) return { blocked: true, error: `нет изображения (finishReason: ${jr.candidates?.[0]?.finishReason ?? "?"})` };
  return { data: Buffer.from(img.inlineData.data, "base64") };
}

// ---------- ffmpeg ----------------------------------------------------------
function ff(a) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg: " + (r.stderr ?? "").split("\n").slice(-2).join(" "));
}
function toWorking(master, dest) {
  ff(["-i", master, "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", "-frames:v", "1", dest]);
}

// ---------- контактный лист (для приёмки глазами) ---------------------------
function contactSheet() {
  const rows = scenes.map((sc) => {
    const f = frameFile(sc.id);
    const p = join(OUT, f);
    const chars = (sc.chars ?? []).map((c) => j.characters[c]?.name ?? c).join(", ") || "без людей";
    return `<tr>
      <td class="img">${existsSync(p) ? `<img src="${f}">` : "<i>нет кадра</i>"}</td>
      <td>
        <div class="id">${sc.id}</div>
        <div class="meta">${chars} · фон «${j.backgrounds[sc.bg]?.name ?? sc.bg}» · ${sc.t?.[1] - sc.t?.[0]} с</div>
        <div class="txt">${sc.img}</div>
        <ul class="chk">
          <li>людей ровно ${(sc.chars ?? []).length}, лишних нет</li>
          <li>лица и одежда как на листах</li>
          <li>мебель как на фоне, ничего лишнего</li>
          <li>надписи нечитаемы</li>
          <li>никого не срезает краем</li>
        </ul>
      </td></tr>`;
  }).join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Приёмка: ${j.title}</title>
<style>body{font:15px/1.5 system-ui;margin:24px;background:#f7f4ee;color:#2b2320}
h1{font-size:20px}table{border-collapse:collapse;width:100%}
td{vertical-align:top;padding:12px;border-bottom:1px solid #ddd4c6}
td.img{width:620px}img{width:600px;border:1px solid #c9bfae;border-radius:4px}
.id{font-weight:700;font-size:17px}.meta{color:#7a6b5c;margin:4px 0 8px}
.txt{margin-bottom:10px}.chk{margin:0;padding-left:18px;color:#5c5045}
.chk li{margin:2px 0}</style>
<h1>${j.title} — приёмка опорных кадров</h1>
<p>Отметь глазами каждый пункт. Кадры 2K лежат в <code>_masters/</code>, рабочие 1280×720 — рядом.</p>
<table>${rows}</table>`;
  const dest = join(OUT, "priemka.html");
  writeFileSync(dest, html, "utf8");
  console.log("Контактный лист:", dest);
}

// ---------- кроп второго плана (бесплатно, из мастера 2K) -------------------
function doCrop(spec) {
  const [sceneId, w, h, x, y] = spec.split(":");
  const master = join(MASTERS, frameFile(sceneId));
  if (!existsSync(master)) throw new Error(`Нет мастера ${master}`);
  const dest = join(OUT, `${sceneId}_sh2_frame.png`);
  ff(["-i", master, "-vf", `crop=${w}:${h}:${x}:${y},scale=1280:720:flags=lanczos`, "-frames:v", "1", dest]);
  console.log(`Второй план: ${dest} (кроп ${w}x${h} из ${basename(master)}, $0)`);
}

// ---------- главный ход -----------------------------------------------------
const problems = preflight();
console.log(`Сценарий: ${j.title} (${args.id})`);
console.log(`Сцен к генерации: ${scenes.length} | размер ${args.size} | ` +
  `оценка $${(scenes.length * (args.size === "2K" ? PRICE_2K : PRICE_1K)).toFixed(2)}`);
if (problems.length) {
  console.log("\nПРЕДПОЛЁТНАЯ ПРОВЕРКА:");
  for (const p of problems) console.log("  ⚠ " + p);
} else console.log("Предполётная проверка: чисто.");

if (args.crop) { doCrop(args.crop); process.exit(0); }
if (args.sheet) { contactSheet(); process.exit(0); }

if (args.showPrompt) {
  for (const sc of scenes) {
    console.log("\n" + "=".repeat(72));
    console.log(`СЦЕНА ${sc.id}`);
    console.log("Референсы:"); refFiles(sc).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log("-".repeat(72));
    console.log(buildPrompt(sc));
  }
  process.exit(0);
}
if (args.check) process.exit(problems.length ? 1 : 0);
if (!KEY) { console.error("Нет GEMINI_API_KEY в окружении"); process.exit(2); }

mkdirSync(MASTERS, { recursive: true });
mkdirSync(join(ROOT, "reports", "night"), { recursive: true });
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { spentUsd: 0, frames: {} };
const price = args.size === "2K" ? PRICE_2K : PRICE_1K;
let made = 0, spent = 0;

for (const sc of scenes) {
  const dest = join(OUT, frameFile(sc.id));
  if (existsSync(dest) && !args.redo) { console.log(`= ${sc.id}: кадр есть, пропуск (--redo чтобы перерисовать)`); continue; }
  if (spent + price > args.maxUsd) { console.log(`Потолок $${args.maxUsd} — стоп.`); break; }

  const prompt = buildPrompt(sc);
  const files = refFiles(sc);
  process.stdout.write(`→ ${sc.id} (${(sc.chars ?? []).length} чел., ${files.length} реф.) ... `);

  let res, attempt = 0;
  for (;;) {
    res = await callApi(prompt, files);
    if (res.retryable && attempt < args.retries) {
      attempt++;
      const wait = attempt * 30000;
      console.log(`${res.error}, жду ${wait / 1000} с`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }

  if (res.data) {
    const master = join(MASTERS, frameFile(sc.id));
    writeFileSync(master, res.data);
    toWorking(master, dest);
    made++; spent += price; state.spentUsd += price;
    state.frames[sc.id] = { status: "ok", ts: new Date().toISOString() };
    console.log(`ok  ($${state.spentUsd.toFixed(2)} всего)`);
  } else {
    state.frames[sc.id] = { status: res.blocked ? "blocked" : "error", error: res.error };
    console.log(`✗ ${res.error}`);
    if (/API_KEY|PERMISSION|billing/i.test(res.error ?? "")) { console.error("Проблема ключа/биллинга — стоп."); break; }
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  await new Promise((r) => setTimeout(r, args.sleep));
}

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
console.log(`\nГотово: ${made} кадров, за прогон ~$${spent.toFixed(2)}.`);
if (made) contactSheet();
