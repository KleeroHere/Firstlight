# Acceptance checklist

How a shot clip is accepted or rejected. This is the reviewer's procedure —
whether the reviewer is a person at the acceptance screen or an agent running
`engine/claude_agent.mjs`, the inputs, the vocabulary and the verdict shape are
the same, so the two are comparable and either can hand off to the other.

The reviewer **judges only**. Nothing here generates, reshoots or edits a
plan-list. A verdict is a decision plus a cause; acting on it is a separate
run.

The rules being checked against are in
[PRODUCTION-RULES.md](PRODUCTION-RULES.md); the numbers are in
[`engine/pipeline.config.json`](../engine/pipeline.config.json) → `qa`.

---

## What the reviewer is given

Per plan, all of it produced by [`engine/qa_clip.py`](../engine/qa_clip.py)
before anyone looks at anything:

| Input | Where | What it is for |
| --- | --- | --- |
| Contact sheet | `reports/qa-<roll>/plan<N>.jpg` | Twelve frames evenly spaced across the clip, 4×3, each labelled with its frame number. Twelve, not six: six was enough to catch a passer-by and not enough to catch a hand that exists for half a second. |
| Metrics | `reports/qa-<roll>/metrics.json` | One row per plan — `sharp`, `jump_max`, `jump_at`, `drift`, `color_drift`, `max_area_dev`, `max_area_at`, `k0_match`, `k1_match`, `duration`, plus a plain-language `flags` list. |
| Start frame | `workspace/takes/<roll>/plan<N>_master.png` | What the clip was supposed to start from, and the composition it was supposed to keep. |
| End key, if the plan has one | `workspace/takes/<roll>/keys/plan<N>_key.png` | Only for a first-last-frame plan (`use_key: true`). Absent means the plan is i2v and there is nothing to arrive at. |
| The plan's motion line | `workspace/plans/<roll>.json` | What **should** be moving. Everything else in frame should not be. |

Metrics are not a verdict. They say what to look at; the reviewer decides. A
clip can pass every number and still be a reject, and a clip can trip a flag
and still be fine — except the still-frame floor, which is a reject on its own
(see the table below).

---

## The seven checks

Go frame by frame across the contact sheet, then read the metrics against what
you saw.

**1. Cast and head-count.** Exactly the people who are in the start frame.
Nobody appears, nobody vanishes, nobody duplicates. No hands or forearms
belonging to somebody outside the frame, no hand that cannot be traced to a
visible body. → `extra_person`, `extra_hand`

**2. Static things stay static.** Books, folders, boards, lamps, chairs,
plants, pictures, equipment — in place, unchanged, not sliding. Marks that read
as writing do not sharpen into legible letters, and no new marks appear. →
`object_moved`, `text_changed`

**3. People, clothes, faces.** Sitting or standing where they were. Same
clothes, same hair, same hair colour. Faces do not melt between frames, eyes
and mouths do not deform, five fingers per hand. Nobody stands up, and nobody
drifts toward the edge of frame. → `face_drift`, `clothes_changed`,
`left_frame`

**4. Props.** The object in the hands is the same object throughout. It does
not appear from nowhere, hang in the air, or turn into a different object. →
`prop_changed`

**5. The commissioned motion happens, and nothing else does.** Compare against
the plan's motion line: one clear action with one object, started and finished
inside the clip. Not a frozen frame, not a different action, not the right
action plus an invented second one. Mouths stay closed — nobody speaks on
camera in this series. → `no_motion`, `wrong_motion`

**6. Start, finish, and the joins.** The first frame matches the master
(`k0_match`). On a first-last-frame plan the last frame matches the end key
(`k1_match`). No jerk or cut anywhere inside (`jump_max`, and `jump_at` says
where to look). Colour does not slide from one end of the clip to the other
(`color_drift`). On a chained plan, the start frame must match the tail of the
clip it chains from. → `jump`, `color_drift`, `k0_mismatch`, `k1_mismatch`

**7. Sharpness.** Not visibly softer than the start frame. Edges crisp, no
smearing on small detail (hands, small objects, faces), no compression
artefacts or crawling noise. → `blur`

---

## Thresholds

Read from `qa.thresholds` in `engine/pipeline.config.json` by `qa_clip.py`, the
acceptance screen and the agent alike — one number in one place, so the three
cannot flag different clips.

