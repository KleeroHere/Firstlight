#!/usr/bin/env node
// Фазовые ключи К1 для FLF2V: правка мастера через Gemini с сохранением сцены.
//
//   $env:GEMINI_API_KEY="..." ; node engine/flf_keys.mjs --id uborka [--redo] [--size 1K] [--only 4,7]
//   node engine/flf_keys.mjs --id uborka --size 1K --estimate   # только счёт, без API
//
// Ключ можно и нарисовать руками: положите готовый файл в
// takes/<ролик>/keys/plan<N>_key.png — скрипт готовые ключи не трогает.
// Промпт для ручной правки печатает keys_sheet.mjs.
//
// Читает engine/flf_plans_<id>.json, для каждого плана без ready
// делает takes/<id>/keys/plan<N>_key.png (2K). Готовые ключи пропускает.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig } from "./lib.mjs";
import { ledger, price, BudgetExceeded } from "./spend.mjs";

// --estimate только считает, сколько ключей и денег нужно: ни API, ни ключа.
const ESTIMATE = process.argv.includes("--estimate");
const KEY = process.env.GEMINI_API_KEY;
if (!KEY && !ESTIMATE) { console.error("Нет GEMINI_API_KEY"); process.exit(2); }
const id = process.argv[process.argv.indexOf("--id") + 1];
const redo = process.argv.includes("--redo");
// --only 4,7 — перегенерировать только эти планы. Нужен, когда из всей
// пачки не получился один-два ключа: остальные трогать незачем, они уже
// приняты глазами по keys-priemka.html.
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1].split(",").map(Number) : null;
// Размер ключа. С переходом на сборку сцены цепочкой кропы не нужны, а
// рабочий кадр всё равно 1280x720 — «1K» отдаёт 1376x768, то есть уже
// больше нужного. 2K оставлен для совместимости со старыми роликами.
const sizeIdx = process.argv.indexOf("--size");
const SIZE = sizeIdx > -1 ? process.argv[sizeIdx + 1] : "2K";
if (!id) { console.error("Нужен --id"); process.exit(2); }

const cfg = loadConfig();
// Книга расходов с жёстким потолком: скрипт останавливается сам, не дожидаясь
// счёта от Google. Потолок правится в reports/gemini-spend.json.
const money = ledger();
const COST = price(SIZE);
const plans = JSON.parse(readFileSync(join(ROOT, "workspace", "plans", `${id}.json`), "utf8")).plans;
const takesDir = join(ROOT, cfg.paths.takes, id);
const keysDir = join(takesDir, "keys");
mkdirSync(keysDir, { recursive: true });

const API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent";

async function editImage(masterPath, instruction) {
  const body = {
    contents: [{ parts: [
      { text: instruction },
      { inline_data: { mime_type: "image/png", data: readFileSync(masterPath).toString("base64") } },
    ] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: SIZE },
      thinkingConfig: { thinkingLevel: "high" },
    },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 15000)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const img = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!img) throw new Error(`нет изображения (${j.candidates?.[0]?.finishReason ?? "?"})`);
    return Buffer.from(img.inlineData.data, "base64");
  }
  throw new Error("3 попытки исчерпаны");
}

if (ESTIMATE) {
  let todo = 0, noMaster = 0;
  for (const p of plans) {
    if (ONLY && !ONLY.includes(p.plan)) continue;
    if (p.ready) continue;
    if (p.i2v) continue; // крупный план без конечного кадра — ключ ему не нужен
    const out = join(keysDir, `plan${p.plan}_key.png`);
    if (existsSync(out) && !redo && !ONLY) continue;
    if (!existsSync(join(takesDir, p.master))) { noMaster += 1; continue; }
    todo += 1;
  }
  console.log(`${id}: ключей к генерации ${todo} × ${SIZE} = $${(todo * COST).toFixed(2)}` +
    (noMaster ? `; ещё ${noMaster} ждут опорного кадра` : ""));
  console.log(money.line());
  process.exit(0);
}

for (const p of plans) {
  if (ONLY && !ONLY.includes(p.plan)) continue;
  if (p.ready) { console.log(`план ${p.plan}: готов (${p.ready}), пропуск`); continue; }
  if (p.i2v) { console.log(`план ${p.plan}: i2v, ключ не нужен, пропуск`); continue; }
  const out = join(keysDir, `plan${p.plan}_key.png`);
  if (existsSync(out) && !redo && !ONLY) { console.log(`план ${p.plan}: ключ уже есть`); continue; }
  const master = join(takesDir, p.master);
  if (!existsSync(master)) {
    console.log(`план ${p.plan}: НЕТ МАСТЕРА ${p.master} — пропуск (кадр ещё не снят)`);
    continue;
  }
  try {
    money.check(COST);
  } catch (e) {
    if (e instanceof BudgetExceeded) { console.error(`
СТОП. ${e.message}`); break; }
    throw e;
  }
  process.stdout.write(`план ${p.plan} ← ${p.master} ... `);
  try {
    writeFileSync(out, await editImage(master, p.edit));
    money.charge("flf_keys", id, SIZE);
    console.log(`ok  (${money.line()})`);
  } catch (e) {
    // Деньги списываем только за выданную картинку: за ошибку Google не берёт.
    console.log(`ОШИБКА: ${e.message}`);
  }
  await new Promise((s) => setTimeout(s, 7000)); // щадим рейт-лимит
}

console.log(`
${money.line()}`);
