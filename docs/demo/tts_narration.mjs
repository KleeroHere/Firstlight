#!/usr/bin/env node
// One-off narration synth for the "How Firstlight works" explainer video —
// not part of the engine (this video isn't a scenario roll), so it talks to
// ElevenLabs directly rather than through tts_all.mjs. Same endpoint, same
// voice as the rest of the series (pipeline.config.json), same environment
// convention as the rest of this session: export the key yourself, this
// script only reads it from process.env.
//
//   node docs/demo/tts_narration.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "engine", "pipeline.config.json"), "utf8"));
const el = cfg.audio.elevenlabs;
const KEY = process.env[el.apiKeyEnv];
if (!KEY) throw new Error(`No ${el.apiKeyEnv} in the environment`);

const OUT = join(ROOT, "docs", "demo", "audio");
mkdirSync(OUT, { recursive: true });

const SECTIONS = [
  ["01-what", "Firstlight turns a written scenario into a finished training film. You write the scenes — who is in frame, what happens, what the narrator says — and the pipeline does the rest: keyframes, motion, narration, captions, cut and grade."],
  ["02-scenario", "There is no timeline and no editor. Every scene names its cast, its background, what the frame shows, and the one movement it makes. Save it, and it compiles straight into prompts — the same style, the same character sheets, every time, so a face stays the same face across forty frames."],
  ["03-keyframes", "Every shot gets a first frame, and, where the motion needs one, a last frame too. They land on an acceptance sheet with a checklist per frame. A keyframe costs a few cents. The same mistake animated into a clip costs a dollar and ten minutes, so a person checks the frame before anything moves."],
  ["04-motion", "Motion runs on a rented GPU, an owned one, or a cloud API — Kling, Seedance or Wan through WaveSpeed — the same plan-list either way. Switching backend is a different command, never a code change."],
  ["05-qa", "Every clip gets a contact sheet and a defect checklist: an extra hand, a moved object, a face that drifted. Accept, reject, or redo with a comment — the decision is written once, to a file the engine only ever reads, and a rejected plan is reshot on the very next run with no flag needed."],
  ["06-cut", "Once the takes exist, everything after is deterministic. Captions are drawn from the scenario. Narration is synthesised per line and placed on its own timecode. The cut is a concat, not a judgement call. Then the film is graded against a written standard, and the report is what the interface shows."],
  ["07-cost", "A keyframe is a few cents. A five-second clip is well under a dollar on a cloud API, or free on an owned GPU. A finished two-minute episode comes from a scenario, a few dollars of generation, and no timeline software at all."],
];

async function api(path, init) {
  const r = await fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { "xi-api-key": KEY, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

let totalChars = 0;
for (const [name, text] of SECTIONS) {
  const out = join(OUT, `${name}.mp3`);
  totalChars += text.length;
  if (existsSync(out)) { console.log(`${name}: exists (${text.length} chars)`); continue; }
  const resp = await api(`/v1/text-to-speech/${el.voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: el.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true } }),
  });
  writeFileSync(out, Buffer.from(await resp.arrayBuffer()));
  console.log(`${name}: synthesised (${text.length} chars) -> ${out}`);
}
console.log(`total narration characters: ${totalChars}`);
