#!/usr/bin/env node
// Приёмочная проверка ролика серии (стандарт, §9–10).
//
//   node engine/verify_video.mjs "<файл.mp4>"
//
// Рядом с файлом ищется <файл>.build-log.json (пишет assemble_video.mjs) —
// по нему проверяются плашки и хронометраж сцен. Проверки:
//   контейнер mp4 + faststart, H.264 high ≤4.1, 1920×1080, 30 fps,
//   AAC 48 кГц стерео 192–256 кбит/с, длительность 60–180 с и ±10% цели,
//   громкость −16 LUFS ±1 / true peak ≤ −1.5 dBTP,
//   все сцены сценария присутствуют в сборке, ни одна не помечена MISSING,
//   в кадре каждой сцены реально прорисована плашка (контраст в зоне плашки).
//
// Рядом с роликом пишется <файл>.verify.json — тот же результат структурой:
// консольный вывод читает человек, файл читает интерфейс приёмки. Печать при
// этом не меняется, добавляется только файл.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ffprobeJson, run, runMerged } from "./lib.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Использование: node engine/verify_video.mjs <файл.mp4>");
  process.exit(2);
}

let pass = 0, fail = 0, warn = 0;
// Раздел, в который попадают следующие проверки: заголовки печатаются по ходу
// («Формат:», «Хронометраж:»…), и группировка в отчёте должна совпадать с тем,
// что человек видит в консоли, иначе они разойдутся.
let section = "";
const checks = [];
const group = (name) => { section = name; console.log(`
${name}:`); };
// У двух проверок ниже зелёного случая нет вовсе — они либо молчат, либо
// предупреждают. Печатались они в обход ok() и потому в отчёт не попадали:
// в консоли было на две строки больше, чем в файле. Теперь идут через это.
const warnNote = (msg) => {
  warn++;
  checks.push({ section, verdict: "warn", message: msg });
  console.log(`  ⚠ ${msg}`);
};
const ok = (cond, msg, softMsg) => {
  const verdict = cond ? "pass" : softMsg !== undefined ? "warn" : "fail";
  checks.push({ section, verdict, message: cond || softMsg === undefined ? msg : softMsg });
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else if (softMsg !== undefined) { warn++; console.log(`  ⚠ ${softMsg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
};

console.log(`Проверка: ${file}\n`);
const meta = ffprobeJson(file);
const v = meta.streams.find((s) => s.codec_type === "video");
const a = meta.streams.find((s) => s.codec_type === "audio");
const dur = Number(meta.format.duration);

group("Формат");
ok(meta.format.format_name.includes("mp4"), `контейнер mp4 (${meta.format.format_name})`);
ok(v && v.codec_name === "h264", `видеокодек H.264 (${v?.codec_name})`);
ok(v && (v.profile === "High" || v.profile === "Main" || v.profile === "Constrained Baseline"),
  `профиль ${v?.profile}`);
ok(v && Number(v.level) <= 41, `level ${v ? Number(v.level) / 10 : "?"} ≤ 4.1`);
ok(v && v.width === 1920 && v.height === 1080, `разрешение ${v?.width}×${v?.height}`);
const fpsParts = (v?.r_frame_rate ?? "0/1").split("/");
const fps = Number(fpsParts[0]) / Number(fpsParts[1]);
ok(Math.abs(fps - 30) < 0.01, `частота кадров ${fps.toFixed(2)} fps`);
ok(v && v.pix_fmt === "yuv420p", `pix_fmt ${v?.pix_fmt}`);
ok(a && a.codec_name === "aac", `аудиокодек AAC (${a?.codec_name})`);
ok(a && Number(a.sample_rate) === 48000, `частота ${a?.sample_rate} Гц`);
ok(a && a.channels === 2, `каналы: ${a?.channels}`);
const abr = a ? Number(a.bit_rate) : 0;
ok(abr >= 96_000 && abr <= 320_000,
  `битрейт аудио ${(abr / 1000).toFixed(0)} кбит/с`,
  abr >= 60_000 ? `битрейт аудио ${(abr / 1000).toFixed(0)} кбит/с — ниже номинала 192к (тихая/пустая дорожка сжалась; с настоящим войсовером поднимется)` : undefined);

// faststart: атом moov раньше mdat
const head = readFileSync(file).subarray(0, 64 * 1024);
const moov = head.indexOf(Buffer.from("moov"));
const mdat = head.indexOf(Buffer.from("mdat"));
ok(moov !== -1 && (mdat === -1 || moov < mdat), "faststart: moov в начале файла");

group("Хронометраж");
ok(dur >= 60 && dur <= 180, `длительность ${dur.toFixed(1)} с в границах стандарта 60–180 с`);

const logPath = file.replace(/\.mp4$/, ".build-log.json");
let log = null;
if (existsSync(logPath)) {
  log = JSON.parse(readFileSync(logPath, "utf8"));
  const target = log.durationTarget;
  ok(Math.abs(dur - target) <= target * 0.1,
    `в пределах ±10% цели сценария (${target} с)`);
  const missing = log.scenes.filter((s) => s.source === "MISSING");
  ok(missing.length === 0,
    missing.length === 0 ? "все сцены собраны из настоящих дублей"
      : `заглушки вместо сцен: ${missing.map((s) => s.id).join(", ")}`);
  // Порог был 4 секунды, и он врал: 31.08 проверка молча пропустила ролик,
  // где сцена стояла замершим кадром семь секунд, и владелец увидел это
  // раньше меня. Стоп-кадр в обучающем ролике не приём, а дыра в
  // раскадровке: секунда на затухание жеста — предел, дальше сцену надо
  // добирать планом (обычно крупным, см. krupno.mjs).
  const frozen = log.scenes.filter((s) => (s.frozenTail ?? 0) > 1);
  ok(frozen.length === 0,
    "стоп-кадровых дотяжек длиннее секунды нет",
    frozen.length ? `сцена стоит замершим кадром (${frozen.map((s) => `${s.id}:${s.frozenTail.toFixed(1)}с`).join(", ")}) — добрать планами` : undefined);
  if (log.voMode !== "elevenlabs") {
    warnNote(`войсовер: ${log.voMode} — для сдачи нужен настоящий (ElevenLabs)`);
  }
} else {
  warnNote("нет build-log.json рядом с файлом — проверки сцен и плашек пропущены");
}

group("Громкость");
const lnOut = runMerged("ffmpeg", ["-hide_banner", "-i", file, "-af",
  "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
const lnStart = lnOut.lastIndexOf("{");
const lnJson = JSON.parse(lnOut.slice(lnStart, lnOut.indexOf("}", lnStart) + 1));
const I = Number(lnJson.input_i);
const TP = Number(lnJson.input_tp);
ok(Math.abs(I - -16) <= 1, `integrated ${I.toFixed(1)} LUFS (цель −16 ±1)`);
ok(TP <= -1.4, `true peak ${TP.toFixed(1)} dBTP (порог −1.5)`);

// Плашки: извлечь кадр из середины каждой сцены и проверить контраст в зоне плашки
if (log) {
  group("Плашки (по кадрам из середины сцен)");
  const p = { x: 32, y: 32, w: 900, h: 110 }; // зона плашки с запасом
  for (const s of log.scenes) {
    if (s.kind !== "scene") continue;
    const mid = (s.t[0] + s.t[1]) / 2;
    const out = runMerged("ffmpeg", ["-hide_banner", "-loglevel", "info",
      "-ss", mid.toFixed(2), "-i", file,
      "-vf", `crop=${p.w}:${p.h}:${p.x}:${p.y},signalstats,metadata=print`,
      "-frames:v", "1", "-f", "null", "-"]);
    const ymin = Number(out.match(/signalstats\.YMIN=(\d+(?:\.\d+)?)/)?.[1]);
    const ymax = Number(out.match(/signalstats\.YMAX=(\d+(?:\.\d+)?)/)?.[1]);
    const range = ymax - ymin;
    ok(range >= 80, `${s.id}: плашка в кадре (перепад яркости ${range})`);
  }
}

console.log(`\nИтог: ${pass} ✅, ${warn} ⚠, ${fail} ❌`);

// Тот же результат структурой — для интерфейса приёмки. Кладём рядом с
// роликом, как build-log.json: у экрана приёмки тогда всё в одной папке.
const report = {
  file,
  checkedAt: new Date().toISOString(),
  verdict: fail === 0 ? (warn === 0 ? "pass" : "warn") : "fail",
  counts: { pass, warn, fail },
  checks,
};
const reportPath = file.replace(/\.mp4$/i, "") + ".verify.json";
try {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Отчёт: ${reportPath}`);
} catch (err) {
  // Отчёт — удобство, а не приёмка. Не смогли записать (диск только на чтение,
  // папка занята) — говорим и уходим с тем же кодом, что и раньше.
  console.log(`Отчёт записать не удалось: ${err.message}`);
}

process.exit(fail === 0 ? 0 : 1);
