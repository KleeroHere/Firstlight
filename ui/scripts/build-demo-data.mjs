#!/usr/bin/env node
// Generates the static snapshots the GitHub Pages demo (and a normal build
// previewed with ?demo=1) read instead of talking to a server — see DEMO in
// ../src/api.ts. Source: the Harbour Light example under workspace/.
//
//   node ui/scripts/build-demo-data.mjs
//
// fog-signal-check and handover-at-the-pier are both real productions now
// (character sheets and backgrounds via WaveSpeed Seedream 4, keyframes the
// same way, motion via Kling 2.6 through WaveSpeed, narration via ElevenLabs,
// a real assemble_video + verify_video pass) — every field below is read
// from workspace/plans/<id>.json, workspace/<id>/acceptance.json and
// workspace/out/<Title>.{verify,build-log}.json, and every file copied is
// the real take/master/key/output on disk; nothing here is fabricated.
// opening-the-office needs nothing invented at all: it really is just a
// written scenario, nothing shot yet.
//
// Idempotent: deletes and rewrites ui/public/demo/ each run. Run this by hand
// whenever the Harbour Light example changes and commit the result — it is
// not run in CI, because its source (workspace/takes/*) is generated media
// that needs WAVESPEED_API_KEY/ELEVENLABS_API_KEY and is gitignored, so a
// clean checkout does not have it. .github/workflows/ci.yml's deploy-demo
// job only builds the interface; it ships the demo/ folder already
// committed here.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "ui", "public", "demo");

// Files only. `takes/<roll>/keys/_raw/` (ungraded originals kept by
// color_match.py) and `_flf/_raw/` are directories, and cpSync on a
// directory without `recursive` throws ERR_FS_EISDIR — which is how a
// perfectly good demo build started failing the moment grading was added.
const list = (dir, pred = () => true) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).filter(pred)
    : [];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}
// The demo is a browsable snapshot, not a production archive. Copying the
// originals put 308 MB into the repository: 2560x1440 PNG start frames and
// 1080p clips, for a page whose largest viewport is a browser window. So
// pictures go in as 1280-wide JPEG and video is transcoded to 720p, unless
// --full is passed. `ffmpeg` does both; it is already required by the engine.
const FULL = process.argv.includes("--full");
const IMG_RE = /\.(png|jpe?g)$/i;
const VID_RE = /\.mp4$/i;

