# Production rules

This is how a shot is framed, prompted, timed and cut in this pipeline, and
why. None of it is taste. Every rule below is the scar of a defect that was
paid for at least once — over forty reshoots on the example series — and each
one names the defect it exists to prevent.

The machine-readable half of this document is
[`engine/pipeline.config.json`](../engine/pipeline.config.json), blocks
`production` and `qa`. [`engine/guard.mjs`](../engine/guard.mjs) and
[`engine/guard.py`](../engine/guard.py) read that block, so the storyboard step
(Python) and the shooting step (Node) cannot drift apart on what a motion
prompt must say. **A rule you want changed is changed in the config, not in a
prompt you type into a plan by hand** — a hand-typed exception survives exactly
one run and is then forgotten.

Every rule names its config key, so the knob is findable.

---

## 1. A plan is 4–6 seconds of real movement

One plan is one shot: one start frame, one action, one clip, 4–6 seconds of
screen. Shorter and the action cannot start, happen and finish inside the clip;
longer and the model invents a second event to fill the time.

**The still-frame defect.** A clip whose busiest frame differs from the clip's
own median frame by less than **2% of the picture** did not move. It is a still
image with grain on it, and it is rejected on that one number alone — even if
every other metric is perfect. That is exactly why it is dangerous: no jump, no
colour drift, a perfect match to the start frame, full sharpness. A flawless
clip of nothing happening. It is the single most common reason a finished
episode looks dead.

| Knob | Config key | Value | What it catches |
| --- | --- | --- | --- |
| Still-frame floor | `qa.thresholds.minAreaDev` | `0.02` | The clip never moved. Reject regardless of every other metric. |
| Motion ceiling | `qa.thresholds.maxAreaDev` | `0.06` | Something too big changed mid-clip — a passer-by, a stray hand. |
| Duration floor | `qa.thresholds.minDurationSec` | `4.0` | The model returned a short clip; the scene will not fill. |

An ordinary intended gesture measures 1–3% of the frame. The window between
floor and ceiling is narrow on purpose: below it nothing happened, above it
something happened that nobody commissioned.

**Scenes are timed so the assembler always trims.** Plan more footage per scene
than the scene's slot needs, so
[`assemble_from_plans.mjs`](../engine/assemble_from_plans.mjs) has surplus to
cut — up to about 10%, taken off the tails. It must never be in the position of
having to stretch. The three things it does when it is short are all visible on
screen: uniform slow-down (`--max-slow`, default `1.12`), an extra close-up
insert, and, as a last resort, a "detail" — a slow push-in on the last frame,
which is a held still with a zoom on it and reads exactly as dead as it is.
Plan long, cut short.

---

## 2. Montage inside a scene

A scene shot from one angle is a slideshow, however good the clip is. Length is
not what decides whether an edit exists — the cut is.

**Three shots per scene, always**, not "if the scene is long enough".
[`auto_storyboard.py`](../engine/auto_storyboard.py) derives them from the
scenario:

| Role | What it is | End key | Model booked |
| --- | --- | --- | --- |
| `wide` | The whole scene cast in the location: set readable, cast at full or three-quarter length, floor and ceiling line visible. Carries the scene's own action line. | Yes (`closed` or `edit`) | `kling26-pro` |
| `medium` | The acting character alone, waist-up, three-quarter, their own hands or the object in them in frame. | No — i2v | `kling26-std` |
| `close` | The other character in a two-hander (or the same one solo), on hands or face. Never asked to loop. | No — i2v | `kling26-std` |

The assembler lays them out **wide → medium → close → back to the wide's own
tail**. The return to the establishing shot is part of the grammar — it tells
the viewer the scene is closing — but it costs no extra generation: the tail of
the already-shot wide *is* the return. `RETURN_SEC` in the assembler reserves
1.8 s for it (or 35% of the wide, whichever is smaller); the head of the wide
plays first.

**Per episode:** four action scenes plus a title card and a closing memo card —
**75–100 seconds**, twelve plans. Below four action scenes an episode has no
shape; above six, the narration outruns what a viewer keeps from one sitting.

---

## 3. Start frames

Config: `production.frame`. Assembled per shot type by `guard.py:frame_rules()`
and pasted into every frame prompt.

A start frame that breaks these rules produces a clip that breaks them worse.
The video model extends what it is handed: a doorway in the start frame is an
invitation for somebody to walk through it; an open mouth is an invitation to
talk over the narration.

