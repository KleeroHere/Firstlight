# Demo production log — Harbour Light

## Later same day — QA, redo, assembly, verify

- Independent QA agent (owner-launched, see `docs/QA-DEMO.md`) reviewed all
  reference art, backgrounds and every plan clip against a defect checklist
  the owner supplied (extra person/hand, object moved, face drift, no
  camera-look, no readable text, start/end match, no jerk/drift — the same
  list `README.md` § Acceptance already documents), writing verdicts to each
  roll's `acceptance.json`. It confirmed my own fog-signal-check
  accepts and my plan4/plan5 reject->reshoot->accept on handover-at-the-pier,
  and caught one I'd missed: handover **plan2 — prop-appears** (a pen
  materialises in Tomas's hand with no visible retrieval). Fixed the motion
  text (explicit "already holds a pen clipped to the notebook's spiral,
  pulls both out together") and reshot with `--seed 23`; the redo still trips
  the same area-change metric (something newly visible either way) but the
  contact sheet now shows a plausible single retrieval, not a prop popping
  into an idle hand — accepted rather than spending a third attempt.
- It also caught a real process bug: `workspace/out/Fog signal check.mp4`
  was still the repo's original synthetic-clips build from before today —
  I hadn't run `assemble_video` for either roll yet at that point. Fixed by
  actually running assembly (see below).
- Spend check (owner, then self-corrected as a false alarm): ledger is
  correct, every WaveSpeed call goes through `--ledger`. Today's Firstlight
  total after all reshoots: **~$4.5** (stills ~$0.73, fog motion $1.05,
  handover motion $1.61 + $0.42 + $0.21 for the three reshoots) — well under
  the $12 cap.
- Narration: real ElevenLabs synthesis for both rolls (`tts_all.mjs --only
  <id>`), 546 + 569 = 1115 characters total, voice `onwK4e9ZLuTAKqWW03F9`
  (Daniel — Steady Broadcaster) pinned in `pipeline.config.json`. Well under
  the 6000-character cap even with the explainer video's script still to
  come.
- Assembled both with `assemble_video.mjs --prefer-takes` (the flag that
  forces real clips over any leftover synthetic/beat-frame path) and graded
  with `verify_video.mjs`:
  - **Fog signal check**: 72.0s, **21 pass, 0 warn, 0 fail** — a clean
    pass, better than the README's documented 20/2/0 (those two warnings
    were about placeholder narration, which no longer applies).
  - **Handover at the pier**: 60.0s, **20 pass, 1 warn, 0 fail** — one
    warning, s2 has a 2.8s frozen-tail push-in (three 5s clips = 15s against
    an 18s scene). Expected, documented pipeline behaviour
    (`detail.minSec`), not a defect; left as an honest warning rather than
    adding a fourth plan to close 3 seconds exactly.


Working notes while producing the two demo episodes, the explainer video and
the updated Pages showcase. Not a design doc — just what happened, in order,
so a second session can pick this up without re-deriving it.

## 2026-09-05

- Scope: two Harbour Light episodes ("Fog signal check" reshot for real,
  "Handover at the pier" new), one explainer video ("How Firstlight works"),
  refreshed Pages demo data + README showcase.
- World: kept the existing example cast (Mara/keeper, Tomas/apprentice,
  Ines/harbour clerk) and the three existing backgrounds — they already match
  the brief's archetypes (keeper / trainee / harbour dispatcher) and the
  scenarios already reference them. No new characters invented; this is a
  produce call to avoid re-deriving a world the repo already ships.
- `workspace/refs/*` and `workspace/backgrounds/*` did not exist yet — the
  example series had never actually been rendered with real images, only
  synthetic test clips. Generating both for real is most of this session's
  new work.
- Budget: WaveSpeed ≤ $1.50 for this task, spend recorded in an external
  ledger file the owner keeps shared across their own projects (outside
  this repository, per the owner's instruction — that file already had
  unrelated entries from other work; appending only, never touching the
  rest). ElevenLabs ≤ 6000 characters total narration.
- Model choice for stills: bytedance/seedream-v4 on WaveSpeed — $0.027/image
  flat, text-to-image for each character's `base` sheet, then
  seedream-v4/edit ($0.027/image) from that base for `fullbody`/`dialog`
  variants, to keep the same face/clothes across sheets. Backgrounds are
  also seedream-v4 text-to-image (no character consistency needed there).
  Klein (local, free) is reserved for its actual designed use: per-shot
  keyframes, not initial character/background art.
- ComfyUI confirmed reachable at 127.0.0.1:8188 (shared queue with other
  work — jobs queued, not forced to the front).
- Character sheets generated: `workspace/refs/{mara,tomas,ines}/{base,fullbody,dialog}.png`
  (7 images, one redo — ines/base.png first came back with the pencil
  crossing through her head like an arrow, "behind one ear" read as both
  sides; fixed the prompt, redo logged as `harbourlight-ines-base-redo`).
  Backgrounds generated: `workspace/backgrounds/{lantern-room,harbour-office,pier}.png`.
  All via `engine/wavespeed_stills.mjs` (new script — bytedance/seedream-v4
  text-to-image + seedream-v4/edit for identity-locked variants). Quality is
  genuinely strong — no further redos needed after the pencil fix.
