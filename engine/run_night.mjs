#!/usr/bin/env node
// Ночной поток серии — один процесс на всю ночь.
//
//   node engine/run_night.mjs --host https://<pod>-8188.proxy.runpod.net
//
// Опции:
//   --host <url>      адрес ComfyUI
//   --queue <file>    очередь роликов (по умолчанию reports/night/queue.json)
//   --phase <фаза>    начать с указанной фазы: frames | clips | assemble
//   --budget <часы>   остановиться, когда израсходовано столько часов GPU
//   --batch <n>       роликов в пачке (по умолчанию из очереди, 4)
//   --resume          продолжить прерванный прогон по state.json
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
//
// Агент останавливается между шагами не по злому умыслу, а потому что
// между шагами есть место остановиться. Здесь его нет: цикл живёт
// внутри одного процесса. Агент не выполняет шаги — он запускает этот
// файл и следит, чтобы тот жил. Решений внутри цикла не принимается
// ни одного: всё, что не получилось, пишется в отчёт, и цикл идёт
// дальше.
//
// ПОЧЕМУ ПАЧКАМИ, А НЕ ПОДРЯД И НЕ ЦЕЛИКОМ ПО ФАЗАМ
//
// Замерено 22.08: лимит памяти контейнера 62 ГБ. Qwen (кадры) и Wan
// (клипы) в одном процессе ComfyUI этот лимит пробивают, и cgroup
// убивает процесс. Значит чередовать модель на каждом ролике нельзя —
// нужен рестарт, а рестарт стоит минуту.
//
// Но и загнать сначала ВСЕ кадры всех тридцати двух роликов, а потом
// все клипы — ошибка ровно того же сорта: если ночь не дотянет до
// конца, к утру на диске будет 375 опорных кадров и ни одного
// готового ролика. Показывать заказчику нечего.
//
// Поэтому середина: пачка роликов проходит кадры → клипы → сборку
// целиком, и только потом начинается следующая.
//
// Размер пачки — компромисс, и цена ошибки в нём мала. Рестарт
// ComfyUI стоит около 75 секунд: это старт процесса плюс однократная
// загрузка весов. НЕ надбавка к каждому клипу — после первого клипа
// веса в страничном кэше, и все следующие идут с одинаковой скоростью.
// Отсюда арифметика за всю ночь:
//
//   пачки по 4   — 16 рестартов, 20 мин, $0.25
//   пачки по 8   —  8 рестартов, 10 мин, $0.12
//   всё одной    —  2 рестарта,   2 мин, $0.03
//
// Разница между крайностями — двадцать центов. Поэтому размер пачки
// выбирается не по экономии, а по тому, когда мы узнаём о поломке:
// первая пачка маленькая (контрольная точка через час), дальше
// крупные. Пачки задаются явно в queue.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";

const cfg = loadConfig();
const NIGHT = join(ROOT, "reports", "night");
mkdirSync(NIGHT, { recursive: true });

const STATE = join(NIGHT, "state.json");
const LOG = join(NIGHT, "night.log");
const INBOX = join(NIGHT, "INBOX.md");

