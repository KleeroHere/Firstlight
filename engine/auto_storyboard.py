#!/usr/bin/env python
"""Scenario -> shot list -> start frames (and end keys), with no per-shot
storyboard written by hand.

The manual path has a person write, for every shot, which frame to generate and
what it should look like. Most of that is redundant: the scenario already says
who is in a scene, where it happens and what happens over it. This script
applies the editing judgement a person would apply -- establish the space, move
in on whoever is acting, come back out -- and calls the image backend itself,
so the input to a roll really can be the three things README promises:
character sheets, background plates, and a scenario.

    python engine/build_prompts.py                      # yaml -> compiled json
    python engine/auto_storyboard.py --id fog-signal-check
    python engine/auto_storyboard.py --id fog-signal-check --only s2 --redo
    python engine/auto_storyboard.py --id fog-signal-check --dry

Shot grammar -- one editorial rule, applied identically to every scene:

  WIDE    the whole scene cast in the location, the scene's own `anim` line as
          the motion, and an END KEY so the clip is shot first-to-last-frame
          rather than "and then whatever the model felt like".
  MEDIUM  the acting character alone, waist-up, three-quarter, their own hands
          (or the object in them) in frame.
  CLOSE   the other character in a two-hander, or the same one solo, on hands
          or face -- no end key, so it can never be asked to loop.

Three shots per scene, always -- not "if the scene is long enough". A scene cut
from one angle is the thing owners call a slideshow; length is not what decides
whether an edit exists. The assembler (assemble_from_plans.mjs) lays them out
wide -> medium -> close -> back to the wide's own tail, so the return to the
establishing shot costs no extra clip.

End keys, per scene, from the scenario's `key:` field:
  closed  (default) the end frame IS the start frame -- a there-and-back action
          that finishes where it began. Costs nothing: the master is copied.
  edit    one honest change, generated as a Seedream edit off the master and
          tone-matched back to it (engine/color_match.py). Use it when the
          scene's action genuinely changes the world (a key changes hands, a
          lamp comes on) and returning to the start would be a lie.
  none    no key; the wide is shot i2v like the rest.

Every motion line goes through engine/guard.py, so the head-count / closed-door
/ locked-camera clauses and the banned-verb check are applied here rather than
being remembered by whoever writes the plans. Every frame prompt carries the
composition rules from the same config block. See docs/PRODUCTION-RULES.md.

Writes workspace/plans/<id>.json (read unchanged by wavespeed_batch.mjs and
flf_batch.mjs) and the master/key PNGs under workspace/takes/<id>/.
"""
import argparse
import json
import os
import shutil
import subprocess

import paths
from guard import apply_guard, check_motion, frame_rules

COMPILED = str(paths.COMPILED)
ROOT = str(paths.ROOT)

# Which motion model each shot is booked against. The wide needs an end frame,
# and on WaveSpeed only Kling 2.6 *Pro* takes one (`end_image`); the solo shots
# are i2v and go to Std, which is the same generation of model at 60% of the
# price. `--model auto` in wavespeed_batch.mjs reads these back.
MODEL_KEYED = "kling26-pro"
MODEL_I2V = "kling26-std"


def passport_of(compiled, name):
    return compiled["characters"][name]["passport"]


def ref_path(char, key):
    return os.path.join("workspace", "refs", char, f"{key}.png").replace("\\", "/")


def best_ref(char, *keys):
    for k in keys:
        p = ref_path(char, k)
        if os.path.exists(os.path.join(ROOT, p)):
            return p
    return ref_path(char, "base")


# Which reference sheet a solo shot is built from. `base` first, deliberately:
# a "dialog" sheet is a picture of the character SPEAKING, and handing it to the
# image model for a shot whose rule is "mouth closed" fights that rule with a
# reference image -- which the model believes over the sentence. This series
# never shows anyone talking on camera (narration is dubbed), so the talking
# sheet is the wrong default everywhere; it stays on disk for a series that
# does want it.
SOLO_REFS = ("base", "dialog")


