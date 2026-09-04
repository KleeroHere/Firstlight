#!/usr/bin/env node
// Генерация опорных кадров серии через Gemini API.
//
//   set GEMINI_API_KEY=...   (PowerShell: $env:GEMINI_API_KEY="...")
//   node engine/gemini_frames.mjs --batch 1 --dry-run
//   node engine/gemini_frames.mjs --batch 1
//
// Опции:
//   --id <id>        сценарий (compiled/<id>.json); можно повторять
//   --batch <n>      пачка n из reports/night/queue.json (1..4)
//   --all            все сценарии из очереди по порядку
//   --only <s1,s2>   только эти сцены (id сцен через запятую)
//   --limit <n>      остановиться после n сгенерированных кадров
//   --max-usd <x>    жёсткий потолок расходов на прогон (по умолчанию 14)
//   --sleep <мс>     пауза между запросами (по умолчанию 7000 — под лимит
//                    10 запросов/мин на Tier 1)
//   --model <name>   по умолчанию gemini-3.1-flash-image
//   --redo           перегенерировать, даже если кадр уже есть
//   --dry-run        посчитать кадры и стоимость, ничего не вызывать
//
// Что делает. Для каждой сцены компилята строит промпт МЕХАНИЧЕСКИ:
// паспорта персонажей + описание кадра (sc.img) + подсказка крупности
// для планов k>=2 + суффикс вписывания + стиль + запреты. Прикладывает
// референсы: листы персонажей (gemini_refs.json) и файл фона из
// компилята. Ответ сохраняет и приводит ffmpeg'ом к 1280x720 — ровно
// в takes/<id>/<сцена>_sh<k>_frame.png, где кадры ждёт comfy_batch.mjs.
//
// Прогон можно прерывать и запускать заново: готовые кадры
// пропускаются, состояние — reports/night/gemini-frames-state.json.
//
// Стоимость: $0.067 за изображение 1K (тариф gemini-3.1-flash-image,
// проверен 23.08.2026). Плюс input-токены референсов — копейки, но в
// счётчик заложен запас 5%.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig, loadScenario } from "./lib.mjs";
import { shotPlan, frameName, framingHint } from "./shots.mjs";

