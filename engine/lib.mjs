// Общие функции конвейера.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig() {
  const cfg = JSON.parse(
    readFileSync(join(ROOT, "engine", "pipeline.config.json"), "utf8"),
  );
  cfg.font = cfg.fonts.candidates.find((f) => existsSync(f));
  if (!cfg.font) throw new Error("Не найден ни один шрифт из pipeline.config.json fonts.candidates");
  return cfg;
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

// Как run(), но возвращает stdout+stderr (ffmpeg пишет отчёты в stderr).
export function runMerged(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return (res.stdout ?? "") + (res.stderr ?? "");
}

export function ffprobeJson(file) {
  const out = run("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", file,
  ]);
  return JSON.parse(out);
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

// drawtext через textfile — обходит все проблемы экранирования кириллицы.
let textFileCounter = 0;
export function textFile(buildDir, text) {
  ensureDir(buildDir);
  const p = join(buildDir, `text_${String(textFileCounter++).padStart(3, "0")}.txt`);
  writeFileSync(p, text, "utf8");
  return p;
}

// Путь внутри filtergraph: прямые слэши, экранированные двоеточия.
export function fpath(p) {
  return p.replaceAll("\\", "/").replaceAll(":", "\\:");
}

export function sanitizeName(s) {
  return s.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();
}

export function loadScenario(cfg, id) {
  const p = join(ROOT, cfg.paths.compiled, `${id}.json`);
  if (!existsSync(p)) {
    throw new Error(`Нет компилята ${p} — запусти python engine/build_prompts.py`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function sceneDuration(sc) {
  return sc.t[1] - sc.t[0];
}
