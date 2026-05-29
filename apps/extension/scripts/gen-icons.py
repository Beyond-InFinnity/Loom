#!/usr/bin/env python3
"""Generate the Loom extension icon set from the Nerv-Analytica brand favicon.

    python3 scripts/gen-icons.py          (or: npm run icons)

Source of truth is the marketing site's favicon (the purple-neuron-on-dark
mark). Its native 16/32/48 frames are used verbatim at those sizes (the ones
that matter in the toolbar + extensions list); 96/128 (store-display sizes) are
Lanczos-upscaled from the 48 frame. The dev build gets a red corner badge so
"Loom" and "Loom (Dev)" are distinguishable side-by-side.

The committed PNGs in public/icons/ are the deliverable — this script just
documents how they were produced and lets you regenerate if the brand mark
changes. Point it elsewhere with LOOM_FAVICON_SRC. Requires Pillow.
"""
import os
from PIL import Image, ImageDraw
from PIL.IcoImagePlugin import IcoFile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "..", "nerv-analytica-website",
                 "src", "app", "favicon.ico")
)
SRC = os.environ.get("LOOM_FAVICON_SRC", DEFAULT_SRC)
OUT = os.path.normpath(os.path.join(HERE, "..", "public", "icons"))
SIZES = [16, 32, 48, 96, 128]

ico = IcoFile(open(SRC, "rb"))
native_sizes = {wh for wh in ico.sizes()}
base = ico.getimage((48, 48)).convert("RGBA")


def prod_icon(size):
    if (size, size) in native_sizes:
        return ico.getimage((size, size)).convert("RGBA")
    return base.resize((size, size), Image.LANCZOS)


def dev_icon(size):
    """Prod mark + a red corner badge (white-ringed for contrast)."""
    im = prod_icon(size).copy()
    d = ImageDraw.Draw(im)
    r = max(2, round(size * 0.18))
    cx, cy = size - r - max(1, size // 32), r + max(1, size // 32)
    d.ellipse([cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1],
              fill=(255, 255, 255, 230))           # ring
    d.ellipse([cx - r, cy - r, cx + r, cy + r],
              fill=(239, 68, 68, 255))              # red dot
    return im


for variant, fn in (("prod", prod_icon), ("dev", dev_icon)):
    d = os.path.join(OUT, variant)
    os.makedirs(d, exist_ok=True)
    for s in SIZES:
        fn(s).save(os.path.join(d, f"{s}.png"))
    print(f"wrote {len(SIZES)} icons -> public/icons/{variant}/  (src: {os.path.basename(SRC)})")
