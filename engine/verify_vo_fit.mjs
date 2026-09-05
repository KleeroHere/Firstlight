#!/usr/bin/env node
// Приёмочная проверка: влезает ли записанная речь в свою сцену.
//
//   node engine/verify_vo_fit.mjs
//   node engine/verify_vo_fit.mjs --only fog-signal-check
//   node engine/verify_vo_fit.mjs --report reports/vo-fit.md
//
// Тексты войсовера писались под расчёт 15,5 знака в секунду. Фактический
// темп дикторки от расчёта отличается, и если речь длиннее сцены, сборщик
// обрежет её на полуслове. Скрипт сверяет фактическую длительность
// takes/<id>/vo/<сцена>.mp3 (ffprobe) с длиной сцены t[1] - t[0].
//
// Классификация:
//   ОК         — речь занимает до 85 % сцены;
//   ТЕСНО      — 85–100 %;
//   НЕ ВЛЕЗЛА  — речь длиннее сцены;
//   НЕТ ФАЙЛА  — mp3 отсутствует.
//
// Код возврата: 0, если ни одной «НЕ ВЛЕЗЛА»; 1 иначе.
//
// Скрипт только читает: ничего не чинит, не пересобирает и не тратит квоту.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ffprobeJson, loadConfig, ROOT, sceneDuration } from "./lib.mjs";

const TIGHT = 0.85; // выше этой доли сцены — «ТЕСНО»

