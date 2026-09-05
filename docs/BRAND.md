<p align="center">
  <img src="brand/firstlight-wordmark.png" width="460" alt="Firstlight" />
</p>

# Brand

Firstlight looks like the films it makes. *Harbour Light* — the example series
in `workspace/` — is drawn as flat gouache travel-poster illustration: deep
teal and indigo, brass fittings, an apricot sunrise, cream paper, soft grain,
a thin dark contour. The interface, the logo and the episode cards all use
that one palette, so an episode playing inside the app never looks like it was
made somewhere else.

Every colour below was sampled off those illustrations
(`workspace/backgrounds/*.png`, `workspace/refs/*/base.png`) rather than
picked in a colour wheel.

---

## Palette

### The hot colour

One character in *Harbour Light* wears an orange storm jacket. It is the only
saturated warm colour in the whole world, which makes it the right thing to
spend on the parts of the interface you can act on — and nothing else.

| Token | Hex | Where it came from | Used for |
| --- | --- | --- | --- |
| `--fl-orange` | `#E04E14` | the storm jacket, lit | the logo, graphics, progress, large type |
| `--fl-orange-deep` | `#C2410C` | the same jacket in shade | links, and the fill of the primary button — the brightest orange that still carries cream text at AA |
| `--fl-orange-darker` | `#A83809` | — | the pressed / hover state of that button |
| `--fl-orange-bright` | `#F2703A` | — | graphics in the dark lightness |
| `--fl-orange-light` | `#F57F43` | — | links and the primary button in the dark lightness |

### Warm secondaries

| Token | Hex | Where it came from | Used for |
| --- | --- | --- | --- |
| `--fl-brass` | `#C9A26A` | the lantern-room fittings | hairlines, the tagline, keyframe progress |
| `--fl-brass-deep` | `#8A6A3C` | brass in shade | card rules on paper |
| `--fl-sun` | `#F7C77E` | the sun disc at the horizon | the lit nav item, the core of the mark |
| `--fl-apricot` | `#F4CFB0` | the sunrise band | washes |

### Cold ground

| Token | Hex | Where it came from | Used for |
| --- | --- | --- | --- |
| `--fl-teal-deep` | `#0C2422` | the lantern-room ceiling | the header; the page in the dark lightness |
| `--fl-teal` | `#12312E` | the same, one step up | cards in the dark lightness |
| `--fl-teal-raised` | `#173A36` | — | raised cards in the dark lightness |
| `--fl-teal-mid` | `#1F5551` | the harbour-office wall | the sea in illustrations |
| `--fl-sea` | `#3E7A72` | the water at dawn | mid-tones |
| `--fl-sea-pale` | `#A9C4BB` | the far shore | secondary text on teal |
| `--fl-indigo` | `#0B384E` | a knitted sweater, deep water | ink accents |

### Paper and ink

| Token | Hex | Used for |
| --- | --- | --- |
| `--fl-paper` | `#F7EFE2` | the page |
| `--fl-paper-raised` | `#FDF8EE` | cards |
| `--fl-paper-edge` | `#E3D3B8` | borders |
| `--fl-cream` | `#F2E7D6` | text on teal |
| `--fl-ink` | `#10302D` | body text — a deep teal-black, never pure black |
| `--fl-ink-soft` | `#4A625D` | secondary text |

### The strip

![palette](brand/palette.png)

---

## Contrast

Nothing in the palette is a matter of taste: `build/contrast.py` lists every
pair the interface actually paints and the level it has to clear, and fails if
one drops below it. Run it after any edit to
`ui/src/styles/firstlight.css`:

```bash
python build/contrast.py     # 27/27 pairs pass
```

Two rules come out of it and are worth stating plainly:

- **`#E04E14` never carries small text.** At 3.5:1 on paper it is a graphic
  colour: marks, bars, rules, headings. Text and button fills use
  `#C2410C` (4.9:1 under cream), which still reads unmistakably orange.
- **Nothing is pure black or pure white.** Ink is `#10302D`, paper is
  `#F7EFE2`; the illustrations have no pure values either.

---

## Type

| Role | Face | Weight | Where |
| --- | --- | --- | --- |
| Display | **Unbounded** | 500 / 600 | the wordmark, page and card titles, counts |
| Body | **Onest** | 400 / 500 | everything else |
| Utility | **JetBrains Mono** | 400 | ids, filenames, logs |

All three are already in the repository as subsetted `.woff2` in
`ui/public/fonts/` (SIL Open Font License), loaded by
`ui/src/styles/fonts.css`. Nothing is fetched at runtime — same rule as the
rest of the project: it has to work with the network unplugged.

---

## The mark

<p align="center">
  <img src="brand/firstlight.png" width="200" alt="the Firstlight mark" />
</p>

A lighthouse standing in a breaking wave, in a circle: the light and the
direction to steer by, and the water it is there for. Deep teal ring and
lower wave, storm orange crest with a cream gap between them, cream ground,
the lamp the one warm dot at the top.

**Where it came from.** It was generated, not drawn. Three rounds through
`engine/wavespeed_stills.mjs` (bytedance/seedream-v4, $0.027 an image, all of
it booked in the WaveSpeed ledger):

