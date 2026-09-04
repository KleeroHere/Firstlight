#!/usr/bin/env node
// Приёмка клипов: восемь метрик, контактный лист, нарезка подозрительного.
//
//   node engine/verify_clips.mjs --id uborka
//   node engine/verify_clips.mjs --all --reel
//
// Опции:
//   --id <id> | --all       что проверять
//   --reel                  собрать out/_podozritelnye.mp4
//   --calibrate             не браковать, только посчитать и записать
//                           разброс — режим набора эталонов
//
// Пороги живут в reports/night/thresholds.json. Пока файла нет, скрипт
// РАБОТАЕТ В РЕЖИМЕ КАЛИБРОВКИ: считает, сортирует, но не бракует.
// Это сознательно: автобрак на выдуманных порогах выкинет хорошее
// и сожжёт деньги на перегенерацию.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { ROOT, loadConfig, run, runMerged } from "./lib.mjs";

const cfg = loadConfig();
const TAKES = join(ROOT, cfg.paths.takes);
const OUT = join(ROOT, cfg.paths.out);
const NIGHT = join(ROOT, "reports", "night");
const KONTAKT = join(OUT, "_kontakt");
const TH = join(NIGHT, "thresholds.json");
mkdirSync(KONTAKT, { recursive: true });
mkdirSync(NIGHT, { recursive: true });

function parseArgs(argv) {
  const a = { ids: [] };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.ids.push(argv[++i]);
    else if (v === "--all") a.all = true;
    else if (v === "--reel") a.reel = true;
    else if (v === "--calibrate") a.calibrate = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  return a;
}
const args = parseArgs(process.argv);
const thresholds = existsSync(TH) ? JSON.parse(readFileSync(TH, "utf8")) : null;
const calibrating = args.calibrate || !thresholds;

// ---------- метрики -----------------------------------------------------
// Считаем по кадрам, уменьшенным до 256 px. Без видеокарты, копейки
// по времени. ffmpeg отдаёт сырые кадры в stdout, читаем их построчно.
function frames(file, size = 128) {
  const out = run("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `scale=${size}:-1,format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const probe = JSON.parse(run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", file,
  ]));
  const w = size;
  const h = Math.round(size * probe.streams[0].height / probe.streams[0].width);
  const per = w * h;
  const n = Math.floor(out.length / per);
  const fs = [];
  for (let i = 0; i < n; i++) fs.push(out.subarray(i * per, (i + 1) * per));
  return { fs, w, h };
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function variance(a) { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return s / a.length; }

// Грубый SSIM по глобальной статистике — нам нужен не точный индекс,
// а провал в момент, где персонаж поплыл.
function ssimRough(a, b) {
  const ma = mean(a), mb = mean(b);
  let va = 0, vb = 0, cov = 0;
  for (let i = 0; i < a.length; i++) {
    va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb);
  }
  va /= a.length; vb /= a.length; cov /= a.length;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
}

function measure(clipFile, startFrame) {
  const { fs } = frames(clipFile);
  if (fs.length < 4) return { error: "меньше четырёх кадров" };

  // 1. первый кадр клипа против исходного кадра сцены
  let firstMatch = null;
  if (startFrame && existsSync(startFrame)) {
    const png = frames(startFrame).fs[0];
    if (png) firstMatch = ssimRough(fs[0], png);
  }

  // 2-3. движение и провалы стабильности
  const diffs = [], ssims = [], brights = [];
  for (let i = 1; i < fs.length; i++) {
    diffs.push(meanAbsDiff(fs[i - 1], fs[i]));
    ssims.push(ssimRough(fs[i - 1], fs[i]));
  }
  for (const f of fs) brights.push(mean(f));

  return {
    frames: fs.length,
    firstMatch,                              // близко к 1 — стартовали с нашего кадра
    motion: mean(diffs),                     // около 0 — замёрз; очень высоко — хаос
    minSsim: Math.min(...ssims),             // провал = момент, где поплыло
    flicker: Math.sqrt(variance(brights)),   // разброс яркости
    drift: Math.abs(brights[0] - brights[brights.length - 1]),
  };
}

// ---------- контактный лист --------------------------------------------
function contactSheet(id, rows) {
  const tiles = [];
  for (const r of rows) {
    if (!existsSync(r.file)) continue;
    const t = join(KONTAKT, `_t_${id}_${r.scene}.png`);
    runMerged("ffmpeg", ["-y", "-v", "error", "-i", r.file,
      "-vf", "select='eq(n\\,0)+eq(n\\,40)+eq(n\\,80)',tile=3x1,scale=1200:-1",
      "-frames:v", "1", t]);
    if (existsSync(t)) tiles.push(t);
  }
  if (!tiles.length) return null;
  const dest = join(KONTAKT, `${id}.jpg`);
  const inputs = tiles.flatMap((t) => ["-i", t]);
  const filter = tiles.map((_, i) => `[${i}:v]`).join("") +
    `vstack=inputs=${tiles.length}`;
  runMerged("ffmpeg", ["-y", "-v", "error", ...inputs,
    "-filter_complex", filter, "-q:v", "3", dest]);
  return existsSync(dest) ? dest : null;
}

