#!/usr/bin/env node
// Пересчёт хронометража сцен под фактическую длительность озвучки.
//
//   node engine/retime_scenes.mjs                  — только показать
//   node engine/retime_scenes.mjs --only kvartsevanie
//   node engine/retime_scenes.mjs --apply           — записать
//   node engine/retime_scenes.mjs --lead 0.5 --tail 1.0
//   node engine/retime_scenes.mjs --shrink   — и укорачивать тоже
//
// ЗАЧЕМ. Тексты войсовера писались под расчёт «15,5 знака в секунду», и
// границы сцен в сценариях расставлены по этому расчёту. Дикторка читает
// медленнее — по 244 репликам медиана 13,6 зн/с, — поэтому девять реплик
// оказались длиннее своих сцен, а сорок девять сидят впритык
// (engine/verify_vo_fit.mjs, reports/vo-fit-2026-08-21.md).
//
// Правильный порядок здесь обратный тому, что был: не речь подгоняется под
// сцену, а сцена под речь. Озвучка уже записана и не перегенерируется —
// значит, она и есть данность, а границы сцен — то, что можно двигать.
// Скрипт делает ровно это: сцена = запас до речи + сама речь + запас после,
// сцены идут подряд без дыр, ролик собирается из новых границ.
//
// ПО УМОЛЧАНИЮ СЦЕНЫ ТОЛЬКО УДЛИНЯЮТСЯ. Это не осторожность ради
// осторожности: замер показал, что при честной подгонке «сцена = речь плюс
// запас» короче становятся ВСЕ 32 ролика — от 2 до 20 секунд. Речь занимает
// в среднем 77 % сцены, остальное отдано картинке, и это не пустота, а ритм,
// который расставил человек. Скрипт не вправе его переписывать: он чинит
// девять мест, где речь не влезает, и не трогает те, где запас есть.
// Сжимать он тоже умеет — ключом --shrink, осознанно.
//
// ЧЕГО СКРИПТ НЕ ДЕЛАЕТ. Не трогает ни одного mp3 и ни одной строки `vo` —
// озвучка оплачена, квота исчерпана, тексты неприкосновенны. Меняются
// только числа `t` и `duration_target` в машинных сценариях
// (production/prompts/scenarios/*.yaml) — источнике, из которого
// build_prompts.py собирает компиляты.
//
// Правка сценариев ТЕКСТОВАЯ, построчная: переписываются только строки
// `t: [a, b]` и `duration_target:`. Блочные скаляры, отступы, комментарии и
// порядок ключей остаются как были — YAML не перечитывается и не
// перезаписывается целиком, поэтому файл после правки читается тем же
// человеком так же, как до неё.
//
// После --apply: python engine/build_prompts.py
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ffprobeJson, loadConfig, ROOT, sceneDuration } from "./lib.mjs";

