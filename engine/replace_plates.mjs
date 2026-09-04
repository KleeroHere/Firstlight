#!/usr/bin/env node
// Замена заставки и финальной карточки в уже собранных роликах серии
// серии на фирменные плашки владельца из production/Op&End.
//
//   node engine/replace_plates.mjs            # все, у кого есть плашки
//   node engine/replace_plates.mjs --id uborka
//   node engine/replace_plates.mjs --dry
//
// Почему не пересборка целиком: таймлайн ролика задан сценарием (sc.t), а
// войсовер кладётся по этим таймкодам. Менять длительность заставки — значит
// переписывать тайминги всех сцен и пересобирать всё заново. Внутренности при
// этом могли бы измениться, а просили поменять только начало и конец.
//
// Поэтому работаем хирургически: пересобираем ТОЛЬКО два сегмента в build/<id>
// с той же длительностью, что были, склеиваем прежним concat.txt без
// перекодирования и подкладываем звук из старого файла копией. Внутренние
// сегменты и звук остаются бит-в-бит теми же, хронометраж не меняется.
//
// Подгонка по монтажу:
//   заставка  — плашка 7.87 с длиннее слота (6.2-7.6 с), лишний статичный
//               хвост режется; надпись проявляется в первую секунду, теряется
//               только время стояния;
//   финал     — плашка 8.17 с короче слота (12.7-18.6 с), последний кадр
//               держится стоп-кадром до конца, пока диктор читает итог.
// Белые вспышки 0.15 с на стыках — как в остальной серии.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, loadConfig, ffprobeJson } from "./lib.mjs";

const cfg = loadConfig();
const { width: W, height: H, fps: FPS } = cfg;
const FADE = cfg.transitionSec;
const plateDir = join(ROOT, "workspace", "op-end");
const buildRoot = join(ROOT, cfg.paths.build);
const outRoot = join(ROOT, cfg.paths.out);
const backupRoot = join(outRoot, "_backup-plates");

// The designer names plate files by the roll's human title, the pipeline by
// its id. The compiled scenario carries both, so the mapping is read from it
// rather than kept as a table here.
const PLATES = Object.fromEntries(
  readdirSync(join(ROOT, cfg.paths.compiled))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const sc = JSON.parse(readFileSync(join(ROOT, cfg.paths.compiled, f), "utf8"));
      return [sc.id, sc.title];
    }),
);

const args = { ids: [] };
for (let i = 2; i < process.argv.length; i++) {
  const v = process.argv[i];
  if (v === "--id") args.ids.push(process.argv[++i]);
  else if (v === "--dry") args.dry = true;
  else throw new Error(`Неизвестный аргумент: ${v}`);
}
const ids = args.ids.length ? args.ids : Object.keys(PLATES);

function ff(list) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...list],
    { stdio: ["ignore", "inherit", "inherit"] });
}

function dur(file) {
  return Number(ffprobeJson(file).format.duration);
}

// Плашка владельца в 1280x720 без звука. Приводим к 1920x1080/30fps,
// подгоняем длительность под слот и ставим белые вспышки на стыках.
function renderPlate(plate, slot, outFile) {
  const pd = dur(plate);
  const pad = slot > pd ? `tpad=stop_mode=clone:stop_duration=${(slot - pd + 0.3).toFixed(3)},` : "";
  const filter = `[0:v]fps=${FPS},scale=${W}:${H}:flags=lanczos,setsar=1,${pad}` +
    `trim=duration=${slot.toFixed(3)},setpts=PTS-STARTPTS,` +
    `fade=t=in:st=0:d=${FADE}:color=white,` +
    `fade=t=out:st=${(slot - FADE).toFixed(3)}:d=${FADE}:color=white[v]`;
  ff(["-i", plate, "-filter_complex", filter, "-map", "[v]",
    "-t", slot.toFixed(3), "-r", String(FPS), ...cfg.encode.videoArgs, "-an", outFile]);
}

// Файл владельца может называться «... Старт» или «... старт» — ищем без
// учёта регистра, чтобы не спотыкаться на одной заглавной букве.
function findPlate(human, kind) {
  const want = `${human} ${kind}`.toLowerCase();
  const hit = readdirSync(plateDir).find((f) => f.toLowerCase() === `${want}.mp4`);
  return hit ? join(plateDir, hit) : null;
}

