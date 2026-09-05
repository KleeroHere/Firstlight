#!/usr/bin/env python
"""Title / cost / closing cards for the explainer video — same look as
make_diagram.py (plain PIL, on-brand, no network dependency)."""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
CREAM = (242, 233, 220)
INK = (43, 35, 32)
CORAL = (217, 106, 95)
TEAL = (58, 108, 110)
AMBER = (214, 158, 85)
SUB = (90, 80, 74)

HERE = os.path.dirname(__file__)


def font(size, bold=False):
    for c in (["C:/Windows/Fonts/arialbd.ttf"] if bold else ["C:/Windows/Fonts/arial.ttf"]):
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def base():
    im = Image.new("RGB", (W, H), CREAM)
    return im, ImageDraw.Draw(im)


def center(d, y, text, f, fill=INK):
    d.text((W / 2, y), text, font=f, fill=fill, anchor="mm")


# ---- title card ----
im, d = base()
center(d, 300, "Firstlight", font(88, bold=True))
center(d, 370, "the first frame, and everything after it", font(26))
center(d, 470, "How the pipeline works", font(34, bold=True), fill=CORAL)
im.save(os.path.join(HERE, "card-title.png"))

# ---- cost/time card ----
im, d = base()
d.text((60, 60), "Cost & time — this demo", font=font(40, bold=True), fill=INK)
rows = [
    ("Character reference sheet", "$0.027 / image (WaveSpeed Seedream 4)"),
    ("Background plate", "$0.027 / image"),
    ("5-second clip, i2v (Kling 2.6 Std)", "$0.21"),
    ("5-second clip, first-last-frame (Kling 2.6 Pro)", "$0.35"),
    ("Two finished episodes, 7 refs, 3 backgrounds, 17 clips", "~$4.50 total"),
    ("Narration, both episodes + this video", "2 935 characters (ElevenLabs)"),
]
y = 160
for label, val in rows:
    d.text((60, y), label, font=font(24), fill=INK)
    d.text((1220, y), val, font=font(24, bold=True), fill=CORAL, anchor="ra")
    y += 56
d.line([(60, y + 6), (1220, y + 6)], fill=(210, 198, 182), width=2)
center(d, y + 60, "A finished two-minute episode: a scenario, a few dollars of generation,", font(22), fill=SUB)
center(d, y + 92, "no timeline software at all.", font(22), fill=SUB)
im.save(os.path.join(HERE, "card-cost.png"))

# ---- closing card ----
im, d = base()
center(d, 280, "Firstlight", font(72, bold=True))
center(d, 350, "MIT licensed \u2014 github.com/KleeroHere/Firstlight", font(26), fill=CORAL)
center(d, 420, "Live demo: kleerohere.github.io/Firstlight", font(24), fill=SUB)
center(d, 480, "Harbour Light is the example series \u2014 no real organisation appears in this repository.", font(19), fill=SUB)
im.save(os.path.join(HERE, "card-closing.png"))

print("wrote card-title.png, card-cost.png, card-closing.png")