function parseArgs(argv) {
  const opts = { only: null, apply: false, lead: 0.5, tail: 1.0, report: null, shrink: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") opts.only = argv[++i];
    else if (a === "--apply") opts.apply = true;
    else if (a === "--shrink") opts.shrink = true;
    else if (a === "--lead") opts.lead = Number(argv[++i]);
    else if (a === "--tail") opts.tail = Number(argv[++i]);
    else if (a === "--report") opts.report = argv[++i];
    else {
      console.error(`Неизвестный аргумент: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.lead) || !Number.isFinite(opts.tail) || opts.lead < 0 || opts.tail < 0) {
    console.error("--lead и --tail — неотрицательные числа секунд.");
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const compiledDir = join(ROOT, cfg.paths.compiled);
const takesDir = join(ROOT, cfg.paths.takes);
const scenariosDir = join(dirname(compiledDir), "scenarios");

if (!existsSync(scenariosDir)) {
  console.error(`Нет папки машинных сценариев ${scenariosDir}`);
  process.exit(2);
}

const files = readdirSync(compiledDir).filter((f) => f.endsWith(".json")).sort();
const rows = [];
const perScenario = [];

for (const f of files) {
  const sc = JSON.parse(readFileSync(join(compiledDir, f), "utf8"));
  if (opts.only && sc.id !== opts.only) continue;

  let cursor = 0;
  const scenes = [];
  let missing = 0;
  for (const scene of sc.scenes ?? []) {
    const oldT = [scene.t[0], scene.t[1]];
    const oldLen = sceneDuration(scene);
    const text = (scene.vo ?? "").trim();
    let voSec = null;
    if (text) {
      const mp3 = join(takesDir, sc.id, "vo", `${scene.id}.mp3`);
      if (existsSync(mp3)) {
        try {
          voSec = Number(ffprobeJson(mp3).format.duration);
        } catch {
          voSec = null;
        }
      }
    }

    // Сцена без речи (разделитель, заставка без войсовера) — длину не
    // трогаем: подгонять её не подо что, а произвольно менять ритм ролика
    // скрипт права не имеет.
    let newLen = oldLen;
    if (voSec !== null) {
      const needed = opts.lead + voSec + opts.tail;
      // Без --shrink сцена может только вырасти: см. разбор в шапке файла.
      newLen = opts.shrink ? needed : Math.max(oldLen, needed);
    } else if (text) missing++;

    // Округление до десятой: сборщик режет по секундам с десятыми, а
    // читать сценарий с числами вида 17.4382 человеку невозможно.
    newLen = Math.round(newLen * 10) / 10;
    const newT = [Math.round(cursor * 10) / 10, Math.round((cursor + newLen) * 10) / 10];
    cursor = newT[1];

    scenes.push({ id: scene.id, oldT, newT, oldLen, newLen, voSec, hasVo: Boolean(text) });
    rows.push({
      scenarioId: sc.id,
      title: sc.title,
      sceneId: scene.id,
      oldT,
      newT,
      oldLen,
      newLen,
      voSec,
      share: voSec === null ? null : voSec / oldLen,
    });
  }

  perScenario.push({
    id: sc.id,
    title: sc.title,
    file: join(scenariosDir, `${sc.id}.yaml`),
    scenes,
    oldTotal: sc.scenes.at(-1)?.t[1] ?? 0,
    newTotal: cursor,
    oldTarget: sc.duration_target ?? null,
    missing,
  });
}

// --- вывод ---------------------------------------------------------------
const n2 = (x) => (x === null || x === undefined ? "—" : x.toFixed(1));
console.log(
  `Пересчёт под фактическую озвучку: запас ${opts.lead} с до речи и ${opts.tail} с после.\n` +
    (opts.shrink ? "Сцены и удлиняются, и укорачиваются (--shrink).\n" : "Сцены только удлиняются; где запас уже есть — не трогаются.\n") +
    `Роликов: ${perScenario.length}, сцен: ${rows.length}.\n`,
);

let grew = 0;
let shrank = 0;
let overCap = [];
for (const s of perScenario) {
  const delta = s.newTotal - s.oldTotal;
  if (delta > 0.05) grew++;
  else if (delta < -0.05) shrank++;
  // Потолок производственного стандарта серии — 180 с (verify_video.mjs).
  if (s.newTotal > 180) overCap.push(s);
  if (Math.abs(delta) < 0.05 && !s.missing) continue;
  const moved = s.scenes.filter((x) => Math.abs(x.newLen - x.oldLen) >= 0.05);
  console.log(
    `${delta > 0 ? "+" : "−"} ${s.title} (${s.id}): ${n2(s.oldTotal)} с -> ${n2(s.newTotal)} с ` +
      `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)} с)` +
      (moved.length ? `  сцены: ${moved.map((x) => `${x.id} ${n2(x.oldLen)}->${n2(x.newLen)}`).join(", ")}` : "") +
      (s.missing ? `  ⚠ реплик без mp3: ${s.missing}` : ""),
  );
}

const tight = rows.filter((r) => r.share !== null && r.share >= 0.85 && r.share <= 1);
const over = rows.filter((r) => r.share !== null && r.share > 1);
console.log("\n" + "—".repeat(64));
console.log(`Роликов удлинилось: ${grew}, укоротилось: ${shrank}, без изменений: ${perScenario.length - grew - shrank}`);
console.log(`Было «не влезла»: ${over.length}, «тесно»: ${tight.length} — после пересчёта таких нет по построению.`);
if (overCap.length) {
  console.log(`\n⚠ Выходят за потолок стандарта 180 с (${overCap.length}):`);
  for (const s of overCap) console.log(`   ${s.title} (${s.id}) — ${n2(s.newTotal)} с`);
}

// --- отчёт ---------------------------------------------------------------
if (opts.report) {
  const md = ["# Пересчёт хронометража сцен под фактическую озвучку", ""];
  md.push(`Запас: ${opts.lead} с до речи, ${opts.tail} с после. Сгенерировано`);
  md.push("`engine/retime_scenes.mjs`.", "");
  md.push("| Ролик | Было, с | Стало, с | Разница |");
  md.push("|---|---:|---:|---:|");
  for (const s of perScenario) {
    md.push(`| ${s.title} | ${n2(s.oldTotal)} | ${n2(s.newTotal)} | ${(s.newTotal - s.oldTotal >= 0 ? "+" : "")}${(s.newTotal - s.oldTotal).toFixed(1)} |`);
  }
  md.push("", "## Посценно", "", "| Ролик | Сцена | Речь, с | Было, с | Стало, с |", "|---|---|---:|---:|---:|");
  for (const r of rows) {
    md.push(`| ${r.scenarioId} | ${r.sceneId} | ${n2(r.voSec)} | ${n2(r.oldLen)} | ${n2(r.newLen)} |`);
  }
  md.push("");
  const out = join(ROOT, opts.report);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md.join("\n"), "utf8");
  console.log(`\nОтчёт: ${out}`);
}

// --- запись --------------------------------------------------------------
if (!opts.apply) {
  console.log("\nНичего не записано. Повторите с --apply, если числа устраивают.");
  process.exit(0);
}

const T_LINE = /^(\s*)t:\s*\[\s*[\d.]+\s*,\s*[\d.]+\s*\]\s*$/;
const ID_LINE = /^\s*-\s+id:\s*(\S+)\s*$/;
const TARGET_LINE = /^(\s*)duration_target:\s*[\d.]+\s*$/;
const num = (x) => (Number.isInteger(x) ? String(x) : String(x));

let written = 0;
for (const s of perScenario) {
  if (!existsSync(s.file)) {
    console.error(`!! нет сценария ${s.file} — пропущен`);
    continue;
  }
  const byId = new Map(s.scenes.map((x) => [x.id, x]));
  const lines = readFileSync(s.file, "utf8").split(/\r?\n/);
  let currentId = null;
  let touched = 0;
  for (let i = 0; i < lines.length; i++) {
    const idm = ID_LINE.exec(lines[i]);
    if (idm) {
      currentId = idm[1].replace(/^["']|["']$/g, "");
      continue;
    }
    const tgt = TARGET_LINE.exec(lines[i]);
    if (tgt && currentId === null) {
      lines[i] = `${tgt[1]}duration_target: ${num(Math.round(s.newTotal))}`;
      continue;
    }
    const tm = T_LINE.exec(lines[i]);
    if (tm && currentId && byId.has(currentId)) {
      const { newT } = byId.get(currentId);
      lines[i] = `${tm[1]}t: [${num(newT[0])}, ${num(newT[1])}]`;
      touched++;
    }
  }
  if (touched !== s.scenes.length) {
    console.error(
      `!! ${s.id}: в сценарии переписано ${touched} строк t, а сцен ${s.scenes.length}. ` +
        "Файл НЕ записан — разберитесь глазами, прежде чем гнать дальше.",
    );
    continue;
  }
  writeFileSync(s.file, lines.join("\n"), "utf8");
  written++;
}

console.log(`\nПереписано сценариев: ${written} из ${perScenario.length}.`);
console.log("Дальше: python engine/build_prompts.py");
console.log("Потом:  node engine/verify_vo_fit.mjs");
process.exit(written === perScenario.length ? 0 : 1);
