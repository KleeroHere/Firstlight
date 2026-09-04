#!/usr/bin/env node
// Пакетный прогон FLF2V (Wan 2.2 + lightx2v 4 шага + AniSora HIGH) по план-листу.
//
//   node engine/flf_batch.mjs --id uborka --host https://<pod>-8188.proxy.runpod.net
//
// Опции: --only 2,3  --redo  --no-anisora  --seed N  --no-concat  --no-nag
//        --jupyter-upload  — класть кадры через файловый API Jupyter,
//                            минуя сломанный /upload/image ComfyUI
//
// К0 = мастер плана, К1 = takes/<id>/keys/plan<N>_key.png (из flf_keys.mjs).
// Клипы кладёт в takes/<id>/_flf/plan<N>.mp4, затем склеивает планы сцены
// в takes/<id>/<scene>_take1.mp4 (порядок — порядок планов в план-листе).
// Готовые клипы пропускает: прогон можно прерывать и запускать заново.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ROOT, loadConfig } from "./lib.mjs";

function parseArgs(argv) {
  const a = { host: "http://127.0.0.1:8188", seed: 7, anisora: true, concat: true, nag: true };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--id") a.id = argv[++i];
    else if (v === "--host") a.host = argv[++i].replace(/\/$/, "");
    else if (v === "--only") a.only = argv[++i].split(",").map(Number);
    else if (v === "--seed") a.seed = Number(argv[++i]);
    else if (v === "--redo") a.redo = true;
    else if (v === "--no-anisora") a.anisora = false;
    else if (v === "--no-concat") a.concat = false;
    else if (v === "--no-nag") a.nag = false;
    else if (v === "--jupyter-upload") a.jupyterUpload = true;
    else throw new Error(`Неизвестный аргумент: ${v}`);
  }
  if (!a.id) throw new Error("Нужен --id");
  return a;
}
const args = parseArgs(process.argv);
const cfg = loadConfig();
const spec = JSON.parse(readFileSync(join(ROOT, "workspace", "plans", `${args.id}.json`), "utf8"));
const takesDir = join(ROOT, cfg.paths.takes, args.id);
const flfDir = join(takesDir, "_flf");
mkdirSync(flfDir, { recursive: true });

// Негатив. ВАЖНО: при cfg = 1 (а у нас 4-шаговая LoRA lightx2v именно на
// cfg = 1) классическая негативная ветка не участвует в сэмплировании —
// эта строка до 29.08.2026 не влияла ни на один клип. Работать она начинает
// только вместе с узлом NAGuidance ниже. Формулировки добавлены по приёмке
// владельца 29.08: посторонние люди, отдельные кисти, висящий в воздухе
// планшет, дым от предметов, подмена одежды.
const NEG = "photorealistic, photograph, live action, 3d render, static, still, frozen, text, watermark, blurry, distorted hands, extra fingers, extra arm, third arm, disembodied hand, floating hand, hand without a body, extra people, additional person entering the frame, stranger walking through the shot, duplicated character, cloned twin figures, character leaving the frame, character re-entering the frame, floating object, levitating clipboard, object hovering in mid air, smoke, smoking, cigarette, steam, changing clothes, taking off clothes, clothing swap, morphing face, changing hair color, people standing up, chairs sliding, swapping seats, walking through furniture, camera pan, camera zoom, scene cut, a hand entering from the edge of the frame, an arm reaching in from off screen, someone offering a plate, someone handing over an object, a handshake, clapping hands, a second pair of hands, a person appearing at the left edge, a person appearing at the right edge, putting on gloves, taking off gloves, a tablet computer, an ipad, a glowing screen";

function ff(a) {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg: " + (r.stderr ?? "").split("\n").slice(-2).join(" "));
}