def solo_anim(anim, primary, compiled):
    """The scene's `anim` line, trimmed to one person's part of it.

    A two-person `anim` scripts both actors by name ("Mara hands over the log;
    Tomas takes it with both hands"). Reused whole in a SOLO shot, that sentence
    itself puts the other person's hand in frame, however firmly the guard says
    "exactly one person". So: split on ';'/'.', keep the clauses naming
    `primary`, and if none do (a solo scene) fall back to the whole line.
    """
    name = compiled["characters"].get(primary, {}).get("name", primary)
    other_names = [c["name"] for k, c in compiled["characters"].items() if k != primary and c.get("name")]
    clauses = [c.strip() for c in anim.replace(";", ".").split(".") if c.strip()]
    mine = [c for c in clauses if name.lower() in c.lower()]
    if not mine:
        return anim
    picked = ". ".join(mine) + "."
    if any(o.lower() in picked.lower() for o in other_names):
        return f"{name} carries on their own part of it, unhurried; nobody else is in the frame."
    return picked


def build_shots(scene, compiled):
    """Three shots per scene: wide, medium, close. Always."""
    chars = scene.get("chars") or []
    bg = compiled["backgrounds"][scene["bg"]]
    img = scene.get("img", "")
    anim = scene.get("anim", "")
    # `anim_wide` lets the establishing shot carry a bigger gesture than the
    # inserts do. The wide is the one shot a viewer reads as "the scene", and a
    # gesture that is legible in a close-up -- a pencil moving, a key ring
    # changing hands -- can be too small to register across a whole room. It
    # also rescues a scene whose start frame has already arrived at the end of
    # its action: give the wide the reverse of it and the clip has somewhere to
    # go, without regenerating any frame.
    wide_anim = scene.get("anim_wide") or anim
    # `anim_solo` is the same escape hatch for the medium and close shots: when
    # the start frame has already arrived at the end of the scene's action, the
    # solo shots need the reverse of it too, or they come back frozen for the
    # same reason the wide did.
    solo_base = scene.get("anim_solo") or anim
    note = (" " + scene["motion_note"].strip()) if scene.get("motion_note") else ""
    style = compiled["style"]
    shots = []

    # ---- WIDE: the cast in the location, the scene's own action ----
    cast = chars or ["?"]
    passports = "; ".join(f"{compiled['characters'][c]['name']}: {passport_of(compiled, c)}" for c in cast)
    shots.append(dict(
        shot="wide", role="wide", cast=cast,
        frame_prompt=f"{frame_rules('wide')} {style} Location: {bg['desc']} {passports}. {img}",
        motion=apply_guard(wide_anim + note, len(cast)),
        refs=[bg["file"]] + [best_ref(c, "fullbody", "base") for c in cast],
    ))

    if not chars:
        return shots

    # ---- MEDIUM: the acting character, alone, waist-up ----
    primary = chars[0]
    my_anim = solo_anim(solo_base, primary, compiled)
    my_img = solo_anim(img, primary, compiled) if len(chars) > 1 else img
    shots.append(dict(
        shot="medium", role="medium", cast=[primary],
        frame_prompt=(
            # The location goes FIRST and is named twice. A character reference
            # sheet is a strong anchor: give the model the person before the
            # place and it will keep the person and quietly relocate them --
            # which is how a scene ends up with its close-up shot somewhere
            # else entirely, on a pier when the wide was indoors.
            f"Set in {bg['name']}: {bg['desc']} "
            f"Medium shot, waist-up, of exactly one person in that same place: "
            f"{compiled['characters'][primary]['name']}, {passport_of(compiled, primary)} {my_img} "
            f"{frame_rules('medium')} {style} "
            f"Behind them, softly out of focus, is unmistakably {bg['name']} and nowhere else."
        ),
        motion=apply_guard(my_anim + note, 1),
        refs=[bg["file"], best_ref(primary, *SOLO_REFS)],
    ))

    # ---- CLOSE: the other one in a two-hander, on hands or face ----
    other = chars[-1] if len(chars) > 1 else chars[0]
    their_anim = solo_anim(solo_base, other, compiled)
    shots.append(dict(
        shot="close", role="close", cast=[other],
        frame_prompt=(
            f"Set in {bg['name']}: {bg['desc']} "
            f"Close shot, in that same place, on the hands of exactly one person: "
            f"{compiled['characters'][other]['name']}, {passport_of(compiled, other)} "
            f"Their own two hands, and the object they are handling, fill the frame, doing part of: {their_anim} "
            f"This is the same moment as the rest of the scene, which is: {img} Keep that light, that "
            "weather and that time of day exactly. "
            f"{frame_rules('close')} {style} "
            f"The little of the background that shows is {bg['name']}, thrown well out of focus -- "
            "not another location. The frame edges are quiet: the place simply continues, "
            "nothing enters from any edge."
        ),
        motion=apply_guard(
            "Only their own hands move, completing one small part of: " + their_anim
            + " The motion starts and finishes once; it does not loop or repeat." + note, 1),
        refs=[bg["file"], best_ref(other, *SOLO_REFS)],
    ))
    return shots


