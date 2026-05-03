#!/usr/bin/env python3
"""Generate Playwright reference for the spike.

Phase 1: a single multilingual text line (Latin + Hebrew + Japanese)
rendered with the bundled Noto fonts.  The frame.html that comes out
is what the browser-side test page (index.html) will fetch and render
via foreignObject + canvas.

Outputs:
  frame.html      — exact HTML payload, also rendered by browser
  reference.png   — Playwright screenshot of frame.html
  reference.bin   — raw 1920x1080 RGBA buffer (PNG decoded)
  fonts/          — Noto font files referenced by frame.html

Run:
  cd spike/pgs-browser && python make_reference.py
"""
import asyncio
import shutil
import struct
import sys
from pathlib import Path

SPIKE_DIR = Path(__file__).parent
REPO_ROOT = SPIKE_DIR.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from playwright.async_api import async_playwright

# Width × height match the production rasterizer's default canvas.
W, H = 1920, 1080

# Phase 2 text: exercise the full subtitle render surface — ruby
# annotation (furigana), text mixing CJK + Hebrew (RTL bidi), bold
# weight on the bottom layer.
BOTTOM_TEXT = "<b>שלום עולם</b>"                          # Hebrew (RTL)
BOTTOM_RTL = True
TOP_HTML = "<ruby>世界<rt>セカイ</rt></ruby>へようこそ"     # Japanese with furigana
ROMAJI_TEXT = "sekai e youkoso"                            # Latin (smaller)


def _ensure_fonts() -> Path:
    """Copy the bundled Noto fonts into spike/pgs-browser/fonts/ so the
    HTTP server can serve them as same-origin URLs."""
    src = REPO_ROOT / "apps/desktop/src-tauri/resources/fonts"
    dst = SPIKE_DIR / "fonts"
    if not src.is_dir():
        sys.exit(
            f"[error] {src} not found.  Run scripts/setup_bundle.sh first "
            "to populate the bundled font tree."
        )
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    print(f"[ok]    copied {len(list(dst.iterdir()))} fonts → {dst}")
    return dst


def _font_face_css() -> str:
    """Build @font-face declarations using HTTP-relative URLs so the same
    HTML works in both Playwright (loaded from file://) and the browser
    (loaded via http.server).  Browsers resolve relative URLs against
    the document's URL — Playwright is going to load via file:// so we
    have to pass the absolute path; for the browser we'll rewrite at
    that side.

    For simplicity in phase 1 we reference a SUBSET of the bundled
    fonts: just the Sans Latin (Regular + Bold), Sans CJK JP, Sans
    Hebrew that the test text needs.  Future phases that exercise
    more scripts will pull in more faces.
    """
    fonts = [
        ("Noto Sans",        "fonts/NotoSans-Regular.otf",       400),
        ("Noto Sans",        "fonts/NotoSans-Bold.otf",          700),
        ("Noto Sans JP",     "fonts/NotoSansJP-Regular.otf",     400),
        ("Noto Sans JP",     "fonts/NotoSansJP-Bold.otf",        700),
        ("Noto Sans Hebrew", "fonts/NotoSansHebrew-Regular.otf", 400),
        ("Noto Sans Hebrew", "fonts/NotoSansHebrew-Bold.otf",    700),
    ]
    css = []
    for family, url, weight in fonts:
        if not (SPIKE_DIR / url).is_file():
            print(f"[warn]  {url} missing — skipping @font-face")
            continue
        css.append(
            f"@font-face {{ font-family: '{family}'; "
            f"src: url('{url}') format('opentype'); "
            f"font-weight: {weight}; font-display: block; }}"
        )
    return "\n".join(css)


def _build_html() -> str:
    """Phase 1 HTML payload: 3 absolutely-positioned divs on a 1920×1080
    canvas with bundled-font @font-face blocks.  Mirrors the production
    layer model from loom_core.rasterize.pgs._build_fullframe_html but
    with text pre-injected (no JS update step)."""
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
{_font_face_css()}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ background: transparent; overflow: hidden;
             width: {W}px; height: {H}px; }}
