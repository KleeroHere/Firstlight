#!/usr/bin/env python
"""The shooting guard, Python side — the twin of engine/guard.mjs.

Both read the same block of engine/pipeline.config.json (`production`), so the
storyboard step (auto_storyboard.py, Python) and the shooting step
(wavespeed_batch.mjs / flf_batch.mjs, Node) cannot drift apart on what a motion
prompt must say or what a start frame must look like. The prose version, with
the reasoning for each clause, is docs/PRODUCTION-RULES.md.

    from guard import guard_text, apply_guard, check_motion, FRAME
"""
import json
import os
import re

import paths

_CFG = json.load(open(os.path.join(str(paths.ROOT), "engine", "pipeline.config.json"), encoding="utf-8"))
GUARD = _CFG["production"]["guard"]
FRAME = _CFG["production"]["frame"]
QA = _CFG["qa"]["thresholds"]
NEGATIVE = GUARD["negativePrompt"]

_MARK = re.compile(r"Exactly (one person is|two people are|three people are|four people are|\d+ people are) in the shot", re.I)


def guard_text(n):
    who = GUARD["counts"].get(str(n), f"{n} people are")
    return GUARD["template"].replace("{who}", who)


def has_guard(motion):
    return bool(_MARK.search(motion or ""))


def apply_guard(motion, cast=1):
    m = (motion or "").strip()
    if has_guard(m):
        return m
    return f"{guard_text(cast)} {m}".strip()


def action_of(motion):
    """The action half of a motion line — what is left once the guard is stripped."""
    m = (motion or "").strip()
    if not has_guard(m):
        return m
    i = m.find("no cut.")
    return m if i == -1 else m[i + len("no cut."):].strip()


def check_motion(motion):
    """Returns (ok, problems). Banned phrases are looked for in the action half
    only — the guard's own wording contains "leaves the frame"."""
    problems = []
    m = (motion or "").strip()
    if not m:
        return False, ["motion is empty"]
    if not has_guard(m):
        problems.append("no head-count guard")
    action = action_of(m)
    low = action.lower()
    for bad in GUARD["banned"]:
        if re.search(r"(^|[^a-z])" + re.escape(bad) + r"([^a-z]|$)", low, re.I):
            problems.append(f'banned motion phrase: "{bad}"')
    if len(re.sub(r"[^a-z]", "", action, flags=re.I)) < 12:
        problems.append("no action after the guard — the clip has nothing to do and will come back a still")
    return not problems, problems


def frame_rules(shot, solo=True):
    """The composition clauses a start frame prompt must carry for this shot type."""
    parts = []
    if shot == "wide":
        parts.append(FRAME["wide"])
    elif solo:
        parts.append(FRAME["solo"])
    if shot != "wide" and FRAME.get("mouth"):
        # Repeated after the composition clauses, not folded into them: an open
        # mouth is the defect that survives being mentioned once, because half
        # the reference sheets show the character speaking.
        parts.append(FRAME["mouth"])
    if shot in ("medium", "close") and FRAME.get("oneProp"):
        # A character reference sheet carries that character's usual props. Left
        # unsaid, they turn up in every shot -- the apprentice hauling a rope
        # ends up holding a pen, because the sheet he was drawn from had one.
        parts.append(FRAME["oneProp"])
    parts.append(FRAME["noDoors"])
    parts.append(FRAME["noText"])
    parts.append(FRAME["tone"])
    return " ".join(parts)
