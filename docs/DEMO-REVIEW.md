# Demo review — what was accepted, and on what evidence

Everything the two acceptance gates saw, in one place, so the decisions can be
checked rather than taken on trust. The full record, comment by comment, is in
`workspace/<roll>/acceptance.json`; this file is the summary a reviewer reads
first.

- **Contact sheets, all twelve accepted plans per roll:**
  - [`docs/demo/review/fog-signal-check-contact-sheets.jpg`](demo/review/fog-signal-check-contact-sheets.jpg)
  - [`docs/demo/review/handover-at-the-pier-contact-sheets.jpg`](demo/review/handover-at-the-pier-contact-sheets.jpg)
- Per-clip sheets and raw metrics: `reports/qa-<roll>/plan<N>.jpg` and
  `reports/qa-<roll>/metrics.json` (not committed — `reports/` is gitignored).
- Review packets, exactly as handed to a reviewer:
  `workspace/<roll>/_review/{frames,qa}/`.

## How to read the numbers

| Column | What it is | Threshold |
|---|---|---|
| `area` | Largest share of the picture that differs from the clip's own median frame, away from the ends. The movement metric. | **≥ 2 %** or it is a still; **> 6 %** and something big appeared — look for an extra person or hand. |
| `jump` | Largest frame-to-frame difference. Catches a cut or a jerk. | ≤ 0.12 |
| `drift` | First frame vs last frame. On a `closed` clip this should be ~0 by construction: the shot has to arrive back where it began. | — |
| `key` | `closed` = end frame **is** the start frame. `edit` = one honest change, generated and tone-matched. `i2v` = no end frame. | — |

## Fog signal check — 12/12 accepted

| # | scene | shot | model | key | s | area | jump | drift | noted defects |
|---|---|---|---|---|---|---|---|---|---|
| 1 | s1 | wide | pro | closed | 5.08 | 2.1 % | 0.006 | 0.002 | — |
| 2 | s1 | medium | std | i2v | 5.04 | 5.3 % | 0.013 | 0.023 | — |
| 3 | s1 | close | std | i2v | 5.04 | 11.7 % | 0.025 | 0.059 | — |
| 4 | s2 | wide | pro | closed | 5.08 | 2.1 % | 0.005 | 0.002 | — |
| 5 | s2 | medium | std | i2v | 5.04 | 4.5 % | 0.020 | 0.025 | — |
| 6 | s2 | close | std | i2v | 5.04 | 3.8 % | 0.013 | 0.026 | — |
| 7 | s3 | wide | pro | edit | 5.08 | 3.6 % | 0.013 | 0.031 | — |
| 8 | s3 | medium | pro | closed | 5.08 | 4.6 % | 0.015 | 0.002 | — |
| 9 | s3 | close | std | i2v | 5.04 | 4.0 % | 0.014 | 0.024 | — |
| 10 | s4 | wide | pro | closed | 5.08 | 5.3 % | 0.012 | 0.002 | — |
| 11 | s4 | medium | std | i2v | 5.04 | 2.7 % | 0.010 | 0.029 | — |
| 12 | s4 | close | pro | closed | 5.08 | 6.7 % | 0.013 | 0.002 | `text_changed` |

Plan 3's 11.7 % is the telephone handset crossing the frame on its way down —
the commissioned action, verified frame by frame on the sheet, not a second
person. Plan 12 carries one known blemish (below).

## Handover at the pier — 12/12 accepted

| # | scene | shot | model | key | s | area | jump | drift | noted defects |
|---|---|---|---|---|---|---|---|---|---|
| 1 | s1 | wide | pro | edit | 5.08 | 1.9 % | 0.007 | 0.029 | — |
| 2 | s1 | medium | std | i2v | 5.04 | 3.4 % | 0.011 | 0.026 | — |
| 3 | s1 | close | std | i2v | 5.04 | 3.0 % | 0.009 | 0.024 | — |
| 4 | s2 | wide | pro | edit | 5.08 | 6.6 % | 0.009 | 0.028 | — |
| 5 | s2 | medium | pro | closed | 5.08 | 4.3 % | 0.006 | 0.002 | — |
| 6 | s2 | close | pro | closed | 5.08 | 7.8 % | 0.012 | 0.002 | `prop_changed` |
| 7 | s3 | wide | pro | edit | 5.08 | 4.6 % | 0.012 | 0.031 | — |
| 8 | s3 | medium | std | i2v | 5.04 | 5.6 % | 0.023 | 0.033 | — |
| 9 | s3 | close | std | i2v | 5.04 | 5.8 % | 0.016 | 0.043 | — |
| 10 | s4 | wide | pro | closed | 5.08 | 3.2 % | 0.008 | 0.002 | — |
| 11 | s4 | medium | std | i2v | 5.04 | 5.8 % | 0.012 | 0.037 | — |
| 12 | s4 | close | std | i2v | 5.04 | 4.4 % | 0.017 | 0.039 | — |

