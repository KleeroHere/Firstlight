#!/usr/bin/env python
"""docs/demo/motion/pipeline-build.mp4 — the Firstlight pipeline drawing itself.

Supersedes make_diagram.py, which drew the same six stages as one flat PNG. The
explainer needs the diagram to *build*: a viewer who watches a box slide in and
an arrow crawl to the next one has been told the order of operations without a
word of narration having to say "and then".

Every stage that lands stays on screen — the finished diagram is the last four
seconds, so the frame can be freeze-framed for a thumbnail. Colour follows
state, not decoration: coral is the stage being placed right now, teal and
amber alternate behind it for what is already done.

Rendered frame by frame with PIL onto the brand cream, then encoded by ffmpeg
to the explainer's spec: H.264 / yuv420p / 1920x1080 / 30 fps / crf 18, silent.
No network, no fonts beyond what Windows or a Linux box already has.

    python docs/demo/make_pipeline_anim.py
    python docs/demo/make_pipeline_anim.py --out docs/demo/motion/pipeline-build.mp4

Re-runnable: frames go to a scratch folder that is emptied first, and the mp4 is
overwritten in place.
"""
import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30

# engine/pipeline.config.json colours, plus the two the series uses for
# "already done" so a finished stage is never mistaken for the live one.
CREAM = (242, 233, 220)
INK = (43, 35, 32)
CORAL = (217, 106, 95)
TEAL = (58, 108, 110)
AMBER = (214, 158, 85)
MUTED = (122, 109, 100)
RULE = (218, 205, 189)

STAGES = [
    ("Scenario", "scene text + narration"),
    ("Compile", "prompts, plan-list, sheets"),
    ("Start frames", "Seedream via WaveSpeed"),
    ("Motion", "Kling 2.6 with a first and last frame"),
    ("Acceptance", "12-frame contact sheet"),
    ("Cut & verify", "captions, narration, grade"),
]

# Timing, in seconds. Six stages at 5.75 s each plus a 1.4 s lead-in and a 4 s
# hold is 39.9 s — the ~40 s the explainer's cut has room for.
LEAD_IN = 1.4
BOX_IN = 1.30      # the box fades and slides into place
BOX_HOLD = 2.00    # it sits there, coral, before the arrow leaves it
ARROW = 2.45       # the line grows to the next box, arrowhead on arrival
STAGE = BOX_IN + BOX_HOLD + ARROW
HOLD_OUT = 4.0

GRID_COLS = 3
GRID_ROWS = 2
BOX_W, BOX_H = 452, 250
GAP_X, GAP_Y = 128, 132
GRID_W = GRID_COLS * BOX_W + (GRID_COLS - 1) * GAP_X
GRID_X = (W - GRID_W) // 2
GRID_Y = 288
# The footer sits under the whole grid, not across it: 288 + 250 + 132 + 250
# leaves the bottom row ending at 920, so 968 clears it with room to breathe.
GRID_BOTTOM = GRID_Y + 2 * BOX_H + GAP_Y
FOOT_Y = GRID_BOTTOM + 48


def font(size, bold=False):
    """The first system font that exists. Never fails: PIL's bitmap default
    is ugly at this size but it keeps the script runnable anywhere."""
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


F_TITLE = font(66, bold=True)
F_KICKER = font(30)
F_LABEL = font(40, bold=True)
F_SUB = font(24)
F_FOOT = font(26)
F_STEP = font(22, bold=True)


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2


def box_rect(i):
    """Where stage i sits. Three across, two down, read left to right on the
    top row and left to right again on the bottom — the same reading order the
    scenario file has."""
    col, row = i % GRID_COLS, i // GRID_COLS
    x = GRID_X + col * (BOX_W + GAP_X)
    y = GRID_Y + row * (BOX_H + GAP_Y)
    return x, y, x + BOX_W, y + BOX_H