// ЗАМЕР 23.08: 61 вызов израсходовал ~€4.5 (~$4.9). Тариф за выход 1K —
// $0.067; сверху ~15% за входные референсы. Итого ~$0.08 за кадр.
// Проверять на https://aistudio.google.com/usage перед каждой большой пачкой.
const PRICE_PER_IMAGE = 0.08;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function parseArgs(argv) {
  const a = { ids: [], sleep: 7000, maxUsd: 14, model: "gemini-3.1-flash-image" };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.ids.push(argv[++i]);
    else if (v === "--batch") a.batch = Number(argv[++i]);
    else if (v === "--all") a.all = true;
    else if (v === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--limit") a.limit = Number(argv[++i]);
    else if (v === "--max-usd") a.maxUsd = Number(argv[++i]);
    else if (v === "--sleep") a.sleep = Number(argv[++i]);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--redo") a.redo = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--show-prompt") { a.dryRun = true; a.showPrompt = true; }
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const TAKES = join(ROOT, cfg.paths.takes);
const STATE_FILE = join(ROOT, "reports", "night", "gemini-frames-state.json");
const REFS = JSON.parse(
  readFileSync(join(ROOT, "workspace", "prompts", "gemini_refs.json"), "utf8"),
).characters;

// ---------- очередь ---------------------------------------------------------
function videoList() {
  if (args.ids.length) return args.ids;
  const q = JSON.parse(readFileSync(join(ROOT, "reports", "night", "queue.json"), "utf8"));
  if (args.batch) {
    const b = q.batches[args.batch - 1];
    if (!b) throw new Error(`В очереди нет пачки ${args.batch}`);
    return b;
  }
  if (args.all) return q.videos ?? q.batches.flat();
  throw new Error("Нужен --id, --batch <n> или --all");
}

// ---------- состояние -------------------------------------------------------
function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  return { spentUsd: 0, frames: {} };
}
const state = loadState();
function saveState() {
  mkdirSync(join(ROOT, "reports", "night"), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ---------- промпт: строго из компилята -------------------------------------
// Ничего «по памяти»: паспорта — из j.characters, кадр — из sc.img,
// стиль и запреты — из j.style / j.negative. Руками сюда текст про
// конкретных людей не вписывать.
// По ресерчу 23.08 (доки Google + практика): негативные формулировки модель
// игнорирует архитектурно — работает только «семантический позитив».
// Поэтому вместо запретов — позитивное описание нужного состояния.
const FIT_SUFFIX =
  "Персонажи вписаны в сцену естественно: единое освещение и цветовая " +
  "температура с фоном, мягкие тени от персонажей на пол в ту же сторону, " +
  "что остальные тени сцены. Все персонажи стоят или сидят, опираясь на пол " +
  "и мебель по её назначению. Комната в точности повторяет референс фона: " +
  "та же мебель на тех же местах, и только она.";

const POSITIVE_RULES =
  "Все доски, экраны, бумаги и обложки в кадре — либо чистые, либо покрыты " +
  "нечитаемыми условными штрихами акварелью; надписи выглядят как абстрактные " +
  "чёрточки. Рты у всех закрыты и нейтральны, взгляды направлены по действию " +
  "сцены. Кисти рук анатомичные, с пятью пальцами.";

function buildPrompt(j, sc, k, chars, bgName, anchorType, hasBg) {
  const p = [];
  const refList = [];
  let n = 1;
  for (const c of chars.slice(0, 4)) {
    refList.push(`изображение ${n++} — референс-лист персонажа ${j.characters[c].name}`);
  }
  if (hasBg) refList.push(`изображение ${n} — фон «${bgName}»`);
  if (refList.length) p.push(`Референсы: ${refList.join("; ")}.`);
  if (chars.length > 4) {
    p.push(
      `Персонажи без референс-листа (${chars.slice(4).map((c) => j.characters[c].name).join(", ")}) ` +
      "рисуются по их текстовому описанию ниже.",
    );
  }
  if (chars.length) {
    p.push(
      "Нарисуй " + (chars.length > 1 ? "этих же персонажей" : "этого же персонажа") +
      " с точно теми же лицами, причёсками и одеждой, что на референсах." +
      (chars.length > 1 ? " Это разные люди, их нельзя делать похожими друг на друга." : ""),
    );
    const names = chars.map((c) => j.characters[c].name).join(", ");
    p.push(
      `В кадре ровно ${chars.length} ${chars.length === 1 ? "человек" : "человека(человек)"}: ${names}, ` +
      "и комната пуста, кроме них. Каждый референс-лист показывает ОДНОГО и того же " +
      "персонажа в нескольких позах — это справочник внешности, в кадре этот персонаж " +
      "появляется ровно один раз. Одежда каждого — строго по его описанию.",
    );
    for (const c of chars) p.push(j.characters[c].passport + ".");
  } else {
    p.push(
      "Кадр предметный, без людей: комната и объекты. Если в описании кадра упомянуты " +
      "руки — в кадре видны только кисти рук, входящие из-за края кадра.",
    );
  }
  p.push(sc.img);
  if (k >= 2) p.push(framingHint(k));
  if (anchorType === "shot") {
    p.push(
      "Последнее референсное изображение — ПРЕДЫДУЩИЙ ПЛАН этой же сцены. " +
      "Это тот же момент времени: те же люди того же роста, в той же одежде, " +
      "на тех же местах относительно мебели; та же комната, та же мебель, тот же " +
      "ковёр и свет. Ничего не переставлять и не добавлять. " +
      "ПОРЯДОК ПЕРСОНАЖЕЙ СЛЕВА НАПРАВО — точно такой же, как на предыдущем плане: " +
      "кто был левее, остаётся левее; кадр не отражается зеркально; окна, двери и " +
      "мебель остаются на той же стороне кадра. " +
      "Относительный рост персонажей — строго как на предыдущем плане: никто не " +
      "становится крупнее или мельче остальных, и никто не выдвигается к камере. " +
      "Каждый сидит на том же предмете мебели, что и на предыдущем плане. " +
      "Единственное изменение — ракурс и крупность камеры.",
    );
  } else if (anchorType === "scene") {
    p.push(
      "Последнее референсное изображение — ПРЕДЫДУЩАЯ СЦЕНА в этой же комнате, " +
      "продолжением которой является этот кадр. Комната, мебель, ковёр и свет — " +
      "строго как на нём, ничего не переставлять и не отражать зеркально. " +
      "Общие персонажи — в той же одежде, того же роста и НА ТЕХ ЖЕ МЕСТАХ: " +
      "тот же стул, та же сторона кадра, тот же порядок слева направо, " +
      "если новое описание прямо не требует иного; " +
      "меняются только их позы и действия по описанию. Кадр не отражается зеркально.",
    );
  }
  if (anchorType) {
    p.push(
      "Якорный кадр задаёт ТОЛЬКО мизансцену. Стиль рисунка, детализация и лица " +
      "бери с референсных листов персонажей: лица точно как на листах, без " +
      "упрощения, без карикатурности, в полном качестве акварельной иллюстрации.",
    );
  }
  p.push(FIT_SUFFIX);
  p.push(POSITIVE_RULES);
  p.push(j.style);
  return p.join(" ");
}

// ---------- референсы -------------------------------------------------------
function mime(f) {
  return extname(f).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}
function refFiles(chars) {
  // Основной лист каждого персонажа; кроп лица добавляется, только если
  // персонажей не больше двух (иначе входов слишком много и вес
  // референсов размывается).
  // Документированный предел NB2 — 4 персонажа с консистентностью:
  // листов прикладываем не больше четырёх, остальные персонажи сцены
  // рисуются по паспорту (без листа).
  const files = [];
  for (const c of chars.slice(0, 4)) {
    const list = REFS[c];
    if (!list) throw new Error(`В gemini_refs.json нет персонажа ${c}`);
    files.push(list[0]);
  }
  if (chars.length <= 2) {
    for (const c of chars) if (REFS[c][1]) files.push(REFS[c][1]);
  }
  return files;
}

// ---------- якорь мизансцены ------------------------------------------------
// Якорь берём СЫРОЙ (_gemini_raw): обработанный 1280x720 дал бы «копию копии» —
// деградацию стиля до карикатуры. Замечено на пачке 1.
function anchorPathFor(t, sceneId) {
  const raw = join(cfg.paths.takes, t.id, "_gemini_raw", frameName(sceneId, 1));
  if (existsSync(join(ROOT, raw))) return raw;
  const done = join(cfg.paths.takes, t.id, frameName(sceneId, 1));
  return existsSync(join(ROOT, done)) ? done : null;
}

// ---------- вызов API -------------------------------------------------------
const KEY = process.env.GEMINI_API_KEY;
async function generate(prompt, imageFiles) {
  const parts = [{ text: prompt }];
  for (const f of imageFiles) {
    parts.push({
      inline_data: {
        mime_type: mime(f),
        data: readFileSync(join(ROOT, f)).toString("base64"),
      },
    });
  }
  // thinking_level: high — официально «significantly improving prompt
  // adherence» для сложных промптов (default у NB2 — minimal). Если API
  // отвергнет поле — повторяем без него.
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "16:9" },
      thinkingConfig: { thinkingLevel: "high" },
    },
  };
  let r = await fetch(`${API_BASE}/${args.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  if (r.status === 400) {
    const errText = await r.text();
    if (/thinking/i.test(errText)) {
      delete body.generationConfig.thinkingConfig;
      r = await fetch(`${API_BASE}/${args.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(body),
      });
    } else {
      return { error: `400 ${errText.slice(0, 300)}` };
    }
  }
  if (r.status === 429) return { retryable: true, error: "429 rate limit" };
  if (r.status >= 500) return { retryable: true, error: `${r.status} server` };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `${r.status} ${JSON.stringify(j).slice(0, 300)}` };
  const block = j.promptFeedback?.blockReason;
  if (block) return { blocked: true, error: `blocked: ${block}` };
  const cand = j.candidates?.[0];
  const img = cand?.content?.parts?.find((p) => p.inlineData?.data);
  if (!img) {
    const fr = cand?.finishReason ?? "нет кандидата";
    return { blocked: true, error: `нет изображения в ответе (finishReason: ${fr})` };
  }
  return { data: Buffer.from(img.inlineData.data, "base64") };
}

