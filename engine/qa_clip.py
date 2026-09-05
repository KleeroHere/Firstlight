#!/usr/bin/env python
"""Objective metrics for a shot clip, plus a contact sheet — a QA agent's
first pass before a human looks at anything (see docs/ARCHITECTURE.md,
Acceptance). None of these thresholds are a verdict; they flag what to look
at, the acceptance screen still decides.

    python engine/qa_clip.py clip.mp4 [--k0 master.png] [--k1 key.png] [--sheet out.jpg] [--json out.json]
    python engine/qa_clip.py --dir workspace/takes/<id>/_flf --plans workspace/plans/<id>.json --out reports/qa-<id>

Metrics (grayscale frames, scaled to 320px wide):
  sharp        — mean Laplacian variance; well below the master's = soft/blurred
  jump_max     — largest frame-to-frame difference (0..1); > 0.12 = a cut/jerk
  drift        — first-frame vs last-frame difference (background composition
                 "sliding" over the clip, not the intended motion)
  color_drift  — mean RGB shift first frame -> last frame (0..255)
  max_area_dev — largest share of the frame that differs from the clip's own
                 median frame by a lot, away from the first/last 8 frames
                 (an ordinary gesture is 1-3%; a passer-by or a stray hand is
                 6%+)
  k0_match     — 1 - difference of the first frame from the master (want > 0.9)
  k1_match     — 1 - difference of the last frame from the end key, for a
                 first-last-frame shot (want > 0.85)
"""
import argparse
import json
import os
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

W = 320


def ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return None


def frames(path):
    tmp = tempfile.mkdtemp()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf", f"scale={W}:-2",
                    os.path.join(tmp, "f%04d.png")], check=True)
    fs = sorted(os.listdir(tmp))
    out = [np.asarray(Image.open(os.path.join(tmp, f)).convert("RGB")).astype(np.float32) for f in fs]
    for f in fs:
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)
    return out


def gray(a):
    return a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)


def laplacian_var(g):
    k = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return float(k.var())


def load_img(p):
    im = Image.open(p).convert("RGB")
    im = im.resize((W, round(W * im.height / im.width)))
    return np.asarray(im).astype(np.float32)


def diff(a, b):
    if a.shape != b.shape:
        h = min(a.shape[0], b.shape[0])
        a, b = a[:h], b[:h]
    return float(np.abs(gray(a) - gray(b)).mean() / 255.0)


def metrics(clip, k0=None, k1=None):
    fr = frames(clip)
    dur = ffprobe_duration(clip)
    fps = (len(fr) / dur) if dur else 24.0
    g = [gray(f) for f in fr]
    sharp = float(np.mean([laplacian_var(x) for x in g]))
    jumps = [diff(fr[i], fr[i + 1]) for i in range(len(fr) - 1)]
    med = np.median(np.stack(fr), axis=0)
    m = {
        "frames": len(fr),
        "fps_est": round(fps, 2),
        "sharp": round(sharp, 1),
        "jump_max": round(max(jumps), 4) if jumps else 0,
        "jump_mean": round(float(np.mean(jumps)), 4) if jumps else 0,
        "jump_at": int(np.argmax(jumps)) + 1 if jumps else 0,
        "drift": round(diff(fr[0], fr[-1]), 4),
        "color_drift": round(float(np.abs(fr[0].mean(axis=(0, 1)) - fr[-1].mean(axis=(0, 1))).mean()), 2),
        "max_dev_med": round(max(diff(f, med) for f in fr), 4),
        "max_dev_at": int(np.argmax([diff(f, med) for f in fr])) + 1,
    }
    areas = [float((np.abs(gray(f) - gray(med)) > 40).mean()) for f in fr]
    inner = areas[8:-8] if len(areas) > 24 else areas
    m["max_area_dev"] = round(max(inner), 4) if inner else 0
    m["max_area_at"] = (int(np.argmax(inner)) + 9) if inner else 0
    if k0 and os.path.exists(k0):
        m["k0_match"] = round(1 - diff(load_img(k0), fr[0]), 4)
    if k1 and os.path.exists(k1):
        m["k1_match"] = round(1 - diff(load_img(k1), fr[-1]), 4)
    flags = []
    if m["jump_max"] > 0.12:
        flags.append(f"jerk/cut at frame {m['jump_at']} ({m['jump_max']})")
    if m["color_drift"] > 6:
        flags.append(f"colour drifted ({m['color_drift']})")
    if m["max_area_dev"] > 0.06:
        flags.append(f"large change mid-clip, frame {m['max_area_at']} ({m['max_area_dev']:.0%} of frame) — extra person/hand?")
    if m.get("k0_match", 1) < 0.9:
        flags.append(f"start doesn't match the master ({m['k0_match']})")
    if m.get("k1_match", 1) < 0.85:
        flags.append(f"finish doesn't match the end key ({m['k1_match']})")
    m["flags"] = flags
    return m, fr


def sheet(fr, out, n=6):
    idx = np.linspace(0, len(fr) - 1, min(n, len(fr))).round().astype(int)
    h = fr[0].shape[0]
    im = Image.new("RGB", (W * len(idx) + 4 * (len(idx) - 1), h + 22), "white")
    d = ImageDraw.Draw(im)
    for j, i in enumerate(idx):
        x = j * (W + 4)
        im.paste(Image.fromarray(fr[i].astype(np.uint8)), (x, 22))
        d.text((x + 4, 4), f"#{i + 1}", fill="black")
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    im.save(out, quality=88)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip", nargs="?")
    ap.add_argument("--k0")
    ap.add_argument("--k1")
    ap.add_argument("--sheet")
    ap.add_argument("--json")
    ap.add_argument("--dir")
    ap.add_argument("--plans")
    ap.add_argument("--out")
    a = ap.parse_args()

    if a.dir:
        spec = json.load(open(a.plans, encoding="utf-8"))
        takes = os.path.dirname(a.dir.rstrip("/\\"))
        os.makedirs(a.out, exist_ok=True)
        rows = []
        for p in spec["plans"]:
            clip = os.path.join(a.dir, f"plan{p['plan']}.mp4")
            if not os.path.exists(clip):
                continue
            k0 = os.path.join(takes, p["master"]) if not str(p.get("master", "")).startswith("chain:") else None
            k1 = os.path.join(takes, "keys", f"plan{p['plan']}_key.png") if p.get("use_key") else None
            m, fr = metrics(clip, k0, k1)
            sheet(fr, os.path.join(a.out, f"plan{p['plan']}.jpg"))
            m.update(plan=p["plan"], scene=p["scene"], shot=p.get("shot"), clip=clip)
            rows.append(m)
            print(f"plan {p['plan']:>2} {p['scene']:<4} {str(p.get('shot')):<6} sharp {m['sharp']:>7} "
                  f"jump {m['jump_max']:.3f} drift {m['drift']:.3f} color {m['color_drift']:>5} "
                  f"{'; '.join(m['flags'])}")
        json.dump(rows, open(os.path.join(a.out, "metrics.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return

    m, fr = metrics(a.clip, a.k0, a.k1)
    if a.sheet:
        sheet(fr, a.sheet)
    if a.json:
        json.dump(m, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(m, ensure_ascii=False))


if __name__ == "__main__":
    main()
