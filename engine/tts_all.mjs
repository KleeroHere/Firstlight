// Пакетная озвучка всей серии через ElevenLabs.
//
// Назначение: за один прогон синтезировать войсовер всех роликов серии и
// сложить его в кэш `takes/<id>/vo/<сцена>.mp3`. Сборщик `assemble_video.mjs`
// берёт готовый файл из этого кэша и к API больше не обращается — после
// успешного прогона подписка ElevenLabs проекту не нужна.
//
// Ключ читается только из переменной окружения (имя — в pipeline.config.json,
// `audio.elevenlabs.apiKeyEnv`). В репозиторий ключ не попадает.
//
// Использование:
//   node engine/tts_all.mjs --voices            список голосов аккаунта
//   node engine/tts_all.mjs --quota             остаток символов
//   node engine/tts_all.mjs --dry-run           смета без трат
//   node engine/tts_all.mjs --voice-name Rima   синтез всей серии
//   node engine/tts_all.mjs --only fog-signal-check --voice-name Rima
//   node engine/tts_all.mjs --force --only fog-signal-check --scene s1
//
// Ключи:
//   --voices          показать голоса аккаунта и выйти
//   --quota           показать остаток квоты и выйти
//   --dry-run         посчитать символы и стоимость, ничего не синтезировать
//   --voice-name <s>  выбрать голос по имени (иначе берётся voiceId из конфига)
//   --voice-id <s>    выбрать голос по идентификатору
//   --only <id>       ограничиться одним роликом
//   --scene <id>      ограничиться одной сценой (только вместе с --only)
//   --force           перезаписать уже озвученные сцены
//   --limit <n>       остановиться после n синтезов (страховка при отладке)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig } from "./lib.mjs";

// ---------- аргументы ----------
function parseArgs(argv) {
  const a = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const name = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      a.opts[name] = next;
      i++;
    } else {
      a.flags.add(name);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const el = cfg.audio.elevenlabs;
const API_KEY = process.env[el.apiKeyEnv];

if (!API_KEY) {
  console.error(
    `Не задана переменная окружения ${el.apiKeyEnv}.\n` +
      `Windows (текущее окно):  set ${el.apiKeyEnv}=sk_...\n` +
      `PowerShell:              $env:${el.apiKeyEnv}="sk_..."`,
  );
  process.exit(1);
}

const API = "https://api.elevenlabs.io";
const headers = { "xi-api-key": API_KEY };

// ---------- вспомогательное ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    throw new Error(`ElevenLabs ${resp.status} ${path}: ${(await resp.text()).slice(0, 400)}`);
  }
  return resp;
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ---------- квота ----------
async function fetchQuota() {
  const d = await (await api("/v1/user/subscription")).json();
  const used = d.character_count ?? 0;
  const limit = d.character_limit ?? 0;
  return {
    tier: d.tier ?? "?",
    used,
    limit,
    left: Math.max(0, limit - used),
    resetsAt: d.next_character_count_reset_unix
      ? new Date(d.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)
      : "?",
  };
}

// ---------- голоса ----------
async function fetchVoices() {
  const out = [];
  let page = null;
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ page_size: "100" });
    if (page) q.set("next_page_token", page);
    const d = await (await api(`/v2/voices?${q}`)).json();
    out.push(...(d.voices ?? []));
    if (!d.has_more) break;
    page = d.next_page_token;
  }
  return out;
}

async function resolveVoice() {
  if (args.opts["voice-id"]) return { voice_id: args.opts["voice-id"], name: "(по идентификатору)" };
  const wanted = args.opts["voice-name"];
  if (!wanted) {
    if (!el.voiceId || el.voiceId === "PASTE_SERIES_VOICE_ID") {
      throw new Error(
        "Голос серии не задан. Укажи --voice-name <имя> или --voice-id <id>,\n" +
          "либо впиши voiceId в engine/pipeline.config.json.",
      );
    }
    return { voice_id: el.voiceId, name: "(из конфига)" };
  }
  const voices = await fetchVoices();
  const norm = (s) => (s ?? "").toLowerCase().trim();
  const hit =
    voices.find((v) => norm(v.name) === norm(wanted)) ??
    voices.find((v) => norm(v.name).includes(norm(wanted)));
  if (!hit) {
    const names = voices.map((v) => v.name).join(", ");
    throw new Error(`Голос «${wanted}» не найден. Доступные: ${names}`);
  }
  return hit;
}

