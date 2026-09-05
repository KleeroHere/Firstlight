#!/usr/bin/env python
"""docs/demo/motion/cost-counter.mp4 — the price of two episodes, counting up.

The one number people ask about first is what it cost, and a static card with
"$7.20" on it gets read in half a second and disbelieved. A number that climbs
from zero and settles holds the eye for the length of the sentence the narration
needs, and the settle is what makes the figure feel arrived-at rather than
asserted.

Three figures on the brand cream, eased so they sprint early and crawl into
place, with a footnote saying what they are the cost *of*. The dollars land
first, then the frames, then the clips, each a beat behind the last, so the
viewer reads them in that order instead of trying to read three moving numbers
at once.

The figures are arguments, not constants: the producer re-cuts this whenever the
ledger moves.

    python docs/demo/make_cost_counter.py
    python docs/demo/make_cost_counter.py --spent 9.40 --frames 34 --clips 29
    python docs/demo/make_cost_counter.py --footnote "three episodes, start to finish"

PIL frame by frame, ffmpeg to H.264 / yuv420p / 1920x1080 / 30 fps / crf 18,
silent. No network, system fonts only. Re-runnable: the frame folder is emptied
first and the mp4 is overwritten in place.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30

CREAM = (242, 233, 220)
INK = (43, 35, 32)
CORAL = (217, 106, 95)
TEAL = (58, 108, 110)
AMBER = (214, 158, 85)
MUTED = (122, 109, 100)
RULE = (218, 205, 189)

LEAD_IN = 0.80     # cream, then the kicker
COUNT = 4.60       # how long one figure takes to climb
STAGGER = 0.95     # the gap between one figure starting and the next
HOLD_OUT = 4.70    # the finished panel, long enough to read all three
# 0.80 + 2x0.95 + 4.60 + 4.70 = 12.0 s, the slot the explainer's cut leaves.


def font(size, bold=False):
    """The first system font that exists — the same ladder every other script
    in docs/demo uses, so the cards and the motion match."""
    for path in (
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


F_KICKER = font(34)
F_NUM = font(148, bold=True)
F_LABEL = font(32)
F_FOOT = font(30)


def ease_out(t):
    """Quintic: most of the distance in the first third, a long settle after —
    a counter that decelerates reads as a total being reached, not a clock."""
    return 1 - (1 - t) ** 5


def fmt_money(v):
    return f"${v:,.2f}"


def fmt_int(v):
    return f"{int(round(v))}"


def panel(draw, x, y, value, half, label, color, alpha):
    """One figure and its caption, centred on x. `half` is measured once from
    the figure's *final* text, not from the digits on screen right now: a rule
    that grows as the count climbs draws the eye to itself instead of to the
    number, and the three rules would never line up."""
    a = round(255 * alpha)
    draw.text((x, y), value, font=F_NUM, fill=color + (a,), anchor="ms")
    draw.line([(x - half, y + 40), (x + half, y + 40)], fill=RULE + (a,), width=3)
    draw.text((x, y + 96), label, font=F_LABEL, fill=MUTED + (a,), anchor="ms")


def frame(t, figures, footnote):
    im = Image.new("RGBA", (W, H), CREAM + (255,))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    head = min(1.0, max(0.0, t / 0.6))
    d.text((W / 2, 318), "What it cost", font=F_KICKER, fill=MUTED + (round(255 * ease_out(head)),), anchor="ms")

    xs = (W * 0.22, W * 0.5, W * 0.78)
    base_y = 648
    for i, (final, label, color, fmt) in enumerate(figures):
        start = LEAD_IN + i * STAGGER
        p = 0.0 if t < start else min(1.0, (t - start) / COUNT)
        e = ease_out(p)
        # The label fades in with the first tick of its own figure, so nothing
        # sits on screen with a zero under it.
        alpha = min(1.0, max(0.0, (t - start + 0.25) / 0.45))
        half = max(150, d.textlength(fmt(final), font=F_NUM) * 0.62)
        panel(d, xs[i], base_y, fmt(final * e), half, label, color, alpha)

    foot_at = LEAD_IN + 2 * STAGGER + COUNT * 0.55
    fa = min(1.0, max(0.0, (t - foot_at) / 0.7))
    if fa > 0:
        d.line([(W * 0.30, 806), (W * 0.70, 806)], fill=RULE + (round(200 * ease_out(fa)),), width=2)
        d.text((W / 2, 876), footnote, font=F_FOOT, fill=INK + (round(255 * ease_out(fa)),), anchor="ms")

    im.alpha_composite(layer)
    return im.convert("RGB")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Animated cost-and-time panel for the explainer.")
    ap.add_argument("--spent", type=float, default=7.20, help="dollars spent (default: 7.20)")
    ap.add_argument("--frames", type=int, default=28, help="start frames generated (default: 28)")
    ap.add_argument("--clips", type=int, default=24, help="clips accepted (default: 24)")
    ap.add_argument("--footnote", default="two 76-second episodes, start to finish")
    ap.add_argument("--out", default=os.path.join(here, "motion", "cost-counter.mp4"))
    ap.add_argument("--fps", type=int, default=FPS)
    args = ap.parse_args()

    figures = [
        (args.spent, "spent", CORAL, fmt_money),
        (float(args.frames), "start frames", TEAL, fmt_int),
        (float(args.clips), "clips accepted", AMBER, fmt_int),
    ]

    duration = LEAD_IN + 2 * STAGGER + COUNT + HOLD_OUT
    n = round(duration * args.fps)
    tmp = os.path.join(tempfile.gettempdir(), "firstlight-cost-counter")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)

    for k in range(n):
        frame(k / args.fps, figures, args.footnote).save(os.path.join(tmp, f"f{k:05d}.png"))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(args.fps),
        "-i", os.path.join(tmp, "f%05d.png"),
        "-an",
        "-r", str(args.fps),
        "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        args.out,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr[-3000:])
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{args.out}  {n} frames  {n / args.fps:.2f} s")


if __name__ == "__main__":
    main()