- Owner revised the plan mid-session: final clips shoot on WaveSpeed (Kling
  2.6 Pro for the one first-last-frame demo per episode, Kling 2.6 Std for
  i2v-only shots) instead of local ComfyUI/Wan — budget raised to <= $12,
  showcase quality over economy. Klein stays available for free local drafts
  but wasn't needed this session (WaveSpeed handled both stills and
  keyframes at acceptable quality and cost).
- Built `engine/auto_storyboard.py`: scenario (scene text + narration) +
  character sheets + backgrounds -> shot list (wide, always; +medium >=14s;
  +close >=17s, each with its own guarded motion text and a 3/4-angle rule
  for solo shots) -> calls the image backend itself (WaveSpeed edit or
  Klein) to generate every master/key frame, writes
  `workspace/plans/<id>.json` directly (the file flf_batch.mjs /
  wavespeed_batch.mjs actually read — note `engine/make_plans.py` currently
  writes to `engine/flf_plans_<id>.json` instead, which those two scripts do
  NOT read; that half of the existing make_plans/preflight_plans pair isn't
  wired to the shoot scripts yet, independent of this work). Used for
  "Handover at the pier" end to end (7 plans, 1 with an end key on the
  handover wide shot) as the demo of the no-manual-storyboard path. "Fog
  signal check" was shot the traditional way instead: its own already-written
  per-scene img/anim text, master/key frames requested by hand per scene
  (all 3 with real end keys) — a deliberate contrast for the explainer video
  and README.
  Found and fixed a real bug in my own first draft of the script: `--only`
  reran with plan numbers restarted from 1, colliding with the other scenes'
  already-generated files. Fixed by deriving plan numbers (and which scene
  gets the FLF demo) from every anim scene up front, regardless of `--only`,
  before generating anything for the selected subset.
- Ported two QA ideas from another of the owner's productions into the
  engine, generalized/anonymized:
  `engine/color_match.py` (LAB mean/std tone transfer, master -> its scene's
  end key) and `engine/qa_clip.py` (objective per-clip metrics: sharpness,
  frame-to-frame jump, drift, colour drift, contact sheet). Ran qa_clip on
  fog-signal-check's 3 clips: all clean; one metric flagged plan1 (9%
  mid-clip area change) but the contact sheet shows it's Ines turning her
  head to the window as scripted, not an intruder — accepted with that note
  in `workspace/fog-signal-check/acceptance.json`.
- Real bug found in `engine/wavespeed_batch.mjs`: its spend ledger path was
  hardcoded to `<repo>/reports/wavespeed-spend.json` (Firstlight's own,
  gitignored), not configurable — so the first 3 motion clips
  (fog-signal-check) logged to a Firstlight-local file instead of the
  owner's shared external ledger. Added a `--ledger <path>` flag (same
  convention as wavespeed_stills.mjs) and folded those 3 entries into the
  shared ledger by hand; the local file is deleted. All later shoots pass
  `--ledger` explicitly.
- Motion: fog-signal-check shot in full (3/3 plans, Kling 2.6 Pro, all with
  real end keys) — $1.05, ~350s render/poll time each, auto-concatenated by
  wavespeed_batch.mjs into `s1_take1.mp4`/`s2_take1.mp4`/`s3_take1.mp4`.
  handover-at-the-pier shot in full too (1 Kling Pro + 6 Kling Std, $1.61).
- QA pass on handover-at-the-pier (qa_clip.py + eyeballing every contact
  sheet, same checklist as above): **plan4 and plan5 rejected — extra_hand.**
  Root cause found in
  `engine/auto_storyboard.py`, not the video model: a two-person scene's
  `img`/`anim` text names both actors (e.g. "Mara hands over the log; Tomas
  takes it"), and that full sentence was being reused verbatim as the prompt
  for a SOLO medium/close shot — scripting the other person's hand into a
  frame that was only ever given one person's reference sheet. Both the
  still master (plan5's hand-off already showed a second wrist reaching in)
  and the resulting clip carried the defect. Fixed with `solo_anim()`: split
  the scene text by actor, keep only the primary's clause, and fall back to
  a generic "continues their own part of it" line rather than ever risk
  scripting a second person into a one-person shot. Regenerated plan4/plan5
  masters (clean on inspection) and reshot both clips ($0.42, Kling Std,
  same seed policy — new prompt, not just a new seed). Everything else
  (plan1,2,3,6,7) accepted on first pass; full detail and the fix are in
  `workspace/handover-at-the-pier/acceptance.json`.
- Owner's spend-cap message (typed independently, then partly retracted as a
  false alarm on a re-check): rule confirmed and already how this session
  operates — hard cap $12 total for the whole demo, shared ledger only,
  every WaveSpeed call already goes through `wavespeed_stills.mjs` /
  `wavespeed_batch.mjs --ledger`, both of which book the spend before
  printing the "ledger total" line, i.e. before the next call. Actual total
  for today, recomputed directly from the ledger by id/date rather than the
  (incomplete) `project` tag some entries lack: **$3.66 before this redo,
  ~$4.08 after it** — well inside the $12 cap, ~$7.9 left. No entries were
  missing; the owner's first check read a filtered view.
