#!/usr/bin/env node
// Автоприёмка конвейера FLF2V: клипы до сборки + build-log после сборки.
//
//   node engine/flf_verify.mjs --id uborka
//
// Проверяет:
//   1. Движение каждого клипа (YAVG по tblend=difference): ниже MIN — статика
//      (ловушка циклического жеста: первый и последний ключ совпали).
//   2. SSIM последнего кадра клипа к ключу К1 (если ключ есть): ниже 0.85 —
//      клип не дошёл до ключа, склейка со следующим планом дёрнется.
//   3. Длительность клипа = кадры плана / 16 fps (±0.2 с).
//   4. Дубль каждой сцены не короче сцены сценария.
//   5. Если ролик уже собран: в build-log каждая сцена-не-карточка обязана
//      быть источником *_take1.mp4 со still:false — иначе сборка ушла в
//      статичный режим (забыли --prefer-takes).
// Выход: код 1, если есть ❌. Предупреждения (⚠) кода не меняют.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";

const id = process.argv[process.argv.indexOf("--id") + 1];
if (!id) { console.error("Нужен --id"); process.exit(2); }
const cfg = loadConfig();
const spec = JSON.parse(readFileSync(join(ROOT, "workspace", "plans", `${id}.json`), "utf8"));
const scenario = JSON.parse(readFileSync(join(ROOT, cfg.paths.compiled, `${id}.json`), "utf8"));
const takesDir = join(ROOT, cfg.paths.takes, id);

// Порог откалиброван по замерам 23.08: статичный кивок (совпали граничные
// ключи) дал 0.61, а живой план «Ярослав перекладывает перчатки» в общем
// плане на четверых — 0.94. Порог 0.8 разделяет эти два случая: мелкий жест
// одного человека в общем плане проходит, настоящая статика ловится.
const MIN_MOTION = 0.8;
const MAX_MOTION = 5.0;   // выше — дребезг/распад
const MIN_SSIM = 0.85;

let ok = 0, warn = 0, fail = 0;
const say = (mark, msg) => { console.log(`  ${mark} ${msg}`); if (mark === "✅") ok++; else if (mark === "⚠") warn++; else fail++; };

function ffText(args) {
  try { return execFileSync("ffmpeg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString(); }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
}
function probeDur(f) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim());
}
function motion(f) {
  const out = ffText(["-i", f, "-vf", "select='gt(n,0)',tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"]);
  const m = [...out.matchAll(/YAVG=([\d.]+)/g)].map((x) => +x[1]);
  return m.length ? m.reduce((s, v) => s + v, 0) / m.length : NaN;
}
function lastFrameSsim(clip, keyPng) {
  const out = ffText(["-sseof", "-0.13", "-i", clip, "-loop", "1", "-i", keyPng,
    "-lavfi", "[1:v]scale=1280:720[b];[0:v][b]ssim=stats_file=-", "-frames:v", "1", "-f", "null", "-"]);
  const m = [...out.matchAll(/All:([\d.]+)/g)];
  return m.length ? +m[m.length - 1][1] : NaN;
}

console.log(`Клипы (${id}):`);
for (const p of spec.plans) {
  const clip = join(takesDir, "_flf", `plan${p.plan}.mp4`);
  if (!existsSync(clip)) { say("❌", `план ${p.plan}: клипа нет (${clip})`); continue; }
  const mv = motion(clip);
  // План может объявить свой порог: у общего плана на сидящую группу,
  // где двигается один человек мелким жестом, кадровая разница низкая
  // по природе кадра, а не из-за статики.
  const minMotion = p.minMotion ?? MIN_MOTION;
  if (mv < minMotion) say("❌", `план ${p.plan}: статика — движение ${mv.toFixed(2)} < ${minMotion} (циклический жест? бить на полуфазы)`);
  else if (mv > (p.maxMotion ?? MAX_MOTION)) say("⚠", `план ${p.plan}: движение ${mv.toFixed(2)} > ${p.maxMotion ?? MAX_MOTION} — проверить глазами на дребезг`);
  else say("✅", `план ${p.plan}: движение ${mv.toFixed(2)}`);
  // Клип, обрезанный на монтаже (flf_trim), короче планового по замыслу:
  // оригинал лежит в _flf/_full/. Тогда длина и совпадение конца с ключом
  // проверяться не должны — важно лишь, что дубль сцены покрывает сцену.
  const trimmed = existsSync(join(takesDir, "_flf", "_full", `plan${p.plan}.mp4`));
  const dur = probeDur(clip);
  const want = p.frames / 16;
  if (trimmed) say("✅", `план ${p.plan}: обрезан на монтаже до ${dur.toFixed(2)} с из ${want.toFixed(2)} с`);
  else if (Math.abs(dur - want) > 0.2 && !p.ready) say("❌", `план ${p.plan}: длительность ${dur.toFixed(2)} с ≠ ${want.toFixed(2)} с (${p.frames} кадров)`);
  // Полуфазный план (cycle) кончается на мастере, обычный — на ключе К1.
  const target = p.cycle ? join(takesDir, p.master) : join(takesDir, "keys", `plan${p.plan}_key.png`);
  const targetName = p.cycle ? "мастеру" : "ключу";
  if (existsSync(target) && !trimmed) {
    const s = lastFrameSsim(clip, target);
    if (s < MIN_SSIM) say("⚠", `план ${p.plan}: SSIM конца к ${targetName} ${s.toFixed(3)} < ${MIN_SSIM} — стык со следующим планом дёрнется`);
    else say("✅", `план ${p.plan}: SSIM конца к ${targetName} ${s.toFixed(3)}`);
  }
}

console.log("Дубли сцен:");
for (const sc of scenario.scenes) {
  if (["title", "divider", "memo"].includes(sc.kind)) continue;
  const need = Number(sc.t[1]) - Number(sc.t[0]);
  const take = join(takesDir, `${sc.id}_take1.mp4`);
  if (!existsSync(take)) { say("❌", `${sc.id}: нет дубля ${sc.id}_take1.mp4`); continue; }
  const dur = probeDur(take);
  if (dur + 0.05 < need) say("⚠", `${sc.id}: дубль ${dur.toFixed(1)} с короче сцены ${need.toFixed(1)} с — хвост дотянется стоп-кадром`);
  else say("✅", `${sc.id}: дубль ${dur.toFixed(1)} с ≥ сцены ${need.toFixed(1)} с`);
}

const logPath = join(ROOT, cfg.paths.build, id, "build-log.json");
if (existsSync(logPath)) {
  console.log("Сборка (build-log):");
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  for (const s of log.scenes) {
    if (s.source === "rendered") continue;
    const fromTake = typeof s.source === "string" && /take\d+\.mp4$/.test(s.source) && !s.still;
    if (fromTake) say("✅", `${s.id}: собрана из ${s.source.split(/[\\/]/).pop()}`);
    else say("❌", `${s.id}: собрана ИЗ СТАТИКИ (${JSON.stringify(s.source).slice(0, 60)}…) — пересобрать с --prefer-takes`);
  }
} else console.log("Сборка: build-log нет — ролик ещё не собирался.");

console.log(`\nИтог: ${ok} ✅, ${warn} ⚠, ${fail} ❌`);
process.exit(fail ? 1 : 0);