// Когда ComfyUI лежит, прокси RunPod отдаёт HTML-страницу ошибки, и обычный
// r.json() падает на «Unexpected token '<'». Поэтому любой ответ разбираем
// осторожно и ждём, пока сервер вернётся: ночью это разница между
// «батч продолжился» и «очередь встала до утра».
async function jsonOrNull(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return null; }
}
async function waitComfy(minutes = 15) {
  for (let i = 0; i < minutes * 2; i++) {
    try {
      const r = await fetch(`${args.host}/system_stats`, { signal: AbortSignal.timeout(15000) });
      if (r.ok && (await jsonOrNull(r))) return true;
    } catch { /* ещё не поднялся */ }
    process.stdout.write("~");
    await new Promise((s) => setTimeout(s, 30000));
  }
  return false;
}

// Запасной путь загрузки: файловый API JupyterLab на 8888.
// 30.08.2026 на одном из подов штатный /upload/image ComfyUI начал
// отдавать 500 на ЛЮБОЙ файл — и снаружи, и с самого пода, при этом в логе
// ни строчки. Каталог input при этом пишется нормально. Ждать починки образа
// нельзя, а Jupyter кладёт файл прямо в /workspace/ComfyUI/input.
async function uploadViaJupyter(localPath, name) {
  const base = args.host.replace("-8188.", "-8888.");
  const seed = await fetch(`${base}/lab`, { signal: AbortSignal.timeout(30000) });
  const cookies = (seed.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
  const xsrf = (cookies.find((c) => c.startsWith("_xsrf=")) || "").split("=")[1] || "";
  const r = await fetch(`${base}/api/contents/ComfyUI/input/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: {
      Cookie: cookies.join("; "), "X-XSRFToken": xsrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "file", format: "base64",
      content: readFileSync(localPath).toString("base64"),
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Jupyter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return name;
}

async function upload(localPath, name) {
  if (args.jupyterUpload) return uploadViaJupyter(localPath, name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append("image", new Blob([readFileSync(localPath)], { type: "image/png" }), name);
      fd.append("overwrite", "true");
      const r = await fetch(`${args.host}/upload/image`, { method: "POST", body: fd });
      const j = r.ok ? await jsonOrNull(r) : null;
      if (j?.name) return j.name;
    } catch { /* сеть моргнула */ }
    if (!(await waitComfy())) throw new Error(`upload ${name}: ComfyUI не отвечает`);
  }
  // ComfyUI не принял файл — пробуем Jupyter, прежде чем сдаваться.
  try {
    const n = await uploadViaJupyter(localPath, name);
    if (!args.jupyterUpload) {
      console.log(`
  (upload ComfyUI не работает — дальше кладу файлы через Jupyter)`);
      args.jupyterUpload = true;
    }
    return n;
  } catch (e) {
    throw new Error(`upload ${name}: ComfyUI молчит, Jupyter тоже — ${e.message}`);
  }
}

function graph(k0, k1, frames, motion, seed = args.seed) {
  const g = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", strength_model: 1, model: ["1", 0] } },
    "3": { class_type: "ModelSamplingSD3", inputs: { shift: 5, model: [args.anisora ? "2b" : "2", 0] } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", weight_dtype: "default" } },
    "5": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", strength_model: 1, model: ["4", 0] } },
    "6": { class_type: "ModelSamplingSD3", inputs: { shift: 5, model: ["5", 0] } },
    "7": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
    "8": { class_type: "CLIPTextEncode", inputs: { text: motion, clip: ["7", 0] } },
    "9": { class_type: "CLIPTextEncode", inputs: { text: NEG, clip: ["7", 0] } },
    "10": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
    "11": { class_type: "LoadImage", inputs: { image: k0 } },
    // Конечный кадр у WanFirstLastFrameToVideo необязателен: без него узел
    // работает как обычный i2v — движение задаёт только текст. Так снимаются
    // крупные планы одного человека (31.08, идея владельца): ключ там не
    // нужен вовсе, а это $0.067 экономии на каждом плане. Для общих планов
    // конечный кадр обязателен: без него Wan уводит рассадку и лица.
    "12": { class_type: "WanFirstLastFrameToVideo", inputs: { positive: ["8", 0], negative: ["9", 0], vae: ["10", 0], width: 1280, height: 720, length: frames, batch_size: 1, start_image: ["11", 0] } },
    "13": { class_type: "KSamplerAdvanced", inputs: { model: [args.nag ? "20" : "3", 0], add_noise: "enable", noise_seed: args.seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["12", 0], negative: ["12", 1], latent_image: ["12", 2], start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } },
    "14": { class_type: "KSamplerAdvanced", inputs: { model: [args.nag ? "21" : "6", 0], add_noise: "disable", noise_seed: args.seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["12", 0], negative: ["12", 1], latent_image: ["13", 0], start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } },
    "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["10", 0] } },
    "16": { class_type: "VHS_VideoCombine", inputs: { images: ["15", 0], frame_rate: 16, loop_count: 0, filename_prefix: `flf_${args.id}`, format: "video/h264-mp4", pingpong: false, save_output: true } },
  };
  if (k1) {
    g["17"] = { class_type: "LoadImage", inputs: { image: k1 } };
    g["12"].inputs.end_image = ["17", 0];
  }
  if (args.anisora)
    g["2b"] = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "Wan2_2_I2V_AniSora_3_2_HIGH_rank_64_fp16.safetensors", strength_model: 1, model: ["2", 0] } };
  // Normalized Attention Guidance. Придуман ровно для дистиллированных
  // моделей на cfg = 1: возвращает влияние негативного условия, не поднимая
  // cfg (подъём cfg ломает 4-шаговую lightx2v). Параметры — как в рабочем
  // wan22_i2v_nag.api.json.
  if (args.nag) {
    g["20"] = { class_type: "NAGuidance", inputs: { model: ["3", 0], nag_scale: 5.0, nag_alpha: 0.5, nag_tau: 1.5 } };
    g["21"] = { class_type: "NAGuidance", inputs: { model: ["6", 0], nag_scale: 5.0, nag_alpha: 0.5, nag_tau: 1.5 } };
  }
  return g;
}

async function genClip(k0, k1, frames, motion, seed, outFile, label) {
  const t0 = Date.now();
  const q = await fetch(`${args.host}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph(k0, k1, frames, motion, seed) }),
  });
  const qj = await jsonOrNull(q);
  if (!q.ok || !qj || qj.error) throw new Error(`queue: ${JSON.stringify(qj ?? { http: q.status }).slice(0, 500)}`);
  process.stdout.write(`${label} (${frames} кадров) ... `);
  let file = null, silent = 0;
  for (;;) {
    await new Promise((s) => setTimeout(s, 10000));
    let e = null;
    try {
      const hr = await fetch(`${args.host}/history/${qj.prompt_id}`, { signal: AbortSignal.timeout(20000) });
      const h = hr.ok ? await jsonOrNull(hr) : null;
      if (h) { e = h[qj.prompt_id]; silent = 0; } else silent++;
    } catch { silent++; }
    // Полторы минуты молчания подряд — ComfyUI упал: ждём его и пересдаём план.
    if (silent >= 9) {
      console.log("сервер пропал, жду возвращения");
      if (!(await waitComfy())) throw new Error("ComfyUI не вернулся");
      throw new Error("RETRY_PLAN");
    }
    // Ловушка 25.08: если ComfyUI перезапустился, /history/<id> отвечает 200 и
    // пустым объектом — «молчания» нет, задания тоже нет, и цикл крутится
    // вечно (так был потерян час пода). Но простой потолок по времени тоже
    // неверен: когда в очередь шлют два задания сразу, второе законно ждёт
    // своей очереди дольше любого потолка. Поэтому спрашиваем саму очередь:
    // задание считается потерянным, только если его нет ни в истории, ни в
    // очереди — и лишь после 20 минут, чтобы не дёргаться на ровном месте.
    if (!e && Date.now() - t0 > 20 * 60 * 1000) {
      let inQueue = true;
      try {
        const qr = await fetch(`${args.host}/queue`, { signal: AbortSignal.timeout(20000) });
        const qq = qr.ok ? await jsonOrNull(qr) : null;
        if (qq) {
          const ids = [...(qq.queue_running ?? []), ...(qq.queue_pending ?? [])]
            .map((it) => (Array.isArray(it) ? it[1] : it?.prompt_id));
          inQueue = ids.includes(qj.prompt_id);
        }
      } catch { /* очередь не ответила — считаем, что ждём дальше */ }
      if (!inQueue) {
        console.log("задание пропало из очереди, пересдаю план");
        if (!(await waitComfy())) throw new Error("ComfyUI не вернулся");
        throw new Error("RETRY_PLAN");
      }
    }
    if (!e) continue;
    if (e.status?.status_str === "error")
      throw new Error(`генерация: ${JSON.stringify(e.status.messages ?? {}).slice(0, 600)}`);
    const vids = Object.values(e.outputs ?? {}).flatMap((o) => o.gifs ?? o.images ?? []);
    if (vids.length) { file = vids[0]; break; }
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  const v = await fetch(`${args.host}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder ?? "")}&type=${file.type}`);
  writeFileSync(outFile, Buffer.from(await v.arrayBuffer()));
  console.log(`${sec} с (${(sec / (frames / 16)).toFixed(1)} с/с видео)`);
}

