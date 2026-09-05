#!/usr/bin/env node
// Сборщик сцены из клипов план-листа — «ограниченная анимация» монтажом,
// вместо одного клипа на сцену (см. assemble_video.mjs). Alternative cut:
// each scene is built from its own plan-list clips (takes/<id>/_flf/planN.mp4)
// in plan order, with close-up inserts cut FROM THE SAME SCENE between the
// wider masters — no cross-episode library, so nothing here can pull in a
// clip of the wrong scene or the wrong cast.
//
//   node engine/assemble_from_plans.mjs --id fog-signal-check [опции]
//
// Опции:
//   --id <id>          id сценария (compiled/<id>.json)
//   --out <file>       путь результата (по умолчанию out/<Название>.mp4)
//   --sketch           раскрытие «эскиз → цвет» в начале сцен (по умолчанию выкл)
//   --max-slow <1.12>  предел равномерного замедления мастеров вместо врезок/детали
//   --push <0>         наезд на мастерах (доля кадра, zoompan)
//   --insert-sec <2.5> базовая длина врезки
//   --placeholder-vo   не звать ElevenLabs, шум вместо речи
//
// Раскладка: мастера план-листа идут по порядку, между мастерами длиннее
// MAX_SHOT секунд вставляется крупный план ИЗ ТОЙ ЖЕ СЦЕНЫ (план с "closeup":
// true в план-листе). Нехватку экрана до длины сцены закрывает: сначала
// подрезка лишнего, потом умеренное равномерное замедление (глазом не
// читается), при необходимости — врезки между мастерами, и как крайний
// случай — деталь (наезд на последний кадр сцены). Титры/памятка и звук —
// как в assemble_video.mjs; те же generic-рендеры карточек, без зашитого
// названия серии (см. pipeline.config.json → series).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadConfig, loadScenario, ffprobeJson, ensureDir, textFile, fpath, sanitizeName, sceneDuration,
} from "./lib.mjs";

