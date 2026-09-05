#!/usr/bin/env python
"""Pipeline diagram for the explainer video — plain PIL, no mermaid-cli/network
dependency. Matches the flow in README.md / docs/ARCHITECTURE.md, condensed to
what reads at video resolution.

    python docs/demo/make_diagram.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
CREAM = (242, 233, 220)
INK = (43, 35, 32)
CORAL = (217, 106, 95)
TEAL = (58, 108, 110)
AMBER = (214, 158, 85)

BOXES = [
    ("Scenario", "scene text + narration", TEAL),
    ("Compile", "prompts + sheets", TEAL),
    ("Keyframes", "start / end + acceptance", AMBER),
    ("Motion", "cloud GPU · local · API", CORAL),
    ("Acceptance", "contact sheet + defects", AMBER),
    ("Cut + verify", "captions, VO, grade", TEAL),
]


def font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def main():
    im = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(im)
    title_f = font(40, bold=True)
    label_f = font(24, bold=True)
    sub_f = font(17)

    d.text((60, 50), "The Firstlight pipeline", font=title_f, fill=INK)
    d.text((60, 102), "scenario \u2192 keyframes \u2192 motion \u2192 acceptance \u2192 cut \u2192 grade",
           font=font(20), fill=(90, 80, 74))

    n = len(BOXES)
    margin = 60
    gap = 24
    bw = (W - 2 * margin - gap * (n - 1)) // n
    bh = 210
    by = 300
    cy = by + bh // 2

    for i, (label, sub, color) in enumerate(BOXES):
        bx = margin + i * (bw + gap)
        d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=18, fill=color)
        # label, wrapped by measuring
        words = label.split(" ")
        d.text((bx + bw / 2, by + 55), label, font=label_f, fill=CREAM, anchor="mm")
        # sub text, wrap manually at ~18 chars
        sub_words = sub.split(" ")
        lines, cur = [], ""
        for w_ in sub_words:
            test = (cur + " " + w_).strip()
            if len(test) > 16 and cur:
                lines.append(cur)
                cur = w_
            else:
                cur = test
        if cur:
            lines.append(cur)
        for j, ln in enumerate(lines):
            d.text((bx + bw / 2, by + 110 + j * 24), ln, font=sub_f, fill=CREAM, anchor="mm")
        if i < n - 1:
            ax0 = bx + bw + 4
            ax1 = bx + bw + gap - 4
            d.line([(ax0, cy), (ax1, cy)], fill=INK, width=4)
            d.polygon([(ax1, cy - 10), (ax1 + 12, cy), (ax1, cy + 10)], fill=INK)

    d.text((60, by + bh + 50),
            "Keyframes and Motion each have three interchangeable backends \u2014 same plan-list, different command.",
            font=font(19), fill=(90, 80, 74))
    d.text((60, by + bh + 84),
            "Everything after the takes exist is deterministic: no timeline, no editor \u2014 the scenario is the edit.",
            font=font(19), fill=(90, 80, 74))

    out = os.path.join(os.path.dirname(__file__), "pipeline-diagram.png")
    im.save(out)
    print(out)


if __name__ == "__main__":
    main()