| Rule | Config key | The defect it prevents |
| --- | --- | --- |
| Three-quarter angle, head turned toward the object or the other person; never square to camera, never into the lens | `production.frame.solo` | A character addressing the viewer — a fourth wall this series never breaks — and a flat, posed frame with nowhere for motion to start from. |
| The character's own hands, or the object in their hands, in frame and unobstructed | `production.frame.solo` | Hands hidden at the start come back as extra hands, third arms and six fingers: the model has to invent them mid-clip, and it invents badly. |
| Mouth closed | `production.frame.solo` | Lip flap over dubbed narration. Nobody speaks on camera in this series. |
| Exactly one person in a solo shot — no second figure, no other hand, no reflection of another person | `production.frame.solo` | `extra_person`. A second body anywhere in frame, including in a window, gets animated. |
| No door, doorway, hatch, archway, stairwell or lit corridor in the background | `production.frame.noDoors` | The most common invented event of all: a passer-by. If nothing in frame suggests somebody *could* walk in, nobody does. The wall behind them is closed, or a window with weather, or equipment. |
| No readable text anywhere — labels, signs, screens, spines and pages are blank or illegible marks | `production.frame.noText` | `text_changed`. Generated letters mutate frame to frame; a label that rewrites itself over five seconds is unwatchable, and legible invented text is a rights problem as well as a visual one. |
| One tone per scene: the same time of day, the same light sources at the same strength, colour-matched to the scene's first frame | `production.frame.tone` | Shots that will not cut together. A medium graded two stops off its own wide makes one scene look like two locations. |

### The 16:9 rule, and why it is in bold

**A start frame must be generated 16:9, with an explicit `--size`.**

`auto_storyboard.py` defaults to `--size 2560x1440`, and that default is not
decoration. Seedream's edit endpoint **does not inherit aspect ratio from its
reference images**: hand it a stack of square character sheets and it will
happily return a portrait master. A portrait master pillarboxes its clip, the
clip pillarboxes its scene, and the scene pillarboxes the episode — black bars
down both sides of a 1920×1080 delivery, discovered at assembly, after every
clip has already been paid for. Pass the size on every still, and check the
first master's actual dimensions before shooting the other eleven.

---

## 4. Motion prompts

Config: `production.guard`. Applied by `applyGuard()` / `apply_guard()`,
checked by `checkMotion()` / `check_motion()`.
[`wavespeed_batch.mjs`](../engine/wavespeed_batch.mjs) runs
`guardPlans(..., { strict: true })` before it spends anything: a plan that
cannot be fixed by prepending the guard **stops the run**. It is not shot and
rejected afterwards — the refusal is free, the clip is not.

### The guard clause

Prepended verbatim to every motion prompt, with `{who}` filled from
`production.guard.counts` by **the shot's own cast size**, not the scene's — a
solo insert cut out of a two-hander is a one-person shot.

> Exactly {who} in the shot; nobody else enters or leaves the frame; every hand
> visible in the frame belongs to a person visible in the frame; every door,
> hatch and opening in the background stays closed; mouths stay closed; the
> camera is static and locked off — no zoom, no pan, no dolly, no cut.

Every clause is a defect somebody paid for: an extra person walked in, a hand
appeared with no owner, a door opened behind the actor, a mouth flapped over
the narration, the camera drifted and the shot would not cut.

Then the action, then `production.guard.actionSuffix`:

> One clear action with one object; it starts and finishes once inside the
> clip, at an even, unhurried speed. Everything else in the frame holds still.

**One action, one object.** Two objects in a motion line and the model swaps
them, merges them, or animates the wrong one. Two actions and it finishes
neither. If a scene genuinely needs two things to happen, that is two plans.

The action half must be at least twelve letters long. `checkMotion` refuses
anything shorter with *"no action after the guard — the clip has nothing to do
and will come back a still"*, which is precisely what happens.

### Banned phrases

`production.guard.banned`. Matched on word boundaries, and **only in the action
half** of the line — the guard's own wording contains "leaves the frame", so
scanning the whole line would flag every plan in the roll.

| Banned | Why |
| --- | --- |
| `breathe`, `breathes`, `breathing` | The classic filler action. Idle breathing lands below the still-frame floor: the model returns what is effectively a freeze frame, and the clip is rejected for not moving. If breathing is all the shot has, the shot has nothing. |
| `walks off`, `walks away`, `walks out`, `steps out of frame`, `leaves the frame` | Anything "off frame" tells the model the frame has an off-stage, and it populates it. The exit becomes an entrance and a passer-by arrives. |
| `turns to camera`, `turns to the camera`, `looks at camera`, `looks at the camera`, `looks into the lens` | Breaks the fourth wall the series never breaks. |
| `camera pans`, `camera zooms`, `camera pushes`, `zoom in`, `pan across` | Fights `camera_fixed: true` in the model call. The model obeys one of the two at random, and half a scene comes back on a moving camera that will not cut against the other half. Camera moves are added at assembly (`--push`), where they are free and reversible. |
| `cut to` | A cut inside a five-second clip is a jump, and it is scored as one (`jump_max`). |

### Negative prompt

`production.guard.negativePrompt`, sent with every model call that accepts one:

