#!/usr/bin/env python3
"""Turns the chosen generated logo into the mark the project ships.

The mark is not drawn by hand and not traced: it is the image the model
returned (docs/brand/wavespeed-fix/04.png), cleaned up deterministically —

  1. every ink is snapped to the palette. The model kept drifting the teal
     towards turquoise; each pixel is matched against the inks it actually
     used, and re-rendered with the palette colour at the same coverage, so
     anti-aliased edges survive and nothing goes chalky.
  2. the badge is cut out of its square. The circle is found from the extent
     of the non-cream pixels, and everything outside it becomes transparent.

    python build/make-mark.py

Writes docs/brand/firstlight.png (1024, transparent outside the circle),
docs/brand/firstlight-on-cream.png (the same on paper) and
ui/public/firstlight.png (256, for the interface header).
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "brand" / "wavespeed-fix" / "04.png"
OUT_MARK = ROOT / "docs" / "brand" / "firstlight.png"
OUT_CREAM = ROOT / "docs" / "brand" / "firstlight-on-cream.png"
OUT_UI = ROOT / "ui" / "public" / "firstlight.png"

CREAM = (0xF7, 0xEF, 0xE2)
ORANGE = (0xE0, 0x4E, 0x14)
TEAL = (0x12, 0x31, 0x2E)

# The inks the model actually laid down, and what each one has to become. The
# turquoise roof and the lighter ring teal are the drift being corrected.
INKS = [
    ((240, 88, 24), ORANGE),    # the wave crest
    ((31, 112, 120), TEAL),     # the ring and the lower wave
    ((42, 157, 157), TEAL),     # the turquoise the model keeps reaching for
    ((18, 60, 64), TEAL),       # the darkest outlines
    ((255, 255, 255), CREAM),   # the lantern glass
]
PAPER = (250, 248, 234)         # the cream the model painted, not ours


def snap(rgb: np.ndarray) -> np.ndarray:
    """Re-ink the image in the palette, keeping every edge's coverage."""
    paper = np.array(PAPER, dtype=np.float64)
    cream = np.array(CREAM, dtype=np.float64)
    best_err = np.full(rgb.shape[:2], np.inf)
    out = np.repeat(cream[None, None, :], rgb.shape[0], 0).repeat(rgb.shape[1], 1)

    for source, target in INKS:
        src = np.array(source, dtype=np.float64)
        tgt = np.array(target, dtype=np.float64)
        axis = src - paper
        denom = float(axis @ axis)
        if denom == 0:
            continue
        # coverage of this ink over the paper, clamped to the segment
        a = np.clip(((rgb - paper) @ axis) / denom, 0.0, 1.0)[..., None]
        err = np.linalg.norm(rgb - (paper + a * axis), axis=2)
        take = err < best_err
        best_err = np.where(take, err, best_err)
        painted = cream + a * (tgt - cream)
        out = np.where(take[..., None], painted, out)
    return out


def circle(alpha_src: np.ndarray) -> tuple[float, float, float]:
    """Centre and radius of the badge, from the extent of what is inked."""
    ys, xs = np.nonzero(alpha_src)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return cx, cy, max(x1 - x0, y1 - y0) / 2


def main() -> None:
    im = Image.open(SOURCE).convert("RGB")
    rgb = np.asarray(im, dtype=np.float64)

    inked = np.linalg.norm(rgb - np.array(PAPER), axis=2) > 26
    cx, cy, r = circle(inked)
    print(f"badge: centre ({cx:.0f}, {cy:.0f}) radius {r:.0f} in {im.width}x{im.height}")

    painted = snap(rgb)

    # a 1.5 px feathered circular alpha, so the ring's outer edge is not sawn off
    yy, xx = np.mgrid[0 : im.height, 0 : im.width]
    dist = np.hypot(xx - cx, yy - cy)
    alpha = np.clip((r + 1.0 - dist) / 1.5, 0.0, 1.0)

    rgba = np.dstack([painted, alpha * 255]).astype(np.uint8)
    cut = Image.fromarray(rgba, "RGBA")

    # square it on the circle, with a hair of margin, then resize once
    side = int(round(r * 2 + 8))
    box = (int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2))
    cut = cut.crop(box)

    mark = cut.resize((1024, 1024), Image.LANCZOS)
    mark.save(OUT_MARK)
    print(f"wrote {OUT_MARK} (1024, transparent outside the circle)")

    on_cream = Image.new("RGBA", mark.size, CREAM + (255,))
    on_cream.alpha_composite(mark)
    on_cream.convert("RGB").save(OUT_CREAM)
    print(f"wrote {OUT_CREAM}")

    cut.resize((256, 256), Image.LANCZOS).save(OUT_UI)
    print(f"wrote {OUT_UI} (256)")


if __name__ == "__main__":
    main()
