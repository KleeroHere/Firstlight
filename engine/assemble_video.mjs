#!/usr/bin/env node
// Сборка ролика серии из сцен, войсовера и программной графики.
//
//   node engine/assemble_video.mjs --id kvartsevanie [опции]
//
// Опции:
//   --id <id>            id сценария (compiled/<id>.json)
//   --takes <dir>        каталог дублей (по умолчанию из конфига: takes/<id>)
//   --out <file>         путь результата (по умолчанию out/<Название>.mp4)
//   --take sN=K          взять для сцены sN дубль K (по умолчанию наименьший)
//   --placeholder-vo     не звать ElevenLabs: подставить шумовую заглушку
//   --allow-missing      отсутствующие сцены заменить серой заглушкой
//
// Что делает: рендерит заставку/разделители/памятку (drawtext, не нейросеть),
// нормализует сцены к 1920x1080/30fps, дотягивает короткие сцены стоп-кадром,
// накладывает плашки, склеивает с белым «кистевым» переходом, кладёт войсовер
// по таймкодам сценария, нормализует громкость до −16 LUFS, кодирует
// H.264/AAC + faststart и пишет build-log.json для приёмочного скрипта.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadConfig, loadScenario, run, ffprobeJson, ensureDir,
  textFile, fpath, sanitizeName, sceneDuration,
} from "./lib.mjs";

function parseArgs(argv) {
  const a = { takeOverrides: {} };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--takes") a.takes = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--take") {
      const [k, n] = argv[++i].split("=");
      a.takeOverrides[k] = Number(n);
    } else if (v === "--placeholder-vo") a.placeholderVo = true;
    else if (v === "--allow-missing") a.allowMissing = true;
    else if (v === "--prefer-takes") a.preferTakes = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id <id сценария>");
  return a;
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const sn = loadScenario(cfg, args.id);
const takesDir = args.takes ?? join(ROOT, cfg.paths.takes, args.id);
const buildDir = join(ROOT, cfg.paths.build, args.id);
const outDir = join(ROOT, cfg.paths.out);
rmSync(buildDir, { recursive: true, force: true });
ensureDir(buildDir);
ensureDir(outDir);

const { width: W, height: H, fps: FPS } = cfg;
const F = fpath(cfg.font);
const fadeD = cfg.transitionSec;
const buildLog = { id: sn.id, title: sn.title, createdAt: new Date().toISOString(), scenes: [] };