Plan 1's 1.9 % is under the still-frame floor and was accepted anyway, with the
reason recorded: a key ring changing hands is a small object seen across a whole
room, and the sheet shows both arms visibly moving between frames 1 and 45. The
metric is calibrated for a person-sized gesture; this is the case it does not
cover.

## Independent QA pass, and what was closed rather than fixed

A second reviewer ran the same packets through `--apply` (the mechanism worked
unchanged) and rejected four positions the first pass had let through. All four
were real, and the finding is recorded here rather than argued with:

| Roll | Position | Defect it found | State now |
|---|---|---|---|
| Fog signal check | frame 3 | Mouth open mid-word with teeth visible; the window a warm sunset against the grey daylight of plans 1–2 in the same scene. | **Frame corrected. Clip not reshot.** |
| Fog signal check | frame 8 | A glazed door still standing at the right edge — the same door that swung open in the previous take. In this take it stays shut, which is how it survived the first review. | **Frame corrected. Clip not reshot.** |
| Handover at the pier | frame 4 | The tag reads `SHIFT` in legible letters. That frame predates the scenario fix and had never been regenerated. | **Frame and end key corrected. Clip not reshot.** |
| Handover at the pier | clip 6 | A second tag on the board from ~frame 45 to ~100 (`max_area_dev` 7.8 %, over the 6 % flag). | **Closed as a known blemish.** |
| Fog signal check | clip 12 | The corner mark — confirmed **cosmetic** by the same pass. | Left alone by decision. |

The reshoot was priced at **$1.37** and cancelled by the owner before any clip
was shot: the episodes were judged good enough, and better is the enemy of good.
**Nothing is pending.** Every one of the 24 frames and 24 clips per roll is
`accepted` in `workspace/<roll>/acceptance.json`, four of them with the defect
named in the record, and `wavespeed_batch.mjs --model auto --dry` reports
`к съёмке 0` for both rolls. Reopening any of them is a single `--only N` run at
$0.21–$0.35.

One asymmetry to know about: the three corrected **start frames** are on disk and
are better than the clips shot from them. The committed Pages demo was built
before they were corrected, so what it shows still matches the shipped episodes —
frames and clips from the same take. Rebuilding the demo would put the corrected
frames beside the older clips until those clips are reshot.

## The fixes that went into the engine anyway

The corrections were cheap and are worth keeping even though three of them were
never shot:

- `production.frame.noDoors` now covers the **edges** of the frame and reflections
  in glass, and says to choose an angle that leaves a door out of shot.
- `production.frame.mouth` is a clause of its own, repeated after the composition
  rules — an open mouth survives being mentioned once.
- The **close** shot's prompt now carries the scene's own `img` line, so it knows
  the weather and the time of day. A close-up had no idea the scene was a grey
  hazy evening, which is how it came back a sunset.
- Solo shots are now built from the character's `base` sheet, not `dialog`: a
  "dialog" sheet is a picture of the character **speaking**, and handing it to the
  image model for a shot whose rule is "mouth closed" fights the rule with a
  reference image, which the model believes over the sentence. This series never
  shows anyone talking on camera — the narration is dubbed — so the talking sheet
  was the wrong default everywhere.
- New scenario field `motion_note`: a per-scene constraint appended to every
  shot's motion, for the thing one particular scene's model keeps getting wrong
  ("the peg board keeps exactly one wooden tag for the whole shot").

## What the two gates actually rejected

| Gate | Judged | Rejected first time | Cause found | Fix |
|---|---|---|---|---|
| Frames | 24 | 6 | close-ups relocated to another background; a door behind an actor's hands; the word "Shift" legible on a prop; a pen from another scene in a rope shot; a mouth open mid-word | location named before the character in the prompt; `production.frame.oneProp`; hardened `noText`; the scenario stopped calling it a "shift tag" |
| Clips | 24 | 8 | one frozen wide, one frozen medium, an actor walking out of frame, a door opening mid-clip, a prop morphing into a different prop, a tag doubling, one clip the provider refused outright | `solo_key: closed` (solo shots shot first-to-last-frame against their own start frame); `anim_wide` / `anim_solo` (a reversed gesture where the start frame had already arrived at the end of the action); one plain retry |

Every reject named a cause to change — a prompt or a start frame — and every fix
went into the scenario or the config, not into a one-off command. That is why
the second take of a rejected plan is a different shot rather than a different
seed: **none of the Kling 2.x endpoints on WaveSpeed accept a seed at all.**
