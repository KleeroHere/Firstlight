#!/usr/bin/env node
// Контрольный лист кадров: N кадров клипа, равномерно по времени, одной
// картинкой-таблицей. Приёмка судит клип по этому листу, не открывая видео.
//
//   node engine/contact_sheet.mjs --clip workspace/takes/<id>/_flf/plan3.mp4 [--n 6] [--out <file>]
//
// Без --out кладёт рядом с клипом как <clip>.sheet.png. Идемпотентен: если
// лист новее клипа, пересборка пропускается (--redo форсирует).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { ffprobeJson } from "./lib.mjs";

function parseArgs(argv) {
  const a = { n: 6, cols: 3 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--clip") a.clip = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--n") a.n = Number(argv[++i]);
    else if (v === "--cols") a.cols = Number(argv[++i]);
    else if (v === "--redo") a.redo = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.clip) throw new Error("Нужен --clip <файл>");
  return a;
}
const args = parseArgs(process.argv);
if (!existsSync(args.clip)) throw new Error(`Нет клипа ${args.clip}`);
const out = args.out ?? `${args.clip}.sheet.png`;

if (existsSync(out) && !args.redo && statSync(out).mtimeMs >= statSync(args.clip).mtimeMs) {
  console.log(out);
  process.exit(0);
}

const dur = Number(ffprobeJson(args.clip).format.duration);
const n = Math.max(1, args.n);
const cols = Math.max(1, Math.min(args.cols, n));
const rows = Math.ceil(n / cols);

const tmp = join(tmpdir(), `fl_sheet_${Date.now()}`);
mkdirSync(tmp, { recursive: true });
try {
  for (let i = 0; i < n; i++) {
    // Кадры равномерно по времени, не с самого края: (i + 0.5) / n от длины.
    const t = Math.max(0, dur * ((i + 0.5) / n));
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", args.clip,
      "-frames:v", "1", "-vf", "scale=320:-2",
      join(tmp, `f${String(i).padStart(2, "0")}.png`),
    ]);
  }
  mkdirSync(dirname(out), { recursive: true });
  // Numbered sequence (image2 demuxer), not -pattern_type glob: glob needs
  // libglob, which most Windows ffmpeg builds do not have.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-start_number", "0", "-i", join(tmp, "f%02d.png"),
    "-frames:v", "1", "-filter_complex", `tile=${cols}x${rows}`,
    out,
  ]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(out);