```
extra person, extra hand, disembodied hand, third arm, duplicated character,
face morphing, changing clothes, changing hair, object appearing from nowhere,
floating object, readable text, letters, watermark, subtitles, camera zoom,
camera pan, camera shake, freeze frame, still image, looping stutter,
motion blur, photorealism, extra fingers
```

It is the defect vocabulary of [QA-CHECKLIST.md](QA-CHECKLIST.md) turned
around. Note that on a distilled ComfyUI graph at cfg = 1 a negative prompt is
inert unless NAG is present — see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 5. End frames

Only the `wide` of a scene is shot first-frame-to-last-frame. The solo shots
are i2v, because a close-up given an end key is a close-up that has been told
to arrive somewhere, and what it usually does instead is loop.

The mode comes from the scenario's `key:` field, per scene:

| `key:` | What happens | Cost | Use it when |
| --- | --- | --- | --- |
| `closed` (default) | The end frame **is** the start frame: the master is copied to `keys/planN_key.png`. | Free — no second generation, and no tone drift to correct. | The action is there-and-back: a lever pulled and released, a head turned and turned back, a hand that reaches and returns. Closed by construction. |
| `edit` | One honest change, generated as an edit off the master ("everything else exactly the same … exactly one thing is different, because the shot has finished") and tone-matched back to the master by [`color_match.py`](../engine/color_match.py). | One still. | The action genuinely changes the world — a key changes hands, a lamp comes on — and returning to the start frame would be a lie. |
| `none` | No key; the wide is shot i2v like the rest. | Free. | The action is one-way and the arrival point does not matter. |

The colour match is not optional on `edit`. A key generated separately lands a
few points off the master's grade, and a clip shot *toward* it arrives at that
grade — a five-second colour ramp that reads as a lighting change nobody asked
for. It scores as `color_drift` and it is a reject.

### The `end_image` trap

On WaveSpeed, **only Kling 2.6 Pro accepts an end frame**, and the field is
called **`end_image`**.

| Model | End frame | Field | 5 s |
| --- | --- | --- | --- |
| `kling26-pro` | yes | `end_image` | $0.35 |
| `kling26-std` | no — i2v only | — | $0.21 |
| `kling21-flf` | yes, required | `end_image` | $0.45 |
| everything else in the `MODELS` table | no | — | see README |

`last_image` is **silently ignored**. The request succeeds, the clip comes
back, it costs full price — and it simply has no first-last-frame behaviour,
which on a contact sheet looks exactly like a model that is bad at holding a
composition. Diagnosing that cost this project a whole round of shooting. The
field name lives in the `MODELS` table in `wavespeed_batch.mjs`
(`end: "end_image"`), and the script now refuses outright rather than
downgrading a keyed plan to i2v behind your back.

Because the wide needs Pro and the two solos do not, each plan carries its own
`model` and the whole roll is shot with one command: **`--model auto`**. Two
`--only` lists with two different `--model` flags is how plans end up shot on
the wrong one.

---

## 6. Picture

- **Clips are used at the resolution the model returns.** Never downscaled to
  "match" something else. Scaling happens once, at the final encode (`norm()`
  in the assembler: `scale … force_original_aspect_ratio=decrease`, then pad).
  A clip downscaled on intake and upscaled again at assembly is visibly worse
  than the same clip padded once.
- **Assembly encodes at CRF 16 or lower.** The knob is `encode.videoArgs`
  (the example ships `-crf 18`, which is fine for a demo and too loose for a
  delivered series). Everything is re-encoded at least twice — the per-scene
  concat and the final mux — and generated video, with its fine grain and soft
  gradients, falls apart under compression faster than camera footage does.
  Losing detail at the last step, after paying for every clip, is the cheapest
  mistake on this list to avoid.
- **Brand cards and caption plates.** Title, divider and memo cards come from
  `cards.titleBg` / `cards.dividerBg` / `cards.memoBg` (1920×1080 PNG, no text
  baked in) when those files exist, and are drawn programmatically from
  `colors`, `fonts`, `title`, `plate` and `memo` when they do not. No series
  name is invented: `series.name` and `series.tagline` are drawn only if set.
  Captions are drawn twice — an ink-coloured box first, a cream box three
  pixels narrower on top — so the plate keeps its outline over any frame.
- **One narration voice for the whole series.** `audio.elevenlabs.voiceId`,
  pinned for the life of the series and never changed mid-way. Narration is
  cached per line (`takes/<id>/vo/<scene>.mp3`), so a re-cut costs nothing —
  but a voice change costs every episode, because a viewer notices a new
  narrator in episode nine instantly.

---

## What to read next

- [QA-CHECKLIST.md](QA-CHECKLIST.md) — how a clip is accepted or rejected
  against these rules, and the defect vocabulary the rejection has to use.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the backends these rules are shot on.
