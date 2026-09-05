#!/usr/bin/env node
// Generates the static snapshots the GitHub Pages demo (and a normal build
// previewed with ?demo=1) read instead of talking to a server — see DEMO in
// ../src/api.ts. Source: the Harbour Light example under workspace/.
//
//   node ui/scripts/build-demo-data.mjs
//
// fog-signal-check already has real placeholder media on disk (the frames a
// keyframe backend drew, and the synthetic gradient clips make_synthetic_takes.mjs
// stands in for real motion with) — those are copied byte for byte, not
// invented. The one thing genuinely authored here is its plan-list: this roll
// predates the plan-list feature (see the comment in ui/server/server.mjs —
// "not every roll has one"), so there is nothing under workspace/plans/ to
// snapshot. The plan-list below reuses the same real frames and clips, only
// renamed to the plan-list's own convention, so the Acceptance tab shows real
// media rather than broken image icons. opening-the-office needs nothing
// invented at all: it really is just a written scenario, nothing shot yet.
//
// Idempotent: deletes and rewrites ui/public/demo/ each run. Run this by hand
// whenever the Harbour Light example changes and commit the result — it is
// not run in CI, because its source (workspace/takes/fog-signal-check/) is
// generated media that needs GEMINI_API_KEY/ComfyUI and is gitignored, so a
// clean checkout does not have it. .github/workflows/pages.yml only builds
// the interface; it ships the demo/ folder already committed here.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "ui", "public", "demo");

