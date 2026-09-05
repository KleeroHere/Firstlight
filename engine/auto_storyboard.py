#!/usr/bin/env python
"""Scenario -> shot-list -> keyframes, with no per-shot storyboard written by hand.

The manual path (see the "Fog signal check" roll) has a person write, for
every shot, which frame to generate and what it should look like. Most of the
time that is redundant: the scenario already says who is in a scene, where it
happens and what happens over it. This script does the editing judgement a
person would apply — establish the space, then move in on whoever is acting —
and calls the image backend itself, so the input to a roll can really be just
the three things the README promises: character sheets, background plates,
and a scenario (scene text + narration). Manual per-shot intake
(`ingest_manual_shots.mjs`) remains the fallback when a shot needs more
correction than a prompt can express.

    python engine/auto_storyboard.py --id handover-at-the-pier
    python engine/auto_storyboard.py --id handover-at-the-pier --only s2 --redo
    python engine/auto_storyboard.py --id handover-at-the-pier --backend klein --dry

Shot grammar (one editorial rule, applied the same way to every scene):
  - every scene opens on a WIDE shot: everyone in the scene, the background in
    full, the scene's own `anim` line as the motion.
  - a scene running >= 14s also gets a MEDIUM shot: the first-listed character,
    three-quarter angle (never facing the camera), waist-up, alone in frame.
  - a scene running >= 17s also gets a CLOSE shot: the last-listed character
    (the other one, in a two-hander) or the same one (solo scenes), on their
    hands or face, no end key (see docs' "close-up without a key" rule) so it
    can't be asked to loop.
  - every shot's motion carries the head-count guard ("exactly N people...",
    doors stay closed, camera locked) that the manual plans also use, scaled
    to that shot's own cast, not the scene's.
The WIDE shot of the scene's own first anim scene additionally gets an end
keyframe (an image-edit off its own start frame) and `use_key: true`, so the
plan-list demonstrates the first/last-frame path too, not only i2v.

Writes `workspace/plans/<id>.json` (read by flf_batch.mjs / wavespeed_batch.mjs
unchanged) and the master/key PNGs under `workspace/takes/<id>/`. Character
reference images are expected at `workspace/refs/<character>/<ref>.png` and
backgrounds at the `file` compiled from series.yaml — both already the case
for every roll shipped with this repository.
"""
import argparse
import json
import os
import subprocess
import sys

import paths

COMPILED = str(paths.COMPILED)
ROOT = str(paths.ROOT)

WORDS = {1: "one person is", 2: "two people are", 3: "three people are", 4: "four people are"}


def guard(n):
    who = WORDS.get(n, f"{n} people are")
    return (f"Exactly {who} in the shot; nobody else enters or leaves the frame; "
            "every door in the background stays closed; the camera is static "
            "and locked off, no zoom, no cut.")


def passport_of(compiled, name):
    return compiled["characters"][name]["passport"]


def ref_path(char, key):
    return os.path.join("workspace", "refs", char, f"{key}.png").replace("\\", "/")


def solo_anim(anim, primary, compiled):
    """The scene's `anim` line, trimmed to one person's part of it.

    A two-person `anim` scripts both actors by name (e.g. "Mara hands over
    the log; Tomas takes it with both hands") — reused whole in a SOLO
    medium/close shot, that sentence itself puts the other person's hand in
    frame, no matter how firmly the guard clause says "exactly one person".
    So: split on ';'/'.', keep only the clause(s) naming `primary`, and if
    none do (a solo scene, or the split didn't find a name), fall back to the
    whole line — there is nothing to strip.
    """
    name = compiled["characters"].get(primary, {}).get("name", primary)
    other_names = [c["name"] for k, c in compiled["characters"].items() if k != primary and c.get("name")]
    clauses = [c.strip() for c in anim.replace(";", ".").split(".") if c.strip()]
    mine = [c for c in clauses if name.lower() in c.lower()]
    if not mine:
        return anim
    picked = ". ".join(mine) + "."
    # Defensive: if the kept clause still names someone else, this scene's
    # anim doesn't split cleanly by actor — better to say less than to
    # script another person's hand into a solo frame.
    if any(o.lower() in picked.lower() for o in other_names):
        return f"{name} continues their own part of it, calm and still; nobody else is in the frame."
    return picked


