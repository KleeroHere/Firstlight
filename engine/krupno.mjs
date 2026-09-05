#!/usr/bin/env node
// Крупный план одного человека для добора сцены до длины озвучки.
//
//   $env:GEMINI_API_KEY="..." ; node engine/krupno.mjs \
//     --id fog-signal-check --scene s1 --char mara --shot 2 \
//     --beat "правая ладонь прижата к груди, он говорит" --emotion "пояснение"
//
// Зачем. Длительность сцены задаёт озвучка, а клип FLF2V — это ровно 5
// секунд. Где планов не хватило, сборщик держал последний кадр: по всей
// серии набирались такие дыры, до нескольких секунд стоп-кадра в сцене.
// Закрывать их крупными планами надёжнее: Gemini почти не ошибается, когда
// в кадре один человек, и на каждого есть лист «диалоговые выражения лица»
// — несколько портретов крупно.
//
// Порядок вложений: сначала лист лица (справочник), последним — кадр сцены.
// Последняя картинка задаёт пропорции выхода, а сцена как раз 16:9; лист
// почти всегда другой формы, и если поставить его последним, кадр выйдет
// не той формы (см. reports/research-nano-banana-30-08.md).
//
// Мастер кладётся в takes/<id>/_masters/<сцена>_sh<N>_frame.png. Рабочий
// кадр 1280x720 из него делает ingest_manual_shots.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, loadConfig, loadScenario } from "./lib.mjs";
import { ledger, price, BudgetExceeded } from "./spend.mjs";

const argv = process.argv;
const arg = (n, d = null) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };

const id = arg("--id");
const scene = arg("--scene");
const charKey = arg("--char");
const shot = Number(arg("--shot", "2"));
const beat = arg("--beat", "");
const emotion = arg("--emotion", "");
const plan = arg("--plan", "");           // погрудный | поясной | лицо
const SIZE = arg("--size", "1K");
const DRY = argv.includes("--dry");
if (!id || !scene || !charKey) {
  console.error("Нужно: --id <ролик> --scene <сцена> --char <персонаж> [--shot N] [--beat ...] [--emotion ...]");
  process.exit(2);
}

const cfg = loadConfig();
const j = loadScenario(cfg, id);
const ch = j.characters[charKey];
if (!ch) { console.error(`Нет персонажа ${charKey} в ${id}`); process.exit(2); }

// Лист лица: «диалоговые выражения» — то, что нужно для крупного плана.
// Ростовые листы не годятся: лицо на них мелкое, и модель его домысливает.
// Карту листов строит face_refs_index.py (в series.yaml лежат только имена
// файлов, а сами файлы разбросаны по папкам персонажей).
const FACES = JSON.parse(readFileSync(join(ROOT, "engine/face_refs.json"), "utf8"));
const faceRefs = FACES[charKey]?.refs ?? {};
const refKey = ["dialog", "emotions", "portrait2", "base"].find((k) => faceRefs[k]);
if (!refKey) { console.error(`У ${charKey} нет листа с лицами — прогоните face_refs_index.py`); process.exit(2); }
const sheetPath = join(ROOT, faceRefs[refKey]);
if (!existsSync(sheetPath)) { console.error(`Лист не найден: ${sheetPath}`); process.exit(2); }

const takes = join(ROOT, cfg.paths.takes, id);
const master = ["_masters/" + scene + "_sh1_frame.jpg", "_masters/" + scene + "_sh1_frame.png",
                scene + "_sh1_frame.png"].map((p) => join(takes, p)).find(existsSync);
if (!master) { console.error(`Нет опорного кадра сцены ${scene} в ${takes}`); process.exit(2); }

const KADR = { "поясной": "поясной план: голова, плечи и корпус до пояса",
               "лицо": "крупный план лица: голова и плечи занимают кадр" };
const framing = KADR[plan] ?? "погрудный план: голова, плечи и грудь занимают кадр";

const instruction = [
  "Сделай КРУПНЫЙ ПЛАН одного человека для того же обучающего рисованного видео.",
  "",
  "РЕФЕРЕНСЫ: первая картинка — лист выражений лица этого персонажа, справочник " +
  "лица, а не сцена: та же форма головы, тот же нос, те же глаза, та же причёска, " +
  "та же растительность на лице. Вторая картинка — кадр сцены: из неё берутся " +
  "комната, свет, стиль рисунка и одежда.",
  "",
  `В КАДРЕ: ровно ОДИН человек и больше никого — ${ch.passport}. Это тот же самый ` +
  `человек, что на второй картинке. ${framing}.` +
  (beat ? ` ${beat[0].toUpperCase()}${beat.slice(1)}.` : "") +
  (emotion ? ` Выражение лица — «${emotion}» с листа.` : ""),
  "",
  "ФОН: та же комната, что на второй картинке, за его спиной — та же стена и та " +
  "же обстановка, крупнее и мягче, чем на общем плане. Других людей в кадре нет: " +
  "камера подошла вплотную, и они остались за границами кадра.",
  "",
  "Ни одной лишней руки, ни одного лишнего человека, ни одной надписи. Тот же " +
  "стиль: тонкий тёмный контур, бледная акварельная заливка. Горизонтальный кадр 16:9.",
].join("\n");

if (DRY) { console.log(instruction); process.exit(0); }

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("Нет GEMINI_API_KEY"); process.exit(2); }
const money = ledger();
try { money.check(price(SIZE)); }
catch (e) { if (e instanceof BudgetExceeded) { console.error(`СТОП. ${e.message}`); process.exit(1); } throw e; }

const mime = (p) => (/\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png");
const body = {
  contents: [{ parts: [
    { text: instruction },
    { inline_data: { mime_type: mime(sheetPath), data: readFileSync(sheetPath).toString("base64") } },
    { inline_data: { mime_type: mime(master), data: readFileSync(master).toString("base64") } },
  ] }],
  generationConfig: {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio: "16:9", imageSize: SIZE },
    thinkingConfig: { thinkingLevel: "high" },
  },
};

const API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent";
let img = null;
for (let attempt = 1; attempt <= 3 && !img; attempt++) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 15000)); continue; }
  if (!r.ok) { console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const jr = await r.json();
  const part = jr.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) { console.error(`нет изображения (${jr.candidates?.[0]?.finishReason ?? "?"})`); process.exit(1); }
  img = Buffer.from(part.inlineData.data, "base64");
}
if (!img) { console.error("3 попытки исчерпаны"); process.exit(1); }

const out = join(takes, "_masters", `${scene}_sh${shot}_frame.png`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, img);
money.charge("krupno", id, SIZE);
console.log(`готово: ${out}`);
console.log(money.line());