| Metric | Key | Threshold | Reading |
| --- | --- | --- | --- |
| `jump_max` | `jumpMax` | ≤ 0.12 | Largest frame-to-frame difference, 0–1. Above it there is a cut or a jerk; `jump_at` gives the frame. |
| `color_drift` | `colorDrift` | ≤ 6 | Mean RGB shift, first frame to last, 0–255. Above it the grade slid over the clip. |
| `max_area_dev` | `maxAreaDev` | ≤ 0.06 | Largest share of the frame differing from the clip's own median, ignoring the first and last 8 frames. An ordinary gesture is 1–3%; 6%+ is a passer-by or a stray hand. |
| `max_area_dev` | `minAreaDev` | **≥ 0.02** | A floor, not a ceiling. Below it the clip did not move: a still frame with grain. **Reject even when every other metric is perfect.** |
| `k0_match` | `k0Match` | ≥ 0.9 | 1 − difference between the first frame and the master. |
| `k1_match` | `k1Match` | ≥ 0.85 | 1 − difference between the last frame and the end key. First-last-frame plans only. |
| `duration` | `minDurationSec` | ≥ 4.0 s | Shorter and the scene will not fill without stretching. |
| `sharp` | `sharpDropRatio` | ≥ 0.6 × master | Mean Laplacian variance. Below roughly 60% of the start frame's, the clip is soft. |

---

## Defect vocabulary

A reject names one or more of these ids and nothing else. The list is fixed:
free-text reasons cannot be counted, cannot be compared across rolls, and
cannot be turned into a change to the config. Prose belongs in `note`.

| id | Means |
| --- | --- |
| `extra_person` | A person who is not in the start frame appears, or one duplicates. |
| `extra_hand` | A hand or arm with no visible owner; a third arm. |
| `object_moved` | Something that should be static moved, slid or changed. |
| `text_changed` | Marks became legible text, or written marks changed. |
| `face_drift` | A face melts, deforms or stops being the same person. |
| `clothes_changed` | Clothing, hair or hair colour changed mid-clip. |
| `prop_changed` | The handled object changed, vanished, appeared or floats. |
| `left_frame` | Someone walked out of frame, or drifted to the edge. |
| `no_motion` | Nothing moved — the still-frame defect. |
| `wrong_motion` | Something moved, but not what the motion line commissioned, or more than it. |
| `jump` | A cut or jerk inside the clip. |
| `color_drift` | The grade slid between the first and last frame. |
| `blur` | Softer than the start frame; smeared detail or artefacts. |
| `k0_mismatch` | The first frame is not the master. |
| `k1_mismatch` | The last frame is not the end key. |

---

## The verdict

One object per plan, written to `reports/qa-<roll>/verdict.json`:

```json
[
  {
    "plan": 1,
    "verdict": "accept",
    "reasons": [],
    "note": "",
    "confidence": 0.9
  },
  {
    "plan": 4,
    "verdict": "reject",
    "reasons": ["extra_hand"],
    "note": "sheet frame 4: a third hand on the table at the left, no owner in frame; start frame has both her hands on the rail, so the frame is fine — tighten the motion line to name whose hands move",
    "confidence": 0.8
  }
]
```

- `verdict` — `accept` or `reject`. Nothing else.
- `reasons` — ids from the table above; empty on an accept.
- `note` — one sentence: **where** (a contact-sheet frame number) and **what**.
  A note without a frame number is not reviewable by the next person.
- `confidence` — 0–1, the reviewer's own certainty.

Finish with a short summary: how many accepted, how many rejected, and the top
reasons across the roll. Three plans rejected for the same id is not three
problems, it is one rule to change.

Human decisions live separately, in `workspace/<roll>/acceptance.json`, keyed
by the clip they judge — that file is written by the interface and only ever
*read* by the engine. `wavespeed_batch.mjs` and `flf_batch.mjs` both consult it
before shooting: `accepted` is left alone even if the clip file is missing
(reshooting it takes `--redo`, on purpose), while `rejected` and `redo` are
reshot on the next run with no flag at all.

---

## Two rules about rejecting

**Doubt resolves to reject.** If you are not sure whether that is a third hand,
it is a third hand. A reshoot is cheap and bounded; a defect that reaches the
finished episode is not, because by then it is buried in a cut that has already
been narrated, graded and delivered, and pulling it out costs the whole scene.

**A reject must name a cause to change.** Either the **motion prompt** (the
action is ambiguous, it names two objects, it invites something off-frame, it
lets the model choose who moves) or the **start frame** (a doorway in the
background, hands out of frame, a mouth open, a second figure, readable text,
the wrong tone). *"Try another seed"* is not a cause, and on this pipeline it
is usually not even possible: every Kling 2.x endpoint in the models table
takes no seed at all, so a re-run with a different `--seed` sends the identical
request and gets back a comparable clip at full price. If the same defect
survives two shoots, the cause is in the frame or in the line — and if it is a
cause the whole roll shares, it belongs in `engine/pipeline.config.json`, not
in one plan.