function parseArgs(argv) {
  const a = { host: "http://127.0.0.1:8188", budget: 20 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--host") a.host = argv[++i].replace(/\/$/, "");
    else if (v === "--queue") a.queue = argv[++i];
    else if (v === "--phase") a.phase = argv[++i];
    else if (v === "--budget") a.budget = Number(argv[++i]);
    else if (v === "--batch") a.batch = Number(argv[++i]);
    else if (v === "--resume") a.resume = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  return a;
}
const args = parseArgs(process.argv);

// ---------- журнал -----------------------------------------------------
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

// ---------- состояние --------------------------------------------------
// Всё, что нужно для продолжения после падения, лежит здесь. Никакого
// состояния в голове агента и никакого в переписке.
function loadState() {
  if (args.resume && existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  const queueFile = args.queue ?? join(NIGHT, "queue.json");
  if (!existsSync(queueFile)) {
    throw new Error(`Нет очереди ${queueFile}. Создай её: {"videos": ["uborka", ...]}`);
  }
  const q = JSON.parse(readFileSync(queueFile, "utf8"));
  // Пачки могут быть заданы явно и разного размера. Первая маленькая —
  // это контрольная точка: если LoRA не та или персонажи не те, это
  // видно через час и два доллара, а не через шесть часов и пять.
  // Дальше пачки крупные: рестарт стоит ~75 с, и чем их меньше,
  // тем меньше холостого хода.
  let batches;
  if (Array.isArray(q.batches) && !args.batch) {
    batches = q.batches;
  } else {
    const size = args.batch ?? q.batchSize ?? 8;
    batches = [];
    for (let i = 0; i < q.videos.length; i += size) batches.push(q.videos.slice(i, i + size));
  }
  return {
    started: new Date().toISOString(),
    videos: q.videos,
    batches,
    batchIndex: 0,
    phase: args.phase ?? "frames",
    done: { frames: [], clips: [], assemble: [], verify: [] },
    ready: [],
    failed: [],
    gpuSeconds: 0,
  };
}
function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8");
}

// ---------- запуск звена ------------------------------------------------
// Каждое звено — отдельный процесс. Если оно упало, это не повод
// останавливать ночь: пишем в failed и идём дальше.
function step(name, cmd, cmdArgs) {
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const sec = (Date.now() - t0) / 1000;
  const ok = r.status === 0;
  const tail = ((r.stdout ?? "") + (r.stderr ?? "")).trim().split("\n").slice(-4).join(" | ");
  log(`${ok ? "✓" : "✗"} ${name}  ${sec.toFixed(0)} с  ${ok ? "" : tail.slice(0, 300)}`);
  return { ok, sec, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ---------- выгрузка моделей ComfyUI ------------------------------------
// Между фазами обязательна: иначе Qwen и Wan встречаются в одной памяти
// (лимит контейнера 62 ГБ, cgroup убивает процесс).
//
// Замерено 22.08: POST /free выгружает модели за ~5 с (28 ГБ → 428 МБ),
// сам процесс ComfyUI при этом жив. Раньше здесь был pkill + рестарт —
// он требовал bash на поде и привязывал цикл к месту запуска. Теперь
// весь цикл управляется по HTTP и может крутиться с машины Антона.
async function restartComfy() {
  log("выгрузка моделей: POST /free (замер 22.08 — 28 ГБ → 428 МБ за 5 с)");
  try {
    const res = await fetch(args.host + "/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!res.ok) log(`/free ответил ${res.status} — продолжаю, но память не гарантирована`);
  } catch (e) {
    log(`/free недоступен: ${e.message}`);
  }
  // /free синхронный, но даём карте секунду выдохнуть и проверяем живость.
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(args.host + "/system_stats");
      if (res.ok) { log("ComfyUI жив, память свободна"); return true; }
    } catch { /* ещё не ответил */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log("ComfyUI не отвечает после /free — фаза пропущена");
  return false;
}

// ---------- фазы --------------------------------------------------------
const PHASES = ["frames", "clips", "assemble", "verify"];

async function runPhase(state, phase, videos) {
  log(`=== фаза ${phase}: ${videos.join(", ")} ===`);

  // Выгрузка моделей нужна только перед клипами (Wan на поде). Кадры
  // с 23.08 генерирует Gemini API с этой машины — карта не участвует.
  if (phase === "clips") {
    const up = await restartComfy();
    if (!up) return;
  }

  for (const id of videos) {
    if (state.done[phase]?.includes(id)) continue;
    if (state.gpuSeconds / 3600 > args.budget) {
      log(`бюджет ${args.budget} ч исчерпан, останавливаюсь`);
      writeFileSync(INBOX, inbox(state, "бюджет исчерпан"), "utf8");
      return "budget";
    }

    let r;
    if (phase === "frames") {
      // Кадры — Gemini API (23.08, после пилота). Ключ — в GEMINI_API_KEY.
      // Расходы считает сам скрипт (reports/night/gemini-frames-state.json),
      // GPU-бюджет ночи кадры больше не тратят.
      r = step(`кадры ${id}`, "node",
        ["engine/gemini_frames.mjs", "--id", id]);
    } else if (phase === "clips") {
      r = step(`клипы ${id}`, "node",
        ["engine/comfy_batch.mjs", "--id", id, "--host", args.host]);
      state.gpuSeconds += r.sec;
    } else if (phase === "assemble") {
      r = step(`сборка ${id}`, "node",
        ["engine/assemble_video.mjs", "--id", id]);
    } else if (phase === "verify") {
      r = step(`приёмка ${id}`, "node",
        ["engine/verify_clips.mjs", "--id", id]);
    }

    if (r.ok) state.done[phase].push(id);
    else state.failed.push({ phase, id, when: new Date().toISOString() });
    saveState(state);
  }
  log(`=== фаза ${phase} закрыта ===`);
}

// ---------- письмо Клавдии ----------------------------------------------
// Пишется в конце и при каждой остановке. Клавдию будит расписание,
// она читает этот файл и контактные листы, и пишет вердикт рядом.
function inbox(state, why) {
  const h = (state.gpuSeconds / 3600).toFixed(1);
  const lines = [
    "# Ночной прогон — состояние", "",
    `Причина письма: **${why}**`, "",
    `Начат: ${state.started}`,
    `Машинного времени потрачено: **${h} ч** (~$${(h * 0.74).toFixed(2)})`, "",
    `Пачка: **${state.batchIndex + 1} из ${state.batches.length}**`, "",
    "## Готовые ролики", "",
    state.ready.length
      ? state.ready.map((v) => `- \`${v}\` → out/${v}.mp4`).join("\n")
      : "_пока ни одного_",
    "",
    "## Сделано", "",
    ...PHASES.map((p) => `- ${p}: ${state.done[p]?.length ?? 0} из ${state.videos.length}`),
    "",
  ];
  if (state.failed.length) {
    lines.push("## Не получилось", "", "| Фаза | Ролик | Когда |", "|---|---|---|");
    for (const f of state.failed) lines.push(`| ${f.phase} | ${f.id} | ${f.when.slice(11, 19)} |`);
    lines.push("");
  }
  lines.push(
    "## Что посмотреть", "",
    "- контактные листы: `workspace/out/_kontakt/*.jpg`",
    "- нарезка подозрительного: `out/_podozritelnye.mp4`",
    "- отчёт приёмки: `reports/night/priyomka.md`",
    "- журнал: `reports/night/night.log`", "",
    "## Что ответить", "",
    "Положить вердикт в `reports/night/VERDICT.md`. Если нужно",
    "переделать — перечислить ролики и сцены там же, агент подберёт.",
  );
  return lines.join("\n");
}

// ---------- ход ---------------------------------------------------------
const state = loadState();
saveState(state);
log(`ночь начата: ${state.videos.length} роликов, бюджет ${args.budget} ч`);

// При --resume продолжаем ровно с той фазы, на которой упали; все
// следующие пачки начинаются с кадров.
let resumePhase = PHASES.indexOf(state.phase ?? "frames");
if (resumePhase < 0) resumePhase = 0;

for (let b = state.batchIndex; b < state.batches.length; b++) {
  const videos = state.batches[b];
  state.batchIndex = b;
  saveState(state);
  log(`########## пачка ${b + 1} из ${state.batches.length}: ${videos.join(", ")} ##########`);

  const from = resumePhase;
  resumePhase = 0;
  for (const phase of PHASES.slice(from)) {
    state.phase = phase;
    saveState(state);
    const stop = await runPhase(state, phase, videos);
    if (stop === "budget") {
      writeFileSync(INBOX, inbox(state, "бюджет исчерпан"), "utf8");
      process.exit(0);
    }
  }
  // Пачка закрыта — значит на диске появились готовые ролики.
  // Пишем Клавдии сразу, не дожидаясь утра: она разберёт их, пока
  // карта считает следующую пачку.
  const fresh = videos.filter((v) => state.done.assemble.includes(v));
  state.ready.push(...fresh);
  saveState(state);
  writeFileSync(INBOX, inbox(state, `пачка ${b + 1} закрыта: ${fresh.join(", ") || "пусто"}`), "utf8");
  log(`########## пачка ${b + 1} закрыта, готовых роликов всего: ${state.ready.length} ##########`);
}

writeFileSync(INBOX, inbox(state, "ночь закончена"), "utf8");
log(`готово. потрачено ${(state.gpuSeconds / 3600).toFixed(1)} ч, ` +
  `готовых роликов ${state.ready.length}`);
