#!/usr/bin/env node
// Claude as a stage of the pipeline: acceptance, and storyboard review.
//
// Two things happen in this pipeline that are judgement, not arithmetic:
// deciding whether a shot clip is good enough to keep, and deciding whether a
// scene has been broken into the right shots. Both were being done by whoever
// happened to be at the keyboard, against a checklist they had to remember.
// This script makes them a command, so the rule is the product's rather than
// the operator's.
//
//   node engine/claude_agent.mjs qa         --roll fog-signal-check
//   node engine/claude_agent.mjs frames     --roll fog-signal-check
//   node engine/claude_agent.mjs storyboard --roll fog-signal-check
//
// Every mode runs one of two ways, and picks automatically:
//
//   API mode      — with ANTHROPIC_API_KEY set (and `npm install` run in
//                   engine/), it calls Claude with the checklist and the
//                   contact sheets as images, and writes the verdicts straight
//                   into workspace/<roll>/acceptance.json.
//
//   packet mode   — with no key, or with --packet, it writes an "agent packet"
//                   to workspace/<roll>/_review/<mode>/: the contact sheets,
//                   the metrics, the motion lines, the checklist, and a
//                   verdict template. Hand that folder to any agent session —
//                   Claude Code, another LLM, or a person — and apply what
//                   comes back with:
//
//                     node engine/claude_agent.mjs qa --roll <id> \
//                          --apply workspace/<id>/_review/qa/verdict.json
//
// The packet is not a downgrade. It is how a human reviewer and a model
// reviewer are given exactly the same evidence, which is the only way their
// verdicts can be compared — and it is what makes this pipeline usable from an
// agent session that has no API key of its own.
//
// Flags (all modes):
//   --roll <id>        the roll to review (required)
//   --packet           write the packet even if a key is available
//   --apply <file>     apply a verdict file to acceptance.json and exit
//   --model <id>       override the model (default $ANTHROPIC_MODEL or claude-sonnet-5)
//   --only <n,n>       restrict to these plan numbers
//   --dry              print what would be sent/written, do nothing
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, loadConfig } from "./lib.mjs";

const cfg = loadConfig();
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MODES = ["qa", "frames", "storyboard"];

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const a = { mode: argv[2] };
  for (let i = 3; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--roll" || v === "--id") a.roll = argv[++i];
    else if (v === "--packet") a.packet = true;
    else if (v === "--apply") a.apply = argv[++i];
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--only") a.only = argv[++i].split(",").map(Number);
    else if (v === "--dry") a.dry = true;
    else throw new Error(`Unknown argument: ${v}`);
  }
  if (!MODES.includes(a.mode)) throw new Error(`Usage: claude_agent.mjs <${MODES.join("|")}> --roll <id> [--packet] [--apply <file>]`);
  if (!a.roll) throw new Error("Need --roll <id>");
  a.model = a.model ?? DEFAULT_MODEL;
  return a;
}
const args = parseArgs(process.argv);

const rollDir = join(ROOT, "workspace", args.roll);
const takesDir = join(ROOT, cfg.paths.takes, args.roll);
const plansPath = join(ROOT, "workspace", "plans", `${args.roll}.json`);
const acceptancePath = join(rollDir, "acceptance.json");
const reviewDir = join(rollDir, "_review", args.mode);
const qaDir = join(ROOT, "reports", `qa-${args.roll}`);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, d) => { mkdirSync(join(p, "..").replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true }); writeFileSync(p, JSON.stringify(d, null, 2) + "\n"); };

// ---------------------------------------------------------------- checklist
// The checklist is a document in the repository, not a string in this file:
// the reviewer a person reads and the reviewer a model reads must be the same
// text, or the two will drift and nobody will notice which one moved.
function checklistText() {
  const p = join(ROOT, "docs", "QA-CHECKLIST.md");
  if (existsSync(p)) return readFileSync(p, "utf8");
  return "docs/QA-CHECKLIST.md is missing — no checklist to apply. Restore it before reviewing anything.";
}

