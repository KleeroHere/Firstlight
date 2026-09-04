// Проверка того, на что жаловался владелец: создать ролик, отредактировать,
// сохранить, увидеть в списке, удалить. Плюс страница workspace и меню.
import { chromium } from "playwright";
const U = "http://localhost:7331/";
let bad = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "  ok  " : " FAIL "} ${n}${d ? " — " + d : ""}`); if (!c) bad++; };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
p.on("pageerror", e => console.log("  [page error] " + e.message));

await p.goto(U + "#/", { waitUntil: "networkidle" });
await p.locator(".fl-nav").waitFor({ timeout: 15000 });
ok("в шапке есть меню", (await p.locator(".fl-nav__link").count()) === 2);

await p.getByRole("link", { name: "Workspace" }).click();
await p.locator(".fl-table").waitFor({ timeout: 10000 });
const rows = await p.locator(".fl-table tbody tr").count();
ok("страница workspace показывает папки", rows >= 8, `строк: ${rows}`);

await p.getByRole("link", { name: "Rolls" }).click();
await p.getByRole("button", { name: "New roll" }).click();
await p.locator(".fl-new input").first().fill("Storm watch drill");
await p.getByRole("button", { name: "Create" }).click();
await p.locator(".fl-editor__bar").waitFor({ timeout: 20000 });
ok("создание ролика открывает сценарий", p.url().includes("storm-watch-drill"), p.url().split("#")[1]);
const scenes = await p.locator(".fl-editor .fl-scene").count();
ok("в заготовке три сцены", scenes === 3, `сцен: ${scenes}`);

// правим и сохраняем
const plate = p.locator(".fl-editor .fl-scene").nth(1).locator("input.fl-input").nth(3);
await plate.fill("Step 1. Close the shutters");
await p.getByRole("button", { name: "Save and compile" }).click();
await p.getByRole("button", { name: "Save and compile" }).waitFor({ state: "attached" });
await p.waitForTimeout(3500);
const saved = await p.locator(".fl-editor__bar").innerText();
ok("сохранение прошло без пометки unsaved", !saved.includes("unsaved"), saved.replace(/\n/g, " ").slice(0, 60));

// правка доехала до файла
const sc = await (await fetch(U + "api/rolls/storm-watch-drill/scenario")).json();
ok("правка записана в сценарий", sc.scenes[1].plate === "Step 1. Close the shutters", sc.scenes[1].plate);

await p.goto(U + "#/", { waitUntil: "networkidle" });
await p.locator(".fl-roll").first().waitFor({ timeout: 10000 });
const titles = await p.locator(".fl-roll__title").allInnerTexts();
ok("новый ролик виден в списке", titles.includes("Storm watch drill"), titles.join(", "));
await p.screenshot({ path: "../docs/screenshots/rolls.png" });

// удаление
p.once("dialog", d => d.accept());
await p.goto(U + "#/roll/storm-watch-drill", { waitUntil: "networkidle" });
await p.getByRole("button", { name: "Delete" }).click();
await p.waitForTimeout(2500);
const left = (await (await fetch(U + "api/rolls")).json()).rolls.map(r => r.id);
ok("удаление убирает ролик", !left.includes("storm-watch-drill"), left.join(", "));

await b.close();
console.log(bad ? `\n${bad} проверок упало` : "\nвсе проверки прошли");
// exitCode, а не exit(): процесс догашивает сокеты сам, иначе libuv ругается.
process.exitCode = bad ? 1 : 0;
