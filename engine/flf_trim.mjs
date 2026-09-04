#!/usr/bin/env node
// Монтажная правка клипов FLF2V: срезать хвост, где картинка портится.
//
//   node engine/flf_trim.mjs --id uborka            — показать
//   node engine/flf_trim.mjs --id uborka --apply    — обрезать
//
// ЗАЧЕМ. Wan к концу клипа иногда «доигрывает»: предмет мутирует или
// исчезает, движение зацикливается, персонаж дёргается. Перегенерация
// стоит времени пода и лотереи сида, а дефект почти всегда в хвосте —
// значит, дешевле отрезать хвост на монтаже. Запас для этого есть:
// планы генерятся длиннее сцены (сумма планов ≥ длины сцены из компилята).
//
// ЧТО СЧИТАЕМ. Покадровая разница яркости d[i] (tblend=difference, YAVG):
//   • скачок — d[i] > медиана + 5·MAD. Так выглядят подмена предмета,
//     рывок камеры, «моргание» кадра;
//   • мёртвый хвост — подряд ≥10 кадров с d[i] < 0.35·медианы: движение
//     кончилось, дальше модель просто держит кадр (или зациклилась).
// Точка реза — самая ранняя из находок, но не раньше, чем позволяет
// запас сцены: сцена не должна стать короче своей длины из компилята.
//
// Оригиналы сохраняются в _flf/_full/, так что откатиться можно всегда.
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";

const id = process.argv[process.argv.indexOf("--id") + 1];
const apply = process.argv.includes("--apply");
if (!id) { console.error("Нужен --id"); process.exit(2); }

const cfg = loadConfig();
const spec = JSON.parse(readFileSync(join(ROOT, "workspace", "plans", `${id}.json`), "utf8"));
const scenario = JSON.parse(readFileSync(join(ROOT, cfg.paths.compiled, `${id}.json`), "utf8"));
const takesDir = join(ROOT, cfg.paths.takes, id);
const flfDir = join(takesDir, "_flf");
const fullDir = join(flfDir, "_full");
const FPS = 16;

function ff(a) { execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]); }
function frameDiffs(file) {
  let out = "";
  try {
    out = execFileSync("ffmpeg", ["-i", file, "-vf",
      "select='gt(n,0)',tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).toString();
  } catch (e) { out = (e.stdout ?? "").toString(); }
  return [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

// Сколько кадров у плана обязаны остаться, чтобы сцена не стала короче.
const need = {};
for (const sc of scenario.scenes) need[sc.id] = (Number(sc.t[1]) - Number(sc.t[0])) * FPS;
const bySceneFrames = {};
for (const p of spec.plans) bySceneFrames[p.scene] = (bySceneFrames[p.scene] ?? 0) + p.frames;

mkdirSync(fullDir, { recursive: true });
const cuts = [];
console.log(`Клипы ${id} (порог реза считается по каждому клипу отдельно):`);

for (const p of spec.plans) {
  const file = join(flfDir, `plan${p.plan}.mp4`);
  if (!existsSync(file)) { console.log(`  план ${p.plan}: клипа нет`); continue; }
  const src = existsSync(join(fullDir, `plan${p.plan}.mp4`)) ? join(fullDir, `plan${p.plan}.mp4`) : file;
  const d = frameDiffs(src);
  if (d.length < 20) { console.log(`  план ${p.plan}: слишком короткий, пропуск`); continue; }

  const med = median(d);
  const mad = median(d.map((x) => Math.abs(x - med))) || 0.001;
  const spikeLimit = med + 5 * mad;
  const deadLimit = 0.35 * med;

  const start = Math.floor(d.length * 0.3);        // начало не трогаем
  let spikeAt = -1;
  for (let i = start; i < d.length; i++) if (d[i] > spikeLimit) { spikeAt = i; break; }
  let deadAt = -1, run = 0;
  for (let i = start; i < d.length; i++) {
    run = d[i] < deadLimit ? run + 1 : 0;
    if (run >= 10) { deadAt = i - run + 1; break; }
  }

  // Кадров у плана должно остаться столько, чтобы сцена дотянула свою длину.
  const share = p.frames / bySceneFrames[p.scene];
  const minKeep = Math.ceil((need[p.scene] ?? p.frames) * share);
  const candidates = [spikeAt, deadAt].filter((x) => x > 0).map((x) => x + 1);
  const cutTo = candidates.length ? Math.max(minKeep, Math.min(...candidates)) : p.frames;

  if (cutTo >= d.length) {
    console.log(`  план ${p.plan}: чисто (медиана ${med.toFixed(2)})`);
    continue;
  }
  const why = spikeAt > 0 && spikeAt + 1 <= cutTo ? `скачок на кадре ${spikeAt}` : `мёртвый хвост с кадра ${deadAt}`;
  console.log(`  план ${p.plan}: рез ${d.length + 1} → ${cutTo} кадров (−${((d.length + 1 - cutTo) / FPS).toFixed(1)} с), ${why}`);
  cuts.push({ plan: p.plan, scene: p.scene, from: d.length + 1, to: cutTo, file, src });
}

if (!cuts.length) { console.log("Резать нечего."); process.exit(0); }
if (!apply) { console.log("\nПоказ без правки. Повторите с --apply."); process.exit(0); }

for (const c of cuts) {
  if (!existsSync(join(fullDir, `plan${c.plan}.mp4`))) copyFileSync(c.file, join(fullDir, `plan${c.plan}.mp4`));
  const tmp = join(flfDir, `plan${c.plan}_trim.mp4`);
  ff(["-i", join(fullDir, `plan${c.plan}.mp4`), "-frames:v", String(c.to), "-c:v", "libx264",
    "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", tmp]);
  copyFileSync(tmp, c.file);
  rmSync(tmp, { force: true });
}

// Пересобираем дубли сцен, которых коснулись резы.
const touched = [...new Set(cuts.map((c) => c.scene))];
for (const sc of touched) {
  const parts = spec.plans.filter((p) => p.scene === sc).map((p) => join(flfDir, `plan${p.plan}.mp4`));
  if (!parts.every(existsSync)) continue;
  const list = join(flfDir, `${sc}_trim_list.txt`);
  writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", join(takesDir, `${sc}_take1.mp4`)]);
  console.log(`пересобран ${sc}_take1.mp4`);
}
console.log(`\nОбрезано клипов: ${cuts.length}. Оригиналы в _flf/_full/.`);