const DEFECTS = [
  "extra_person", "extra_hand", "object_moved", "text_changed", "face_drift",
  "clothes_changed", "prop_changed", "left_frame", "no_motion", "wrong_motion",
  "jump", "color_drift", "blur", "k0_mismatch", "k1_mismatch",
  // frame-acceptance only
  "faces_camera", "hands_hidden", "mouth_open", "door_visible", "wrong_aspect", "tone_mismatch",
];

// ---------------------------------------------------------------- gathering
function plans() {
  if (!existsSync(plansPath)) throw new Error(`No plan list ${plansPath}`);
  let ps = readJson(plansPath).plans;
  if (args.only) ps = ps.filter((p) => args.only.includes(p.plan));
  return ps;
}

function metrics() {
  const p = join(qaDir, "metrics.json");
  if (!existsSync(p)) return [];
  return readJson(p);
}

// A packet is meant to be handed to somebody else, so nothing in it may be a
// path that only exists on this machine.
const rel = (p) => (p ? p.slice(p.startsWith(ROOT) ? ROOT.length + 1 : 0).split("\\").join("/") : p);

// One review item per plan: the evidence a reviewer needs and nothing else.
function items() {
  const ms = new Map(metrics().map((m) => [m.plan, m]));
  return plans().map((p) => {
    const it = { plan: p.plan, scene: p.scene, shot: p.shot ?? p.role, motion: p.motion };
    if (args.mode === "qa") {
      it.metrics = ms.get(p.plan) ?? null;
      it.sheet = join(qaDir, `plan${p.plan}.jpg`);
      it.clip = join(takesDir, "_flf", `plan${p.plan}.mp4`);
      it.start_frame = join(takesDir, p.master ?? "");
      it.end_key = p.use_key ? join(takesDir, "keys", `plan${p.plan}_key.png`) : null;
      it.key_mode = p.key_mode ?? null;
    } else if (args.mode === "frames") {
      it.image = join(takesDir, p.master ?? "");
      it.end_key = p.use_key ? join(takesDir, "keys", `plan${p.plan}_key.png`) : null;
      it.cast_size = p.cast_size ?? null;
    }
    return it;
  });
}

// A start frame is a 2560x1440 PNG — far more than a reviewer needs and more
// than is polite to send over an API. Downscale to a JPEG beside the packet.
function previewOf(src, out, width = 1280) {
  mkdirSync(join(out, "..").replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `scale=${width}:-2`, "-q:v", "4", out]);
  return out;
}