// ---------- постобработка ---------------------------------------------------
function toFrame(rawFile, dest) {
  // Кадр конвейера — строго 1280x720: кроп по большей стороне.
  const r = spawnSync("ffmpeg", [
    "-y", "-i", rawFile,
    "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
    "-frames:v", "1", dest,
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    console.warn("  ffmpeg не справился, кладу кадр как есть:", (r.stderr ?? "").split("\n").slice(-2).join(" "));
    copyFileSync(rawFile, dest);
  }
}

// ---------- план работ ------------------------------------------------------
const jobs = [];
for (const id of videoList()) {
  const j = loadScenario(cfg, id);
  for (const sc of j.scenes) {
    if (sc.kind === "title" || sc.kind === "memo" || !sc.img) continue;
    const chars = sc.chars ?? [];
    const bg = j.backgrounds?.[sc.bg];
    if (!bg) { console.warn(`⚠ ${id}/${sc.id}: нет фона «${sc.bg}» в компиляте — пропуск`); continue; }
    if (!existsSync(join(ROOT, bg.file))) { console.warn(`⚠ ${id}/${sc.id}: нет файла фона ${bg.file} — пропуск`); continue; }
    for (const shot of shotPlan(sc)) {
      // --only принимает и сцену (s2b — оба плана), и конкретный кадр (s2b_sh2)
      if (args.only && !args.only.includes(sc.id) && !args.only.includes(`${sc.id}_sh${shot.k}`)) continue;
      const dest = join(TAKES, id, frameName(sc.id, shot.k));
      const done = existsSync(dest) && !args.redo;
      jobs.push({ id, sc, k: shot.k, j, bg, dest, done });
    }
  }
}

const todo = jobs.filter((x) => !x.done);
const estUsd = todo.length * PRICE_PER_IMAGE;
console.log(`Кадров всего: ${jobs.length}, готово: ${jobs.length - todo.length}, к генерации: ${todo.length}`);
console.log(`Оценка: $${estUsd.toFixed(2)} (${args.model}, 1K, синхронно). Потрачено ранее: $${state.spentUsd.toFixed(2)}. Потолок прогона: $${args.maxUsd}`);
if (args.dryRun) {
  const perVideo = {};
  for (const t of todo) perVideo[t.id] = (perVideo[t.id] ?? 0) + 1;
  for (const [id, cnt] of Object.entries(perVideo)) {
    console.log(`  ${id}: ${cnt} кадров, $${(cnt * PRICE_PER_IMAGE).toFixed(2)}`);
  }
  // --show-prompt: показать ровно тот текст и тот список референсов, которые
  // уйдут в API. Ничего не вызывается и ничего не стоит — приёмка промпта
  // до траты денег.
  if (args.showPrompt) {
    for (const t of todo) {
      const chars = t.sc.chars ?? [];
      const refs = [...refFiles(chars), t.bg.file];
      let anchorType = null, anchor = null;
      if (t.k >= 2) { anchor = anchorPathFor(t, t.sc.id); if (anchor) anchorType = "shot"; }
      else if (t.sc.anchor) { anchor = anchorPathFor(t, t.sc.anchor); if (anchor) anchorType = "scene"; }
      if (anchor) {
        const bgIdx = refs.indexOf(t.bg.file);
        if (bgIdx >= 0) refs.splice(bgIdx, 1);
        refs.push(anchor);
      }
      while (refs.length > 6) refs.splice(anchor ? refs.length - 2 : refs.length - 1, 1);
      console.log("\n" + "=".repeat(70));
      console.log(`${t.id} / ${t.sc.id}_sh${t.k}   якорь: ${anchorType ?? "нет"}`);
      console.log("РЕФЕРЕНСЫ (по порядку):");
      refs.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      console.log("ПРОМПТ:");
      console.log(buildPrompt(t.j, t.sc, t.k, chars, t.bg.name, anchorType, refs.includes(t.bg.file)));
    }
  }
  process.exit(0);
}
if (!KEY) { console.error("Нет GEMINI_API_KEY в окружении"); process.exit(2); }

// ---------- прогон ----------------------------------------------------------
let made = 0, spent = 0, blocked = [];
outer:
for (const t of todo) {
  if (args.limit && made >= args.limit) break;
  if (spent + PRICE_PER_IMAGE > args.maxUsd) {
    console.log(`Потолок $${args.maxUsd} достигнут — стоп. Продолжить: тот же запуск, готовое пропустится.`);
    break;
  }
  const chars = t.sc.chars ?? [];
  const refs = [...refFiles(chars), t.bg.file];
  // Якоря мизансцены (замерено пилотом К4):
  //  - план k>=2 продолжает первый план своей сцены (рост, одежда, стороны стола);
  //  - сцена с полем anchor: <id> продолжает мизансцену той сцены (рассадка,
  //    мебель) — для непрерывных эпизодов вроде круга в «Ежедневниках».
  // Якорь берём СЫРОЙ (_gemini_raw): обработанный 1280x720 дал бы «копию
  // копии» — деградацию стиля до карикатуры. Замечено на пачке 1.
  let anchorType = null, anchor = null;
  if (t.k >= 2) {
    anchor = anchorPathFor(t, t.sc.id);
    if (anchor) anchorType = "shot";
    else console.warn(`  ⚠ нет якоря sh1 для ${t.sc.id}_sh${t.k} — план пойдёт без привязки`);
  } else if (t.sc.anchor) {
    anchor = anchorPathFor(t, t.sc.anchor);
    if (anchor) anchorType = "scene";
    else console.warn(`  ⚠ нет якорной сцены ${t.sc.anchor} для ${t.sc.id} — кадр пойдёт без привязки`);
  }
  if (anchor) {
    // Комната уже на якоре — файл фона не прикладываем, чтобы не раздувать
    // вход: при 6+ картинках вес референсов падает и модель сочиняет.
    const bgIdx = refs.indexOf(t.bg.file);
    if (bgIdx >= 0) refs.splice(bgIdx, 1);
    refs.push(anchor);
  }
  // Жёсткий потолок входов: 6 изображений. Лишнее режем с конца списка
  // персонажных рефов (кропы лиц уходят первыми — refFiles кладёт их в хвост).
  while (refs.length > 6) {
    const cut = anchor ? refs.length - 2 : refs.length - 1; // якорь не трогаем
    refs.splice(cut, 1);
  }
  const prompt = buildPrompt(t.j, t.sc, t.k, chars, t.bg.name, anchorType, refs.includes(t.bg.file));
  const tag = `${t.id}/${t.sc.id}_sh${t.k}`;
  process.stdout.write(`→ ${tag} (${chars.join("+") || "без людей"}, ${refs.length} реф.) ... `);

  let res, attempt = 0;
  for (;;) {
    res = await generate(prompt, refs);
    if (res.retryable && attempt < 3) {
      attempt++;
      const wait = attempt * 30000;
      console.log(`${res.error}, жду ${wait / 1000} с (попытка ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }

  if (res.data) {
    mkdirSync(join(TAKES, t.id, "_gemini_raw"), { recursive: true });
    const raw = join(TAKES, t.id, "_gemini_raw", frameName(t.sc.id, t.k));
    writeFileSync(raw, res.data);
    mkdirSync(join(TAKES, t.id), { recursive: true });
    toFrame(raw, t.dest);
    made++; spent += PRICE_PER_IMAGE; state.spentUsd += PRICE_PER_IMAGE;
    state.frames[tag] = { status: "ok", ts: new Date().toISOString() };
    console.log(`ok (${made}/${todo.length}, $${(state.spentUsd).toFixed(2)})`);
  } else {
    state.frames[tag] = { status: res.blocked ? "blocked" : "error", error: res.error, ts: new Date().toISOString() };
    if (res.blocked) blocked.push(tag);
    console.log(`✗ ${res.error}`);
    if (!res.blocked && !res.retryable) {
      // Систематическая ошибка (ключ, биллинг, модель) — нет смысла жечь очередь.
      if (/API_KEY|PERMISSION|billing|quota exceeded for metric/i.test(res.error)) {
        console.error("Похоже на проблему ключа/биллинга — останавливаюсь.");
        break outer;
      }
    }
  }
  saveState();
  await new Promise((r) => setTimeout(r, args.sleep));
}

saveState();
console.log(`\nГотово: ${made} кадров, потрачено за прогон ~$${spent.toFixed(2)}, всего ~$${state.spentUsd.toFixed(2)}.`);
if (blocked.length) {
  console.log(`Заблокировано фильтром (${blocked.length}): ${blocked.join(", ")}`);
  console.log("Эти кадры — в ручную очередь: переформулировать сцену или сгенерировать в приложении.");
}
