# How Firstlight works — narration script

Working script for the explainer video (ElevenLabs, voice pinned in
`engine/pipeline.config.json`). Section markers are for the video's own
captions/cut points, not spoken.

## 1. What it does
Firstlight turns a written scenario into a finished training film. You write
the scenes — who is in frame, what happens, what the narrator says — and the
pipeline does the rest: keyframes, motion, narration, captions, cut and
grade.

## 2. The scenario is the edit
There is no timeline and no editor. Every scene names its cast, its
background, what the frame shows, and the one movement it makes. Save it,
and it compiles straight into prompts — the same style, the same character
sheets, every time, so a face stays the same face across forty frames.

## 3. Keyframes and acceptance
Every shot gets a first frame, and — where the motion needs one — a last
frame too. They land on an acceptance sheet with a checklist per frame. A
keyframe costs a few cents. The same mistake animated into a clip costs a
dollar and ten minutes, so a person checks the frame before anything moves.

## 4. Motion, on whichever backend fits the day
Motion runs on a rented GPU, an owned one, or a cloud API — Kling, Seedance
or Wan through WaveSpeed — the same plan-list either way. Switching backend
is a different command, never a code change.

## 5. QA agents and metrics
Every clip gets a contact sheet and a defect checklist: an extra hand, a
moved object, a face that drifted. Accept, reject, or redo with a comment —
the decision is written once, to a file the engine only ever reads, and a
rejected plan is reshot on the very next run with no flag needed.

## 6. Cut, narration, verify
Once the takes exist, everything after is deterministic. Captions are drawn
from the scenario. Narration is synthesised per line and placed on its own
timecode. The cut is a concat, not a judgement call. Then the film is graded
against a written standard — format, timing, loudness, every caption
actually visible — and the report is what the interface shows.

## 7. Cost and time
A keyframe is a few cents. A five-second clip is well under a dollar on a
cloud API, or free on an owned GPU. A finished two-minute episode comes from
a scenario, a few dollars of generation, and no timeline software at all.