function parseArgs(argv) {
  const a = { push: 0, insertSec: 2.5, sketch: false, maxSlow: 1.12 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--no-sketch") a.sketch = false;
    else if (v === "--sketch") a.sketch = true;
    else if (v === "--max-slow") a.maxSlow = Number(argv[++i]);
    else if (v === "--push") a.push = Number(argv[++i]);
    else if (v === "--insert-sec") a.insertSec = Number(argv[++i]);
    else if (v === "--placeholder-vo") a.placeholderVo = true;
    // A release asset often has a hard size cap (GitHub, a wiki, an intranet).
    // --target-mb re-encodes the finished picture in two passes at the exact
    // bitrate that lands under that cap, instead of the caller guessing a CRF,
    // measuring, and guessing again.
    else if (v === "--target-mb") a.targetMb = Number(argv[++i]);
    else if (v === "--audio-kbps") a.audioKbps = Number(argv[++i]);
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id");
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const sn = loadScenario(cfg, args.id);
const takesDir = join(ROOT, cfg.paths.takes, args.id);
const buildDir = join(ROOT, cfg.paths.build, `${args.id}_plans`);
const outDir = join(ROOT, cfg.paths.out);
rmSync(buildDir, { recursive: true, force: true });
ensureDir(buildDir); ensureDir(outDir);

const { width: W, height: H, fps: FPS } = cfg;
const F = fpath(cfg.font);
const fadeD = cfg.transitionSec;
const CREAM = cfg.colors.cream, INK = cfg.colors.ink;
const SK_HOLD = 1.44, SK_WHITE = 0.5, SK_WIPE = 0.4, SK_DISS = 0.7;
const SKETCH_ADD = SK_WHITE + SK_HOLD - SK_WIPE - SK_DISS; // сколько экрана добавляет эскиз
const buildLog = { id: sn.id, title: sn.title, version: "from-plans", createdAt: new Date().toISOString(), scenes: [] };

const plansFile = join(ROOT, "workspace", "plans", `${args.id}.json`);
const plans = existsSync(plansFile) ? JSON.parse(readFileSync(plansFile, "utf8")).plans : [];

function ff(list) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...list], { stdio: ["ignore", "inherit", "inherit"] });
}
function vdur(f) { return Number(ffprobeJson(f).format.duration); }
function fades(dur, o = {}) {
  const p = [];
  if (o.in !== false) p.push(`fade=t=in:st=0:d=${fadeD}:color=white`);
  if (o.out !== false) p.push(`fade=t=out:st=${(dur - fadeD).toFixed(3)}:d=${fadeD}:color=white`);
  return p.length ? p.join(",") : "null";
}
function encodeSegment(outFile, inputArgs, filter, dur) {
  ff([...inputArgs, "-filter_complex", filter, "-map", "[v]", "-t", dur.toFixed(3), "-r", String(FPS), ...cfg.encode.videoArgs, "-an", outFile]);
}
function centeredText(text, size, color, yExpr, extra = "") {
  const tf = fpath(textFile(buildDir, text));
  return `drawtext=fontfile='${F}':textfile='${tf}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${yExpr}${extra}`;
}
// Подпись-бокс: текст рисуется дважды — сначала с «чернильной» подложкой
// (это обводка), потом с кремовой на 3 px уже. Появляется после эскиза.
function caption(text, fromSec) {
  const tf = fpath(textFile(buildDir, text));
  const p = cfg.plate; const en = fromSec > 0 ? `:enable='gte(t,${fromSec.toFixed(2)})'` : "";
  const base = `drawtext=fontfile='${F}':textfile='${tf}':fontsize=${p.fontSize}:fontcolor=${INK}:x=${p.margin}:y=${p.margin}`;
  return `${base}:box=1:boxcolor=${INK}:boxborderw=${p.padY + 3}${en},${base}:box=1:boxcolor=${CREAM}@0.94:boxborderw=${p.padY}${en}`;
}
const norm = (speed = 1) => `${speed !== 1 ? `setpts=${speed.toFixed(4)}*PTS,` : ""}fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${CREAM},setsar=1,format=yuv420p`;
function pushIn(frames) {
  if (!args.push) return "null";
  return `zoompan=z='1+${args.push}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
}

// ---------- карточки (generic, без зашитого названия серии) ----------
function renderTitle(sc, outFile) {
  const dur = sceneDuration(sc);
  let filter = [`color=c=${CREAM}:s=${W}x${H}:r=${FPS}`, `drawbox=x=iw*0.14:y=ih*0.40:w=iw*0.72:h=ih*0.22:color=${cfg.colors.coral}:t=fill`].join(",");
  if (cfg.series?.name) filter += "," + centeredText(cfg.series.name, cfg.title.subFontSize, INK, "h*0.18");
  if (cfg.series?.tagline) filter += "," + centeredText(cfg.series.tagline, Math.round(cfg.title.subFontSize * 0.66), INK, "h*0.18+" + Math.round(cfg.title.subFontSize * 1.4));
  filter += "," + centeredText(sc.plate, cfg.title.fontSize, CREAM, "h*0.40+(h*0.22-text_h)/2");
  filter += `,${fades(dur)}[v]`;
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}
function renderDivider(sc, outFile) {
  const dur = sceneDuration(sc);
  let filter = `color=c=${cfg.colors.coral}:s=${W}x${H}:r=${FPS}` + "," + centeredText(sc.plate, Math.round(cfg.title.fontSize * 0.8), CREAM, "(h-text_h)/2") + `,${fades(dur)}[v]`;
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}
function renderMemo(sc, outFile) {
  const dur = sceneDuration(sc); const m = cfg.memo;
  let filter = `color=c=${CREAM}:s=${W}x${H}:r=${FPS}`;
  filter += "," + centeredText(sc.memo.title, m.titleFontSize, INK, "h*0.12");
  filter += "," + centeredText(sc.memo.items.join("\n"), m.itemFontSize, INK, "h*0.30", `:line_spacing=${m.lineSpacing}`);
  filter += `,${fades(dur)}[v]`;
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}


// ---------- сцена-вставка готовым видео (kind: "clip") ----------
// Для роликов, у которых картинка не снимается моделью, а уже существует:
// запись экрана интерфейса, покадрово отрисованная схема, врезка из готового
// эпизода. Тот же тайминг, те же плашки, тот же войсовер — отличается только
// источник кадров. Стоп-кадры запрещены и здесь: если исходник короче сцены,
// это ошибка сборки, а не повод задержать последний кадр.
function renderClip(sc, outFile) {
  const dur = sceneDuration(sc);
  const src = join(ROOT, sc.file);
  if (!existsSync(src)) throw new Error(`Сцена ${sc.id}: нет файла ${sc.file}`);
  const S = vdur(src);
  const at = Number(sc.at ?? 0);
  const avail = S - at;
  if (avail < dur - 0.05) {
    throw new Error(`Сцена ${sc.id}: источник даёт ${avail.toFixed(2)} с при сцене ${dur} с — ` +
      `удлини ${sc.file} или укороти сцену; держать кадр нельзя`);
  }
  const cap = sc.plate ? `,${caption(sc.plate, 0)}` : "";
  const chain = `[0:v]trim=start=${at.toFixed(3)}:duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,${norm()}${cap},${fades(dur)}[v]`;
  encodeSegment(outFile, ["-i", src], chain, dur);
  buildLog.scenes.push({ id: sc.id, kind: "clip", t: sc.t, plate: sc.plate ?? null,
    source: sc.file, sourceDuration: Number(S.toFixed(2)), at, target: dur,
    screen: Number(dur.toFixed(2)), still: false });
}

// ---------- сцена из план-листа ----------
function sceneClips(sc) {
  const all = plans.filter((p) => p.scene === sc.id).map((p) => ({ ...p, file: join(takesDir, "_flf", `plan${p.plan}.mp4`) })).filter((p) => existsSync(p.file));
  return { masters: all.filter((p) => !p.closeup), local: all.filter((p) => p.closeup) };
}
// Врезки только из крупных планов ЭТОЙ ЖЕ сцены (план-лист помечает их
// "closeup": true) — никакой библиотеки чужих сцен: действие и состав кадра
// в других сценах, скорее всего, не совпадают с этой.
function pickInserts(local, need) {
  if (need === 0) return local.length > 0;
  const out = [];
  for (let i = 0; i < need && local.length; i++) out.push(local[(insertCursor + i) % local.length]);
  insertCursor += need;
  return out;
}
let insertCursor = 0;

// Раскладка: [{kind:'master'|'insert'|'detail', file, start, len, speed}]
// Правило кадра: мастер на экране не дольше MAX_SHOT. Длинный клип режется
// на две части, между ними врезка, а вторая часть начинается на длину
// врезки позже — монтажная склейка прячет скачок времени, экран не растёт.
const MAX_SHOT = 6.5;

// Монтаж сцены, снятой по ролям (auto_storyboard.py пишет role: wide/medium/
// close): общий → средний → крупный → возврат на хвост ТОГО ЖЕ общего плана.
// Возврат к установочному кадру — обязательная часть грамматики сцены, но
// отдельного клипа он не стоит: хвост уже снятого общего плана и есть возврат.
const RETURN_SEC = 1.8;
function montageItems(masters) {
  const wide = masters.find((p) => p.role === "wide");
  const rest = masters.filter((p) => p !== wide);
  if (!wide || !rest.length) return null;
  const S = vdur(wide.file);
  const tail = Math.min(RETURN_SEC, Math.max(1.2, S * 0.35));
  const head = S - tail;
  if (head < 1.5) return null; // общий слишком короток, чтобы делить
  const order = { medium: 0, close: 1 };
  rest.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.plan - b.plan);
  return [
    { kind: "master", file: wide.file, plan: wide.plan, start: 0, src: head },
    ...rest.map((p) => ({ kind: "master", file: p.file, plan: p.plan, start: 0, src: vdur(p.file) })),
    { kind: "master", file: wide.file, plan: wide.plan, start: head, src: tail, ret: true },
  ];
}

function layout(sc, masters, local) {
  const D = sceneDuration(sc);
  if (!masters.length) return null;
  const sketch = args.sketch ? SKETCH_ADD : 0;
  const notes = [];
  const hasInserts = !!pickInserts(local, 0);
  // 1. куски мастеров (+ обязательные врезки внутри длинных клипов)
  let items = montageItems(masters);
  if (items) notes.push(`монтаж по ролям: общий → средний → крупный → возврат ${items.at(-1).src.toFixed(1)} с`);
  else items = [];
  for (const p of items.length ? [] : masters) {
    const S = vdur(p.file);
    if (hasInserts && S > MAX_SHOT) {
      const a = S / 2 - args.insertSec / 2;
      items.push({ kind: "master", file: p.file, plan: p.plan, start: 0, src: a });
      items.push({ kind: "insert", len: args.insertSec, fixed: true });
      items.push({ kind: "master", file: p.file, plan: p.plan, start: a + args.insertSec, src: S - a - args.insertSec });
    } else items.push({ kind: "master", file: p.file, plan: p.plan, start: 0, src: S });
  }
  const mastersTotal = items.filter((x) => x.kind === "master").reduce((s, x) => s + x.src, 0);
  const fixedIns = items.filter((x) => x.kind === "insert").reduce((s, x) => s + x.len, 0);
  let deficit = D - sketch - mastersTotal - fixedIns;
  items.forEach((x) => { if (x.kind === "master") { x.speed = 1; x.len = x.src; } });
  // 2. лишнее — подрезать с конца (не короче 1.5 с на кусок)
  if (deficit <= 0) {
    let over = -deficit;
    for (let i = items.length - 1; i >= 0 && over > 0.01; i--) {
      if (items[i].kind !== "master") continue;
      const cut = Math.min(over, items[i].src - 1.5); if (cut > 0) { items[i].src -= cut; items[i].len = items[i].src; over -= cut; }
    }
    notes.push(`клипов с запасом, подрезано ${(-deficit).toFixed(1)} с`);
  } else if (deficit / mastersTotal <= args.maxSlow - 1) {
    // 3. небольшая нехватка — равномерное замедление мастеров (глазом не читается)
    const k = (mastersTotal + deficit) / mastersTotal;
    items.forEach((x) => { if (x.kind === "master") { x.speed = k; x.len = x.src * k; } });
    notes.push(`замедление ×${k.toFixed(3)}`);
  } else if (!hasInserts) {
    // 4. врезок нет (в сцене нет крупных планов) — тянем сильнее и добираем деталью-наездом
    const kk = Math.min(1.35, (mastersTotal + deficit) / mastersTotal);
    items.forEach((x) => { if (x.kind === "master") { x.speed = kk; x.len = x.src * kk; } });
    const rest = D - sketch - items.reduce((s, x) => s + x.len, 0);
    notes.push(`врезок нет: замедление ×${kk.toFixed(2)}` + (rest > 0.2 ? `, деталь ${rest.toFixed(1)} с` : ""));
    if (rest > 0.2) items.push({ kind: "detail", len: rest, from: masters[masters.length - 1].file });
  } else {
    // 5. врезки между мастерами там, где их ещё нет
    const gaps = [];
    for (let i = 0; i < items.length - 1; i++) if (items[i].kind === "master" && items[i + 1].kind === "master") gaps.push(i + 1);
    if (!gaps.length) gaps.push(items.length); // один мастер — врезка после него
    let per = deficit / gaps.length, extra = 0;
    if (per > 3.6) { extra = deficit - 3.6 * gaps.length; per = 3.6; }
    if (per < 1.8) {
      const k = (mastersTotal + deficit) / mastersTotal;
      items.forEach((x) => { if (x.kind === "master") { x.speed = k; x.len = x.src * k; } });
      notes.push(`замедление ×${k.toFixed(3)} (врезка вышла бы короче 1.8 с)`);
    } else {
      for (let g = gaps.length - 1; g >= 0; g--) items.splice(gaps[g], 0, { kind: "insert", len: per });
      let left = extra;
      while (left > 0.2) { const L = Math.min(3.0, left); items.push({ kind: "insert", len: L }); left -= L; }
      notes.push(`врезок добавлено ${gaps.length} по ${per.toFixed(1)} с` + (extra > 0 ? `, хвост ${extra.toFixed(1)} с` : ""));
    }
  }
  // 6. раздать файлы врезкам (крутим по кругу локальные крупные планы сцены)
  const need = items.filter((x) => x.kind === "insert").length;
  const ins = pickInserts(local, need);
  let j = 0;
  items.forEach((x) => { if (x.kind === "insert" && Array.isArray(ins)) { x.file = ins[j].file; x.id = `plan${ins[j].plan}`; j++; } });
  if (need) notes.push(`врезок всего ${need}`);
  return { items, notes };
}

function renderScene(sc, segBase) {
  const D = sceneDuration(sc);
  const { masters, local } = sceneClips(sc);
  const lay = layout(sc, masters, local);
  if (!lay) throw new Error(`Сцена ${sc.id}: нет клипов в ${takesDir}/_flf`);
  const files = [];
  const cap = caption(sc.plate, 0);
  lay.items.forEach((it, i) => {
    const f = `${segBase}_${String(i + 1).padStart(2, "0")}.mp4`;
    const first = i === 0, last = i === lay.items.length - 1;
    if (it.kind === "master") {
      const frames = Math.round(it.len * FPS);
      let chain, inputs = ["-i", it.file], segLen = it.len;
      if (first && args.sketch) {
        inputs.push("-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=${FPS}:d=${SK_WHITE}`);
        segLen = it.len + SKETCH_ADD;
        chain = `[0:v]trim=start=${(it.start ?? 0).toFixed(3)},setpts=PTS-STARTPTS,${norm(it.speed)},split[c][s];` +
          `[s]trim=0:0.04,setpts=PTS-STARTPTS,edgedetect=low=0.06:high=0.18,negate,format=gray,format=yuv420p,tpad=stop_mode=clone:stop_duration=${SK_HOLD}[sk0];` +
          `[1:v]format=yuv420p[wh];[wh][sk0]xfade=transition=wipetl:duration=${SK_WIPE}:offset=${(SK_WHITE - SK_WIPE).toFixed(2)}[sk];` +
          `[c]trim=duration=${it.len.toFixed(3)},setpts=PTS-STARTPTS,${pushIn(frames)}[cz];` +
          `[sk][cz]xfade=transition=dissolve:duration=${SK_DISS}:offset=${(SK_WHITE + SK_HOLD - SK_WIPE - SK_DISS).toFixed(2)},` +
          `${caption(sc.plate, SK_WHITE + SK_HOLD - SK_WIPE - 0.2)},${fades(segLen, { out: !!last })}[v]`;
      } else {
        chain = `[0:v]trim=start=${(it.start ?? 0).toFixed(3)},setpts=PTS-STARTPTS,${norm(it.speed)},trim=duration=${it.len.toFixed(3)},setpts=PTS-STARTPTS,${pushIn(frames)},${cap},` +
          `${fades(segLen, { in: first, out: last })}[v]`;
      }
      encodeSegment(f, inputs, chain, segLen);
      it.screen = segLen;
    } else if (it.kind === "insert") {
      // врезка: середина исходного клипа, «на двойках» без замедления
      const src = vdur(it.file); const start = Math.max(0, (src - it.len) / 2);
      const chain = `[0:v]trim=start=${start.toFixed(2)}:duration=${it.len.toFixed(3)},setpts=PTS-STARTPTS,fps=15,${norm()},${cap},${fades(it.len, { in: first, out: last })}[v]`;
      encodeSegment(f, ["-i", it.file], chain, it.len); it.screen = it.len;
    } else { // detail — медленный наезд на последний кадр
      const still = `${segBase}_last.png`;
      ff(["-sseof", "-0.2", "-i", it.from, "-frames:v", "1", still]);
      const frames = Math.max(1, Math.round(it.len * FPS));
      const chain = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:color=${CREAM},setsar=1,` +
        `zoompan=z='1.15+0.08*on/${frames}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},trim=duration=${it.len.toFixed(3)},setpts=PTS-STARTPTS,${cap},${fades(it.len, { in: false, out: last })}[v]`;
      encodeSegment(f, ["-loop", "1", "-i", still], chain, it.len); it.screen = it.len;
    }
    files.push(f);
  });
  const total = lay.items.reduce((s, x) => s + x.screen, 0);
  buildLog.scenes.push({
    id: sc.id, kind: "scene", t: sc.t, plate: sc.plate, target: D, screen: Number(total.toFixed(2)),
    layout: lay.items.map((x) => ({ kind: x.kind, plan: x.plan, id: x.id, len: Number(x.screen.toFixed(2)), speed: x.speed })),
    notes: lay.notes, still: lay.items.some((x) => x.kind === "detail"),
  });
  if (Math.abs(total - D) > 0.15) console.warn(`⚠ ${sc.id}: экран ${total.toFixed(2)} с при сцене ${D} с`);
  return files;
}

