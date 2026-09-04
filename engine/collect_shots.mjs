#!/usr/bin/env node
// Разбор готовых кадров: из наборов и из инбокса — по местам, без ручного
// переименования.
//
//   node engine/collect_shots.mjs --id izmenenie-v-raspisanii
//   node engine/collect_shots.mjs --id razbor-dnevnikov --dry
//
// Три способа отдать кадр, любой на выбор:
//
// 1. Сохранить в папку набора kits/<ролик>/<сцена>/ под ЛЮБЫМ именем —
//    папка и есть имя сцены, гадать не о чем. Самый надёжный путь.
// 2. Бросить в общий инбокс production/_inbox/, назвав файл так, чтобы в
//    имени была сцена: «s2», «s2.png», «s2 второй дубль.png». Достаточно
//    напечатать два символа в диалоге сохранения.
// 3. Бросить в инбокс как есть, «Gemini_Generated_Image_5py4uz.png». Тогда
//    файлы раскладываются по недостающим кадрам В ПОРЯДКЕ ВРЕМЕНИ создания
//    — но только если число файлов совпадает с числом недостающих кадров.
//    Иначе скрипт ничего не трогает и объясняет, что не сошлось.
//
// Дальше вызывается тот же интейк, что и всегда: кадр приводится к рабочим
// 1280x720 и пересобирается страница приёмки.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import { ROOT, loadConfig, loadScenario } from "./lib.mjs";

const cfg = loadConfig();
const KITS = join(ROOT, "workspace/kits");
const INBOX = join(ROOT, "workspace/_inbox");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--dry") a.dry = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id");
  return a;
}
const args = parseArgs(process.argv);

const IMG = /\.(png|jpe?g|webp)$/i;
// Файлы самого набора: пронумерованные референсы и текстовые памятки.
const isKitFile = (f) => /^\d+ — /.test(f) || /\.txt$/i.test(f);

const j = loadScenario(cfg, args.id);
const takesDir = join(ROOT, cfg.paths.takes, args.id);
const mastersDir = join(takesDir, "_masters");
mkdirSync(mastersDir, { recursive: true });
mkdirSync(INBOX, { recursive: true });

const sceneIds = j.scenes
  .filter((s) => (s.kind ?? "scene") === "scene" && s.img)
  .map((s) => s.id);

// Имя мастера для сцены: первый кадр сцены. Дополнительные кадры («s3_sh2»)
// приходят через инбокс — там имя файла задаёт кадр напрямую.
const masterName = (scene, ext) => `${scene}_frame${ext}`;
const targetFor = (sceneId) => `${sceneId}_sh1`;

const moved = [];
const problems = [];

// ---------- 1. Наборы: папка = сцена ---------------------------------------
for (const sceneId of sceneIds) {
  const dir = join(KITS, args.id, sceneId);
  if (!existsSync(dir)) continue;
  const found = readdirSync(dir).filter((f) => IMG.test(f) && !isKitFile(f));
  if (found.length === 0) continue;
  if (found.length > 1) {
    // Несколько дублей — берём самый свежий, остальные оставляем на месте.
    found.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    problems.push(`${sceneId}: в наборе ${found.length} картинок, беру самую свежую (${found[0]})`);
  }
  const src = join(dir, found[0]);
  const dest = join(mastersDir, masterName(targetFor(sceneId), extname(found[0]).toLowerCase()));
  moved.push({ from: src, to: dest, how: "набор" });
}

