# QA — Harbour Light demo (independent acceptance pass)

Independent QA pass over the demo material for the two Harbour Light episodes
("Fog signal check", "Handover at the pier") plus the explainer video. Method:
character/background reference check, then each plan's clip judged from its
6-frame contact sheet (`reports/qa-<id>/plan<N>.jpg`) plus `metrics.json` from
`engine/qa_clip.py`, against the defect checklist `README.md` § Acceptance
documents (extra person/hand, object moved, face drift, no camera-look, no
readable text, start/end match, no jerk/drift) and the `acceptance.json`
format in `docs/ARCHITECTURE.md`. Decisions are written to `workspace/<roll>/acceptance.json`
(the file `flf_batch.mjs` / `wavespeed_batch.mjs` read before reshooting). This
file is the human-readable summary; the JSON files are authoritative.

Run as four passes over about 45 minutes while production was still active.
Everything below is the **current** (final) state; the "history" column notes
what changed between passes so the reject → reshoot → accept cycles aren't
lost.

## Reference art (not plan-scoped, no acceptance.json entry)

| File | Verdict | Notes |
| --- | --- | --- |
| `workspace/refs/mara/{base,fullbody}.png` | accept | Silver bob, teal turtleneck, brass-key pendant — identical across both sheets. |
| `workspace/refs/tomas/{base,fullbody,dialog}.png` | accept | Curly dark hair, orange jacket over grey hoodie, spiral notebook in pocket — consistent in front, full-body and 3/4 profile. |
| `workspace/refs/ines/{base,dialog}.png` | accept | Glasses, green cardigan, pencil behind ear — consistent front and profile. Note: `dialog.png` is the redo mentioned in `docs/DEMO-LOG.md` (pencil no longer crosses her face); redo reads clean. |
| `workspace/backgrounds/{harbour-office,lantern-room,pier}.png` | accept | Flat-gouache teal/brass/sunset palette holds across all three; corkboard/log-book pages show blank ruled lines only, no readable text; no people in any background plate. |

## fog-signal-check — 3/3 plans accepted

| Plan | Verdict | Reason | Prompt fix needed |
| --- | --- | --- | --- |
| plan1 (s1, medium, Ines) | accept | Single actor throughout; QA metric's 9%-area flag at frame 9 is her scripted head-turn to the window, not an intruder. k0/k1 ≈ 0.99, jump 0.011. | none |
| plan2 (s2, wide, Mara+Tomas) | accept | One clean lever-pull-and-release cycle; Tomas's notebook stays shut and in place; no extra hands. jump 0.005, drift 0.022. | none |
| plan3 (s3, medium, Tomas) | accept | Radio lowers into a thumbs-up that lands on the last frame, matching the FLF end key. jump 0.003, drift 0.024. | none |

