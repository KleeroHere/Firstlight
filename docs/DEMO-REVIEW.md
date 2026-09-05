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

## Two blemishes carried into the final cut

Recorded rather than hidden, because the WaveSpeed budget for the pass was spent
(**$9.90 of $10.00**) by the time they were the only things left.

1. **Fog signal check, plan 12 (`text_changed`)** — a faint letter-shaped mark
   in the top-right corner, outside the action. It is in the start frame, so it
   is present in every frame rather than appearing mid-clip; the fix is
   regenerating the frame ($0.027) and reshooting ($0.35).
2. **Handover at the pier, plan 6 (`prop_changed`)** — between roughly frames 45
   and 100 a second wooden tag is briefly visible on the board beside the one in
   her hand, resolving before the end. This take is already the second, and it
   fixed the worse version (the tag doubling in size and staying doubled); the
   clip now returns exactly to its first frame.

## What the two gates actually rejected

| Gate | Judged | Rejected first time | Cause found | Fix |
|---|---|---|---|---|
| Frames | 24 | 6 | close-ups relocated to another background; a door behind an actor's hands; the word "Shift" legible on a prop; a pen from another scene in a rope shot; a mouth open mid-word | location named before the character in the prompt; `production.frame.oneProp`; hardened `noText`; the scenario stopped calling it a "shift tag" |
| Clips | 24 | 8 | one frozen wide, one frozen medium, an actor walking out of frame, a door opening mid-clip, a prop morphing into a different prop, a tag doubling, one clip the provider refused outright | `solo_key: closed` (solo shots shot first-to-last-frame against their own start frame); `anim_wide` / `anim_solo` (a reversed gesture where the start frame had already arrived at the end of the action); one plain retry |

Every reject named a cause to change — a prompt or a start frame — and every fix
went into the scenario or the config, not into a one-off command. That is why
the second take of a rejected plan is a different shot rather than a different
seed: **none of the Kling 2.x endpoints on WaveSpeed accept a seed at all.**