const report = [];
for (const id of ids) {
  const human = PLATES[id];
  if (!human) throw new Error(`${id}: нет плашек в списке`);
  const buildDir = join(buildRoot, id);
  const logFile = join(buildDir, "build-log.json");
  if (!existsSync(logFile)) throw new Error(`${id}: нет ${logFile} — ролик не собран`);
  const log = JSON.parse(readFileSync(logFile, "utf8"));
  const start = findPlate(human, "старт");
  const end = findPlate(human, "конец");
  if (!start || !end) throw new Error(`${id}: не найдена плашка «${human} старт/конец»`);

  const titleScene = log.scenes.find((s) => s.kind === "title");
  const memoScene = log.scenes.find((s) => s.kind === "memo");
  const segTitle = join(buildDir, `seg_${titleScene.id}.mp4`);
  const segMemo = join(buildDir, `seg_${memoScene.id}.mp4`);
  const oldOut = log.output;
  for (const f of [segTitle, segMemo, oldOut, join(buildDir, "concat.txt")]) {
    if (!existsSync(f)) throw new Error(`${id}: нет ${f}`);
  }
  // Длительности берём с диска, а не из сценария: слот сегмента — это ровно
  // то, что уже склеено, и хронометраж ролика от подмены не поедет.
  const slotTitle = dur(segTitle);
  const slotMemo = dur(segMemo);
  const totalBefore = dur(oldOut);
  console.log(`\n${id}: заставка ${slotTitle.toFixed(2)} с (плашка ${dur(start).toFixed(2)}), ` +
    `финал ${slotMemo.toFixed(2)} с (плашка ${dur(end).toFixed(2)}), ролик ${totalBefore.toFixed(2)} с`);
  if (args.dry) continue;

  // Старое кладём в резерв: если плашка не сядет, откат — копированием назад.
  mkdirSync(backupRoot, { recursive: true });
  const keep = join(buildDir, "_plates-before");
  mkdirSync(keep, { recursive: true });
  for (const f of [segTitle, segMemo]) {
    const b = join(keep, f.split(/[\\/]/).pop());
    if (!existsSync(b)) copyFileSync(f, b);
  }
  const outBackup = join(backupRoot, oldOut.split(/[\\/]/).pop());
  if (!existsSync(outBackup)) copyFileSync(oldOut, outBackup);

  renderPlate(start, slotTitle, segTitle);
  renderPlate(end, slotMemo, segMemo);

  // Склейка прежним списком: внутренние сегменты копируются как есть.
  const concatFile = join(buildDir, "concat.txt");
  const videoFile = join(buildDir, "video.mp4");
  const tmpVideo = join(tmpdir(), `plates_${id}_video.mp4`);
  ff(["-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", tmpVideo]);
  rmSync(videoFile, { force: true });
  renameSync(tmpVideo, videoFile);

  // Звук — копией из прежнего файла: войсовер и нормализация громкости
  // остаются ровно теми же, ни одного пересчёта.
  const tmpOut = join(tmpdir(), `plates_${id}_out.mp4`);
  ff(["-i", videoFile, "-i", outBackup, "-map", "0:v:0", "-map", "1:a:0",
    "-c", "copy", "-movflags", "+faststart", tmpOut]);
  const totalAfter = dur(tmpOut);
  const drift = Math.abs(totalAfter - totalBefore);
  if (drift > 0.15) {
    rmSync(tmpOut, { force: true });
    throw new Error(`${id}: хронометраж поехал на ${drift.toFixed(2)} с ` +
      `(${totalBefore.toFixed(2)} → ${totalAfter.toFixed(2)}) — файл не заменён`);
  }
  rmSync(oldOut, { force: true });
  renameSync(tmpOut, oldOut);
  const streams = ffprobeJson(oldOut).streams.map((s) => s.codec_type).sort().join("+");
  console.log(`  готово: ${totalAfter.toFixed(2)} с, потоки ${streams}, расхождение ${drift.toFixed(3)} с`);
  report.push({ id, title: log.title, seconds: Number(totalAfter.toFixed(2)), drift: Number(drift.toFixed(3)) });
}

if (!args.dry) {
  console.log(`\nЗаменены плашки в ${report.length} роликах. ` +
    `Прежние файлы — ${backupRoot}`);
}
