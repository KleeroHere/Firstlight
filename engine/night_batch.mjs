#!/usr/bin/env node
// Ночной пакет серии: собрать и проверить всё, что готово.
//
//   node engine/night_batch.mjs [--placeholder-vo]
//
// Проходит по всем компилятам; ролик берётся в работу, если для КАЖДОЙ его
// генерируемой сцены есть хотя бы один дубль в takes/<id>/. Уже собранные и
// прошедшие проверку ролики пропускаются (идемпотентность — по build-log:
// если источники не новее сборки). Падение одного ролика не валит пакет.
// Код возврата 0, если ни одна сборка не упала (пропуски — не падение).
//
// Подключение к night-runner (scripts/night-runner/config.mjs):
//   { name: "firstlight-batch", command: "node",
//     args: ["engine/night_batch.mjs"],
//     timeoutMs: 60 * MINUTE, required: false }
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig, sanitizeName } from "./lib.mjs";

const cfg = loadConfig();
const extra = process.argv.slice(2);
const compiledDir = join(ROOT, cfg.paths.compiled);
const results = [];

for (const f of readdirSync(compiledDir).filter((f) => f.endsWith(".json")).sort()) {
  const sn = JSON.parse(readFileSync(join(compiledDir, f), "utf8"));
  const takesDir = join(ROOT, cfg.paths.takes, sn.id);
  const genScenes = sn.scenes.filter((s) => (s.kind ?? "scene") === "scene");
  const haveAll = existsSync(takesDir) && genScenes.every((s) =>
    readdirSync(takesDir).some((x) => x.startsWith(`${s.id}_take`)));
  if (!haveAll) {
    const missing = !existsSync(takesDir) ? genScenes.length
      : genScenes.filter((s) => !readdirSync(takesDir).some((x) => x.startsWith(`${s.id}_take`))).length;
    results.push({ id: sn.id, status: "ждёт дублей", detail: `не хватает сцен: ${missing}/${genScenes.length}` });
    continue;
  }
  const outFile = join(ROOT, cfg.paths.out, `${sanitizeName(sn.title)}.mp4`);
  if (existsSync(outFile)) {
    const outTime = statSync(outFile).mtimeMs;
    const newest = Math.max(...readdirSync(takesDir).map((x) => statSync(join(takesDir, x)).mtimeMs));
    if (outTime > newest) {
      results.push({ id: sn.id, status: "готов (пропущен)", detail: "сборка новее дублей" });
      continue;
    }
  }
  try {
    execFileSync("node", ["engine/assemble_video.mjs", "--id", sn.id, ...extra],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    try {
      execFileSync("node", ["engine/verify_video.mjs", outFile],
        { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
      results.push({ id: sn.id, status: "собран и проверен", detail: outFile });
    } catch {
      results.push({ id: sn.id, status: "собран, НЕ прошёл проверку", detail: outFile });
    }
  } catch (e) {
    results.push({ id: sn.id, status: "ОШИБКА сборки", detail: String(e.message ?? e).slice(0, 200) });
  }
}

console.log("\n=== Утренняя сводка пакета ===");
for (const r of results) console.log(`  ${r.status.padEnd(26)} ${r.id}  ${r.detail}`);
const built = results.filter((r) => r.status.startsWith("собран")).length;
const failed = results.filter((r) => r.status.startsWith("ОШИБКА")).length;
console.log(`Итого: ${results.length} роликов в плане, собрано за ночь: ${built}, ошибок: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