// ---------------------------------------------------------------- the packet
const PACKET_README = (mode, roll) => `# Review packet — ${roll} (${mode})

Everything a reviewer needs to judge this roll, and nothing they have to go
looking for. Generated by \`node engine/claude_agent.mjs ${mode} --roll ${roll} --packet\`.

## What is here

| File | What it is |
|---|---|
| \`CHECKLIST.md\` | The acceptance checklist, verbatim from \`docs/QA-CHECKLIST.md\`. |
| \`items.json\` | One entry per plan: its motion line, its metrics, and the paths to its evidence. |
| \`sheets/\` | ${mode === "qa" ? "A 12-frame contact sheet per clip — the frames to judge." : "A preview of each start frame."} |
| \`verdict.template.json\` | The shape your answer must take. Copy it to \`verdict.json\` and fill it in. |

## What to do

Judge each plan against \`CHECKLIST.md\` using the evidence in \`items.json\`.
Doubt resolves to \`reject\`: a reshoot costs cents, a defect in a finished
episode costs the episode. A \`reject\` must name a **cause to change** — the
motion line, or the start frame — not just "try another seed".

Write your answer as \`verdict.json\` next to this file, then apply it:

    node engine/claude_agent.mjs ${mode} --roll ${roll} --apply workspace/${roll}/_review/${mode}/verdict.json

## Verdict vocabulary

${DEFECTS.map((d) => `- \`${d}\``).join("\n")}
`;

function writePacket() {
  mkdirSync(reviewDir, { recursive: true });
  const list = items();
  const sheetsDir = join(reviewDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });
  for (const it of list) {
    const src = args.mode === "qa" ? it.sheet : it.image;
    if (src && existsSync(src)) {
      const out = join(sheetsDir, `plan${it.plan}.jpg`);
      if (args.mode === "qa") copyFileSync(src, out);
      else previewOf(src, out);
      it.packet_image = `sheets/plan${it.plan}.jpg`;
    } else {
      it.packet_image = null;
      it.missing = `no evidence file at ${src}`;
    }
  }
  writeFileSync(join(reviewDir, "CHECKLIST.md"), checklistText(), "utf8");
  writeFileSync(join(reviewDir, "README.md"), PACKET_README(args.mode, args.roll), "utf8");
  const portable = list.map((it) => ({
    ...it,
    sheet: rel(it.sheet), clip: rel(it.clip), image: rel(it.image),
    start_frame: rel(it.start_frame), end_key: rel(it.end_key), missing: it.missing ? rel(it.missing) : undefined,
  }));
  writeFileSync(join(reviewDir, "items.json"), JSON.stringify({ roll: args.roll, mode: args.mode, thresholds: cfg.qa.thresholds, items: portable }, null, 2), "utf8");
  writeFileSync(join(reviewDir, "verdict.template.json"), JSON.stringify(
    list.map((it) => ({ plan: it.plan, verdict: "accept|reject", reasons: [], note: "which frame, and what exactly", cause: "prompt|start-frame|none", confidence: 0.0 })), null, 2), "utf8");
  console.log(`packet: ${reviewDir}`);
  console.log(`  ${list.length} plans, ${list.filter((i) => i.packet_image).length} with an image`);
  for (const it of list.filter((i) => i.missing)) console.log(`  ⚠ plan ${it.plan}: ${it.missing}`);
  console.log(`\nHand this folder to a reviewer, then:\n  node engine/claude_agent.mjs ${args.mode} --roll ${args.roll} --apply ${join(reviewDir, "verdict.json")}`);
}

// ---------------------------------------------------------------- applying
// Two acceptance passes happen per roll and they must not overwrite each
// other: `frames` judges the start frame BEFORE a clip exists, `qa` judges the
// clip afterwards. They live in separate keys of the same file — `frames` and
// `plans` — because wavespeed_batch.mjs reads `plans` to decide what still
// needs shooting, and a frame verdict landing there would tell it that a clip
// it has never shot is already accepted.
const SECTION = { qa: "plans", frames: "frames", storyboard: "storyboard" };

function applyVerdict(file) {
  const verdicts = readJson(resolve(file));
  const acc = existsSync(acceptancePath) ? readJson(acceptancePath) : {};
  const section = SECTION[args.mode] ?? "plans";
  acc[section] = acc[section] ?? {};
  let accepted = 0, rejected = 0;
  for (const v of verdicts) {
    const decision = v.verdict === "accept" ? "accepted" : "rejected";
    if (decision === "accepted") accepted++; else rejected++;
    acc[section][`plan${v.plan}`] = {
      decision,
      defects: v.reasons ?? [],
      comment: [v.note, v.cause && v.cause !== "none" ? `cause: ${v.cause}` : null,
                v.confidence != null ? `confidence ${v.confidence}` : null].filter(Boolean).join(" — "),
      reviewer: v.reviewer ?? `claude_agent.mjs ${args.mode}`,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    };
  }
  mkdirSync(rollDir, { recursive: true });
  writeFileSync(acceptancePath, JSON.stringify(acc, null, 2) + "\n", "utf8");
  console.log(`${acceptancePath} [${section}]: ${accepted} accepted, ${rejected} rejected`);
  const bad = verdicts.filter((v) => v.verdict !== "accept");
  for (const v of bad) console.log(`  plan ${v.plan}: ${(v.reasons ?? []).join(", ") || "rejected"} — ${v.note ?? ""}`);
  // A rejected plan is un-shot as far as wavespeed_batch.mjs is concerned: it
  // reads this same file and reshoots anything not marked accepted.
  if (bad.length) console.log(`\nReshoot with:\n  node engine/wavespeed_batch.mjs --id ${args.roll} --model auto --only ${bad.map((v) => v.plan).join(",")}`);
}

// ---------------------------------------------------------------- API mode
const SYSTEM = (mode) => `You are the acceptance reviewer for a small animation pipeline. You are given, for
each shot, the evidence listed below and the checklist that decides. You do not
generate anything and you do not rewrite plans: you judge, and you say why.