function ff(argsList) {
  execFileSync("ffmpeg", ["-hidden_banner" === "x" ? "" : "-hide_banner", "-loglevel", "error", "-y", ...argsList], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

// Белый «кистевой» переход ставится только на внешних границах сцены.
// Внутренний стык (клип → деталь) идёт встык, без вспышки.
function fades(dur, opts = {}) {
  const fi = opts.in !== false;
  const fo = opts.out !== false;
  const parts = [];
  if (fi) parts.push(`fade=t=in:st=0:d=${fadeD}:color=white`);
  if (fo) parts.push(`fade=t=out:st=${(dur - fadeD).toFixed(3)}:d=${fadeD}:color=white`);
  return parts.length ? parts.join(",") : "null";
}

function encodeSegment(outFile, inputArgs, filter, dur) {
  ff([...inputArgs, "-filter_complex", filter, "-map", "[v]",
    "-t", dur.toFixed(3), "-r", String(FPS), ...cfg.encode.videoArgs, "-an", outFile]);
}

function drawPlate(text) {
  const tf = fpath(textFile(buildDir, text));
  const p = cfg.plate;
  return `drawtext=fontfile='${F}':textfile='${tf}':fontsize=${p.fontSize}` +
    `:fontcolor=${cfg.colors.ink}:x=${p.margin}:y=${p.margin}` +
    `:box=1:boxcolor=${cfg.colors.plateBox}:boxborderw=${p.padY}`;
}

function centeredText(text, size, color, yExpr, extra = "") {
  const tf = fpath(textFile(buildDir, text));
  return `drawtext=fontfile='${F}':textfile='${tf}':fontsize=${size}` +
    `:fontcolor=${color}:x=(w-text_w)/2:y=${yExpr}${extra}`;
}

// Подложка-карточка (например, экспорт из Canva): если в конфиге cards.*
// указан существующий PNG — он становится фоном вместо программной
// заливки. Текст всё равно рисует drawtext: он меняется от ролика к
// ролику и правится за секунду. Требования к файлам — production/canva.md.
function cardBase(kindKey) {
  const rel = cfg.cards?.[kindKey];
  if (!rel) return null;
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return {
    inputArgs: ["-loop", "1", "-i", abs],
    base: `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},setsar=1,fps=${FPS}`,
    source: rel,
  };
}

function renderTitle(sc, outFile) {
  const dur = sceneDuration(sc);
  const card = cardBase("titleBg");
  if (card) {
    let filter = card.base;
    filter += "," + centeredText(sc.plate, cfg.title.fontSize, cfg.colors.cream, "h*0.40+(h*0.22-text_h)/2");
    filter += `,${fades(dur)}[v]`;
    encodeSegment(outFile, card.inputArgs, filter, dur);
    return;
  }
  const chain = [
    `color=c=${cfg.colors.cream}:s=${W}x${H}:r=${FPS}`,
    // коралловое «пятно» под названием
    `drawbox=x=iw*0.14:y=ih*0.40:w=iw*0.72:h=ih*0.22:color=${cfg.colors.coral}:t=fill`,
  ];
  let filter = chain.join(",");
  filter += "," + centeredText("ПРОБУЖДЕНИЕ", cfg.title.subFontSize, cfg.colors.ink, "h*0.18");
  filter += "," + centeredText("реабилитационный центр", Math.round(cfg.title.subFontSize * 0.66), cfg.colors.ink, "h*0.18+" + Math.round(cfg.title.subFontSize * 1.4));
  filter += "," + centeredText(sc.plate, cfg.title.fontSize, cfg.colors.cream, "h*0.40+(h*0.22-text_h)/2");
  if (cfg.logoPng && existsSync(join(ROOT, cfg.logoPng))) {
    // при наличии растрового логотипа — вставить сверху
    const lf = fpath(join(ROOT, cfg.logoPng));
    filter = `movie='${lf}',scale=-1:${Math.round(H * 0.12)}[logo];` + filter + `[bg];[bg][logo]overlay=(W-w)/2:H*0.05[vv]`;
    filter = filter.replace("[vv]", "") + `,${fades(dur)}[v]`;
  } else {
    filter += `,${fades(dur)}[v]`;
  }
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}

function renderDivider(sc, outFile) {
  const dur = sceneDuration(sc);
  let filter = `color=c=${cfg.colors.coral}:s=${W}x${H}:r=${FPS}`;
  filter += "," + centeredText(sc.plate, Math.round(cfg.title.fontSize * 0.8), cfg.colors.cream, "(h-text_h)/2");
  filter += `,${fades(dur)}[v]`;
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}

function renderMemo(sc, outFile) {
  const dur = sceneDuration(sc);
  const m = cfg.memo;
  let filter = `color=c=${cfg.colors.cream}:s=${W}x${H}:r=${FPS}`;
  filter += "," + centeredText(sc.memo.title, m.titleFontSize, cfg.colors.ink, "h*0.12");
  filter += "," + centeredText(sc.memo.items.join("\n"), m.itemFontSize, cfg.colors.ink,
    "h*0.30", `:line_spacing=${m.lineSpacing}`);
  filter += `,${fades(dur)}[v]`;
  encodeSegment(outFile, ["-f", "lavfi", "-i", "nullsrc=s=16x16"], filter, dur);
}

// Кадры сцены, нарисованные Gemini: s1_sh1_frame.png, s1_sh2_frame.png, ...
// Сцена собирается как нарезка по ним, а не как один кадр на полминуты.
// Порядок — по номеру шота.
function findBeatFrames(sceneId) {
  if (!existsSync(takesDir)) return [];
  const rx = new RegExp(`^${sceneId}_sh(\\d+)_frame\\.(png|jpe?g)$`, "i");
  return readdirSync(takesDir)
    .map((f) => ({ f, m: f.match(rx) }))
    .filter((x) => x.m)
    .map((x) => ({ file: join(takesDir, x.f), n: Number(x.m[1]) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.file);
}

// Плашка шага: на первом кадре сцены выезжает слева, дальше стоит.
// Движение живёт в графике, а не в персонажах — сломаться тут нечему.
function drawPlateAnimated(text, slide) {
  const tf = fpath(textFile(buildDir, text));
  const p = cfg.plate;
  const x = slide
    ? `'if(lt(t,0.45), ${p.margin}-360+360*(t/0.45), ${p.margin})'`
    : String(p.margin);
  return `drawtext=fontfile='${F}':textfile='${tf}':fontsize=${p.fontSize}` +
    `:fontcolor=${cfg.colors.ink}:x=${x}:y=${p.margin}` +
    `:box=1:boxcolor=${cfg.colors.plateBox}:boxborderw=${p.padY}`;
}

// Лестница планов: из одной нарисованной картинки получается несколько
// разных кадров — общий, затем более тесные врезки. Это те же пиксели,
// поэтому «поплыть» им негде, а монтаж перестаёт быть слайд-шоу.
// Вертикальный якорь держим выше центра: головы в верхних двух третях.
// Планы идут по нарастанию: общий → средний → крупный. Возврата к общему
// внутри одной картинки нет — он читается как сброс, а не как монтаж.
// Вторая картинка сцены открывается уже средним, чтобы сцена не начиналась
// заново. Сторона врезки чередуется от сцены к сцене, иначе весь фильм
// собирается по одному шаблону и это видно.
function ladderFor(frameIndex, flip) {
  const near = flip ? 0.63 : 0.37;
  const far = flip ? 0.37 : 0.63;
  if (frameIndex === 0) {
    return [
      { z: 1.00, cx: 0.50 },
      { z: 1.26, cx: near },
      { z: 1.55, cx: far },
    ];
  }
  return [
    { z: 1.14, cx: 0.50 },
    { z: 1.40, cx: far },
    { z: 1.60, cx: near },
  ];
}

function beatCrop(step) {
  if (step.z <= 1.001) {
    return `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${cfg.colors.cream}`;
  }
  // Выражения берём в кавычки: внутри clip() есть запятые, а ffmpeg
  // без кавычек считает их разделителями фильтров.
  const cw = `iw/${step.z}`;
  const ch = `ih/${step.z}`;
  const x = `clip(iw*${step.cx}-(${cw})/2,0,iw-(${cw}))`;
  const y = `clip(ih*0.42-(${ch})/2,0,ih-(${ch}))`;
  return `crop=w='${cw}':h='${ch}':x='${x}':y='${y}',` +
    `scale=${W}:${H}:flags=lanczos`;
}

// Один кадр нарезки: статичная картинка, жёсткий внутренний стык.
// Белая вспышка — только на внешних границах сцены.
function renderBeat(sc, image, dur, outFile, opts) {
  const pre = `[0:v]${beatCrop(opts.step)},setsar=1,fps=${FPS},` +
    `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,`;
  const filter = pre + drawPlateAnimated(sc.plate, opts.first) +
    `,${fades(dur, { in: opts.first, out: opts.last })}[v]`;
  encodeSegment(outFile, ["-loop", "1", "-i", image], filter, dur);
}

// План нарезки сцены: сколько кадров и какой план на каждом.
// Целимся примерно в 5 секунд на кадр — ниже этого монтаж читается
// как слайд-шоу, выше начинает суетиться.
function planBeats(frames, dur, targetSec = 5, flip = false) {
  const want = Math.max(frames.length, Math.round(dur / targetSec));
  const perFrame = Math.ceil(want / frames.length);
  const plan = [];
  frames.forEach((file, fi) => {
    const ladder = ladderFor(fi, flip);
    for (let k = 0; k < perFrame && plan.length < want; k++) {
      plan.push({ file, step: ladder[Math.min(k, ladder.length - 1)], frameIndex: fi });
    }
  });
  return plan;
}

function findTake(sceneId) {
  if (!existsSync(takesDir)) return null;
  const want = args.takeOverrides[sceneId];
  const rx = new RegExp(`^${sceneId}_take(\\d+)\\.(mp4|mov|webm|mkv|png|jpg|jpeg)$`, "i");
  const found = readdirSync(takesDir)
    .map((f) => ({ f, m: f.match(rx) }))
    .filter((x) => x.m)
    .map((x) => ({ file: join(takesDir, x.f), n: Number(x.m[1]) }))
    .sort((a, b) => a.n - b.n);
  if (found.length === 0) return null;
  if (want != null) {
    const hit = found.find((x) => x.n === want);
    if (!hit) throw new Error(`${sceneId}: запрошен дубль ${want}, а есть: ${found.map((x) => x.n).join(", ")}`);
    return hit.file;
  }
  return found[0].file;
}

// Кадр «деталь»: последний кадр клипа, взятый крупнее и с медленным
// наездом. Нужен, чтобы длинная сцена не превращалась в мёртвый стоп-кадр,
// и чтобы ритм «показываем → рассказываем» держался без новой генерации.
function renderDetail(sc, take, dur, outFile) {
  const still = join(buildDir, `last_${sc.id}.png`);
  ff(["-sseof", "-0.2", "-i", take, "-frames:v", "1", still]);
  const frames = Math.max(1, Math.round(dur * FPS));
  const z0 = cfg.detail?.zoomStart ?? 1.28;
  const dz = cfg.detail?.zoomDrift ?? 0.1;
  const pre = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,` +
    `pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:color=${cfg.colors.cream},setsar=1,` +
    `zoompan=z='${z0}+${dz}*on/${frames}':d=${frames}` +
    `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},` +
    `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,`;
  const filter = pre + drawPlate(sc.plate) + `,${fades(dur, { in: false })}[v]`;
  encodeSegment(outFile, ["-loop", "1", "-i", still], filter, dur);
}

// Возвращает список файлов-сегментов: одна сцена может состоять из двух
// кадров — самого клипа и добора деталью.
function renderScene(sc, outFile) {
  const dur = sceneDuration(sc);

  // Штатный путь серии: нарезка по нарисованным кадрам сцены.
  // Персонажи неподвижны — это заявленный приём, поэтому сломаться нечему.
  const frames = args.preferTakes ? [] : findBeatFrames(sc.id);
  if (frames.length > 0) {
    // Чередование стороны врезки — по порядковому номеру сцены в ролике.
    const sceneNo = sn.scenes.filter((s) => (s.kind ?? "scene") === "scene")
      .findIndex((s) => s.id === sc.id);
    const plan = planBeats(frames, dur, cfg.beat?.targetSec ?? 5, sceneNo % 2 === 1);
    const each = dur / plan.length;
    const files = plan.map((b, i) => {
      const f = outFile.replace(/\.mp4$/, `_b${i + 1}.mp4`);
      renderBeat(sc, b.file, each, f,
        { first: i === 0, last: i === plan.length - 1, step: b.step });
      return f;
    });
    buildLog.scenes.push({
      id: sc.id, kind: "scene", t: sc.t, plate: sc.plate,
      source: frames.map((b) => b.split(/[\\/]/).pop()), still: true,
      motion: "cut", beats: plan.length, beatSec: Number(each.toFixed(2)),
      framing: plan.map((b) => `${b.step.z.toFixed(2)}@${b.step.cx}`),
    });
    return files;
  }

  const take = findTake(sc.id);
  const detailMin = cfg.detail?.minSec ?? 3;

  if (take == null) {
    if (!args.allowMissing) {
      throw new Error(`Сцена ${sc.id}: нет файла ${sc.id}_take*.mp4 в ${takesDir} (есть --allow-missing для черновой сборки)`);
    }
    const inputArgs = ["-f", "lavfi", "-i", `color=c=0x777777:s=${W}x${H}:r=${FPS}:d=${dur}`];
    const pre = `[0:v]setsar=1,` +
      centeredText(`СЦЕНА ${sc.id}: дубль не сгенерирован`, 48, "white", "(h-text_h)/2") + ",";
    buildLog.scenes.push({ id: sc.id, kind: "scene", t: sc.t, plate: sc.plate, source: "MISSING" });
    encodeSegment(outFile, inputArgs, pre + drawPlate(sc.plate) + `,${fades(dur)}[v]`, dur);
    return [outFile];
  }

  if (/\.(png|jpe?g)$/i.test(take)) {
    // Статичный кадр: медленный программный наезд на всю сцену.
    // Штатный путь для сцен с motion: pan — генерация им не нужна.
    const frames = Math.round(dur * FPS);
    const pre = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,` +
      `pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:color=${cfg.colors.cream},setsar=1,` +
      `zoompan=z='1+0.06*on/${frames}':d=${frames}` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},` +
      `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,`;
    buildLog.scenes.push({
      id: sc.id, kind: "scene", t: sc.t, plate: sc.plate,
      source: take, still: true, frozenTail: 0, motion: sc.motion ?? "pan",
    });
    encodeSegment(outFile, ["-i", take], pre + drawPlate(sc.plate) + `,${fades(dur)}[v]`, dur);
    return [outFile];
  }

  const meta = ffprobeJson(take);
  const vdur = Number(meta.format.duration);
  const clipDur = Math.min(vdur, dur);
  const detailDur = Number((dur - clipDur).toFixed(3));

  if (detailDur < detailMin) {
    // Хвост короткий — добираем стоп-кадром, как раньше, одним сегментом.
    const padNeeded = Math.max(0, dur - vdur + 0.2);
    const pre = `[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${cfg.colors.cream},setsar=1,` +
      `tpad=stop_mode=clone:stop_duration=${padNeeded.toFixed(3)},` +
      `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,`;
    buildLog.scenes.push({
      id: sc.id, kind: "scene", t: sc.t, plate: sc.plate, source: take,
      sourceDuration: vdur, frozenTail: Math.max(0, dur - vdur),
      motion: sc.motion ?? "anim", beats: 1,
    });
    encodeSegment(outFile, ["-i", take], pre + drawPlate(sc.plate) + `,${fades(dur)}[v]`, dur);
    return [outFile];
  }

  // Два кадра: клип целиком, затем деталь с наездом на его последний кадр.
  const clipFile = outFile.replace(/\.mp4$/, "_a.mp4");
  const detailFile = outFile.replace(/\.mp4$/, "_b.mp4");
  const pre = `[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${cfg.colors.cream},setsar=1,` +
    `trim=duration=${clipDur.toFixed(3)},setpts=PTS-STARTPTS,`;
  encodeSegment(clipFile, ["-i", take],
    pre + drawPlate(sc.plate) + `,${fades(clipDur, { out: false })}[v]`, clipDur);
  renderDetail(sc, take, detailDur, detailFile);
  buildLog.scenes.push({
    id: sc.id, kind: "scene", t: sc.t, plate: sc.plate, source: take,
    sourceDuration: vdur, motion: sc.motion ?? "anim", beats: 2,
    clipSec: clipDur, detailSec: detailDur,
  });
  return [clipFile, detailFile];
}

// ---------- войсовер ----------
async function ttsElevenLabs(text, outFile) {
  const el = cfg.audio.elevenlabs;
  const key = process.env[el.apiKeyEnv];
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${el.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: el.modelId }),
    },
  );
  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${await resp.text()}`);
  writeFileSync(outFile, Buffer.from(await resp.arrayBuffer()));
}

async function makeVo(sc) {
  if (!sc.vo) return null;
  const voDir = join(takesDir, "vo");
  ensureDir(voDir);
  const cached = join(voDir, `${sc.id}.mp3`);
  if (existsSync(cached)) return { file: cached, mode: "cached" };
  const hasKey = !!process.env[cfg.audio.elevenlabs.apiKeyEnv] &&
    cfg.audio.elevenlabs.voiceId !== "PASTE_SERIES_VOICE_ID";
  if (!args.placeholderVo && hasKey) {
    await ttsElevenLabs(sc.vo, cached);
    return { file: cached, mode: "elevenlabs" };
  }
  // заглушка: розовый шум длиной «как речь» — чтобы сборка и нормализация
  // громкости были проверяемы без ключа
  const dur = Math.min(sceneDuration(sc) - 0.4, sc.vo.length / cfg.audio.voCharsPerSec);
  const ph = join(buildDir, `vo_${sc.id}.wav`);
  ff(["-f", "lavfi", "-i",
    `anoisesrc=colour=pink:amplitude=0.08:d=${Math.max(0.5, dur).toFixed(2)}`,
    "-ar", "48000", "-ac", "1", ph]);
  return { file: ph, mode: "placeholder" };
}

// ---------- основной ход ----------
const t0 = Date.now();
const segments = [];
const voClips = [];
for (const sc of sn.scenes) {
  const kind = sc.kind ?? "scene";
  const segFile = join(buildDir, `seg_${sc.id}.mp4`);
  let made = [segFile];
  if (kind === "title") renderTitle(sc, segFile);
  else if (kind === "divider") renderDivider(sc, segFile);
  else if (kind === "memo") {
    renderMemo(sc, segFile);
  } else made = renderScene(sc, segFile);
  if (kind !== "scene") {
    buildLog.scenes.push({ id: sc.id, kind, t: sc.t, plate: sc.plate, source: "rendered" });
  }
  segments.push(...made);
  const vo = await makeVo(sc);
  if (vo) {
    const meta = ffprobeJson(vo.file);
    const voDur = Number(meta.format.duration);
    // vo_at — на какой секунде ОТ НАЧАЛА СЦЕНЫ вступает диктор.
    // Принцип «показываем → рассказываем»: сцена открывается молча.
    const voAt = Math.max(0, Number(sc.vo_at ?? 0));
    const room = sceneDuration(sc) - voAt;
    if (voDur > room + 0.3) {
      console.warn(`⚠ ${sc.id}: войсовер ${voDur.toFixed(1)} с не влезает после ` +
        `vo_at=${voAt} с (осталось ${room.toFixed(1)} с) — подрежется`);
    }
    voClips.push({
      scene: sc.id, at: sc.t[0] + voAt, voAt, file: vo.file,
      mode: vo.mode, duration: voDur,
    });
  }
}

// склейка видео без перекодирования
const listFile = join(buildDir, "concat.txt");
writeFileSync(listFile,
  segments.map((s) => `file '${s.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"),
  "utf8");
const concatFile = join(buildDir, "video.mp4");
ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatFile]);

// аудио: войсоверы по таймкодам + нормализация громкости
const totalDur = sn.scenes.at(-1).t[1];
const outName = args.out ?? join(outDir, `${sanitizeName(sn.title)}.mp4`);
const inputs = ["-i", concatFile];
let fc = "";
const mixIn = [];
voClips.forEach((c, i) => {
  inputs.push("-i", c.file);
  const ms = Math.round(c.at * 1000);
  fc += `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,` +
    `atrim=duration=${(sceneDuration(sn.scenes.find((s) => s.id === c.scene)) - c.voAt).toFixed(2)},` +
    `adelay=${ms}|${ms}[a${i}];`;
  mixIn.push(`[a${i}]`);
});
if (mixIn.length > 0) {
  fc += `${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,` +
    `${cfg.audio.loudnormFilter},aresample=48000,apad[aout]`;
} else {
  fc += `anullsrc=r=48000:cl=stereo[aout]`;
}
ff([...inputs, "-filter_complex", fc, "-map", "0:v", "-map", "[aout]",
  "-c:v", "copy", ...cfg.encode.audioArgs, "-t", totalDur.toFixed(3),
  "-movflags", "+faststart", outName]);

buildLog.output = outName;
buildLog.totalDuration = totalDur;
buildLog.durationTarget = sn.duration_target;
buildLog.vo = voClips.map(({ file, ...rest }) => rest);
// «cached» — это те же файлы ElevenLabs, только уже лежащие на диске.
// Раньше они считались заглушкой, и сборка врала в отчёте.
const realVo = (m) => m === "elevenlabs" || m === "cached";
buildLog.voMode = voClips.every((c) => realVo(c.mode)) ? "elevenlabs"
  : voClips.some((c) => realVo(c.mode)) ? "mixed" : "placeholder";
writeFileSync(join(buildDir, "build-log.json"), JSON.stringify(buildLog, null, 2), "utf8");
writeFileSync(outName.replace(/\.mp4$/, ".build-log.json"), JSON.stringify(buildLog, null, 2), "utf8");

console.log(`\nСобрано: ${outName}`);
console.log(`Хронометраж: ${totalDur} с (цель ${sn.duration_target} с), ` +
  `сцен: ${segments.length}, войсовер: ${buildLog.voMode}, ` +
  `${((Date.now() - t0) / 1000).toFixed(1)} с сборки`);
console.log(`Проверка: node engine/verify_video.mjs "${outName}"`);