const list = (dir, pred = () => true) => (existsSync(dir) ? readdirSync(dir).filter(pred) : []);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
function dirSize(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
function sceneShape(sc) {
  return {
    id: sc.id,
    kind: sc.kind ?? "scene",
    plate: sc.plate ?? "",
    t: sc.t ?? null,
    chars: sc.chars ?? [],
    bg: sc.bg ?? null,
    img: sc.img ?? "",
    anim: sc.anim ?? "",
    vo: sc.vo ?? "",
  };
}
const DEFECTS = ["extra-person", "extra-hand", "object-moved", "cut-jump", "face-drift", "blur"];
function summarizeAcceptance(plans) {
  let accepted = 0,
    rejected = 0,
    pending = 0,
    unshot = 0;
  for (const p of plans) {
    if (!p.variants.length) unshot++;
    else if (p.variants.some((v) => v.decision === "accepted")) accepted++;
    else if (p.variants.every((v) => v.decision === "rejected" || v.decision === "redo")) rejected++;
    else pending++;
  }
  return { total: plans.length, accepted, rejected, pending, unshot, defects: DEFECTS };
}
/** engine/scenario.py is the one place that reads scenario YAML into the shape the interface expects. */
function readScenario(id) {
  try {
    const out = execFileSync("python", [join(ROOT, "engine", "scenario.py"), "read", "--id", id], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return JSON.parse(out);
  } catch (e) {
    console.warn(`[demo-data] could not read the scenario for ${id} (is Python on PATH?): ${e.message}`);
    return null;
  }
}

console.log(`[demo-data] writing to ${OUT}`);
rmSync(OUT, { recursive: true, force: true });

const rolls = [];

// === fog-signal-check: shot and assembled, with a fabricated plan-list =====
{
  const id = "fog-signal-check";
  const compiled = readJson(join(ROOT, "workspace", "prompts", "compiled", `${id}.json`));
  const takesDir = join(ROOT, "workspace", "takes", id);
  const files = list(takesDir);

  const scenes = compiled.scenes.map((sc) => {
    const s = sceneShape(sc);
    s.frames = files.filter((f) => f.startsWith(`${s.id}_sh`) && f.endsWith("_frame.png")).sort();
    s.takes = files.filter((f) => f.startsWith(`${s.id}_take`) && /\.(mp4|png|jpg)$/i.test(f)).sort();
    s.rejected = 0;
    return s;
  });
  for (const f of files) {
    if (/\.(png|mp4|jpg)$/i.test(f)) copy(join(takesDir, f), join(OUT, "files", "takes", id, f));
  }
  const outMp4 = "Fog signal check.mp4";
  copy(join(ROOT, "workspace", "out", outMp4), join(OUT, "files", "out", outMp4));

  const plansSpec = [
    {
      plan: 1,
      scene: "s1",
      motion: "She finishes the line and looks up at the window.",
      frames: 8,
      masterSrc: "s1_sh1_frame.png",
      keySrc: "s1_sh2_frame.png",
      variants: [{ takeSrc: "s1_take1.mp4", decision: "accepted", defects: [], comment: "Clean — the look-up reads clearly, keeps both keyframes." }],
    },
    {
      plan: 2,
      scene: "s2",
      cycle: true,
      motion: "Mara pulls the lever down once, holds it, lets it back up.",
      frames: 16,
      masterSrc: "s2_sh1_frame.png",
      keySrc: "s2_sh2_frame.png",
      variants: [{ takeSrc: "s2_take1.mp4", decision: "redo", defects: ["cut-jump"], comment: "The hold reads as two separate pulls — retime it to one beat." }],
    },
    {
      plan: 3,
      scene: "s3",
      i2v: true,
      closeup: true,
      motion: "He lowers the radio and gives a small thumbs-up towards the tower.",
      frames: 24,
      masterSrc: "s3_sh1_frame.png",
      keySrc: null,
      variants: [
        { takeSrc: "s3_take1.mp4", seed: "1", decision: "rejected", defects: ["extra-hand"], comment: "A second hand appears on the radio for two frames." },
        { takeSrc: "s3_take1.mp4", seed: "2", decision: null, defects: [], comment: "" },
      ],
    },
  ];
  const plans = plansSpec.map((p) => {
    if (p.masterSrc) copy(join(takesDir, p.masterSrc), join(OUT, "files", "takes", id, `plan${p.plan}_master.png`));
    if (p.keySrc) copy(join(takesDir, p.keySrc), join(OUT, "files", "takes", id, "keys", `plan${p.plan}_key.png`));
    const variants = p.variants.map((v) => {
      const key = `plan${p.plan}${v.seed ? `_s${v.seed}` : ""}`;
      const file = `${key}.mp4`;
      copy(join(takesDir, v.takeSrc), join(OUT, "files", "takes", id, file));
      return { file, key, decision: v.decision, defects: v.defects, comment: v.comment };
    });
    return {
      plan: p.plan,
      scene: p.scene,
      i2v: !!p.i2v,
      cycle: !!p.cycle,
      closeup: !!p.closeup,
      motion: p.motion,
      frames: p.frames,
      master: p.masterSrc ? `plan${p.plan}_master.png` : null,
      key: p.keySrc ? `keys/plan${p.plan}_key.png` : null,
      variants,
    };
  });
  writeJson(join(OUT, "plans", `${id}.json`), { plans, defects: DEFECTS });

  // Real result, retitled in English — the file on disk (workspace/out/*.verify.json)
  // has the same checks with section names and messages in Russian, which is
  // this tool's own internal language, not the public demo's.
  const verify = {
    verdict: "warn",
    counts: { pass: 20, warn: 2, fail: 0 },
    checkedAt: "2026-09-04T12:02:18.708Z",
    checks: [
      { section: "Format", verdict: "pass", message: "container mp4" },
      { section: "Format", verdict: "pass", message: "video codec H.264, High profile, level 4.1" },
      { section: "Format", verdict: "pass", message: "1920×1080, 30.00 fps, yuv420p" },
      { section: "Format", verdict: "pass", message: "audio AAC, 48000 Hz, 2 channels" },
      {
        section: "Format",
        verdict: "warn",
        message: "audio bitrate 96 kbps — below the 192k nominal (a quiet placeholder track compresses down; a real voice-over brings it back up)",
      },
      { section: "Format", verdict: "pass", message: "faststart: moov at the front of the file" },
      { section: "Timing", verdict: "pass", message: "duration 72.0 s, within the 60–180 s standard" },
      { section: "Timing", verdict: "pass", message: "within ±10% of the scenario's target (72 s)" },
      { section: "Timing", verdict: "pass", message: "every scene cut from a real take" },
      { section: "Timing", verdict: "pass", message: "no still-frame extension longer than a second" },
      { section: "Timing", verdict: "warn", message: "voice-over: placeholder — a real one (ElevenLabs) is needed before this ships" },
      { section: "Loudness", verdict: "pass", message: "integrated -16.2 LUFS (target −16 ±1)" },
      { section: "Loudness", verdict: "pass", message: "true peak -4.7 dBTP (threshold −1.5)" },
      { section: "Title cards (sampled mid-scene)", verdict: "pass", message: "s1: card in frame (brightness delta 191)" },
      { section: "Title cards (sampled mid-scene)", verdict: "pass", message: "s2: card in frame (brightness delta 201)" },
      { section: "Title cards (sampled mid-scene)", verdict: "pass", message: "s3: card in frame (brightness delta 188)" },
    ],
  };
  const buildLog = { createdAt: "2026-09-04T12:25:52.089Z", totalDuration: 72, voMode: "placeholder" };

  const roll = {
    id,
    title: compiled.title,
    durationTarget: compiled.duration_target ?? null,
    scenes,
    output: outMp4,
    buildLog,
    verify,
    priemka: false,
    acceptance: summarizeAcceptance(plans),
    updatedAt: Date.parse(verify.checkedAt),
    stage: "assembled",
  };
  rolls.push(roll);
  writeJson(join(OUT, "rolls", `${id}.json`), roll);
  const scenario = readScenario(id);
  if (scenario) writeJson(join(OUT, "scenarios", `${id}.json`), scenario);
}

// === opening-the-office: scenario written, nothing shot yet ================
{
  const id = "opening-the-office";
  const compiled = readJson(join(ROOT, "workspace", "prompts", "compiled", `${id}.json`));
  const scenes = compiled.scenes.map((sc) => ({ ...sceneShape(sc), frames: [], takes: [], rejected: 0 }));
  const roll = {
    id,
    title: compiled.title,
    durationTarget: compiled.duration_target ?? null,
    scenes,
    output: null,
    buildLog: null,
    verify: null,
    priemka: false,
    acceptance: null,
    updatedAt: Date.parse("2026-09-04T09:00:00.000Z"),
    stage: "planned",
  };
  rolls.push(roll);
  writeJson(join(OUT, "rolls", `${id}.json`), roll);
  const scenario = readScenario(id);
  if (scenario) writeJson(join(OUT, "scenarios", `${id}.json`), scenario);
}

// --- rolls.json, with an illustrative spend ledger --------------------------
rolls.sort((a, b) => b.updatedAt - a.updatedAt);
const spend = { backends: { wavespeed: { spent_usd: 4.85, runs: 6 } }, total_usd: 4.85 };
writeJson(join(OUT, "rolls.json"), { rolls, spend });

// --- workspace.json, real folder counts from this checkout ------------------
const folder = (key, dir, what) => ({
  key,
  path: dir.replace(ROOT + "\\", "").replace(ROOT + "/", "").replaceAll("\\", "/"),
  what,
  ...dirSize(dir),
});
writeJson(join(OUT, "workspace.json"), {
  root: "workspace",
  config: "engine/pipeline.config.json",
  folders: [
    folder("scenarios", join(ROOT, "workspace", "prompts", "scenarios"), "One YAML per episode. This is the source of truth — everything else is made from it."),
    folder("series", join(ROOT, "workspace", "prompts"), "series.yaml: the style, the cast and their reference sheets, the backgrounds."),
    folder("compiled", join(ROOT, "workspace", "prompts", "compiled"), "What the scenarios compile into. Every later stage reads these, not the YAML."),
    folder("refs", join(ROOT, "workspace", "refs"), "Reference sheets per character, named as in series.yaml."),
    folder("backgrounds", join(ROOT, "workspace", "backgrounds"), "One image per background."),
    folder("takes", join(ROOT, "workspace", "takes"), "Per roll: keyframes, generated clips, and _rejected/ for what was turned down."),
    folder("build", join(ROOT, "workspace", "build"), "Intermediate segments while an episode is being cut."),
    folder("out", join(ROOT, "workspace", "out"), "Finished episodes, each with its build log and its grade."),
  ],
});

console.log(`[demo-data] ${rolls.length} rolls, done.`);