def gen_image(backend, refs, prompt, out, tag, ledger, size, seed, redo=False, dry=False):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out) and not redo:
        return "exists"
    if dry:
        return "dry"
    if backend == "wavespeed":
        cmd = ["node", os.path.join(ROOT, "engine", "wavespeed_stills.mjs"),
               "--edit", ",".join(refs), "--prompt", prompt, "--out", out,
               "--tag", tag, "--ledger", ledger, "--size", size.replace("x", "*")]
    else:
        cmd = ["python", os.path.join(ROOT, "engine", "klein_keys.py")]
        for r in refs:
            cmd += ["--ref", os.path.join(ROOT, r)]
        cmd += ["--prompt", prompt, "--out", out, "--size", size, "--seed", str(seed)]
    subprocess.run(cmd, check=True, cwd=ROOT)
    return "generated"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True)
    ap.add_argument("--backend", choices=["wavespeed", "klein"], default="wavespeed")
    ap.add_argument("--only", default="", help="scene ids, comma-separated")
    ap.add_argument("--plans", default="",
                    help="plan numbers, comma-separated -- work on exactly these plans and leave "
                         "the rest of their scene alone. Restricts scope only: add --redo to actually "
                         "regenerate their frames, omit it to re-plan them (mode, end key, model) "
                         "while keeping frames an acceptance pass has already approved")
    ap.add_argument("--redo", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--size", default="2560x1440",
                    help="start-frame size. 16:9 -- a portrait master is the single most "
                         "expensive mistake in this pipeline, it pillarboxes the whole episode")
    ap.add_argument("--ledger", default=os.path.join(ROOT, "reports", "wavespeed-spend.json"))
    ap.add_argument("--dry", action="store_true", help="print the plan, generate nothing")
    a = ap.parse_args()

    compiled_path = os.path.join(COMPILED, f"{a.id}.json")
    if not os.path.exists(compiled_path):
        raise SystemExit(f"no compiled {a.id}.json -- run python engine/build_prompts.py first")
    compiled = json.load(open(compiled_path, encoding="utf-8"))
    only = set(a.only.split(",")) if a.only else None
    only_plans = {int(x) for x in a.plans.split(",") if x.strip()} if a.plans else None

    takes = os.path.join(ROOT, "workspace", "takes", a.id)
    keys_dir = os.path.join(takes, "keys")
    plans_path = os.path.join(ROOT, "workspace", "plans", f"{a.id}.json")
    existing = {}
    if os.path.exists(plans_path):
        existing = {p["plan"]: p for p in json.load(open(plans_path, encoding="utf-8"))["plans"]}

    # Plan numbers come from EVERY anim scene regardless of --only, so a partial
    # rerun never renumbers (and so never collides with) another scene's frames.
    all_anim = [sc for sc in compiled["scenes"] if sc.get("motion") == "anim"]

    plans, n, cost = [], 0, 0.0
    for sc in all_anim:
        key_mode = sc.get("key", "closed")
        # `solo_key: closed` closes the MEDIUM and CLOSE shots too, by shooting
        # them first-to-last-frame with the start frame as the end frame. It
        # costs more per clip (only the Pro endpoint takes an end frame), and it
        # is the fix for the three ways a solo i2v shot goes wrong: the actor
        # walks out of frame, a door opens behind them, or the object in their
        # hands turns into a different object. A clip that has to arrive back at
        # its own first frame can do none of those.
        solo_key = sc.get("solo_key")
        for shot in build_shots(sc, compiled):
            n += 1
            selected = (not only or sc["id"] in only) and (only_plans is None or n in only_plans)
            master = f"plan{n}_master.png"
            master_path = os.path.join(takes, master)
            ok, problems = check_motion(shot["motion"])
            if not ok:
                raise SystemExit(f"plan {n} ({sc['id']} {shot['shot']}): GUARD {'; '.join(problems)}")
            if shot["role"] == "wide":
                mode = key_mode
            else:
                mode = solo_key if solo_key in ("closed", "edit") else None
            has_key = mode in ("closed", "edit")
            plan = {
                "plan": n, "scene": sc["id"], "shot": shot["shot"], "role": shot["role"],
                "cast_size": len(shot["cast"]), "master": master, "frames": 81,
                "i2v": not has_key, "motion": shot["motion"],
                "model": MODEL_KEYED if has_key else MODEL_I2V,
            }
            if has_key:
                plan["use_key"] = True
                plan["key_mode"] = mode
            if not selected:
                plans.append(existing.get(n, plan))
                continue
            print(f"plan {n:<2} {sc['id']:<4} {shot['role']:<6} cast={','.join(shot['cast']):<14} "
                  f"{plan['model']:<12} -> {master}")
            redo = a.redo
            st = gen_image(a.backend, shot["refs"], shot["frame_prompt"], master_path,
                           f"{a.id}-plan{n}-master", a.ledger, a.size, a.seed + n, redo, a.dry)
            if st in ("generated", "dry"):
                cost += 0.027 if a.backend == "wavespeed" else 0.0
            if has_key:
                key_path = os.path.join(keys_dir, f"plan{n}_key.png")
                if mode == "closed":
                    # The end frame IS the start frame. A there-and-back action
                    # (a lever pulled and released, a head turned and turned
                    # back) is closed by construction, and it costs nothing --
                    # no second generation, and no tone drift to correct.
                    print(f"        + end key (closed loop, free) -> keys/plan{n}_key.png")
                    if not a.dry and (redo or not os.path.exists(key_path)):
                        os.makedirs(keys_dir, exist_ok=True)
                        shutil.copyfile(master_path, key_path)
                else:
                    change = sc.get("key_change") or shot["motion"]
                    key_prompt = (
                        "Edit this image, keeping everything else exactly the same: the same room, "
                        "the same light and colour temperature, the same style, the same camera and "
                        "framing, the same people in the same clothes in the same places, the same "
                        "number of hands. Exactly one thing is different, because the shot has "
                        f"finished: {change} Nothing else in the frame has moved.")
                    print(f"        + end key (edit) -> keys/plan{n}_key.png")
                    st = gen_image(a.backend, [master_path], key_prompt, key_path,
                                   f"{a.id}-plan{n}-key", a.ledger, a.size, a.seed + 100 + n, redo, a.dry)
                    if st in ("generated", "dry"):
                        cost += 0.027 if a.backend == "wavespeed" else 0.0
            plans.append(plan)

    scenes = len({p["scene"] for p in plans})
    print(f"\n{a.id}: {len(plans)} plans across {scenes} scenes; stills this run ~${cost:.2f}")
    if a.dry:
        print("(dry run; nothing generated, workspace/plans not written)")
        return
    os.makedirs(os.path.dirname(plans_path), exist_ok=True)
    json.dump({"id": a.id, "plans": plans}, open(plans_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"written: {os.path.relpath(plans_path, ROOT)}")
    # One tone per scene. Each frame came from its own image-edit call, and two
    # calls off the same background can land a whole grade apart; cut together
    # that reads as two different evenings. The scene's wide frame is the
    # reference, everything else in the scene is pulled toward it.
    cm = os.path.join(ROOT, "engine", "color_match.py")
    grade = ["python", cm, "--id", a.id, "--masters"]
    if only_plans:
        # Grading is idempotent per frame (originals are kept in _raw/), but
        # only the frames that were just regenerated need it.
        grade += ["--only", ",".join(str(x) for x in sorted(only_plans))]
    subprocess.run(grade, check=True, cwd=ROOT)
    # ...and every generated end key back to its own master, so a clip shot
    # first-to-last-frame does not "arrive" at a different colour grade.
    if any(p.get("key_mode") == "edit" for p in plans):
        subprocess.run(["python", cm, "--id", a.id], check=True, cwd=ROOT)
    # A `closed` key IS the master, so it has to be re-copied after the master
    # was graded — otherwise the clip starts graded and ends ungraded.
    for p in plans:
        if p.get("key_mode") == "closed":
            shutil.copyfile(os.path.join(takes, p["master"]),
                            os.path.join(keys_dir, f"plan{p['plan']}_key.png"))


if __name__ == "__main__":
    main()
