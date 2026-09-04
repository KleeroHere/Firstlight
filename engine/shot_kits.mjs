#!/usr/bin/env node
// Наборы на кадр: одна папка на кадр, в ней всё нужное и ничего лишнего.
//
//   node engine/shot_kits.mjs --id izmenenie-v-raspisanii
//   node engine/shot_kits.mjs --id razbor-dnevnikov --only s2,s3
//   node engine/shot_kits.mjs --peresyom      # все кадры пересъёма
//
// Зачем. Раньше на один кадр уходило: найти лист Роксаны в «Персонажи для
// видео/_refs», лист Ярослава — в «Готовые иллюстрации/Персонажи», фон — в
// «Готовые иллюстрации/Фоны», скопировать промпт из markdown, а потом
// переименовать «Gemini_Generated_Image_5py4uz…» руками. Восемьдесят
// процентов времени уходило на лазание по папкам.
//
// Теперь: kits/<ролик>/<сцена>/ — там лежат КОПИИ референсов, пронумерованные
// в порядке вложения, промпт текстом и место, куда положить результат.
// Открыть папку, выделить всё, перетащить в Gemini, сохранить ответ сюда же.
// Дальше `collect_shots.mjs` разложит результат по местам сам.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ROOT, loadConfig, loadScenario } from "./lib.mjs";
import { buildPrompt, refFiles, sheetChars, MAX_SHEETS } from "./shot_prompt.mjs";

const cfg = loadConfig();
const REFS = JSON.parse(readFileSync(join(ROOT, "engine/gemini_refs.json"), "utf8")).characters;
const KITS = join(ROOT, "workspace/kits");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--only") a.only = argv[++i].split(",");
    else if (v === "--peresyom") a.peresyom = true;
    else if (v === "--clean") a.clean = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  return a;
}
const args = parseArgs(process.argv);

// Scenes queued for a reshoot, per roll. Production state, not code: it lives
// in workspace/reshoot.json as { "<roll id>": ["s1", "s2b", …] } and is empty
// when the file is missing.
const PERESYOM = (() => {
  const p = join(ROOT, "workspace", "reshoot.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
})();

// Цепочка: сцена -> от какого ПРИНЯТОГО кадра она продолжается (тот же список,
// что в build_regen_doc.py). Принятый кадр прикладывается ПОСЛЕДНИМ вложением:
// нумерация листов не сдвигается, а последняя картинка задаёт пропорции выхода.
const CHAIN = {
  "razbor-dnevnikov": { s2: "s1", s3: "s2", s4: "s3" },
  "ezhednevniki": { s2: "s1", s3b: "s2", s4: "s3b" },
  "priem-novichka-1": { s2a: "s1", s2b: "s2a" },
  // izmenenie-v-raspisanii из пересъёма исключён 30.08: кадры перерисованы
  // владельцем, ролик собран и принят.
  // Волна 4 и новые сценарии (30.08): цепочка размечена только там, где
  // продолжение бесспорно — тот же фон и та же продолжающаяся мизансцена.
  // Фильмотерапия сознательно без цепочки: стулья переставляются между
  // сценами, фраза «сидят на тех же местах» там соврала бы.
  // s6 (круг размыкается) тоже цепочкой: 31.08 старый мастер s6 оказался
  // из другого дня — дневной свет, Гарик в футболке с рукавами, рассадка
  // своя. Финальная сцена обязана быть тем же вечером и тем же кругом.
  "vecherniy-krug": { s3: "s2", s4: "s3", s5a: "s4", s5b: "s5a", s5c: "s5b", s5d: "s5c", s6: "s5d" },
  "priem-zadaniy": { s4a: "s1" },
  "zhurnaly-brakerazha-i-temperatury": { s5: "s3" },
  "zhaloby-na-drugogo-konsultanta": { s2: "s1", s3: "s2", s4a: "s3", s4b: "s4a" },
  "pokidaet-rc": { s2: "s1" },
  "klient-khochet-pokinut-tsentr": { s4: "s2" },
  "peresmenka-1": { s2: "s1", s5b: "s5a" },
  "peresmenka-2": { s3: "s1" },
  "oskorblenie-personala": { s2b: "s1" },
  // Пересъём по приёмке 30.08 (вечер). У «Звонка» s4 принят владельцем —
  // от него цепляются обе соседние сцены той же мизансцены («та же
  // мизансцена» в тексте s4 отсылает к s3). У «Обратной связи» s5 без
  // цепочки: состав круга меняется (Настя вместо Игоря Степановича).
  "itogi-nedeli": { s3: "s2", s4: "s3" },
  "obratnaya-svyaz": { s2: "s1", s3: "s2", s4a: "s3", s4b: "s4a" },
  "zvonok-rodnym": { s3: "s4", s5a: "s4" },
};

const chainNote = (n) =>
  `ЦЕПОЧКА: референс ${n} — принятый кадр предыдущей сцены этого ролика. ` +
  `Комната, свет, мебель, точка съёмки и крупность — точно как на нём; ` +
  `все сидящие сидят на тех же местах и в той же одежде, что на нём. ` +
  `Меняется только действие, описанное в «ГЛАВНОЕ В КАДРЕ»; ` +
  `состав кадра — строго по блоку СОСТАВ.`;

const jobs = args.peresyom
  ? Object.entries(PERESYOM)
  : args.id ? [[args.id, args.only ?? null]] : null;
if (!jobs) throw new Error("Нужен --id <ролик> или --peresyom");

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Имя файла-референса: номер в порядке вложения + человеческая подпись.
// Windows сортирует по имени, поэтому номер впереди — выделив всё в папке,
// человек получает файлы ровно в том порядке, в каком их ждёт промпт.
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, "").trim();