// ---------- 2. Инбокс: сцена в имени файла ---------------------------------
const inboxFiles = existsSync(INBOX)
  ? readdirSync(INBOX).filter((f) => IMG.test(f))
    .map((f) => ({ f, t: statSync(join(INBOX, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
  : [];

const claimed = new Set(moved.map((m) => basename(m.to)));
const leftovers = [];
for (const { f } of inboxFiles) {
  // Дополнительный кадр сцены («s3_sh2») — в компиляте его нет, но имя файла
  // задаёт его однозначно. Такие кадры есть в пересъёме 29.08: три двери в
  // ночной смене, пробуждение дежурного, кастрюля на столе.
  const direct = f.match(/(^|[^a-z0-9])(s[a-z0-9]+_sh\d+)([^a-z0-9]|$)/i);
  if (direct) {
    const dest = join(mastersDir, `${direct[2].toLowerCase()}_frame${extname(f).toLowerCase()}`);
    if (claimed.has(basename(dest))) {
      problems.push(`${f}: кадр ${direct[2]} уже пришёл, файл оставлен в инбоксе`);
      continue;
    }
    claimed.add(basename(dest));
    moved.push({ from: join(INBOX, f), to: dest, how: "инбокс, кадр назван прямо" });
    continue;
  }
  // Иначе — самый длинный подходящий id сцены: s2b выигрывает у s2.
  const hit = sceneIds
    .filter((id) => new RegExp(`(^|[^a-z0-9])${id}([^a-z0-9]|$)`, "i").test(f))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) { leftovers.push(f); continue; }
  const dest = join(mastersDir, masterName(targetFor(hit), extname(f).toLowerCase()));
  if (claimed.has(basename(dest))) {
    problems.push(`${f}: кадр ${hit} уже пришёл из набора, файл оставлен в инбоксе`);
    continue;
  }
  claimed.add(basename(dest));
  moved.push({ from: join(INBOX, f), to: dest, how: "инбокс по имени" });
}

// ---------- 3. Инбокс: по порядку, если число сходится ----------------------
if (leftovers.length > 0) {
  const pending = sceneIds.filter((id) =>
    !claimed.has(`${targetFor(id)}_frame.png`) &&
    !claimed.has(`${targetFor(id)}_frame.jpg`) &&
    !existsSync(join(mastersDir, `${targetFor(id)}_frame.png`)) &&
    !existsSync(join(mastersDir, `${targetFor(id)}_frame.jpg`)));
  if (leftovers.length === pending.length && pending.length > 0) {
    leftovers.forEach((f, i) => {
      const dest = join(mastersDir, masterName(targetFor(pending[i]), extname(f).toLowerCase()));
      moved.push({ from: join(INBOX, f), to: dest, how: "инбокс по порядку" });
    });
  } else {
    problems.push(
      `в инбоксе ${leftovers.length} файлов без имени сцены, а недостающих кадров ` +
      `${pending.length} — по порядку разложить нельзя, ничего не трогаю. ` +
      `Допишите в имя файла сцену (например «s2») и запустите снова.`);
    problems.push(`  файлы: ${leftovers.join(", ")}`);
    if (pending.length) problems.push(`  ждут кадра: ${pending.join(", ")}`);
  }
}

// ---------- перекладка ------------------------------------------------------
if (moved.length === 0) {
  console.log("Новых кадров не нашлось.");
} else {
  console.log(args.dry ? "СУХОЙ ПРОГОН:" : "Разложено:");
  for (const m of moved) {
    console.log(`  ${basename(m.from)}  →  _masters/${basename(m.to)}   (${m.how})`);
    if (args.dry) continue;
    // Старый мастер с другим расширением убираем в брак: иначе интейк
    // возьмёт его вместо нового по алфавиту.
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      const old = m.to.replace(/\.[^.]+$/, ext);
      if (old !== m.to && existsSync(old)) {
        const rej = join(takesDir, "_rejected");
        mkdirSync(rej, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        renameSync(old, join(rej, `${basename(old, ext)}_do-${stamp}${ext}`));
        console.log(`    прежний ${basename(old)} → _rejected/`);
      }
    }
    copyFileSync(m.from, m.to);
    renameSync(m.from, m.from + ".принято");
  }
}

for (const p of problems) console.log("  ! " + p);

if (!args.dry && moved.length > 0) {
  console.log("\nИнтейк:");
  const r = spawnSync("node", [join("engine", "ingest_manual_shots.mjs"), "--id", args.id],
    { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