// ---------- ход ---------------------------------------------------------
const ids = args.all
  ? readdirSync(join(ROOT, cfg.paths.compiled)).filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  : args.ids;

const all = [];
for (const id of ids) {
  const dir = join(TAKES, id);
  if (!existsSync(dir)) continue;
  // Меряем ЗВЕНЬЯ, а не собранную сцену. В собранной сцене есть
  // монтажные склейки между планами, и любая метрика по минимуму
  // честно назовёт склейку разрывом. Звено — чистые 5,06 с без
  // склеек, и если что-то поплыло, сразу видно какое именно звено
  // перегенерировать.
  const chainDir = join(dir, "_chain");
  const rows = [];
  if (existsSync(chainDir)) {
    for (const c of readdirSync(chainDir).filter((f) => /_sh\d+_c\d+\.mp4$/i.test(f))) {
      const m2 = c.match(/^(.+)_sh(\d+)_c(\d+)\.mp4$/i);
      const scene = m2[1], sh = Number(m2[2]), ci = Number(m2[3]);
      const file = join(chainDir, c);
      // Первое звено плана стартует с нарисованного кадра, следующие —
      // с последнего кадра предыдущего звена. Сверяем с тем, с чего
      // звено на самом деле стартовало.
      const src = ci === 1
        ? join(dir, `${scene}_sh${sh}_frame.png`)
        : join(chainDir, `${scene}_sh${sh}_c${ci - 1}_last.png`);
      const m = measure(file, existsSync(src) ? src : null);
      rows.push({ id, scene: `${scene}/п${sh}з${ci}`, file, ...m });
    }
  }
  if (!rows.length) {
    for (const c of readdirSync(dir).filter((f) => /_take\d+\.mp4$/i.test(f))) {
      const scene = c.replace(/_take\d+\.mp4$/i, "");
      const file = join(dir, c);
      const m = measure(file, join(dir, `${scene}_sh1_frame.png`));
      rows.push({ id, scene, file, ...m });
    }
  }
  const sheet = contactSheet(id, rows);
  all.push(...rows);
  console.log(`${id}: звеньев ${rows.length}${sheet ? `, лист ${basename(sheet)}` : ""}`);
}

// балл подозрительности: чем выше, тем раньше смотреть
for (const r of all) {
  let score = 0;
  if (r.firstMatch !== null && r.firstMatch !== undefined) score += (1 - r.firstMatch) * 3;
  if (r.motion !== undefined) score += r.motion < 0.6 ? 2 : 0;
  if (r.minSsim !== undefined) score += (1 - r.minSsim) * 2;
  if (r.flicker !== undefined) score += r.flicker / 10;
  r.score = Number(score.toFixed(3));
}
all.sort((a, b) => b.score - a.score);

const md = [
  "# Приёмка клипов", "",
  calibrating
    ? "**Режим калибровки.** Порогов нет, поэтому ничего не бракуется —" +
      " только считается и сортируется. Пороги ставятся после того," +
      " как архитектор примет первые ролики руками."
    : "Пороги взяты из `thresholds.json`.",
  "",
  "Сверху — самое подозрительное.", "",
  "| Балл | Ролик | Сцена | 1-й кадр | движение | мин SSIM | мерцание |",
  "|---:|---|---|---:|---:|---:|---:|",
  ...all.map((r) => `| ${r.score} | ${r.id} | ${r.scene} | ` +
    `${r.firstMatch?.toFixed(3) ?? "—"} | ${r.motion?.toFixed(2) ?? "—"} | ` +
    `${r.minSsim?.toFixed(3) ?? "—"} | ${r.flicker?.toFixed(1) ?? "—"} |`),
  "", "## Как читать", "",
  "- **1-й кадр** — близко к 1 значит клип стартовал с нашего кадра.",
  "  Просело — модель проигнорировала вход, на стыке будет склейка.",
  "- **движение** — около нуля клип замёрз, очень высоко разваливается.",
  "- **мин SSIM** — провал в одном месте при нормальном среднем и есть",
  "  тот кадр, где персонаж перетёк. Среднее это прячет.",
  "- **мерцание** — разброс яркости, на стоп-кадре не виден вообще.",
].join("\n");
writeFileSync(join(NIGHT, "priyomka.md"), md, "utf8");

if (args.reel && all.length) {
  const worst = all.slice(0, 15).filter((r) => existsSync(r.file));
  if (worst.length) {
    const list = join(NIGHT, "_reel.txt");
    writeFileSync(list, worst.map((r) => `file '${r.file.replaceAll("'", "'\\''")}'`).join("\n"));
    runMerged("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", join(OUT, "_podozritelnye.mp4")]);
    console.log(`нарезка подозрительного: ${worst.length} клипов`);
  }
}
console.log(`отчёт: reports/night/priyomka.md, листы: out/_kontakt/`);
