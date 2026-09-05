#!/usr/bin/env node
// Приёмка КЛЮЧЕЙ FLF2V: страница «старт → финиш» по каждому плану.
//
//   node engine/keys_sheet.mjs --id fog-signal-check
//
// Зачем. У опорных кадров приёмка есть (priemka.html), у ключей не было:
// они уезжали в съёмку вслепую, и брак вылезал уже в собранном ролике —
// после часов на поде. Практика показала, что половина замечаний по
// приёмке («не тот цвет одежды вернулся», «фон снова другой», «персонаж
// снова не на своём месте») видна прямо на паре старт-финиш, до всякой
// генерации видео.
//
// Страница кладётся в takes/<ролик>/keys-priemka.html. Рядом с каждой парой
// напечатан текст правки — если ключ забраковали, этим же текстом его можно
// перерисовать руками в веб-Gemini и положить файл на место: скрипт
// flf_keys.mjs готовые ключи не трогает.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { ROOT, loadConfig } from "./lib.mjs";

const id = process.argv[process.argv.indexOf("--id") + 1];
if (!id) { console.error("Нужен --id"); process.exit(2); }

const cfg = loadConfig();
const spec = JSON.parse(readFileSync(
  join(ROOT, "workspace", "plans", `${id}.json`), "utf8"));
const takesDir = join(ROOT, cfg.paths.takes, id);

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Путь для <img>: относительно самой страницы, чтобы файл открывался
// двойным кликом из проводника, без сервера.
const rel = (abs) => relative(takesDir, abs).replace(/\\/g, "/");

// Картинка разницы. Без неё приёмка ключей ловит только грубое: на странице
// ключ шириной 500 пикселей, и свитер от рубашки на пуговицах не отличить —
// именно так 30.08 проехал переодетый персонаж. Усиленная разница показывает
// ровно то, что изменилось между стартом и финишем: всё, кроме заявленного в
// правке, должно быть чёрным.
const diffDir = join(takesDir, "keys", "diff");
mkdirSync(diffDir, { recursive: true });
function makeDiff(k0, k1, out) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", k0, "-i", k1,
    "-filter_complex",
    "[0:v]scale=1280:720,setsar=1[a];[1:v]scale=1280:720,setsar=1[b];" +
    "[a][b]blend=all_mode=difference,format=gray,eq=contrast=3.2:brightness=0.06",
    "-frames:v", "1", out], { encoding: "utf8" });
  return r.status === 0;
}

let missing = 0;
const rows = spec.plans.map((p) => {
  const k0 = join(takesDir, p.master);
  const k1 = join(takesDir, "keys", `plan${p.plan}_key.png`);
  const has0 = existsSync(k0);
  const has1 = existsSync(k1);
  if (!has1) missing += 1;
  const diff = join(diffDir, `plan${p.plan}.png`);
  const hasDiff = has0 && has1 && makeDiff(k0, k1, diff);
  const cell = (path, ok, label) => ok
    ? `<figure><img src="${esc(rel(path))}"><figcaption>${label}</figcaption></figure>`
    : `<div class="net">нет файла<br><code>${esc(rel(path))}</code></div>`;
  const sec = p.cycle
    ? `${(2 * (8 * Math.max(1, Math.round((p.frames / 2 - 1) / 8)) + 1) / 16).toFixed(1)} с, цикл`
    : `${(p.frames / 16).toFixed(1)} с`;
  return `<tr>
  <td class="meta">
    <div class="id">план ${p.plan}</div>
    <div class="sub">сцена ${esc(p.scene)} · ${sec}</div>
    <div class="txt"><b>правка:</b> ${esc(p.edit)}</div>
    <div class="txt en"><b>движение:</b> ${esc(p.motion)}</div>
    <ul class="chk">
      <li>на финише те же люди, что на старте — никто не пришёл и не исчез</li>
      <li>одежда и лица не поменялись, ничего не перешло от одного к другому</li>
      <li>изменилось РОВНО то, что написано в правке, и больше ничего</li>
      <li>мебель на местах, в воздухе ничего не висит, лишних кистей нет</li>
      <li>если кто-то уходит — на финише он дальше от камеры, а не ближе</li>
      <li>на картинке «что изменилось» светится ТОЛЬКО то, что названо в правке:
          светящийся силуэт целиком — переоделся или сменил причёску</li>
    </ul>
  </td>
  <td class="img">${cell(k0, has0, "старт (К0)")}</td>
  <td class="img">${cell(k1, has1, "финиш (К1)")}</td>
  <td class="img">${cell(diff, hasDiff, "что изменилось")}</td>
</tr>`;
}).join("\n");

const html = `<!doctype html><meta charset="utf-8">
<title>${esc(id)} — приёмка ключей</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#F2E9DC;color:#3a332c;margin:24px;max-width:1500px}
h1{font-size:22px;margin:0 0 4px}
p.lead{color:#7a6b5c;margin:0 0 18px}
table{border-collapse:collapse;width:100%}
td{vertical-align:top;padding:12px;border-bottom:1px solid #ddd4c6}
td.meta{width:380px}
td.img{width:430px}
img{width:410px;border:1px solid #c9bfae;border-radius:4px;display:block}
figcaption{color:#7a6b5c;font-size:12px;margin-top:4px}
.id{font-weight:700;font-size:17px}
.sub{color:#7a6b5c;margin:2px 0 8px}
.txt{margin-bottom:8px;font-size:13px;line-height:1.45}
.en{color:#6b5f52}
.chk{margin:8px 0 0;padding-left:18px;color:#5c5045;font-size:13px}
.chk li{margin:3px 0}
.net{padding:24px;border:1px dashed #c9bfae;border-radius:4px;color:#a33;font-size:13px}
</style>
<h1>${esc(spec.id ?? id)} — приёмка ключей FLF2V</h1>
<p class="lead">Слева старт клипа, справа финиш. Между ними Wan рисует движение:
что не так на этой паре, в видео станет только хуже. Брак — перерисовать ключ
(<code>flf_keys.mjs --id ${esc(id)} --only &lt;план&gt;</code>) либо нарисовать
руками текстом правки и положить файл в <code>keys/plan&lt;N&gt;_key.png</code>.</p>
<table>${rows}</table>`;

const dest = join(takesDir, "keys-priemka.html");
writeFileSync(dest, html, "utf8");
console.log(`Приёмка ключей: ${dest}`);
console.log(`Планов: ${spec.plans.length}, ключей не хватает: ${missing}`);
