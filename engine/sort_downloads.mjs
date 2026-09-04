#!/usr/bin/env node
// Разбор папки загрузок по сценам ролика — чтобы человек ничего не
// переименовывал руками.
//
//   node engine/sort_downloads.mjs --id <id> [опции]
//
// Контракт (рабочий-процесс.md): за одну сессию скачиваются дубли ОДНОГО
// ролика, строго в порядке листа промптов, по одному файлу на сцену
// (только выбранный дубль). Скрипт берёт свежие видео/картинки из папки
// загрузок в порядке времени скачивания и раскладывает их по недостающим
// сценам ролика: takes/<id>/<сцена>_take<N>.<расширение>.
//
// Опции:
//   --id <id>          id сценария (обязательно)
//   --downloads <dir>  папка загрузок (по умолчанию: конфиг paths.downloads,
//                      иначе ~/Downloads)
//   --since <часов>    брать файлы не старше N часов (по умолчанию 12)
//   --scene <sN>       перегенерация: самый свежий подходящий файл — в эту
//                      сцену (новым дублем), остальные файлы не трогаются
//   --dry-run          показать раскладку, ничего не перемещать
//
// Если число свежих файлов не совпадает с числом недостающих сцен — скрипт
// ничего не делает и объясняет, чего не хватает или что лишнее. Все
// перемещения пишутся в takes/<id>/sort-log.json (откуда и куда).
import {
  copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { ROOT, ensureDir, loadConfig, loadScenario } from "./lib.mjs";

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

function parseArgs(argv) {
  const a = { sinceHours: 12 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--downloads") a.downloads = argv[++i];
    else if (v === "--since") a.sinceHours = Number(argv[++i]);
    else if (v === "--scene") a.scene = argv[++i];
    else if (v === "--dry-run") a.dryRun = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id <id сценария>");
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const sn = loadScenario(cfg, args.id);
const takesDir = join(ROOT, cfg.paths.takes, args.id);
const downloadsDir = args.downloads ??
  (cfg.paths.downloads ? join(ROOT, cfg.paths.downloads) : join(homedir(), "Downloads"));
if (!existsSync(downloadsDir)) {
  throw new Error(`Папка загрузок не найдена: ${downloadsDir} (задай --downloads)`);
}

// Сцены ролика, требующие дублей, в порядке сценария.
const sceneIds = sn.scenes
  .filter((s) => (s.kind ?? "scene") === "scene")
  .map((s) => s.id);

function existingTakes(sceneId) {
  if (!existsSync(takesDir)) return [];
  const rx = new RegExp(`^${sceneId}_take(\\d+)\\.`, "i");
  return readdirSync(takesDir)
    .map((f) => f.match(rx))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

// Свежие кандидаты из загрузок, по времени скачивания (старые — раньше).
const cutoff = Date.now() - args.sinceHours * 3600 * 1000;
const candidates = readdirSync(downloadsDir)
  .filter((f) => {
    const ext = extname(f).toLowerCase();
    if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) return false;
    if (f.endsWith(".crdownload") || f.endsWith(".part")) return false;
    return true;
  })
  .map((f) => ({ file: join(downloadsDir, f), name: f, mtime: statSync(join(downloadsDir, f)).mtimeMs }))
  .filter((c) => c.mtime >= cutoff)
  .sort((a, b) => a.mtime - b.mtime);

let plan = []; // { from, sceneId, takeN }

if (args.scene) {
  if (!sceneIds.includes(args.scene)) {
    throw new Error(`Сцены ${args.scene} нет в ролике ${args.id}. Есть: ${sceneIds.join(", ")}`);
  }
  if (candidates.length === 0) {
    throw new Error(`В ${downloadsDir} нет свежих видео/картинок (за последние ${args.sinceHours} ч)`);
  }
  const newest = candidates.at(-1);
  const n = Math.max(0, ...existingTakes(args.scene)) + 1;
  plan.push({ from: newest, sceneId: args.scene, takeN: n });
} else {
  const missing = sceneIds.filter((id) => existingTakes(id).length === 0);
  if (missing.length === 0) {
    console.log(`У ролика «${sn.title}» дубли всех сцен уже на месте (${takesDir}).`);
    console.log("Для замены отдельной сцены: --scene <id сцены>.");
    process.exit(0);
  }
  if (candidates.length !== missing.length) {
    console.error(`Не сходится счёт — ничего не перемещаю.`);
    console.error(`Недостающие сцены (${missing.length}): ${missing.join(", ")}`);
    console.error(`Свежих файлов в загрузках (${candidates.length}):`);
    for (const c of candidates) console.error(`  ${new Date(c.mtime).toLocaleTimeString()}  ${c.name}`);
    console.error(candidates.length < missing.length
      ? "Докачай недостающие сцены по порядку листа и запусти снова."
      : "Лишние файлы убери из загрузок (или сузь окно: --since 2) и запусти снова.");
    process.exit(1);
  }
  plan = candidates.map((c, i) => ({ from: c, sceneId: missing[i], takeN: 1 }));
}

ensureDir(takesDir);
const logPath = join(takesDir, "sort-log.json");
const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];

console.log(`Ролик «${sn.title}» (${args.id}), загрузки: ${downloadsDir}`);
for (const p of plan) {
  const ext = extname(p.from.name).toLowerCase().replace(".jpeg", ".jpg");
  const target = join(takesDir, `${p.sceneId}_take${p.takeN}${ext}`);
  const kind = IMAGE_EXT.has(ext) ? "статичный кадр" : "видео";
  console.log(`  ${p.from.name}  →  ${basename(target)}  (${kind})`);
  if (!args.dryRun) {
    copyFileSync(p.from.file, target); // копия+удаление: переживает разные диски
    unlinkSync(p.from.file);
    log.push({
      at: new Date().toISOString(), from: p.from.name, to: basename(target),
      downloadedAt: new Date(p.from.mtime).toISOString(),
    });
  }
}
if (args.dryRun) {
  console.log("(--dry-run: ничего не перемещено)");
} else {
  writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  console.log(`Готово. Журнал: ${logPath}`);
  console.log(`Дальше: node engine/assemble_video.mjs --id ${args.id}`);
}
