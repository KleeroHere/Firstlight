#!/usr/bin/env node
// Синтетические дубли сцен для обкатки конвейера без генерации.
//
//   node engine/make_synthetic_takes.mjs --id fog-signal-check
//
// Для каждой генерируемой сцены сценария создаёт клип-заглушку
// (движущийся тестовый градиент с подписью сцены) НАМЕРЕННО в чужом
// формате — 1280×720, 24 fps, 8 секунд, — чтобы проверить нормализацию,
// дотяжку стоп-кадром и тримминг в assemble_video.mjs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig, loadScenario, ensureDir, textFile, fpath } from "./lib.mjs";

const idArg = process.argv.indexOf("--id");
if (idArg === -1) {
  console.error("Использование: node engine/make_synthetic_takes.mjs --id <id>");
  process.exit(2);
}
const id = process.argv[idArg + 1];
const cfg = loadConfig();
const sn = loadScenario(cfg, id);
const takesDir = join(ROOT, cfg.paths.takes, id);
ensureDir(takesDir);
const F = fpath(cfg.font);

let n = 0;
for (const sc of sn.scenes) {
  if ((sc.kind ?? "scene") !== "scene") continue;
  const out = join(takesDir, `${sc.id}_take1.mp4`);
  const tf = fpath(textFile(takesDir, `SYNTH ${sn.id} ${sc.id}`));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=8",
    "-vf",
    `drawtext=fontfile='${F}':textfile='${tf}':fontsize=64:fontcolor=white:` +
    "x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.55:boxborderw=18",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", out],
  { stdio: ["ignore", "inherit", "inherit"] });
  n++;
}
// Опорные кадры к синтетике: первый и последний кадр каждого дубля под теми
// же именами, что даёт генерация (sN_sh1_frame.png / sN_sh2_frame.png). Без них
// экран приёмки на примере пуст, а проверить его хочется без ключей и GPU.
for (const sc of sn.scenes) {
  if ((sc.kind ?? "scene") !== "scene") continue;
  const take = join(takesDir, `${sc.id}_take1.mp4`);
  if (!existsSync(take)) continue;
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", take,
    "-frames:v", "1", join(takesDir, `${sc.id}_sh1_frame.png`)]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-sseof", "-0.2", "-i", take,
    "-frames:v", "1", "-update", "1", join(takesDir, `${sc.id}_sh2_frame.png`)]);
}

console.log(`Создано ${n} синтетических дублей в ${takesDir}`);
