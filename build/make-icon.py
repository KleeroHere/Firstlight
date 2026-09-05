#!/usr/bin/env python3
"""Turns docs/brand/firstlight.png (the mark, 1024x1024, transparent) into a
multi-size .ico: build/firstlight.ico for Firstlight.exe (build-exe.mjs
embeds it with rcedit) and ui/public/favicon.ico for the browser tab (see
the <link rel="icon"> in ui/index.html).

An .ico is square, so a mark that is not gets padded onto a transparent
square canvas first (centered, nothing cropped) rather than squashed. The
current mark is already square, which leaves square() a no-op.

Run `python build/make-mark.py` first — that is what cuts the PNG out of the
generated logo.

    python build/make-icon.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "brand" / "firstlight.png"
SIZES = [256, 128, 64, 48, 32, 16]
OUTPUTS = [ROOT / "build" / "firstlight.ico", ROOT / "ui" / "public" / "favicon.ico"]


def square(im: Image.Image) -> Image.Image:
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas


def main() -> None:
    im = Image.open(SOURCE).convert("RGBA")
    canvas = square(im)
    for out in OUTPUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(out, format="ICO", sizes=[(s, s) for s in SIZES])
        print(f"wrote {out} ({', '.join(str(s) for s in SIZES)})")


if __name__ == "__main__":
    main()
