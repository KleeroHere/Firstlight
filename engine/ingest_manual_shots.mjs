// Принять опорные кадры, сгенерированные ВРУЧНУЮ в веб-Gemini (29.08.2026).
//
// Решение владельца: опорные кадры девяти последних сценариев генерятся
// руками в веб-интерфейсе — у автоматической генерации многовато брака, а
// квота API уже сожжена (~$40). Конвейер при этом не меняется: этот скрипт
// доводит ручной кадр до того же вида, что делал gemini_shots.mjs.
//
// Порядок работы:
//   1. Сгенерировать кадр по промпту из
//      «workspace/prompts/manual-shots-29-08.md».
//   2. Сохранить картинку как
//      «workspace/takes/<ролик>/_masters/<сцена>_sh1_frame.png»
//      (например s1_sh1_frame.png; png или jpg — jpg будет переконвертирован).
//   3. node engine/ingest_manual_shots.mjs --id <ролик>
//      — сожмёт мастера в рабочие 1280x720 и соберёт контактный лист приёмки.
//
// Идемпотентен: рабочий кадр пересоздаётся, только если мастер новее него
// (пересохранил мастер — прогнал ещё раз, ничего лишнего не трогается).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const idIdx = args.indexOf("--id");
if (idIdx < 0) {
  console.error("Нужно: --id <ролик> (папка в production/takes)");
  process.exit(2);
}
const id = args[idIdx + 1];
const OUT = join("workspace/takes", id);
const MASTERS = join(OUT, "_masters");

if (!existsSync(MASTERS)) {
  console.error(`Нет папки ${MASTERS} — создайте её и положите мастера (см. шапку скрипта).`);
  process.exit(2);
}

// Принимаем любой номер кадра: у сцены их может быть несколько (s3_sh1,
// s3_sh2, s3_sh3 — три разные двери в «Завершении смены»). До 29.08.2026
// фильтр брал только _sh1_frame и молча пропускал остальные.
const masters = readdirSync(MASTERS).filter((f) => /_sh\d+_frame\.(png|jpe?g)$/i.test(f));
if (masters.length === 0) {
  console.error(`В ${MASTERS} нет ни одного файла вида s1_sh1_frame.png.`);
  process.exit(1);
}

let made = 0;
for (const f of masters) {
  const src = join(MASTERS, f);
  const dest = join(OUT, f.replace(/\.(jpe?g)$/i, ".png"));
  if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) continue;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", src, "-vf",
      "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", "-frames:v", "1", dest],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`ffmpeg на ${f}: ${(r.stderr ?? "").split("\n").slice(-2).join(" ")}`);
    process.exit(1);
  }
  console.log(`ок  ${f} → ${dest} (1280x720)`);
  made += 1;
}

console.log(`\nМастеров: ${masters.length}, пересобрано рабочих кадров: ${made}.`);
// Контактный лист — тем же кодом, что и всегда: один источник правды.
execFileSync("node", ["engine/gemini_shots.mjs", "--id", id, "--sheet"], { stdio: "inherit" });
