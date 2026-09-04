<p align="center">
  <img src="docs/brand/firstlight.png" width="150" alt="Firstlight" />
</p>

<h1 align="center">Firstlight</h1>

<p align="center"><b>The first frame, and everything after it.</b><br/>
A pipeline that turns a written scenario into a finished training film — keyframes, motion, narration, captions, cut and acceptance — with no editing by hand.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node_22-engine_%2B_server-3c873a?logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/Python_3-prompts_%2B_checks-3776ab?logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/ffmpeg-cut_%2B_grade-007808" alt="ffmpeg" />
  <img src="https://img.shields.io/badge/React_19-interface-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/license-MIT-8957e5" alt="MIT" />
</p>

> **Where the name comes from.** *First light* is the moment a new telescope produces its first image — the instrument works. It is also dawn, which makes it family to [Aurora](https://github.com/KleeroHere/Aurora), the offline knowledge base these films are made for. And it is, literally, the *first frame*: the whole engine is built on first-frame-to-last-frame video generation. Aurora is what people see. Firstlight is how the films inside it get made.

## What it does

You write an episode as a scenario: scenes with a caption, who is in the frame, which background, what the frame shows, how it moves, and what the narrator says. Firstlight does the rest:

1. **Compiles** the scenario into frame prompts, with the series style and each character's reference sheets attached — the same sheets every time, so a face stays the same face across forty frames.
2. **Generates keyframes** — the first and last frame of every shot — and lays them out on an acceptance sheet with a checklist per frame.
3. **Generates motion** between those two frames on a rented GPU (Wan 2.2 first-last-frame in ComfyUI), in batches, overnight, with a queue that knows what is already done.
4. **Cuts the episode**: title card, captions over every scene, dividers, a closing memo card, narration synthesised per line and placed on its timecode, loudness normalised to broadcast level, encoded for the target player.
5. **Grades it** against a written standard — container, codec, resolution, duration against target, loudness, every scene present, every caption actually visible in the frame — and writes the report as a file the interface reads.

There is no timeline and no editor. The scenario is the edit.

| The acceptance screen | One roll, keyframes and takes |
| --- | --- |
| ![Rolls](docs/screenshots/rolls.png) | ![Roll](docs/screenshots/roll.png) |

## Why it is built this way

Three facts about the production shaped everything else:

- **Consistency is the whole problem.** An illustrated series with a fixed cast lives or dies on whether the keeper looks like the keeper in every frame. So every frame prompt carries the same reference sheets, the same "passport" line for each character, and the same consistency clause verbatim; a scene names only the people who are in it; and the second keyframe of a shot is generated *from* the first, not from the description again.
- **Generation is expensive, judgement is cheap.** A keyframe is a few cents and a minute; a wrong keyframe animated into a clip is a dollar and ten minutes. So keyframes are checked by eye one at a time *before* anything moves, the pipeline never regenerates what already exists unless told to, and every stage writes a state file so a night run can pick up where it left off.
- **Nobody edits video at 2 a.m.** Everything after the takes exist is deterministic: captions are drawn from the scenario, narration is placed by timecode, the cut is a concat without re-encoding, and acceptance is a script. The morning report says which episodes are done and which frames need a human.

## The pipeline

```mermaid
flowchart LR
    S["scenario.yaml<br/>+ series.yaml"] -->|build_prompts| C["compiled JSON<br/>+ prompt sheets"]
    C -->|gemini_shots / flf_keys| K["keyframes<br/>first · last per shot"]
    K -->|keys_sheet| A["acceptance sheet<br/>checklist per frame"]
    A -->|flf_batch on ComfyUI| T["takes<br/>one clip per scene"]
    T -->|tts_all| V["narration<br/>cached per line"]
    T -->|assemble_video| E["episode.mp4<br/>+ build-log.json"]
    V --> E
    E -->|verify_video| R["verify.json<br/>pass · warn · fail"]
    R --> UI["interface"]
    A --> UI
```

### Stages and their scripts

| Stage | Script | What it does |
| --- | --- | --- |
| Compile | `build_prompts.py` | YAML scenarios → prompt sheets (`sheets/*.md`) and compiled JSON, one per roll. Validates cast against the series, warns about a line that will not fit its scene. |
| Plan | `make_plans.py`, `preflight_plans.py`, `check_plan_counts.py`, `check_scene_cast.py` | Shot plans per scene; checks that every scene has the right number of shots and that nobody appears who is not in the cast. |
| Keyframes | `gemini_shots.mjs`, `gemini_frames.mjs`, `flf_keys.mjs` | First and last frame per shot through the Gemini image API, references attached. `--only s2,s3` regenerates by name; nothing else is touched. |
| Review | `keys_sheet.mjs`, `flf_verify.mjs`, `keys_delta.py`, `align_keys.py` | The acceptance sheet; a measure of how much a shot's two keys differ (a frozen shot is caught here, before it is animated). |
| Motion | `flf_batch.mjs`, `comfy_batch.mjs`, `comfy_frames.mjs`, `flf_night.mjs`, `flf_trim.mjs`, `krupno.mjs` | Batches keyframe pairs through a ComfyUI workflow on a RunPod GPU, polls the queue, downloads clips, trims, and adds close-up "detail" shots. `pod_exec.mjs` runs commands on the pod when SSH is not available. |
| Intake | `sort_downloads.mjs`, `collect_shots.mjs`, `ingest_manual_shots.mjs`, `shot_kits.mjs` | Files a folder of downloads into the right scenes; assembles the kit of references a human needs to redo a shot by hand. |
| Narration | `tts_all.mjs`, `verify_vo_fit.mjs`, `retime_scenes.mjs` | One ElevenLabs call per line, cached — a re-cut costs nothing; checks every line fits its scene at the narrator's reading speed. |
| Cut | `assemble_video.mjs`, `replace_plates.mjs`, `make_synthetic_takes.mjs` | Renders the graphic cards, overlays captions, places narration, normalises loudness, encodes H.264 High 4.1 with faststart. `make_synthetic_takes` fakes the takes so the cut can be tested without a GPU. |
| Grade | `verify_video.mjs`, `verify_clips.mjs` | The written standard as a script; the result printed for a person and written as JSON for the interface. |
| Night | `run_night.mjs`, `night_batch.mjs`, `spend.mjs` | One process for the night: shoot what has keys, cut what has takes, grade what has a cut, write the morning summary. Money spent is tracked per stage. |

`engine/lib.mjs` holds the handful of things every script shares: config, paths, `ffprobe`, running a command. `engine/paths.py` is the same for the Python side. Everything reads `engine/pipeline.config.json`.

## The interface

The engine ran from the command line for a month. What it needed was not a dashboard but a better version of the one thing that was already there: the acceptance sheet — a static HTML page the keyframe stage wrote beside the frames, with a checklist per frame, opened in a browser and acted on in a file manager.

The interface is that page made live. It reads the same folders the scripts read, shows every roll and how far it has got, every scene with its keyframes and the checklist, the takes, the cut episode and its grade — and it runs the scripts. Rejecting a frame moves it to `_rejected/`, which is where the engine already kept them. There is no database: close the server and nothing is lost, because the workspace was the state all along.

```
ui/server/server.mjs   lists rolls, serves frames and clips, runs scripts as jobs (SSE log)
ui/src/                React, two screens and a drawer; Aurora's tokens with Firstlight's palette
```

## Quick start — the example series

The repository ships a small fictional series so the whole loop can be run without a GPU, an API key, or a production behind it: *Harbour Light*, a lighthouse and the three people who run it. `workspace/prompts/series.yaml` defines the world; `workspace/prompts/scenarios/fog-signal-check.yaml` is one 72-second episode.

```bash
pip install pyyaml               # ffmpeg and ffprobe on PATH, Node 22
python engine/build_prompts.py   # scenario → compiled JSON + prompt sheet
node engine/make_synthetic_takes.mjs --id fog-signal-check
node engine/assemble_video.mjs --id fog-signal-check --placeholder-vo
node engine/verify_video.mjs "workspace/out/Fog signal check.mp4"
```

That produces a real 1080p30 episode — title card, three captioned scenes, a memo card, placeholder narration, normalised audio — and grades it: on the example it comes out 20 pass, 2 warn, 0 fail — both warnings about the placeholder narration (it is silent, so the audio track compresses below the nominal bitrate). With a real voice they go away.

### The interface

On Windows, double-click **`start.cmd`** in the repository root. It installs
what is missing, builds the interface if the sources are newer than the build,
serves both the interface and the API on one port and opens the browser at
<http://localhost:7331>. Closing the window stops it.

The same thing by hand, on any platform:

```bash
cd ui && npm install && npm run build
cd .. && node ui/server/server.mjs --serve dist   # http://localhost:7331
```

While working on the interface itself, run the two halves separately so Vite
can hot-reload:

```bash
node ui/server/server.mjs   # API and files on :7331
cd ui && npm run dev        # interface on :1421, proxying /api to the server
```

### Making it real

Three things turn the example into a production, all of them configuration:

- **Keyframes** — `GEMINI_API_KEY` in the environment, reference sheets in `workspace/refs/<character>/` named as in `series.yaml`.
- **Motion** — a ComfyUI host with the Wan 2.2 first-last-frame workflow (`engine/wan22_i2v_nag.api.json` is the one used in production): `--host https://<pod>-8188.proxy.runpod.net`, `POD_ID` for `pod_exec`.
- **Narration** — `ELEVENLABS_API_KEY`, and one `voiceId` in `pipeline.config.json`, pinned for the life of the series.

## Honest notes

- This engine was built for one production — thirty-odd episodes for a staff handbook — and generalised afterwards. The shape is general; some defaults (durations, caption length, the 1920×1080/30 target) are that production's standard.
- The engine's inline comments are in Russian, the language it was built in. The README, the configuration, the interface and the example are in English. The comments are worth reading even so: most of them record why a decision was made, usually after something went wrong at night.
- The example series is fictional. No real organisation, person or film appears in this repository.

## License

MIT — see [LICENSE](LICENSE).