.frame {{ position: relative; width: {W}px; height: {H}px; }}
.layer {{
  position: absolute; width: 100%; text-align: center;
  white-space: pre-wrap; padding: 0 10px; box-sizing: border-box;
  unicode-bidi: isolate;
}}
#bottom {{
  font-family: 'Noto Sans Hebrew', 'Noto Sans', sans-serif;
  font-size: 48px;
  color: white;
  bottom: 40px;
  text-shadow: -3px -3px 0 black, 3px -3px 0 black,
               -3px  3px 0 black, 3px  3px 0 black;
}}
#top {{
  font-family: 'Noto Sans JP', sans-serif;
  font-size: 52px;
  color: white;
  top: 90px;
  text-shadow: -2.5px -2.5px 0 black, 2.5px -2.5px 0 black,
               -2.5px  2.5px 0 black, 2.5px  2.5px 0 black;
}}
#top rt {{
  font-family: 'Noto Sans JP', sans-serif;
  font-size: 26px;
  color: white;
  text-shadow: -1.5px -1.5px 0 black, 1.5px -1.5px 0 black,
               -1.5px  1.5px 0 black, 1.5px  1.5px 0 black;
}}
#romaji {{
  font-family: 'Noto Sans', sans-serif;
  font-size: 30px;
  color: rgb(200, 200, 200);
  top: 10px;
  text-shadow: -1.5px -1.5px 0 black, 1.5px -1.5px 0 black,
               -1.5px  1.5px 0 black, 1.5px  1.5px 0 black;
}}
</style></head>
<body><div class="frame">
  <div id="bottom" class="layer"{' dir="rtl"' if BOTTOM_RTL else ''}>{BOTTOM_TEXT}</div>
  <div id="top" class="layer">{TOP_HTML}</div>
  <div id="romaji" class="layer">{ROMAJI_TEXT}</div>
</div></body></html>"""


async def _screenshot(html_path: Path, out_png: Path):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": W, "height": H},
            device_scale_factor=1,
        )
        page = await context.new_page()
        await page.goto(html_path.as_uri())
        # Give @font-face a beat to load before screenshotting.
        await page.wait_for_load_state("networkidle")
        await page.wait_for_function("document.fonts.ready")
        # Screenshot just the .frame element so the result is exactly
        # 1920×1080 with no chrome.
        await page.locator(".frame").screenshot(
            path=str(out_png), omit_background=True,
        )
        await browser.close()


def _png_to_rgba(png_path: Path, raw_path: Path):
    """Decode reference.png to a raw 1920×1080 RGBA buffer for byte-level
    comparison.  Uses Pillow since it's already a project dep."""
    from PIL import Image
    img = Image.open(png_path).convert("RGBA")
    if img.size != (W, H):
        sys.exit(f"[error] expected {W}×{H}, got {img.size}")
    raw_path.write_bytes(img.tobytes())
    print(f"[ok]    {raw_path.name}: {raw_path.stat().st_size:,} bytes "
          f"({W}×{H} RGBA)")


async def main():
    _ensure_fonts()

    html_path = SPIKE_DIR / "frame.html"
    html_path.write_text(_build_html(), encoding="utf-8")
    print(f"[ok]    {html_path.name}: {html_path.stat().st_size:,} bytes")

    ref_png = SPIKE_DIR / "reference.png"
    print(f"[run]   Playwright screenshot → {ref_png.name} (this takes ~2s)")
    await _screenshot(html_path, ref_png)
    print(f"[ok]    {ref_png.name}: {ref_png.stat().st_size:,} bytes")

    _png_to_rgba(ref_png, SPIKE_DIR / "reference.bin")

    print()
    print("Next:")
    print("  1. ./serve.sh  (in another terminal)")
    print("  2. open http://localhost:8001/index.html")
    print("  3. run python diff.py")


if __name__ == "__main__":
    asyncio.run(main())
