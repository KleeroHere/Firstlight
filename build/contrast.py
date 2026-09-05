#!/usr/bin/env python3
"""WCAG contrast check for the Firstlight palette.

Every pair the interface actually paints is listed here with the level it has
to clear, so a palette edit that hurts legibility fails loudly instead of
shipping. The values must match ui/src/styles/firstlight.css; docs/BRAND.md
explains what each colour is for.

    python build/contrast.py
"""
import sys

# --- light: cream paper -----------------------------------------------------
PAPER = "#f7efe2"          # --color-bg
CARD = "#fdf8ee"           # --color-surface
INK = "#10302d"            # --color-text-primary
INK_SOFT = "#4a625d"       # --color-text-secondary
MUTED = "#5c736e"          # --color-text-muted
ACCENT = "#c2410c"         # --color-accent: links, and the primary button
ACCENT_HOVER = "#a83809"
ORANGE = "#e04e14"         # --color-accent-bright: graphics and large type

# --- dark: deep teal --------------------------------------------------------
TEAL_DEEP = "#0c2422"      # --color-bg, and the header in both lightnesses
TEAL = "#12312e"           # --color-surface
TEAL_RAISED = "#173a36"    # --color-surface-raised
CREAM = "#f2e7d6"
SEA_PALE = "#a9c4bb"
MUTED_DARK = "#8fa9a2"
ACCENT_DARK = "#f57f43"    # --color-accent in the dark lightness
ORANGE_BRIGHT = "#f2703a"  # --color-accent-bright in the dark lightness
BRASS = "#c9a26a"
SUN = "#f7c77e"            # the active nav pill

PAIRS = [
    # (what it is, foreground, background, minimum ratio)
    ("light  body text", INK, PAPER, 4.5),
    ("light  body on a card", INK, CARD, 4.5),
    ("light  secondary text", INK_SOFT, CARD, 4.5),
    ("light  muted text", MUTED, CARD, 4.5),
    ("light  link / accent text", ACCENT, CARD, 4.5),
    ("light  link on the page", ACCENT, PAPER, 4.5),
    ("light  primary button", CARD, ACCENT, 4.5),
    ("light  primary button, hover", CARD, ACCENT_HOVER, 4.5),
    ("light  accepted chip", "#1d6a4b", "#e2eee7", 4.5),
    ("light  warn chip", "#8a5a06", "#f6ead2", 4.5),
    ("light  failed chip", "#a5301c", "#f6e3dc", 4.5),
    ("light  brand orange, large type", ORANGE, PAPER, 3.0),
    ("header cream on teal", CREAM, TEAL_DEEP, 4.5),
    ("header tagline (brass)", BRASS, TEAL_DEEP, 4.5),
    ("header nav, idle", SEA_PALE, TEAL_DEEP, 4.5),
    ("header nav, active", TEAL_DEEP, SUN, 4.5),
    ("dark   body text", CREAM, TEAL, 4.5),
    ("dark   body on a card", CREAM, TEAL_RAISED, 4.5),
    ("dark   secondary text", SEA_PALE, TEAL_RAISED, 4.5),
    ("dark   muted text", MUTED_DARK, TEAL_RAISED, 4.5),
    ("dark   link / accent text", ACCENT_DARK, TEAL_RAISED, 4.5),
    ("dark   primary button", TEAL_DEEP, ACCENT_DARK, 4.5),
    ("dark   brand orange, large type", ORANGE_BRIGHT, TEAL_RAISED, 3.0),
    ("dark   accepted chip", "#7ad6a4", TEAL_RAISED, 4.5),
    ("dark   warn chip", "#e8b45a", TEAL_RAISED, 4.5),
    ("dark   failed chip", "#f28b7d", TEAL_RAISED, 4.5),
    ("dark   log panel", SEA_PALE, TEAL_DEEP, 4.5),
]


def lum(hexstr: str) -> float:
    h = hexstr.lstrip("#")
    out = 0.0
    for c, w in zip((h[0:2], h[2:4], h[4:6]), (0.2126, 0.7152, 0.0722)):
        v = int(c, 16) / 255
        v = v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        out += v * w
    return out


def ratio(a: str, b: str) -> float:
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main() -> int:
    bad = 0
    for name, fg, bg, need in PAIRS:
        r = ratio(fg, bg)
        ok = r >= need
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {r:5.2f}:1 (>= {need}) {name}  {fg} on {bg}")
    print(f"\n{len(PAIRS) - bad}/{len(PAIRS)} pairs pass")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