let totalShots = 0;
const pages = [];

for (const [id, only] of jobs) {
  const j = loadScenario(cfg, id);
  const scenes = j.scenes.filter((s) => {
    if (s.kind === "title" || s.kind === "memo" || !s.img) return false;
    if (only && !only.includes(s.id)) return false;
    return true;
  });
  if (scenes.length === 0) { console.log(`${id}: нечего собирать`); continue; }

  const videoDir = join(KITS, id);
  if (args.clean && existsSync(videoDir)) rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  const cards = [];
  for (const sc of scenes) {
    const dir = join(videoDir, sc.id);
    mkdirSync(dir, { recursive: true });

    // 1. Копии референсов, пронумерованные в порядке вложения.
    const files = refFiles(j, sc, REFS);
    const sheets = sheetChars(sc, REFS);
    const labels = sheets.map((c) => j.characters[c].name)
      .concat([`фон ${j.backgrounds[sc.bg].name}`]);
    const copied = [];
    files.forEach((f, i) => {
      const src = join(ROOT, f);
      if (!existsSync(src)) { console.log(`  ! нет референса ${f}`); return; }
      const name = `${i + 1} — ${safe(labels[i] ?? basename(f))}${extname(f)}`;
      copyFileSync(src, join(dir, name));
      copied.push({ name, src: f });
    });

    // 1а. Цепочка: принятый кадр предыдущей сцены — последним вложением.
    let chainWarn = null;
    let prompt = buildPrompt(j, sc, REFS);
    const prev = CHAIN[id]?.[sc.id];
    if (prev) {
      const n = copied.length + 1;
      prompt += "\n\n" + chainNote(n);
      // Принятый кадр ищем в _masters, а у роликов старого макета — в корне.
      const takesDir = join(ROOT, "workspace/takes", id);
      // Мастер владельца приходит из веб-Gemini в jpg и ложится в _masters
      // как есть (31.08: его кадры править запрещено, даже перекодировкой).
      // Берём мастер в первую очередь — он 2K, рабочий кадр в корне 1280x720.
      const master = [
        join(takesDir, "_masters", `${prev}_sh1_frame.png`),
        join(takesDir, "_masters", `${prev}_sh1_frame.jpg`),
        join(takesDir, `${prev}_sh1_frame.png`),
      ].find(existsSync);
      // Если предыдущий кадр сам в этом же пересъёме, его мастер на диске —
      // старый (забракованный): копировать его в набор нельзя, цепочка
      // заякорит весь ролик на брак.
      const prevStale = scenes.some((s) => s.id === prev);
      if (master && !prevStale) {
        const name = `${n} — цепочка, принятый кадр ${prev}${extname(master)}`;
        copyFileSync(master, join(dir, name));
        copied.push({ name, src: master });
      } else {
        chainWarn = `ЦЕПОЧКА: этот кадр делается ПОСЛЕ кадра ${prev}. ` +
          `Сгенерируйте и примите ${prev}, а потом приложите его к этому ` +
          `кадру ПОСЛЕДНИМ (№${n}) вложением — файл у вас под рукой; либо ` +
          `перезапустите shot_kits --id ${id}, и принятый ${prev} сам ` +
          `скопируется в набор`;
      }
    }

    // 2. Промпт текстом — чтобы копировать из файла, а не из markdown.
    writeFileSync(join(dir, "ПРОМПТ.txt"), prompt, "utf8");

    // 3. Куда класть результат: сюда же. Имя файла не важно.
    writeFileSync(join(dir, "СЮДА-СОХРАНИТЬ-РЕЗУЛЬТАТ.txt"),
      `Готовый кадр сохраните в эту же папку.\r\n` +
      `Имя файла не важно — хоть Gemini_Generated_Image_5py4uz.\r\n` +
      `Потом одна команда из корня репозитория:\r\n\r\n` +
      `    node engine/collect_shots.mjs --id ${id}\r\n\r\n` +
      `Она сама переименует файл в ${sc.id}_sh1_frame.png, положит куда надо,\r\n` +
      `сожмёт до рабочих 1280x720 и пересоберёт страницу приёмки.\r\n`, "utf8");

    const warn = (sc.chars ?? []).length > MAX_SHEETS
      ? `в кадре ${sc.chars.length} человек, листов подаётся ${MAX_SHEETS} — ` +
        `последнего добавляйте правкой принятого изображения`
      : null;
    cards.push({ sc, dir, copied, prompt, warn: [warn, chainWarn].filter(Boolean).join("; ") || null });
    totalShots += 1;
  }

  // Страница ролика: промпт с кнопкой «копировать» и превью референсов.
  const rows = cards.map(({ sc, dir, copied, prompt, warn }) => `
<section>
  <h2>${esc(sc.id)} <span class="plate">${esc(sc.plate ?? "")}</span></h2>
  ${warn ? `<p class="warn">${esc(warn)}</p>` : ""}
  <p class="path">папка набора: <code>${esc(dir)}</code></p>
  <div class="refs">${copied.map((c, i) => `
    <figure><img src="${esc(sc.id)}/${encodeURIComponent(c.name)}">
    <figcaption>${i + 1}. ${esc(c.name.replace(/^\d+ — /, ""))}</figcaption></figure>`).join("")}
  </div>
  <button onclick="copyPrompt(this)">Скопировать промпт</button>
  <pre>${esc(prompt)}</pre>
</section>`).join("\n");

  const html = `<!doctype html><meta charset="utf-8">
<title>${esc(j.title)} — наборы на кадр</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#F2E9DC;color:#3a332c;margin:24px;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}
p.lead{color:#7a6b5c;margin:0 0 20px}
section{border-top:1px solid #ddd4c6;padding:18px 0}
h2{font-size:18px;margin:0 0 2px}
.plate{font-weight:400;color:#7a6b5c;font-size:14px}
.path{color:#7a6b5c;font-size:13px;margin:6px 0 10px}
.warn{background:#f6e2d8;border-left:3px solid #D96A5F;padding:8px 10px;margin:8px 0;font-size:13px}
.refs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
figure{margin:0;width:180px}
img{width:180px;border:1px solid #c9bfae;border-radius:4px;display:block}
figcaption{font-size:12px;color:#7a6b5c;margin-top:3px}
button{font:inherit;padding:6px 12px;border:1px solid #c9bfae;background:#fff;border-radius:4px;cursor:pointer}
button:hover{background:#f6efe4}
pre{white-space:pre-wrap;background:#fffdf8;border:1px solid #ddd4c6;border-radius:4px;padding:12px;font-size:13px;line-height:1.45;margin-top:10px}
code{background:#fffdf8;padding:1px 4px;border-radius:3px}
</style>
<h1>${esc(j.title)} — наборы на кадр</h1>
<p class="lead">На каждый кадр своя папка: референсы уже скопированы и
пронумерованы в порядке вложения. Выделить в папке файлы с номерами,
перетащить в Gemini, сюда же нажать «Скопировать промпт». Готовый кадр
сохранить в ту же папку под любым именем, потом одна команда:
<code>node engine/collect_shots.mjs --id ${esc(id)}</code></p>
${rows}
<script>
function copyPrompt(btn){
  const t = btn.parentElement.querySelector("pre").textContent;
  navigator.clipboard.writeText(t).then(() => {
    const was = btn.textContent; btn.textContent = "скопировано";
    setTimeout(() => { btn.textContent = was; }, 1200);
  });
}
</script>`;
  const page = join(videoDir, "index.html");
  writeFileSync(page, html, "utf8");
  pages.push(page);
  console.log(`${id}: наборов ${cards.length} → ${page}`);
}