def wrap(draw, text, fnt, max_w):
    lines, cur = [], ""
    for word in text.split(" "):
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=fnt) > max_w and cur:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def blend(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def done_color(i):
    return TEAL if i % 2 == 0 else AMBER


def draw_box(base, i, alpha, slide, color):
    """One stage card, composited so it can fade in over the cream."""
    x0, y0, x1, y1 = box_rect(i)
    y0 += slide
    y1 += slide
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = round(255 * alpha)

    # A soft drop shadow, so a card reads as placed on the cream, not printed on it.
    d.rounded_rectangle([x0 + 6, y0 + 10, x1 + 6, y1 + 10], radius=22, fill=(43, 35, 32, round(28 * alpha)))
    d.rounded_rectangle([x0, y0, x1, y1], radius=22, fill=color + (a,))

    step = f"{i + 1:02d}"
    d.text((x0 + 30, y0 + 26), step, font=F_STEP, fill=CREAM + (round(a * 0.6),))

    label, sub = STAGES[i]
    label_lines = wrap(d, label, F_LABEL, BOX_W - 64)
    ly = y0 + 84
    for line in label_lines:
        d.text((x0 + BOX_W / 2, ly), line, font=F_LABEL, fill=CREAM + (a,), anchor="ma")
        ly += 48

    d.line([(x0 + 40, ly + 16), (x1 - 40, ly + 16)], fill=CREAM + (round(a * 0.35),), width=2)

    sy = ly + 38
    for line in wrap(d, sub, F_SUB, BOX_W - 72):
        d.text((x0 + BOX_W / 2, sy), line, font=F_SUB, fill=CREAM + (round(a * 0.88),), anchor="ma")
        sy += 31

    base.alpha_composite(layer)


def arrow_path(i):
    """The polyline from stage i to stage i+1. Along a row it is a straight
    horizontal run; at the end of a row it drops and doubles back, which is why
    this returns a list of points rather than two."""
    ax0, ay0, ax1, ay1 = box_rect(i)
    bx0, by0, bx1, by1 = box_rect(i + 1)
    same_row = (i // GRID_COLS) == ((i + 1) // GRID_COLS)
    if same_row:
        y = (ay0 + ay1) / 2
        return [(ax1 + 14, y), (bx0 - 14, y)]
    # Row wrap: out of the right edge, down the gutter, back along the row below.
    mid_y = ay1 + GAP_Y / 2
    return [
        (ax1 + 14, (ay0 + ay1) / 2),
        (ax1 + 62, (ay0 + ay1) / 2),
        (ax1 + 62, mid_y),
        (bx0 - 62, mid_y),
        (bx0 - 62, (by0 + by1) / 2),
        (bx0 - 14, (by0 + by1) / 2),
    ]


def draw_arrow(d, i, progress, color):
    """Grow the polyline to `progress` (0..1) of its total length and put the
    head on only once it has arrived — a head that slides along the line reads
    as a moving object, and this is a line being drawn."""
    pts = arrow_path(i)
    segs = [(pts[k], pts[k + 1]) for k in range(len(pts) - 1)]
    lengths = [math.dist(a, b) for a, b in segs]
    total = sum(lengths)
    want = total * progress
    run = 0.0
    drawn = [pts[0]]
    for (a, b), ln in zip(segs, lengths):
        if run + ln <= want:
            drawn.append(b)
            run += ln
        else:
            t = max(0.0, (want - run) / ln) if ln else 0.0
            drawn.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            break
    if len(drawn) > 1:
        d.line(drawn, fill=color, width=6, joint="curve")
    if progress >= 0.999:
        (px, py), (qx, qy) = segs[-1]
        ang = math.atan2(qy - py, qx - px)
        size = 20
        d.polygon(
            [
                (qx, qy),
                (qx - size * math.cos(ang - 0.42), qy - size * math.sin(ang - 0.42)),
                (qx - size * math.cos(ang + 0.42), qy - size * math.sin(ang + 0.42)),
            ],
            fill=color,
        )


def frame(t):
    """The whole picture at time t, from scratch — no state carried between
    frames, so any frame can be re-rendered on its own."""
    im = Image.new("RGBA", (W, H), CREAM + (255,))
    d = ImageDraw.Draw(im)

    d.text((GRID_X, 118), "How Firstlight makes an episode", font=F_TITLE, fill=INK)
    d.text((GRID_X, 205), "six steps, each one a folder on disk", font=F_KICKER, fill=MUTED)
    d.line([(GRID_X, 258), (GRID_X + GRID_W, 258)], fill=RULE, width=2)

    # Which stage is live, and how far into its own little sequence it is.
    live = -1
    for i in range(len(STAGES)):
        s0 = LEAD_IN + i * STAGE
        if t >= s0:
            live = i

    # Arrows first, so a box always sits on top of the line that reaches it.
    for i in range(len(STAGES) - 1):
        a0 = LEAD_IN + i * STAGE + BOX_IN + BOX_HOLD
        if t < a0:
            continue
        p = min(1.0, (t - a0) / ARROW)
        colour = INK if p >= 0.999 else CORAL
        draw_arrow(d, i, ease_in_out(p), colour)

    for i in range(len(STAGES)):
        s0 = LEAD_IN + i * STAGE
        if t < s0:
            continue
        appear = min(1.0, (t - s0) / BOX_IN)
        e = ease_out(appear)
        alpha = e
        slide = round((1 - e) * 46)
        # Coral while it is the newest stage; it settles to its done colour as
        # the arrow leaves it for the next box.
        settle_from = s0 + BOX_IN + BOX_HOLD
        settle = 0.0 if t <= settle_from else min(1.0, (t - settle_from) / 0.55)
        colour = blend(CORAL, done_color(i), ease_in_out(settle)) if i < live or settle > 0 else CORAL
        draw_box(im, i, alpha, slide, colour)

    # The footer arrives with the last stage: it is the claim the diagram makes.
    foot_at = LEAD_IN + (len(STAGES) - 1) * STAGE + BOX_IN
    if t >= foot_at:
        fa = min(1.0, (t - foot_at) / 0.8)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        fd = ImageDraw.Draw(layer)
        fd.text(
            (W / 2, FOOT_Y),
            "Nothing between the steps is hidden — every arrow is a file the next step reads.",
            font=F_FOOT,
            fill=MUTED + (round(255 * ease_out(fa)),),
            anchor="ma",
        )
        im.alpha_composite(layer)

    return im.convert("RGB")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=os.path.join(here, "motion", "pipeline-build.mp4"))
    ap.add_argument("--fps", type=int, default=FPS)
    args = ap.parse_args()

    duration = LEAD_IN + len(STAGES) * STAGE + HOLD_OUT
    n = round(duration * args.fps)
    tmp = os.path.join(tempfile.gettempdir(), "firstlight-pipeline-anim")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)

    for k in range(n):
        frame(k / args.fps).save(os.path.join(tmp, f"f{k:05d}.png"))
        if k % 60 == 0:
            print(f"  {k}/{n}", flush=True)

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