function parseArgs(argv) {
  const opts = { only: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") opts.only = argv[++i];
    else if (argv[i] === "--report") opts.report = argv[++i];
    else if (argv[i] === "--no-report") opts.report = false;
    else {
      console.error(`Неизвестный аргумент: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

function defaultReportPath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return join("reports", `vo-fit-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`);
}

const opts = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const compiledDir = join(ROOT, cfg.paths.compiled);
const takesDir = join(ROOT, cfg.paths.takes);

if (!existsSync(compiledDir)) {
  console.error(`Нет папки компилятов ${compiledDir} — запусти python engine/build_prompts.py`);
  process.exit(2);
}

const files = readdirSync(compiledDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const rows = [];
for (const f of files) {
  const sc = JSON.parse(readFileSync(join(compiledDir, f), "utf8"));
  if (opts.only && sc.id !== opts.only) continue;
  for (const scene of sc.scenes ?? []) {
    const text = (scene.vo ?? "").trim();
    if (!text) continue;
    const mp3 = join(takesDir, sc.id, "vo", `${scene.id}.mp3`);
    const sceneSec = sceneDuration(scene);
    const row = {
      scenarioId: sc.id,
      title: sc.title,
      sceneId: scene.id,
      chars: text.length,
      sceneSec,
      voSec: null,
      ratio: null,
      status: "НЕТ ФАЙЛА",
      mp3,
    };
    if (existsSync(mp3)) {
      let dur = NaN;
      try {
        dur = Number(ffprobeJson(mp3).format.duration);
      } catch (e) {
        row.status = "НЕТ ФАЙЛА";
        row.error = String(e.message ?? e).split("\n")[0];
      }
      if (Number.isFinite(dur)) {
        row.voSec = dur;
        row.ratio = sceneSec > 0 ? dur / sceneSec : Infinity;
        row.status = row.ratio > 1 ? "НЕ ВЛЕЗЛА" : row.ratio >= TIGHT ? "ТЕСНО" : "ОК";
      }
    }
    rows.push(row);
  }
}

const MARK = { "ОК": "✅", "ТЕСНО": "⚠", "НЕ ВЛЕЗЛА": "❌", "НЕТ ФАЙЛА": "∅" };
const by = (s) => rows.filter((r) => r.status === s);
const n2 = (x) => (x === null ? "—" : x.toFixed(2));
const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(0)} %`);

console.log(`Проверка укладки речи в сцены: ${files.length} компилятов, ${rows.length} реплик\n`);

let currentScenario = null;
for (const r of rows) {
  if (r.scenarioId !== currentScenario) {
    currentScenario = r.scenarioId;
    console.log(`\n${r.title} (${r.scenarioId})`);
  }
  const tail = r.status === "НЕ ВЛЕЗЛА"
    ? `  — длиннее сцены на ${(r.voSec - r.sceneSec).toFixed(2)} с`
    : "";
  console.log(
    `  ${MARK[r.status]} ${r.sceneId.padEnd(6)} ` +
      `сцена ${n2(r.sceneSec).padStart(6)} с  речь ${n2(r.voSec).padStart(6)} с  ` +
      `${pct(r.ratio).padStart(6)}  ${r.status}${tail}`,
  );
}

const summary = ["ОК", "ТЕСНО", "НЕ ВЛЕЗЛА", "НЕТ ФАЙЛА"].map((s) => [s, by(s).length]);
console.log("\n" + "—".repeat(60));
console.log("Итого:");
for (const [s, n] of summary) console.log(`  ${MARK[s]} ${s.padEnd(10)} ${String(n).padStart(4)}`);
console.log(`  всего реплик ${String(rows.length).padStart(6)}`);

const problems = [...by("НЕ ВЛЕЗЛА"), ...by("НЕТ ФАЙЛА")];
if (problems.length) {
  console.log("\nПроблемные сцены поимённо:");
  for (const r of problems) {
    console.log(
      `  ${MARK[r.status]} ${r.scenarioId}/${r.sceneId} — ${r.status}` +
        (r.status === "НЕ ВЛЕЗЛА"
          ? `: речь ${n2(r.voSec)} с при сцене ${n2(r.sceneSec)} с (+${(r.voSec - r.sceneSec).toFixed(2)} с, ${pct(r.ratio)})`
          : ""),
    );
  }
}

// --- отчёт ---------------------------------------------------------------
if (opts.report !== false) {
  const out = join(ROOT, opts.report ?? defaultReportPath());
  const md = [];
  md.push("# Укладка речи в сцены — приёмка");
  md.push("");
  md.push("Сгенерировано `engine/verify_vo_fit.mjs`. Фактическая");
  md.push("длительность mp3 (ffprobe) против длины сцены `t[1] - t[0]`.");
  md.push("Порог «ТЕСНО» — 85 % сцены.");
  md.push("");
  md.push("| Категория | Реплик |");
  md.push("|---|---:|");
  for (const [s, n] of summary) md.push(`| ${MARK[s]} ${s} | ${n} |`);
  md.push(`| **всего** | **${rows.length}** |`);
  md.push("");
  if (problems.length) {
    md.push("## Проблемные сцены");
    md.push("");
    md.push("| Ролик | Сцена | Сцена, с | Речь, с | Доля | Статус |");
    md.push("|---|---|---:|---:|---:|---|");
    for (const r of problems) {
      md.push(`| ${r.scenarioId} | ${r.sceneId} | ${n2(r.sceneSec)} | ${n2(r.voSec)} | ${pct(r.ratio)} | ${r.status} |`);
    }
    md.push("");
  } else {
    md.push("Проблемных сцен нет: ни одной «НЕ ВЛЕЗЛА», ни одного пропавшего mp3.");
    md.push("");
  }
  const tight = by("ТЕСНО");
  if (tight.length) {
    md.push("## Тесно (85–100 % сцены)");
    md.push("");
    md.push("Формально влезает, но запаса на паузу и хвост дорожки нет.");
    md.push("");
    md.push("| Ролик | Сцена | Сцена, с | Речь, с | Доля |");
    md.push("|---|---|---:|---:|---:|");
    for (const r of tight) {
      md.push(`| ${r.scenarioId} | ${r.sceneId} | ${n2(r.sceneSec)} | ${n2(r.voSec)} | ${pct(r.ratio)} |`);
    }
    md.push("");
  }
  md.push("## Полная таблица");
  md.push("");
  md.push("| Ролик | Сцена | Знаков | Сцена, с | Речь, с | Доля | Статус |");
  md.push("|---|---|---:|---:|---:|---:|---|");
  for (const r of rows) {
    md.push(
      `| ${r.scenarioId} | ${r.sceneId} | ${r.chars} | ${n2(r.sceneSec)} | ${n2(r.voSec)} | ${pct(r.ratio)} | ${r.status} |`,
    );
  }
  md.push("");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md.join("\n"), "utf8");
  console.log(`\nОтчёт: ${out}`);
}

const failed = by("НЕ ВЛЕЗЛА").length;
console.log(failed ? `\n❌ Не влезло реплик: ${failed}` : "\n✅ Все реплики влезают в свои сцены");
process.exit(failed ? 1 : 0);