**Episode assembly — resolved.** At the first pass, `workspace/out/Fog signal
check.mp4` (built 2026-09-04, before today's real motion clips existed) had
`"still": true` for every scene — assembled from static beat-frame stills, not
the accepted `_flf/plan*.mp4` takes above; it passed `verify.json` anyway
because that check only looks at format/timing/loudness, not which source was
used. It has since been rebuilt: `build-log.json` now sources every scene from
`s<N>_take1.mp4` (the real motion takes), real ElevenLabs narration replaced
the placeholder track, and `verify.json` is a clean **21/21 pass** (loudness
-16.1 LUFS, true peak -1.6 dBTP, all title/memo plates present).

## handover-at-the-pier — 8/8 plans accepted (after 3 reshoots + 1 added plan)

| Plan | Verdict | History | Prompt fix needed |
| --- | --- | --- | --- |
| plan1 (s1, wide, Tomas) | accept | clean throughout | none |
| plan2 (s1, medium, Tomas) | accept | **reject** (`prop-appears`) — a pen appeared in his writing hand around frame 49-73 of 121 with no visible retrieval, matching the QA metric's own 13%-area flag. Reshot: the pen is now visible clipped to the notebook from the moment both come out of his pocket (~frame 21-25) and stays in view through writing — reads as one retrieval, not an object popping into an idle hand. | resolved by reshoot |
| plan3 (s2, wide, Mara+Tomas, FLF) | accept | clean throughout | QA metric flags colour drift (6.74, the highest in the roll); not visible across the 6 sampled frames, most likely the rotating beacon lamp behind them, not a defect — worth a glance if a tone shift ever shows up in the cut |
| plan4 (s2, medium, Mara) | accept | **reject** (`extra-hand`/`extra-person`) — motion text said "exactly one person in the shot" but a second, dark-sleeved hand not matching Tomas's orange-jacket reference entered frame ~25-97 to pass the book/keys. Root cause fixed in `engine/auto_storyboard.py` (solo shots no longer inherit the two-person motion clause verbatim); reshot clean. | resolved upstream |
| plan5 (s2, close, Tomas) | accept | **reject** — same root cause as plan4 (extra hand in the master itself). Reshot: Tomas alone, one small calm motion at his jacket zipper, nothing loops, no second person. | resolved upstream |
| plan6 (s3, wide, Ines) | accept | clean throughout | none |
| plan7 (s3, medium, Ines) | accept | clean throughout | none |
| plan8 (s2, close, Tomas) — new | accept | Added specifically to cover a 2.8s freeze-frame pad `verify.json` flagged for scene s2 (see below). Tomas alone, tucks the logbook page and keys into his jacket pocket and settles still — one non-looping closing beat, no extra hands. | none. Note: `reports/qa-handover-at-the-pier/metrics.json` had not been regenerated to include plan8 as of this review (still 7 entries) — this accept is from the visual contact sheet only; re-run `engine/qa_clip.py` and re-check its numeric flags once it has plan8's row. |

**Episode assembly — resolved.** `workspace/out/Handover at the pier.mp4` was
first assembled sourcing every scene from the real `s<N>_take1.mp4` takes (not
stills) with real narration, but `verify.json` came back **20/21, one warn**:
*"сцена стоит замершим кадром (s2:2.8с) — добрать планами"* — scene s2 (the
logbook-and-keys handoff) padded 2.8s of its runtime with a frozen last frame
because the three original clips didn't fill the time the scenario gives that
scene. Plan8 above was shot to close that gap and the episode was
reassembled; `verify.json` is now a clean **21/21 pass**.

## Explainer video ("How Firstlight works.mp4", 2:51)

Reviewed via a 36-frame contact sheet sampled every 5s across the full
runtime. Screen-recorded UI walkthrough (rolls list → scenario/acceptance
screens for "Handover at the pier", showing the real acceptance decisions and
comments from this QA pass rendered correctly in the app) intercut with the
pipeline diagram, a short montage of already-accepted footage (Tomas
confirming the last boat, writing in his notebook, the Mara/Tomas handover),
and title/cost/closing cards. All text on every card and caption is crisp and
correctly spelled (this is the one place in the whole demo where readable
text is *supposed* to appear — informational overlays, not in-universe
signage). The closing card explicitly states "Harbour Light is the example
series — no real organisation appears in this repository", consistent with
the anonymisation requirement. No visual defects found. Accept (not
plan-scoped, no acceptance.json entry — this isn't a roll).

## Outstanding / out of scope for this pass

- `opening-the-office` has a compiled prompt/scenario but still no
  `workspace/takes/opening-the-office/` as of the fourth and final check —
  per `docs/DEMO-LOG.md` this session's scope was the two episodes above plus
  the explainer video, so this is expected, not a gap.

## Summary

- **11 plan clips reviewed across both episodes (10 original + 1 added), 11
  accepted, 0 currently rejected.**
- 3 plans (handover plan2, plan4, plan5) went reject → reshoot → accept
  during this pass — all three genuine defects (a materializing prop, and
  twice an extra hand from an uncredited person) were fixed at the root and
  confirmed clean on reshoot, not just re-labelled.
- 1 plan (handover plan8) was added mid-review to close a timing gap and
  accepted clean.
- 2 episode-assembly issues found and both resolved by the end of the pass:
  `Fog signal check.mp4` originally shipped static stills instead of the
  accepted clips (rebuilt, now 21/21); `Handover at the pier.mp4` had a 2.8s
  freeze-frame pad in scene s2 (closed by plan8, now 21/21).
- Explainer video reviewed separately: clean, no defects.