def build_shots(scene, compiled):
    """One editorial rule, same for every scene: wide always, medium/close by length."""
    chars = scene.get("chars") or []
    dur = scene["t"][1] - scene["t"][0]
    bg = compiled["backgrounds"][scene["bg"]]
    img, anim, vo = scene.get("img", ""), scene.get("anim", ""), scene.get("vo", "")

    shots = []
    # WIDE — the whole scene cast, the establishing action.
    cast = chars or ["?"]
    passports = "; ".join(f"{c}: {passport_of(compiled, c)}" for c in cast)
    frame_prompt = (f"Wide establishing shot. {compiled['style']} {bg['desc']} "
                     f"{passports}. {img}")
    motion = f"{guard(len(cast))} {anim}"
    refs = [bg["file"]] + [ref_path(c, "fullbody") if os.path.exists(os.path.join(ROOT, ref_path(c, "fullbody")))
                            else ref_path(c, "base") for c in cast]
    shots.append(dict(shot="wide", cast=cast, frame_prompt=frame_prompt, motion=motion, refs=refs, key=False))

    if dur >= 14 and chars:
        primary = chars[0]
        my_anim = solo_anim(anim, primary, compiled)
        my_img = solo_anim(img, primary, compiled) if len(chars) > 1 else img
        frame_prompt = (f"Medium shot, waist-up, three-quarter angle, not facing the camera "
                         f"directly, of exactly one person: {passport_of(compiled, primary)} "
                         f"{my_img} Background: {bg['desc']}, softly out of focus behind them. "
                         "Solo shot: only this one person, no other hands, no other figure, "
                         "no door or opening visible behind them.")
        motion = f"{guard(1)} {my_anim} Their mouth stays closed unless they are the one speaking."
        refs = [bg["file"], ref_path(primary, "dialog") if os.path.exists(os.path.join(ROOT, ref_path(primary, "dialog")))
                else ref_path(primary, "base")]
        shots.append(dict(shot="medium", cast=[primary], frame_prompt=frame_prompt, motion=motion, refs=refs, key=False))

    if dur >= 17 and chars:
        primary = chars[-1] if len(chars) > 1 else chars[0]
        my_anim = solo_anim(anim, primary, compiled)
        frame_prompt = (f"Close, detail shot on the hands (or, if that reads better, the face) of "
                         f"exactly one person: {passport_of(compiled, primary)} Their own two hands "
                         "are the only hands in frame, doing one small part of: "
                         f"{my_anim} Background: {bg['desc']}, well out of focus. The frame edges are "
                         "described positively: the room continues quietly behind them, nothing "
                         "else enters from any edge.")
        motion = (f"{guard(1)} Only their own hands (or face) move, doing one small, calm motion "
                  "related to: " + my_anim + " Nothing loops; the motion starts and finishes once.")
        refs = [bg["file"], ref_path(primary, "dialog") if os.path.exists(os.path.join(ROOT, ref_path(primary, "dialog")))
                else ref_path(primary, "base")]
        shots.append(dict(shot="close", cast=[primary], frame_prompt=frame_prompt, motion=motion, refs=refs, key=False))

    return shots


def gen_image(backend, refs, prompt, out, tag, ledger, size, seed, redo=False):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out) and not redo:
        return "exists"
    if backend == "wavespeed":
        cmd = [sys.executable.replace("python.exe", "node") if False else "node",
               os.path.join(ROOT, "engine", "wavespeed_stills.mjs"),
               "--edit", ",".join(refs), "--prompt", prompt, "--out", out,
               "--tag", tag, "--ledger", ledger]
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
    ap.add_argument("--redo", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--ledger", default=os.path.join(ROOT, "reports", "wavespeed-spend.json"))
    ap.add_argument("--dry", action="store_true", help="print the plan, generate nothing")
    a = ap.parse_args()

    compiled_path = os.path.join(COMPILED, f"{a.id}.json")
    if not os.path.exists(compiled_path):
        raise SystemExit(f"no compiled {a.id}.json — run build_prompts.py first")
    compiled = json.load(open(compiled_path, encoding="utf-8"))
    only = set(a.only.split(",")) if a.only else None

    takes = os.path.join(ROOT, "workspace", "takes", a.id)
    keys_dir = os.path.join(takes, "keys")
    plans_path = os.path.join(ROOT, "workspace", "plans", f"{a.id}.json")
    existing = {}
    if os.path.exists(plans_path):
        existing = {p["plan"]: p for p in json.load(open(plans_path, encoding="utf-8"))["plans"]}

    # Plan numbers and the FLF-demo scene are derived from EVERY anim scene in
    # the roll, regardless of --only, so a partial rerun never renumbers (and
    # so never collides with) another scene's already-generated frames.
    all_anim = [sc for sc in compiled["scenes"] if sc.get("motion") == "anim"]
    flf_scene_id = max(all_anim, key=lambda sc: len(sc.get("chars") or []))["id"] if all_anim else None

    plans, n = [], 0
    for sc in all_anim:
        for shot in build_shots(sc, compiled):
            n += 1
            selected = not only or sc["id"] in only
            master = f"plan{n}_master.png"
            master_path = os.path.join(takes, master)
            plan = {"plan": n, "scene": sc["id"], "shot": shot["shot"], "master": master,
                    "frames": 81, "i2v": True, "motion": shot["motion"]}
            has_key = shot["shot"] == "wide" and sc["id"] == flf_scene_id
            if has_key:
                plan["i2v"] = False
                plan["use_key"] = True
            if not selected:
                # Keep this scene exactly as it was written before (same plan
                # number already guaranteed by the loop above matching it).
                plans.append(existing.get(n, plan))
                continue
            print(f"plan {n:<2} {sc['id']:<4} {shot['shot']:<6} cast={','.join(shot['cast']):<14} -> {master}")
            if not a.dry:
                gen_image(a.backend, shot["refs"], shot["frame_prompt"], master_path,
                          f"{a.id}-plan{n}-master", a.ledger, a.size, a.seed + n, a.redo)
            if has_key:
                key_path = os.path.join(keys_dir, f"plan{n}_key.png")
                key_prompt = ("Edit this image keeping everything exactly the same: same room, "
                               "same light, same style, same camera, same people in the same "
                               "clothes and the same places. Only one change, by the end of the "
                               f"shot: {shot['motion'].split('. ', 1)[-1]}")
                print(f"        + end key -> keys/plan{n}_key.png")
                if not a.dry:
                    gen_image(a.backend, [master_path], key_prompt, key_path,
                              f"{a.id}-plan{n}-key", a.ledger, a.size, a.seed + 100 + n, a.redo)
            plans.append(plan)

    print(f"\n{a.id}: {len(plans)} plans across {len({p['scene'] for p in plans})} scenes")
    if a.dry:
        print("(dry run; nothing generated, workspace/plans not written)")
        return
    os.makedirs(os.path.dirname(plans_path), exist_ok=True)
    json.dump({"id": a.id, "plans": plans}, open(plans_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"written: {os.path.relpath(plans_path, ROOT)}")


if __name__ == "__main__":
    main()