${checklistText()}

Rules that override anything you might infer:
- Doubt resolves to reject. A reshoot costs cents; a defect in a finished episode costs the episode.
- A reject must name a cause to change — "prompt" (the motion line invites the defect) or
  "start-frame" (the frame itself is wrong) — never "different seed".
- Judge only what you can see. Do not assume a defect you cannot point at in a numbered frame.
- Reasons must come from the fixed vocabulary: ${DEFECTS.join(", ")}.
${mode === "frames" ? "- You are judging START FRAMES, not clips: composition, cast, hands, mouth, doors, aspect ratio, tone." : "- You are judging CLIPS through a 12-frame contact sheet: frame 1 is the first frame, the last is the last."}`;

const VERDICT_TOOL = {
  name: "submit_verdicts",
  description: "Record one verdict per plan reviewed.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            plan: { type: "integer" },
            verdict: { type: "string", enum: ["accept", "reject"] },
            reasons: { type: "array", items: { type: "string", enum: DEFECTS } },
            note: { type: "string", description: "Which numbered frame, and what exactly is wrong or right." },
            cause: { type: "string", enum: ["prompt", "start-frame", "none"] },
            confidence: { type: "number" },
          },
          required: ["plan", "verdict", "reasons", "note", "cause", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  },
};

async function apiMode() {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    console.error("The Anthropic SDK is not installed. Either:\n" +
      "  cd engine && npm install        (then re-run this command)\n" +
      "or run the same review without a key, as a packet:\n" +
      `  node engine/claude_agent.mjs ${args.mode} --roll ${args.roll} --packet`);
    process.exit(2);
  }
  const client = new Anthropic();
  const list = items();
  const content = [];
  for (const it of list) {
    const src = args.mode === "qa" ? it.sheet : it.image;
    if (!src || !existsSync(src)) { console.log(`⚠ plan ${it.plan}: no evidence, skipped`); continue; }
    let img = src;
    if (args.mode === "frames") {
      mkdirSync(reviewDir, { recursive: true });
      img = previewOf(src, join(reviewDir, `plan${it.plan}.jpg`));
    }
    content.push({ type: "text", text:
      `--- plan ${it.plan} (scene ${it.scene}, ${it.shot}) ---\n` +
      `commissioned motion: ${it.motion}\n` +
      (it.metrics ? `metrics: ${JSON.stringify(it.metrics)}\n` : "") +
      (it.key_mode ? `end key: ${it.key_mode}\n` : "") });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(img).toString("base64") } });
  }
  if (!content.length) { console.error("Nothing to review — no contact sheets or frames on disk."); process.exit(1); }
  content.push({ type: "text", text: `Review every plan above and call submit_verdicts exactly once, with one entry per plan. Thresholds in force: ${JSON.stringify(cfg.qa.thresholds)}` });

  if (args.dry) { console.log(`would send ${content.length} blocks to ${args.model}`); return; }
  console.log(`${args.model}: reviewing ${list.length} plans of ${args.roll}…`);
  const resp = await client.messages.create({
    model: args.model,
    max_tokens: 16000,
    system: SYSTEM(args.mode),
    tools: [VERDICT_TOOL],
    messages: [{ role: "user", content }],
  });
  const call = resp.content.find((b) => b.type === "tool_use" && b.name === "submit_verdicts");
  if (!call) {
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    throw new Error(`No verdicts returned (stop_reason ${resp.stop_reason}).\n${text.slice(0, 800)}`);
  }
  mkdirSync(reviewDir, { recursive: true });
  const out = join(reviewDir, "verdict.json");
  const verdicts = call.input.verdicts.map((v) => ({ ...v, reviewer: `${args.model} via claude_agent.mjs` }));
  writeFileSync(out, JSON.stringify(verdicts, null, 2) + "\n", "utf8");
  console.log(`verdicts: ${out}`);
  applyVerdict(out);
}

// ---------------------------------------------------------------- storyboard
// A different question from acceptance: not "is this clip good" but "is this
// scene cut into the right shots". Packet-only for now — it produces a written
// review, not a machine verdict, because a plan list is edited by a person or
// by auto_storyboard.py, never by a reviewer directly.
function storyboardPacket() {
  mkdirSync(reviewDir, { recursive: true });
  const compiled = join(ROOT, cfg.paths.compiled, `${args.roll}.json`);
  const sn = existsSync(compiled) ? readJson(compiled) : null;
  const ps = plans();
  const byScene = {};
  for (const p of ps) (byScene[p.scene] ??= []).push({ plan: p.plan, role: p.role ?? p.shot, cast_size: p.cast_size, motion: p.motion, key: p.key_mode ?? (p.use_key ? "yes" : "no") });
  writeFileSync(join(reviewDir, "items.json"), JSON.stringify({
    roll: args.roll,
    rules: cfg.production,
    scenes: (sn?.scenes ?? []).filter((s) => (s.kind ?? "scene") === "scene").map((s) => ({
      id: s.id, seconds: s.t[1] - s.t[0], plate: s.plate, cast: s.chars, background: s.bg,
      narration: s.vo, action: s.anim, shots: byScene[s.id] ?? [],
    })),
  }, null, 2), "utf8");
  writeFileSync(join(reviewDir, "README.md"), `# Storyboard review — ${args.roll}

