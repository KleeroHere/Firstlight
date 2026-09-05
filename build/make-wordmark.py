#!/usr/bin/env python3
"""Writes docs/brand/firstlight-wordmark.svg — the mark beside the word.

The word is converted to outlines from the Unbounded the interface already
ships (ui/public/fonts/unbounded-600-latin.woff2), so the file needs no font
at render time and looks the same in a README, a browser and an editor.

    python build/make-wordmark.py
"""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "ui" / "public" / "fonts" / "unbounded-600-latin.woff2"
MARK = ROOT / "docs" / "brand" / "firstlight.svg"
OUT = ROOT / "docs" / "brand" / "firstlight-wordmark.svg"

WORD = "Firstlight"
CAP_PX = 132          # cap height of the word in the 1600x400 artwork
TRACKING = -0.012     # em, Unbounded is roomy enough to tighten a little
INK = "#10302D"


def word_path() -> tuple[str, float]:
    """The word as one SVG path in font units, plus its advance width."""
    font = TTFont(FONT)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    kern = font["hmtx"]
    upem = font["head"].unitsPerEm
    d, x = [], 0.0
    for ch in WORD:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        seg = pen.getCommands()
        if seg:
            d.append(f'<path transform="translate({x:.1f} 0)" d="{seg}"/>')
        x += kern[name][0] + TRACKING * upem
    return "\n    ".join(d), x


def main() -> None:
    font = TTFont(FONT)
    upem = font["head"].unitsPerEm
    cap = font["OS/2"].sCapHeight
    paths, advance = word_path()

    scale = CAP_PX / cap
    word_w = advance * scale
    mark = 236                     # the mark, drawn as a nested <svg>
    gap = 56
    left = 40
    baseline = 262                 # y of the baseline in the 1600x400 canvas
    total = left + mark + gap + word_w + left

    inner = MARK.read_text(encoding="utf-8")
    inner = inner.split("\n", 1)[1] if inner.startswith("<?xml") else inner
    inner = inner.replace('width="512" height="512"', f'x="{left}" y="{(400 - mark) / 2:.0f}" width="{mark}" height="{mark}"')

    OUT.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total:.0f} 400" '
        f'width="{total:.0f}" height="400" role="img" aria-label="Firstlight">\n'
        f"  <title>Firstlight</title>\n"
        f"  {inner.strip()}\n"
        f'  <g fill="{INK}" transform="translate({left + mark + gap:.1f} {baseline}) scale({scale:.5f} -{scale:.5f})">\n'
        f"    {paths}\n"
        f"  </g>\n"
        f"</svg>\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT} ({total:.0f}x400)")


if __name__ == "__main__":
    main()