// ---------- войсовер (кэш takes/<id>/vo) ----------
async function makeVo(sc) {
  if (!sc.vo) return null;
  const cached = join(takesDir, "vo", `${sc.id}.mp3`);
  if (existsSync(cached)) return { file: cached, mode: "cached" };
  const key = process.env[cfg.audio.elevenlabs.apiKeyEnv];
  if (!args.placeholderVo && key) {
    ensureDir(join(takesDir, "vo"));
    const el = cfg.audio.elevenlabs;
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${el.voiceId}?output_format=mp3_44100_128`,
      { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ text: sc.vo, model_id: el.modelId }) });
    if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${await resp.text()}`);
    writeFileSync(cached, Buffer.from(await resp.arrayBuffer()));
    return { file: cached, mode: "elevenlabs" };
  }
  const dur = Math.max(0.5, Math.min(sceneDuration(sc) - 0.4, sc.vo.length / cfg.audio.voCharsPerSec));
  const ph = join(buildDir, `vo_${sc.id}.wav`);
  ff(["-f", "lavfi", "-i", `anoisesrc=colour=pink:amplitude=0.08:d=${dur.toFixed(2)}`, "-ar", "48000", "-ac", "1", ph]);
  return { file: ph, mode: "placeholder" };
}

// ---------- ход ----------
const t0 = Date.now();
const segments = []; const voClips = [];
for (const sc of sn.scenes) {
  const kind = sc.kind ?? "scene";
  const segFile = join(buildDir, `seg_${sc.id}.mp4`);
  let made = [segFile];
  if (kind === "title") renderTitle(sc, segFile);
  else if (kind === "divider") renderDivider(sc, segFile);
  else if (kind === "memo") renderMemo(sc, segFile);
  else if (kind === "clip") renderClip(sc, segFile);
  else made = renderScene(sc, join(buildDir, `seg_${sc.id}`));
  if (kind !== "scene" && kind !== "clip") buildLog.scenes.push({ id: sc.id, kind, t: sc.t, plate: sc.plate, source: "rendered" });
  segments.push(...made);
  const vo = await makeVo(sc);
  if (vo) {
    const voDur = Number(ffprobeJson(vo.file).format.duration);
    const voAt = Math.max(0, Number(sc.vo_at ?? 0));
    if (voDur > sceneDuration(sc) - voAt + 0.3) console.warn(`⚠ ${sc.id}: речь ${voDur.toFixed(1)} с не влезает`);
    voClips.push({ scene: sc.id, at: sc.t[0] + voAt, voAt, file: vo.file, mode: vo.mode, duration: voDur });
  }
}
const listFile = join(buildDir, "concat.txt");
writeFileSync(listFile, segments.map((s) => `file '${s.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
const concatFile = join(buildDir, "video.mp4");
ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatFile]);

const totalDur = sn.scenes.at(-1).t[1];
const outName = args.out ?? join(outDir, `${sanitizeName(sn.title)}.mp4`);
// ---------- необязательный ужим под размер (--target-mb) ----------
// Две прохода x264 по готовой картинке: считаем битрейт из остатка бюджета
// после звука, а не подбираем CRF вслепую. Картинка при этом одна и та же —
// сегменты уже склеены, так что ужимается ровно то, что увидит зритель.
let pictureFile = concatFile;
const audioKbps = args.audioKbps ?? (args.targetMb ? 96 : null);
if (args.targetMb) {
  const dur = Number(ffprobeJson(concatFile).format.duration);
  const budgetBits = args.targetMb * 1024 * 1024 * 8;
  const audioBits = (audioKbps * 1000) * dur;
  // 2% запас на контейнер и заголовки
  const vBitrate = Math.max(300, Math.floor(((budgetBits - audioBits) * 0.98) / dur / 1000));
  console.log(`ужим под ${args.targetMb} МБ: ${dur.toFixed(1)} с → видео ${vBitrate} кбит/с + звук ${audioKbps} кбит/с`);
  const passLog = join(buildDir, "x264-2pass");
  const shared = ["-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p",
    "-b:v", `${vBitrate}k`, "-maxrate", `${Math.round(vBitrate * 1.5)}k`, "-bufsize", `${vBitrate * 3}k`,
    "-preset", "slow", "-r", String(FPS), "-passlogfile", passLog];
  ff(["-i", concatFile, ...shared, "-pass", "1", "-an", "-f", "mp4", process.platform === "win32" ? "NUL" : "/dev/null"]);
  pictureFile = join(buildDir, "video_sized.mp4");
  ff(["-i", concatFile, ...shared, "-pass", "2", "-an", pictureFile]);
}

const inputs = ["-i", pictureFile]; let fc = ""; const mixIn = [];
voClips.forEach((c, i) => {
  inputs.push("-i", c.file); const ms = Math.round(c.at * 1000);
  fc += `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${(sceneDuration(sn.scenes.find((s) => s.id === c.scene)) - c.voAt).toFixed(2)},adelay=${ms}|${ms}[a${i}];`;
  mixIn.push(`[a${i}]`);
});
fc += mixIn.length ? `${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,${cfg.audio.loudnormFilter},aresample=48000,apad[aout]` : `anullsrc=r=48000:cl=stereo[aout]`;
const audioArgs = audioKbps ? ["-c:a", "aac", "-b:a", `${audioKbps}k`, "-ar", "48000", "-ac", "2"] : cfg.encode.audioArgs;
ff([...inputs, "-filter_complex", fc, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", ...audioArgs, "-t", totalDur.toFixed(3), "-movflags", "+faststart", outName]);

buildLog.output = outName; buildLog.totalDuration = totalDur; buildLog.durationTarget = sn.duration_target;
buildLog.vo = voClips.map(({ file, ...r }) => r);
const realVo = (m) => m === "elevenlabs" || m === "cached";
buildLog.voMode = voClips.every((c) => realVo(c.mode)) ? "elevenlabs" : voClips.some((c) => realVo(c.mode)) ? "mixed" : "placeholder";
writeFileSync(join(buildDir, "build-log.json"), JSON.stringify(buildLog, null, 2), "utf8");
writeFileSync(outName.replace(/\.mp4$/, ".build-log.json"), JSON.stringify(buildLog, null, 2), "utf8");
const sizeMb = statSync(outName).size / 1024 / 1024;
buildLog.sizeMb = Number(sizeMb.toFixed(2));
if (args.targetMb) buildLog.targetMb = args.targetMb;
writeFileSync(outName.replace(/[.]mp4$/, ".build-log.json"), JSON.stringify(buildLog, null, 2), "utf8");
console.log(`\nСобрано (from-plans): ${outName}\nХронометраж: ${totalDur} с, сегментов: ${segments.length}, ${sizeMb.toFixed(1)} МБ, ${((Date.now() - t0) / 1000).toFixed(1)} с сборки`);
if (args.targetMb && sizeMb > args.targetMb) console.warn(`WARN ${sizeMb.toFixed(1)} MB against a ${args.targetMb} MB target`);
for (const s of buildLog.scenes.filter((x) => x.kind === "scene")) console.log(`  ${s.id}: ${s.target} с → ${s.screen} с; ${s.notes.join("; ")}; ${s.layout.map((l) => `${l.kind}${l.plan ? " p" + l.plan : l.id ? " " + l.id : ""} ${l.len}`).join(" | ")}`);