\`items.json\` holds every scene of this roll with its narration, its action
line, and the shots \`auto_storyboard.py\` derived from it, plus the production
rules in force (\`engine/pipeline.config.json\` -> \`production\`).

Judge each scene against the rules in \`docs/PRODUCTION-RULES.md\`:

1. Does the scene have at least three shots, and do they read wide -> medium -> close?
2. Does each shot's motion describe **one** action with **one** object, and can that
   action visibly finish inside 5 seconds?
3. Is the end key right — \`closed\` only where the action genuinely returns to where
   it started, \`edit\` where the world changes?
4. Does the narration have room? Roughly 15 characters per second of scene.
5. Is any shot's motion line inviting a defect the guard cannot catch?

Answer in prose, per scene, naming the plan numbers you would change and what to
change them to. A storyboard review is applied by editing the scenario
(\`workspace/prompts/scenarios/${args.roll}.yaml\`) and re-running
\`build_prompts.py\` + \`auto_storyboard.py\`, not by editing the plan list by hand.
`, "utf8");
  console.log(`packet: ${reviewDir}`);
}

// ---------------------------------------------------------------- go
if (args.apply) {
  applyVerdict(args.apply);
} else if (args.mode === "storyboard") {
  storyboardPacket();
} else if (args.packet || !process.env.ANTHROPIC_API_KEY) {
  if (!process.env.ANTHROPIC_API_KEY && !args.packet) {
    console.log("No ANTHROPIC_API_KEY — writing an agent packet instead of calling the API.\n");
  }
  writePacket();
} else {
  await apiMode();
}