| Round | What was asked for | Sheet |
| --- | --- | --- |
| 1 | eight marks built on the letter **F** | `docs/brand/logo-concepts-F.png` |
| 2 | eight lighthouses, no letter | `docs/brand/logo-wavespeed-sheet.png` |
| 3 | eight edits of the one chosen out of round 2 | `docs/brand/logo-final-sheet.png` |

The owner chose the lighthouse riding a wave, then asked for three
corrections — a badge edge you can actually see, the two-colour wave back,
and the sunrise bands gone — which were made with `seedream-v4/edit` off that
same image rather than by redrawing:
`docs/brand/wavespeed-fix/04.png` is the one that ships. Everything before it
is kept in `docs/brand/concepts/` and the `wavespeed*` folders.

**How the file is finished.** `build/make-mark.py` does two deterministic
passes over that PNG, so the mark can be rebuilt from the generation at any
time:

1. **Re-inking.** The model kept drifting the teal towards turquoise. Every
   pixel is matched against the inks it actually laid down and repainted with
   the palette colour at the same coverage — so `#12312E` really is `#12312E`,
   and the anti-aliased edges survive.
2. **Cutting.** The badge circle is found from the extent of the non-cream
   pixels, and everything outside it becomes transparent.

**Rules.**

- Clear space around the badge: a quarter of its diameter.
- Never re-colour it, never put it on a busy photograph, never squash it —
  the circle is a circle.
- Below 24 px use the badge alone, never the wordmark.
- On teal, use the transparent PNG; on paper either that or
  `firstlight-on-cream.png`.
- There is no SVG of the mark, on purpose. It is a raster, and the sizes that
  matter are exported from `docs/brand/firstlight.png` at 1024.

## The wordmark

<p align="center">
  <img src="brand/firstlight-wordmark.png" width="520" alt="Firstlight wordmark" />
</p>

**Manrope 700**, tracked in a little (−0.028 em). Four faces were set beside
the mark and compared at both poster and interface size —
`docs/brand/wordmark-options.png`: Unbounded 600, Manrope 700, Fraunces 600
and Bricolage Grotesque 700. Manrope wins on the job the wordmark actually
has to do: the badge is round, warm and busy, so the word has to be the calm
half of the pair, and Manrope is the only one of the four whose lowercase is
still unambiguous at 18 px. Unbounded is too loud beside a circle; Fraunces is
the prettiest and the most opinionated; Bricolage sits between them.

Two lockups, both composed from the mark PNG and the real font by
`build/make-brand.mjs`:

- **horizontal** — badge, a gap of a quarter of the badge, then the word
- **stacked** — badge above the word, both centred

All four candidate faces are in `ui/public/fonts/` (SIL Open Font License),
so nothing is fetched at runtime.

---

## Files

| File | What it is |
| --- | --- |
| `docs/brand/firstlight.png` | the mark, 1024, transparent outside the circle |
| `docs/brand/firstlight-on-cream.png` | the same on paper |
| `docs/brand/firstlight-wordmark.png` | mark beside the word |
| `docs/brand/firstlight-wordmark-stacked.png` | mark above the word |
| `docs/brand/social-preview.png` | 1280×640, the GitHub social card |
| `docs/brand/palette.png` | the palette strip above |
| `docs/brand/wavespeed-fix/04.png` | the generation the mark is cut from |
| `docs/brand/logo-*-sheet.png`, `logo-concepts*.png` | the three rounds, as shown to the owner |
| `docs/brand/concepts/`, `wavespeed*/` | everything that was tried and not chosen |
| `docs/brand/cards/*.svg` | the episode card artwork |
| `ui/public/firstlight.png` | the same mark at 256, for the interface header |
| `ui/public/favicon.ico`, `build/firstlight.ico` | six sizes, 16–256 |
| `workspace/brand/title-bg.png` | 1920×1080 title card background |
| `workspace/brand/divider-bg.png` | 1920×1080 chapter divider background |
| `workspace/brand/memo-bg.png` | 1920×1080 closing memo background |

### Regenerating them

```bash
python build/make-mark.py     # re-ink and cut the mark out of the generation
node build/make-brand.mjs     # the lockups, the social card, the strip, the cards
python build/make-icon.py     # the two .ico files, from the mark PNG
python build/contrast.py      # the palette check
```

---

## The episode cards

`engine/assemble_video.mjs` draws the title, divider and memo cards over the
three PNGs above when they exist (`cards.*` in `engine/pipeline.config.json`),
and falls back to flat colour when they do not — so the artwork is never a
hard dependency. The text is always drawn by ffmpeg, never baked into the
image, because it changes per episode.

Each card leaves its text room deliberately:

- **Title** — the episode title is drawn in cream across the middle fifth of
  the frame, so that band carries a shade scrim over the dawn sky. The
  lighthouse sits far left, the sun far right; nothing crosses the middle.
- **Divider** — a deep-orange field with the same fan of light, struck from
  below the frame. Cream title, centred.
- **Memo** — cream paper: the closing checklist is drawn in ink, so the sea
  band and the sun stay below the last line, and the lens rings stay in the
  top margin.

Put an episode beside the interface and the two are the same picture.
