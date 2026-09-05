# Working in this repository

Firstlight turns a written scenario into a finished short film: keyframes,
motion, narration, captions, the cut and the acceptance report, with no editing
by hand. The scenario is the edit — there is no timeline. The example series
shipped here is *Harbour Light*, a fictional lighthouse and the three people
who run it, and it is the only series in this repository.

## A production run, in order

Each step is a command. Do not skip the two acceptance gates: they are the
whole reason this pipeline is cheaper than reshooting.

```bash
python engine/build_prompts.py                     # scenarios -> compiled JSON + prompt sheets
python engine/auto_storyboard.py --id <roll>       # scenes -> 3 shots each, start frames + end keys
#   >>> FRAME ACCEPTANCE — look at every master before anything moves
node engine/wavespeed_batch.mjs --id <roll> --model auto
#   >>> CLIP ACCEPTANCE — contact sheets and metrics, verdict per plan
node engine/tts_all.mjs --only <roll>              # narration, cached per line
node engine/assemble_from_plans.mjs --id <roll>    # title, scenes, captions, memo, audio
node engine/verify_video.mjs "workspace/out/<Title>.mp4"
```

- `--model auto` is not optional. Each plan carries its own `model`, because
  the wide of a scene needs an end frame (Kling 2.6 Pro) and its two solo shots
  do not (Kling 2.6 Std, same generation, 60% of the price). One command shoots
  the roll correctly; two `--only` lists with two `--model` flags is how plans
  get shot on the wrong model.
- **Frame acceptance** is a person or `engine/claude_agent.mjs` looking at
  `workspace/takes/<roll>/plan*_master.png`. A wrong frame costs a still; a
  wrong frame animated costs a clip and the ten minutes waiting for it. Check
  the first master's dimensions too — a portrait master pillarboxes the whole
  episode.
- **Clip acceptance** runs `python engine/qa_clip.py --dir
  workspace/takes/<roll>/_flf --plans workspace/plans/<roll>.json --out
  reports/qa-<roll>` first, then judges against
  [docs/QA-CHECKLIST.md](docs/QA-CHECKLIST.md).
- Add `--dry` to `auto_storyboard.py` and `wavespeed_batch.mjs` to see the plan
  and the estimate without spending anything. Do this first, every time.

## Hard rules

**Never spend without checking the ledger.** `reports/wavespeed-spend.json`
holds `spent_usd` and a row per call. Read it before any paid run, and quote
the estimate to the user before starting one. Every paid call goes through a
script that books the spend into that ledger — never call a paid API directly
from an ad-hoc script or a one-off `curl`, because a call that is not booked is
a call nobody can account for later.

**Never invent a character or a background.** Both come from
`workspace/prompts/series.yaml`, with reference sheets under `workspace/refs/`.
If a scene needs somebody who is not in the series, that is a question for the
author, not a name you choose. `check_scene_cast.py` enforces the cast; do not
work around it.

**English only in this repository.** Documentation, configuration, scenarios,
the interface and anything new you write. (The engine's older inline comments
are in Russian, the language it was built in — leave them, but do not add
more.) No real organisation, person or production appears anywhere here.

**No readable text inside generated frames.** Labels, signs, screens, spines
and pages are blank or illegible marks. Generated letters mutate frame to frame
and there is no way to fix them after the fact.

**Do not commit unless asked.** And never commit a key, a `.env`, or anything
under `reports/` or `workspace/takes/`.

## Where the state lives

| What | Where |
| --- | --- |
| Acceptance verdicts (accept / reject / redo per clip) | `workspace/<roll>/acceptance.json` |
| Shot plans | `workspace/plans/<roll>.json` |
| Frames and clips | `workspace/takes/<roll>/`, clips in `_flf/` |
| QA metrics and contact sheets | `reports/qa-<roll>/` |
| Money | `reports/wavespeed-spend.json`, `reports/gemini-spend.json` |
| Finished episodes | `workspace/out/`, with `.build-log.json` and `.verify.json` beside each |

`acceptance.json` is written by the interface and only ever **read** by the
engine. `wavespeed_batch.mjs` and `flf_batch.mjs` both consult it before
shooting: `accepted` is left alone even when the clip file is missing
(reshooting it takes `--redo`, deliberately), while `rejected` and `redo` are
reshot on the next run with no flag at all. Closing the server loses nothing —
the workspace was the state all along.

## The rules of the craft

- [docs/PRODUCTION-RULES.md](docs/PRODUCTION-RULES.md) — how a shot is framed,
  prompted, timed and cut, and which defect each rule prevents.
- [docs/QA-CHECKLIST.md](docs/QA-CHECKLIST.md) — the acceptance procedure, the
  thresholds, the fixed defect vocabulary and the verdict shape.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the three keyframe backends
  and the three motion backends, and when each is the right one.

## If you need to change a rule, change the config

The shooting rules are data, not prose: `production` and `qa` in
[`engine/pipeline.config.json`](engine/pipeline.config.json). `engine/guard.mjs`
and `engine/guard.py` read that one block, so the Python storyboard step and
the Node shooting step cannot disagree about what a motion prompt must say or
what a start frame must look like, and `qa_clip.py`, the acceptance screen and
the agent all flag the same clip against the same numbers.

So when a shot needs a different rule — a phrase unbanned, a threshold moved, a
composition clause reworded — change it there and let it apply to the whole
roll. Do **not** hand-edit the guard text into one plan's motion line or type
an exception into a prompt: that exception survives exactly one run, is invisible
to the checks, and is forgotten by the next person, who then pays for the same
defect again. If the change is worth making it is worth making once, in the
config, with a line in `docs/PRODUCTION-RULES.md` saying which defect it
prevents.