console.log(`\nВсего кадров: ${totalShots}`);
for (const p of pages) console.log("  " + p);

// Корневой индекс: один вход на все наборы. Пересобирается при каждом
// запуске по фактическому содержимому kits/.
{
  const { readdirSync, statSync } = await import("node:fs");
  const rows = readdirSync(KITS)
    .filter((d) => existsSync(join(KITS, d, "index.html")))
    .map((d) => {
      const scenes = readdirSync(join(KITS, d))
        .filter((s) => statSync(join(KITS, d, s)).isDirectory());
      let title = d;
      try { title = loadScenario(cfg, d).title; } catch {}
      return { d, title, n: scenes.length };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
  const html = `<!doctype html><meta charset="utf-8">
<title>Наборы на кадр — вся серия</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#F2E9DC;color:#3a332c;margin:24px;max-width:760px}
h1{font-size:22px}
a{color:#a4472f}
li{margin:6px 0;font-size:15px}
.n{color:#7a6b5c;font-size:13px}
</style>
<h1>Наборы на кадр — вся серия</h1>
<p>Порядок работы и чек-лист — в шапке каждого ролика. Готовые кадры —
в папку набора или в <code>production/_inbox/</code>, потом
<code>node engine/collect_shots.mjs --id &lt;ролик&gt;</code>.</p>
<ol>${rows.map((r) =>
    `<li><a href="${encodeURIComponent(r.d)}/index.html">${esc(r.title)}</a> <span class="n">(${r.d}, кадров: ${r.n})</span></li>`).join("\n")}
</ol>`;
  writeFileSync(join(KITS, "index.html"), html, "utf8");
  console.log("  " + join(KITS, "index.html"));
}
