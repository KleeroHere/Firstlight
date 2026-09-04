#!/usr/bin/env node
// Точечная правка готового опорного кадра через Gemini Image.
//
//   $env:GEMINI_API_KEY="..." ; node engine/fix_shot.mjs \
//     --in  "путь/кадр.jpg" --out "путь/кадр.png" --instr-file правка.txt [--size 2K]
//
// Зачем отдельный скрипт (31.08.2026). Владелец генерит опорные кадры руками
// в веб-Gemini. Когда во всей пачке повторяется ОДИН системный дефект —
// например модель дорисовала в холл диван, которого нет на референсе фона, —
// пересдавать пачку руками дорого: это его ночь. Один edit-проход по
// шаблону «измени только одно…» из reports/research-nano-banana-30-08.md
// стоит центы и правит дефект, не трогая людей и композицию.
//
// Ограничение из шапки gemini_shots.mjs остаётся в силе: ОДИН проход правки
// от принятого кадра. Edit-of-edit вырождает стиль в шарж — если после
// правки дефект остался, кадр пересдаётся руками, а не правится второй раз.
//
// Идемпотентности здесь нет намеренно: каждый запуск — это деньги, поэтому
// скрипт отказывается писать поверх существующего --out без --redo.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import { ledger, price, BudgetExceeded } from "./spend.mjs";

const argv = process.argv;
const arg = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const IN = arg("--in");
const OUT = arg("--out");
const INSTR_FILE = arg("--instr-file");
const INSTR_TEXT = arg("--instr");
const SIZE = arg("--size") ?? "2K";
const REDO = argv.includes("--redo");
const ESTIMATE = argv.includes("--estimate");

if (!IN || !OUT || (!INSTR_FILE && !INSTR_TEXT)) {
  console.error("Нужно: --in <кадр> --out <кадр> --instr-file <файл> | --instr <текст> [--size 2K] [--redo]");
  process.exit(2);
}
if (!existsSync(IN)) { console.error(`Нет входного кадра: ${IN}`); process.exit(2); }
if (existsSync(OUT) && !REDO) { console.error(`${OUT} уже есть — нужен --redo, чтобы переплатить за повтор`); process.exit(2); }

const instruction = INSTR_TEXT ?? readFileSync(INSTR_FILE, "utf8").trim();
const COST = price(SIZE);

if (ESTIMATE) {
  console.log(`правка ${IN} × ${SIZE} = $${COST.toFixed(3)}`);
  console.log(ledger().line());
  process.exit(0);
}

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("Нет GEMINI_API_KEY"); process.exit(2); }

const API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent";
const MIME = /\.jpe?g$/i.test(extname(IN)) ? "image/jpeg" : "image/png";

const money = ledger();
try {
  money.check(COST);
} catch (e) {
  if (e instanceof BudgetExceeded) { console.error(`СТОП. ${e.message}`); process.exit(1); }
  throw e;
}

// --ref можно повторять: дополнительные листы-справочники. Идут ПЕРЕД
// основным кадром, потому что пропорции выхода задаёт последняя картинка,
// а лист персонажа почти всегда не 16:9 (31.08: для крупных планов
// прикладываем лист «диалоговые выражения лица» — на нём восемь портретов
// крупно, и лицо получается точнее, чем при увеличении из общего плана).
const REFS = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ref") REFS.push(argv[i + 1]);
}
const mimeOf = (p) => (/\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png");
for (const r of REFS) {
  if (!existsSync(r)) { console.error(`Нет референса: ${r}`); process.exit(2); }
}

const body = {
  contents: [{ parts: [
    { text: instruction },
    ...REFS.map((r) => ({ inline_data: { mime_type: mimeOf(r), data: readFileSync(r).toString("base64") } })),
    { inline_data: { mime_type: MIME, data: readFileSync(IN).toString("base64") } },
  ] }],
  generationConfig: {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio: "16:9", imageSize: SIZE },
    thinkingConfig: { thinkingLevel: "high" },
  },
};

let img = null;
for (let attempt = 1; attempt <= 3 && !img; attempt++) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 15000)); continue; }
  if (!r.ok) { console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const j = await r.json();
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) { console.error(`нет изображения (${j.candidates?.[0]?.finishReason ?? "?"})`); process.exit(1); }
  img = Buffer.from(part.inlineData.data, "base64");
}
if (!img) { console.error("3 попытки исчерпаны"); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, img);
money.charge("fix_shot", arg("--id") ?? OUT.split(/[\\/]/).slice(-1)[0], SIZE);
console.log(`готово: ${OUT}`);
console.log(money.line());