function ff(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (!FULL && IMG_RE.test(from)) {
    const out = to.replace(IMG_RE, ".jpg");
    ff(["-i", from, "-vf", "scale='min(1280,iw)':-2", "-q:v", "5", out]);
    return out;
  }
  if (!FULL && VID_RE.test(from)) {
    ff(["-i", from, "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-crf", "26",
        "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "96k", to]);
    return to;
  }
  cpSync(from, to);
  return to;
}
// A picture referenced in JSON must be referenced under the name it was
// written as, not the name it had on disk.
const web = (name) => (FULL ? name : name.replace(IMG_RE, ".jpg"));
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

// === fog-signal-check / handover-at-the-pier: real production, real media ==
// Both actually shot end to end (03-05.09) — real reference sheets and
// backgrounds (WaveSpeed Seedream 4), real keyframes, real motion (Kling 2.6
// via WaveSpeed), real ElevenLabs narration, a real assemble_video +
// verify_video pass. Nothing below is invented: every field is read from
// workspace/plans/<id>.json, workspace/<id>/acceptance.json and
// workspace/out/<Title>.{verify,build-log}.json, and every file copied is
// the actual take/master/key/output on disk.
function buildRealRoll(id, title) {
  const compiled = readJson(join(ROOT, "workspace", "prompts", "compiled", `${id}.json`));
  const takesDir = join(ROOT, "workspace", "takes", id);
  const flfDir = join(takesDir, "_flf");
  const keysDir = join(takesDir, "keys");
  const planSpec = readJson(join(ROOT, "workspace", "plans", `${id}.json`));
  const acceptancePath = join(ROOT, "workspace", id, "acceptance.json");
  const accFile = existsSync(acceptancePath) ? readJson(acceptancePath) : {};
  const acceptance = accFile.plans ?? {};
  // Two gates per roll since 05.09: `frames` judges the start frame before a
  // clip exists, `plans` judges the clip. The demo shows both, because "this
  // frame was rejected and why" is half the story of how the roll got here.
  const frameAcceptance = accFile.frames ?? {};

  const scenes = compiled.scenes.map((sc) => {
    const s = sceneShape(sc);
    s.frames = planSpec.plans.filter((p) => p.scene === s.id).map((p) => p.master).filter(Boolean).map(web);
    s.takes = list(takesDir, (f) => f.startsWith(`${s.id}_take`) && /\.(mp4|png|jpg)$/i.test(f)).sort();
    s.rejected = 0;
    return s;
  });
  for (const f of s_takeFiles(takesDir)) copy(join(takesDir, f), join(OUT, "files", "takes", id, f));
  // Clips only. `_flf/` also holds the ffmpeg concat lists (`s1_list.txt`),
  // which are absolute paths on whoever's machine built the roll — no use in a
  // browser and not something to publish.
  for (const f of list(flfDir, (f) => VID_RE.test(f))) copy(join(flfDir, f), join(OUT, "files", "takes", id, "_flf", f));
  for (const f of list(keysDir)) copy(join(keysDir, f), join(OUT, "files", "takes", id, "keys", f));

  const outMp4 = `${title}.mp4`;
  copy(join(ROOT, "workspace", "out", outMp4), join(OUT, "files", "out", outMp4));

  const plans = planSpec.plans.map((p) => {
    const key = `plan${p.plan}`;
    const dec = acceptance[key] ?? {};
    const clipFile = `_flf/plan${p.plan}.mp4`;
    const variants = existsSync(join(flfDir, `plan${p.plan}.mp4`))
      ? [{ file: clipFile, key, decision: dec.decision ?? null, defects: dec.defects ?? [], comment: dec.comment ?? "" }]
      : [];
    return {
      plan: p.plan,
      scene: p.scene,
      i2v: !!p.i2v,
      cycle: !!p.cycle,
      closeup: p.shot === "close",
      motion: p.motion,
      frames: p.frames,
      master: p.master ? web(p.master) : null,
      key: p.use_key ? web(`keys/plan${p.plan}_key.png`) : null,
      keyMode: p.key_mode ?? null,
      role: p.role ?? p.shot ?? null,
      model: p.model ?? null,
      frame: frameAcceptance[key]
        ? { decision: frameAcceptance[key].decision, defects: frameAcceptance[key].defects ?? [], comment: frameAcceptance[key].comment ?? "" }
        : null,
      variants,
    };
  });
  writeJson(join(OUT, "plans", `${id}.json`), { plans, defects: DEFECTS });
  const frameCounts = Object.values(frameAcceptance).reduce(
    (a, v) => ({ ...a, [v.decision]: (a[v.decision] ?? 0) + 1 }), {});

  const verify = readJson(join(ROOT, "workspace", "out", `${title}.verify.json`));
  const buildLog = readJson(join(ROOT, "workspace", "out", `${title}.build-log.json`));

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
    frameAcceptance: frameCounts,
    updatedAt: Date.parse(verify.checkedAt),
    stage: "assembled",
  };
  rolls.push(roll);
  writeJson(join(OUT, "rolls", `${id}.json`), roll);
  const scenario = readScenario(id);
  if (scenario) writeJson(join(OUT, "scenarios", `${id}.json`), scenario);
}
function s_takeFiles(takesDir) {
  return list(takesDir, (f) => /^s\d+_take\d+\.(mp4|png|jpg)$/i.test(f) || /^plan\d+_master\.png$/i.test(f));
}
buildRealRoll("fog-signal-check", "Fog signal check");
buildRealRoll("handover-at-the-pier", "Handover at the pier");

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

// --- rolls.json, with the real spend ledger ---------------------------------
// From reports/wavespeed-spend.json for 2026-09-05 (both rolls: 7 reference
// sheets, 3 backgrounds, 18 keyframes/keys, 17 motion clips including 3
// reshoots after QA rejects) — a snapshot, not live-computed, since that
// ledger lives outside this repository's workspace.
rolls.sort((a, b) => b.updatedAt - a.updatedAt);
const spend = {
  backends: {
    wavespeed: {
      spent_usd: 4.526,
      runs: 52,
      breakdown: { "stills (Seedream 4, refs+backgrounds+keyframes)": 1.026, "motion i2v (Kling 2.6 Std)": 2.1, "motion first-last-frame (Kling 2.6 Pro)": 1.4 },
    },
  },
  total_usd: 4.526,
};
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
