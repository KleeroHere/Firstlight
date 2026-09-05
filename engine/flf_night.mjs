#!/usr/bin/env node
// Ночной прогон: очередь роликов через конвейер FLF2V без участия человека.
//
//   node engine/flf_night.mjs --host https://<pod>-8188.proxy.runpod.net \
//        --ids fog-signal-check,opening-the-office
//
// Для каждого ролика по порядку: батч клипов → автоприёмка клипов →
// сборка с --prefer-takes → приёмка ролика. Всё пишется в
// reports/night-24-08.md по ходу, чтобы утром было видно, что случилось.
//
// Устойчивость: ролик без готовых ключей пропускается; падение одного
// ролика не роняет очередь; перед каждым роликом проверяется, жив ли
// ComfyUI (если нет — ждём до 10 минут, потом пропускаем ролик).
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";

function parseArgs(argv) {
  const a = { host: "http://127.0.0.1:8188", ids: [] };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--host") a.host = argv[++i].replace(/\/$/, "");
    else if (v === "--ids") a.ids = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--report") a.report = argv[++i];
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.ids.length) throw new Error("Нужен --ids id1,id2");
  return a;
}
const args = parseArgs(process.argv);
const cfg = loadConfig();
const REPORT = join(ROOT, args.report ?? "reports/night-24-08.md");
mkdirSync(join(ROOT, "reports"), { recursive: true });

const stamp = () => new Date().toISOString().slice(11, 19);
function log(line) {
  console.log(line);
  appendFileSync(REPORT, line + "\n", "utf8");
}
function run(script, extra) {
  const r = spawnSync(process.execPath, [join(ROOT, "engine", script), ...extra],
    { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}
async function comfyAlive() {
  try {
    const r = await fetch(`${args.host}/system_stats`, { signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch { return false; }
}
// Сторож: ComfyUI за ночь падает (23.08 упал между роликами и увёл очередь
// в бесконечное ожидание). Поднимаем его сами через Jupyter на поде.
function restartComfy() {
  const cmd = "cd /ComfyUI && nohup python3 main.py --listen --enable-cors-header '*' " +
    "--use-sage-attention --extra-model-paths-config /ComfyUI/extra_model_paths.yaml " +
    "> /workspace/comfyui_restart.log 2>&1 &";
  const r = spawnSync(process.execPath, [join(ROOT, "engine/pod_exec.mjs"), cmd, "90"],
    { encoding: "utf8", cwd: ROOT });
  return r.status === 0;
}
async function ensureComfy(label) {
  if (await comfyAlive()) return true;
  log(`- ${stamp()} ${label}: ComfyUI молчит, поднимаю`);
  restartComfy();
  for (let i = 0; i < 20; i++) {
    await new Promise((s) => setTimeout(s, 30000));
    if (await comfyAlive()) { log(`- ${stamp()} ComfyUI поднялся`); return true; }
    if (i === 9) { log(`- ${stamp()} вторая попытка перезапуска`); restartComfy(); }
  }
  return false;
}

log(`\n## Прогон ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);

for (const id of args.ids) {
  const t0 = Date.now();
  log(`### ${id}`);

  const spec = join(ROOT, "workspace", "plans", `${id}.json`);
  if (!existsSync(spec)) { log(`- ✗ нет план-листа, пропуск\n`); continue; }
  const plans = JSON.parse(readFileSync(spec, "utf8")).plans;
  const keysDir = join(ROOT, cfg.paths.takes, id, "keys");
  const missing = plans.filter((p) => !p.ready && !existsSync(join(keysDir, `plan${p.plan}_key.png`)));
  if (missing.length) {
    log(`- ✗ нет ключей для планов ${missing.map((p) => p.plan).join(", ")} — пропуск\n`);
    continue;
  }

  if (!(await ensureComfy(id))) { log(`- ✗ ComfyUI не поднялся, пропуск ролика\n`); continue; }

  // Батч гоняем до двух раз: готовые клипы он пропускает, так что второй
  // заход доделывает ровно то, что не успело до падения сервера.
  for (let pass = 1; pass <= 2; pass++) {
    log(`- ${stamp()} батч (${plans.length} планов${pass > 1 ? ", добор после сбоя" : ""})`);
    const batch = run("flf_batch.mjs", ["--id", id, "--host", args.host]);
    for (const l of batch.out.split("\n").filter(Boolean)) log(`      ${l}`);
    const flfDir = join(ROOT, cfg.paths.takes, id, "_flf");
    const missing = plans.filter((p) => !existsSync(join(flfDir, `plan${p.plan}.mp4`)));
    if (!missing.length) break;
    log(`- ⚠ не хватает клипов: ${missing.map((p) => p.plan).join(", ")}`);
    if (pass === 1 && !(await ensureComfy(id))) break;
  }

  const verify = run("flf_verify.mjs", ["--id", id]);
  const fails = verify.out.split("\n").filter((l) => l.includes("❌"));
  const warns = verify.out.split("\n").filter((l) => l.includes("⚠"));
  log(`- ${stamp()} приёмка клипов: ${verify.out.split("\n").pop()}`);
  for (const l of [...fails, ...warns]) log(`      ${l.trim()}`);

  const asm = run("assemble_video.mjs", ["--id", id, "--prefer-takes"]);
  const asmLine = asm.out.split("\n").find((l) => l.includes("Хронометраж")) ?? asm.out.split("\n").pop();
  if (!asm.ok) { log(`- ✗ сборка упала: ${asm.out.slice(-400)}\n`); continue; }
  log(`- ${stamp()} сборка: ${asmLine}`);

  const outFile = asm.out.split("\n").find((l) => l.includes("Собрано:"))?.split("Собрано:")[1]?.trim();
  if (outFile) {
    const vv = run("verify_video.mjs", [outFile]);
    log(`- ${stamp()} приёмка ролика: ${vv.out.split("\n").filter(Boolean).pop()}`);
  }
  log(`- готово за ${Math.round((Date.now() - t0) / 60000)} мин\n`);
}

log(`Очередь пройдена ${stamp()}.\n`);
