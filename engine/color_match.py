#!/usr/bin/env python
"""Match a generated end-keyframe's tone back to its scene's master frame.

An end key is an edit of the master (see auto_storyboard.py / flf_keys.mjs):
the same image-edit call that changes the pose can also drift the tone a few
LAB units warmer or cooler. First-last-frame motion "arrives" at the key's
tone over the clip, which reads on screen as a visible colour-grade shift —
worth catching before a clip is shot, not after.

    python engine/color_match.py --id handover-at-the-pier [--only 3] [--strength 1.0]
    python engine/color_match.py --src master.png --dst key.png [--out key.png] [--mode meanstd|mean]

Matches full mean+std of L*a*b* (meanstd) by default — the safe choice for a
same-crop, same-composition edit like a key. `--mode mean` (mean only, gentler)
is there for a case where the two images differ more in composition than a key
normally does. Originals are kept beside the corrected file as `_raw/`.
"""
import argparse
import json
import os
import shutil

import numpy as np
from PIL import Image

import paths

ROOT = str(paths.ROOT)


def to_lab(a):
    a = a / 255.0
    m = a <= 0.04045
    a = np.where(m, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = a @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    A = 500 * (f[..., 0] - f[..., 1])
    B = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, A, B], axis=-1)


def from_lab(lab):
    L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16) / 116
    fx = fy + A / 500
    fz = fy - B / 200

    def inv(f):
        return np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787)

    xyz = np.stack([inv(fx), inv(fy), inv(fz)], axis=-1) * np.array([0.95047, 1.0, 1.08883])
    M = np.array([[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]])
    rgb = xyz @ M.T
    rgb = np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * np.power(np.clip(rgb, 0, None), 1 / 2.4) - 0.055)
    return np.clip(rgb * 255, 0, 255)


def match(src_img, dst_img, mode="meanstd", strength=1.0):
    """Push dst_img's tone toward src_img's. Returns a new PIL Image."""
    s = to_lab(np.asarray(src_img.convert("RGB")).astype(np.float64))
    d = to_lab(np.asarray(dst_img.convert("RGB")).astype(np.float64))
    ms, ss = s.reshape(-1, 3).mean(0), s.reshape(-1, 3).std(0) + 1e-6
    md, sd = d.reshape(-1, 3).mean(0), d.reshape(-1, 3).std(0) + 1e-6
    if mode == "meanstd":
        out = (d - md) / sd * ss + ms
    else:
        out = d - md + ms
    out = d + (out - d) * strength
    return Image.fromarray(from_lab(out).astype(np.uint8))


def stats(img):
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    return a.mean(axis=(0, 1)).round(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id")
    ap.add_argument("--only", default="")
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--src")
    ap.add_argument("--dst")
    ap.add_argument("--out")
    ap.add_argument("--mode", default="meanstd")
    a = ap.parse_args()

    if a.src:
        out = match(Image.open(a.src), Image.open(a.dst), a.mode, a.strength)
        out.save(a.out or a.dst)
        print("ok", stats(Image.open(a.src)), "->", stats(out))
        return

    plans_path = os.path.join(ROOT, "workspace", "plans", f"{a.id}.json")
    plans = json.load(open(plans_path, encoding="utf-8"))["plans"]
    takes = os.path.join(ROOT, "workspace", "takes", a.id)
    keys = os.path.join(takes, "keys")
    raw = os.path.join(keys, "_raw")
    os.makedirs(raw, exist_ok=True)
    only = {int(x) for x in a.only.split(",") if x}

    # Scene master = first plan in the scene with a real (non-chain) master file.
    scene_master = {}
    for p in plans:
        m = str(p.get("master", ""))
        if not m.startswith("chain:") and p["scene"] not in scene_master:
            scene_master[p["scene"]] = os.path.join(takes, m)

    for p in plans:
        n = p["plan"]
        if only and n not in only:
            continue
        if not (p.get("use_key") or (p.get("key_prompt") and not p.get("i2v"))):
            continue
        master = scene_master.get(p["scene"])
        if not master or not os.path.exists(master):
            continue
        key_file = os.path.join(keys, f"plan{n}_key.png")
        if not os.path.exists(key_file):
            continue
        raw_file = os.path.join(raw, os.path.basename(key_file))
        if not os.path.exists(raw_file):
            shutil.copy(key_file, raw_file)
        src_img = Image.open(raw_file)
        before = stats(src_img)
        out = match(Image.open(master), src_img, "meanstd", a.strength)
        out.save(key_file)
        print(f"plan {n:>2} {os.path.basename(key_file):18} {before} -> {stats(out)}  master {stats(Image.open(master))}")


if __name__ == "__main__":
    main()