// ---------- сценарии ----------
function loadAllScenarios() {
  const dir = join(ROOT, cfg.paths.compiled);
  if (!existsSync(dir)) {
    throw new Error(`Нет каталога компилятов ${dir} — запусти python engine/build_prompts.py`);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function collectJobs(scenarios, voiceId) {
  const jobs = [];
  for (const sc of scenarios) {
    if (args.opts.only && sc.id !== args.opts.only) continue;
    for (const scene of sc.scenes ?? []) {
      const text = (scene.vo ?? "").trim();
      if (!text) continue;
      if (args.opts.scene && scene.id !== args.opts.scene) continue;
      const voDir = join(ROOT, cfg.paths.takes, sc.id, "vo");
      const file = join(voDir, `${scene.id}.mp3`);
      jobs.push({
        scenarioId: sc.id,
        title: sc.title ?? sc.id,
        sceneId: scene.id,
        text,
        chars: text.length,
        voDir,
        file,
        exists: existsSync(file),
        voiceId,
      });
    }
  }
  return jobs;
}

// ---------- синтез ----------
async function synth(job) {
  const q = new URLSearchParams({ output_format: "mp3_44100_128" });
  const resp = await api(`/v1/text-to-speech/${job.voiceId}?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: job.text,
      model_id: el.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    }),
  });
  mkdirSync(job.voDir, { recursive: true });
  writeFileSync(job.file, Buffer.from(await resp.arrayBuffer()));
}

async function synthWithRetry(job, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await synth(job);
      return;
    } catch (e) {
      last = e;
      const status = /ElevenLabs (\d+)/.exec(e.message)?.[1];
      // 401/402/422 повторять бессмысленно — ключ, деньги или текст
      if (["401", "402", "403", "422"].includes(status)) throw e;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw last;
}

// ---------- ход ----------
const quota = await fetchQuota();

if (args.flags.has("quota")) {
  console.log(
    `Тариф: ${quota.tier}\nИзрасходовано: ${fmt(quota.used)} из ${fmt(quota.limit)}\n` +
      `Остаток: ${fmt(quota.left)} символов\nСчётчик обнуляется: ${quota.resetsAt}`,
  );
  process.exit(0);
}

if (args.flags.has("voices")) {
  const voices = await fetchVoices();
  console.log(`Голосов в аккаунте: ${voices.length}\n`);
  for (const v of voices) {
    const lang = v.labels?.language ?? v.fine_tuning?.language ?? "—";
    console.log(`${v.voice_id}  ${(v.name ?? "").padEnd(24)} ${String(lang).padEnd(6)} ${v.category ?? ""}`);
  }
  process.exit(0);
}

const voice = args.flags.has("dry-run") && !args.opts["voice-name"] && !args.opts["voice-id"]
  ? { voice_id: el.voiceId, name: "(смета, голос не важен)" }
  : await resolveVoice();

const scenarios = loadAllScenarios();
const all = collectJobs(scenarios, voice.voice_id);
const todo = args.flags.has("force") ? all : all.filter((j) => !j.exists);

const charsTodo = todo.reduce((s, j) => s + j.chars, 0);
const charsAll = all.reduce((s, j) => s + j.chars, 0);

console.log(`Голос: ${voice.name}  ${voice.voice_id}`);
console.log(`Модель: ${el.modelId}`);
console.log(`Роликов: ${new Set(all.map((j) => j.scenarioId)).size}   реплик всего: ${all.length} (${fmt(charsAll)} знаков)`);
console.log(`Уже озвучено: ${all.length - todo.length}   к синтезу: ${todo.length} (${fmt(charsTodo)} знаков)`);
console.log(`Квота: остаток ${fmt(quota.left)} из ${fmt(quota.limit)}, обнуление ${quota.resetsAt}`);

if (charsTodo > quota.left) {
  console.error(
    `\nОСТАНОВ: нужно ${fmt(charsTodo)} символов, доступно ${fmt(quota.left)}.\n` +
      `Ничего не потрачено. Сократи объём (--only) или дождись обнуления счётчика.`,
  );
  process.exit(2);
}

if (args.flags.has("dry-run")) {
  const byScenario = new Map();
  for (const j of todo) byScenario.set(j.scenarioId, (byScenario.get(j.scenarioId) ?? 0) + j.chars);
  console.log("\nПо роликам:");
  for (const [id, c] of [...byScenario].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(38)} ${String(fmt(c)).padStart(7)} знаков`);
  }
  console.log("\nСмета. Ничего не синтезировано и не потрачено.");
  process.exit(0);
}

const limit = args.opts.limit ? Number(args.opts.limit) : Infinity;
let done = 0, spent = 0, failed = 0;
const errors = [];

console.log("");
for (const job of todo) {
  if (done >= limit) {
    console.log(`Достигнут --limit ${limit}, останов.`);
    break;
  }
  const tag = `${job.scenarioId}/${job.sceneId}`;
  try {
    await synthWithRetry(job);
    done++;
    spent += job.chars;
    console.log(`  ✓ ${tag.padEnd(46)} ${String(job.chars).padStart(5)} зн.`);
  } catch (e) {
    failed++;
    errors.push(`${tag}: ${e.message}`);
    console.log(`  ✗ ${tag.padEnd(46)} ${e.message.slice(0, 90)}`);
    if (/ElevenLabs (401|402|403)/.test(e.message)) {
      console.error("\nОстанов: ключ или квота. Дальше не пробуем.");
      break;
    }
  }
  await sleep(300);
}

// журнал прогона рядом с кэшем
const logPath = join(ROOT, cfg.paths.takes, "tts-log.json");
mkdirSync(join(ROOT, cfg.paths.takes), { recursive: true });
writeFileSync(
  logPath,
  JSON.stringify(
    {
      voiceId: voice.voice_id,
      voiceName: voice.name,
      modelId: el.modelId,
      synthesized: done,
      failed,
      charsSpent: spent,
      quotaBefore: quota,
      errors,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`\nСинтезировано: ${done}   ошибок: ${failed}   потрачено символов: ${fmt(spent)}`);
console.log(`Журнал: ${logPath}`);
if (failed) {
  console.log("Неозвученные сцены остались без файлов — повтори запуск, готовое пропустится.");
  process.exit(1);
}
console.log("Кэш озвучки заполнен. Сборка роликов больше не обращается к ElevenLabs.");
