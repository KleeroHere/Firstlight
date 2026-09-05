<p align="center">
  <img src="brand/firstlight-wordmark.png" width="420" alt="Firstlight" />
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
  <img src="brand/firstlight.png" width="180" alt="the Firstlight mark" />
</p>

A round badge: the sun halved by the horizon, the fan of light it throws, and
the light broken across the water below. Deep teal sky, cream rays, the storm
orange for the sun and its reflections, a brass hairline inside a dark
contour — the harbour of the example series, reduced to seven shapes.

**Why this one.** Four concepts were drawn and rendered side by side at 512,
128 and 32 pixels — `docs/brand/logo-concepts.png`, sources in
`docs/brand/concepts/`:

| Concept | Verdict |
| --- | --- |
| **Daybreak beam** | Chosen. It is the name, literally — first light, on the water. It is the only one where the orange is the subject rather than a detail, and at 32 px it still reads as a lit half-disc with a fan over it. |
| **Fresnel lens** | The most legible of the four at 16 px, and the one that says the least: concentric rings read as a target or a record before they read as a lantern. |
| **Lantern window** | Handsome large. The muntins are the whole idea and they are the first thing to disappear below 64 px. |
| **First frame** | The best *concept* — a frame of film with a sunrise held in it, which is exactly what the tool does — but a 16:9 frame wastes a square icon, and its sprockets mush at small sizes. Kept as the runner-up. |

**Rules.**

- Clear space around the badge: a quarter of its diameter.
- Never re-colour it, never put it on a busy photograph, never squash it —
  it is square, and `.ico` and favicon are square for that reason.
- Below 24 px use the badge alone, never the wordmark.
- On teal, the badge works as-is; on paper it works as-is. It needs no
  variant.

## The wordmark

<p align="center">
  <img src="brand/firstlight-wordmark.png" width="480" alt="Firstlight wordmark" />
</p>

Badge, a gap of a quarter of the badge's width, then *Firstlight* in Unbounded
600 with slightly tightened tracking, in ink. The word is stored as outlines,
not as text calling for a font, so the SVG renders the same everywhere.

---

## Files

| File | What it is |
| --- | --- |
| `docs/brand/firstlight.svg` / `.png` | the mark (PNG 1024, transparent) |
| `docs/brand/firstlight-wordmark.svg` / `.png` | mark + word (PNG 1600 wide, transparent) |
| `docs/brand/social-preview.png` | 1280×640, the GitHub social card |
| `docs/brand/logo-concepts.png` | the four concepts at three sizes |
| `docs/brand/concepts/*.svg` | those concepts, as drawn |
| `docs/brand/cards/*.svg` | the episode card artwork |
| `docs/brand/palette.png` | the palette strip above |
| `ui/public/firstlight.png` | the same mark at 256, for the interface header |
| `ui/public/favicon.ico`, `build/firstlight.ico` | six sizes, 16–256 |
| `workspace/brand/title-bg.png` | 1920×1080 title card background |
| `workspace/brand/divider-bg.png` | 1920×1080 chapter divider background |
| `workspace/brand/memo-bg.png` | 1920×1080 closing memo background |

### Regenerating them

```bash
node build/make-brand.mjs     # every raster, from the SVGs (Chromium renders them)
python build/make-wordmark.py # the wordmark SVG, from the mark + Unbounded outlines
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