// Ближайшее допустимое число кадров Wan: F = 8x+1.
const wanFrames = (n) => 8 * Math.max(1, Math.round((n - 1) / 8)) + 1;

async function runPlan(p) {
  const out = join(flfDir, `plan${p.plan}.mp4`);
  if (p.ready) {
    if (!existsSync(out)) copyFileSync(join(takesDir, p.ready), out);
    console.log(`план ${p.plan}: готовый клип (${p.ready})`);
    return;
  }
  if (existsSync(out) && !args.redo) { console.log(`план ${p.plan}: клип уже есть`); return; }
  // Планы с "i2v": true снимаются БЕЗ конечного кадра: движение задаёт
  // только текст. Так делаются крупные планы одного человека — ключ там
  // не нужен, а каждый ключ это $0.067 из общего потолка. Для общих планов
  // ключ обязателен: без него Wan уводит рассадку, лица и мебель.
  const keyPath = join(takesDir, "keys", `plan${p.plan}_key.png`);
  if (!p.i2v && !existsSync(keyPath)) throw new Error(`нет ключа ${keyPath} — сначала flf_keys.mjs`);
  // К1 приводим к 1280x720, чтобы узел не масштабировал 2K сам
  const key720 = join(tmpdir(), `${args.id}_plan${p.plan}_key720.png`);
  if (!p.i2v) ff(["-i", keyPath, "-vf", "scale=1280:720", key720]);
  // К0 тоже приводим к 1280x720: мастером плана может быть ключ предыдущего
  // плана (чейнинг сцены из одного кадра), а ключи сохраняются в 2K.
  const k0src = join(takesDir, p.master);
  const k0_720 = join(tmpdir(), `${args.id}_plan${p.plan}_k0_720.png`);
  ff(["-i", k0src, "-vf", "scale=1280:720", k0_720]);
  const k0 = await upload(k0_720, `${args.id}_p${p.plan}_k0.png`);
  rmSync(k0_720, { force: true });
  let k1 = null;
  if (!p.i2v) {
    k1 = await upload(key720, `${args.id}_p${p.plan}_k1.png`);
    rmSync(key720, { force: true });
  }

  if (p.cycle) {
    // Циклический жест (кивок, качание): у него начало = конец, одним FLF2V
    // выходит статика. Бьём на полуфазы: мастер→ключ→мастер.
    const half = wanFrames(p.frames / 2);
    const a = join(tmpdir(), `${args.id}_plan${p.plan}_a.mp4`);
    const b = join(tmpdir(), `${args.id}_plan${p.plan}_b.mp4`);
    await genClip(k0, k1, half, p.motion, args.seed, a, `план ${p.plan}/фаза А`);
    await genClip(k1, k0, half, p.motionBack ?? p.motion, args.seed + 1, b, `план ${p.plan}/фаза Б`);
    const list = join(tmpdir(), `${args.id}_plan${p.plan}_list.txt`);
    writeFileSync(list, [a, b].map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
    rmSync(a, { force: true }); rmSync(b, { force: true }); rmSync(list, { force: true });
  } else {
    await genClip(k0, k1, p.frames, p.motion, args.seed, out, `план ${p.plan}`);
  }
}

// Предполёт: NAGuidance — кастомный узел ComfyUI, и если его на поде нет,
// упадёт КАЖДЫЙ план, а узнали бы мы об этом только по пустой папке утром.
// Проверяем один раз и, если узла нет, честно снимаем NAG и говорим об этом:
// клипы без него всё равно снимутся, просто негатив снова не будет работать.
if (args.nag) {
  try {
    const r = await fetch(`${args.host}/object_info/NAGuidance`, { signal: AbortSignal.timeout(20000) });
    const j = r.ok ? await jsonOrNull(r) : null;
    if (!j || !j.NAGuidance) {
      console.log("ВНИМАНИЕ: узла NAGuidance на поде нет — снимаю NAG.");
      console.log("  Негатив при cfg=1 работать не будет: лишние люди и руки ничем не сдерживаются.");
      console.log("  Поставить: ComfyUI-Manager → NAG (Normalized Attention Guidance), затем перезапустить ComfyUI.");
      args.nag = false;
    } else {
      console.log("Предполёт: NAGuidance на поде есть, негатив включён.");
    }
  } catch {
    console.log("ВНИМАНИЕ: ComfyUI не ответил на проверку NAGuidance — снимаю NAG на всякий случай.");
    args.nag = false;
  }
}

const plans = spec.plans.filter((p) => !args.only || args.only.includes(p.plan));
for (const p of plans) {
  // Падение ComfyUI посреди плана не должно ронять весь батч: ждём сервер
  // (это делает genClip) и пересдаём тот же план ещё дважды.
  for (let attempt = 1; ; attempt++) {
    try { await runPlan(p); break; }
    catch (e) {
      // «три попытки исчерпаны» — это провал загрузки кадра, когда в ComfyUI
        // пишут несколько заданий разом. Он тоже временный: план надо
        // пересдать, а не пропустить (25.08 так едва не потеряли план).
        const retryable = /RETRY_PLAN|не отвечает|не вернулся|fetch failed|ECONNRESET|terminated|исчерпаны/i.test(e.message);
      if (!retryable || attempt >= 3) { console.log(`план ${p.plan}: ✗ ${e.message.slice(0, 200)}`); break; }
      console.log(`план ${p.plan}: повтор ${attempt + 1}/3 после сбоя связи`);
    }
  }
}

if (args.concat) {
  const scenes = [...new Set(spec.plans.map((p) => p.scene))];
  for (const sc of scenes) {
    const parts = spec.plans.filter((p) => p.scene === sc).map((p) => join(flfDir, `plan${p.plan}.mp4`));
    if (!parts.every((f) => existsSync(f))) { console.log(`${sc}: не все планы готовы, склейку пропускаю`); continue; }
    const list = join(flfDir, `${sc}_list.txt`);
    writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const take = join(takesDir, `${sc}_take1.mp4`);
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", take]);
    console.log(`${sc}_take1.mp4 ← ${parts.map((f) => basename(f)).join(" + ")}`);
  }
}
