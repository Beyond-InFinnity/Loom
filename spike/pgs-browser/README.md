# PGS-in-browser feasibility spike

**Goal:** validate that browser canvas can produce pixel-equivalent output
to the desktop's Playwright + Chromium PGS rasterization path.  If yes,
Step 4's Option B architecture (all-client video processing + JS port of
PGS rasterizer) is viable.  If no, fall back to Option A (hybrid
client/server) before committing to the JS port investment.

## Phases

1. **Phase 1 — minimal smoke test.** Render a single line of multilingual
   text (Latin + Hebrew + Japanese) via a hidden SVG `<foreignObject>` →
   canvas → PNG.  Compare to a Playwright screenshot of the same HTML.
   Goal: confirm the technique works with custom @font-face, then quantify
   pixel deltas.

2. **Phase 2 — Loom HTML payload.** Use the actual `_build_fullframe_html`
   output (with text pre-injected, no JS update) and repeat the
   browser-vs-Playwright pixel diff.  Goal: confirm the full subtitle
   layout (bottom/top/romaji/annotation, ruby furigana, RTL bidi) renders
   identically.

3. **Phase 3 — palette quantization.** Quantize both browser and reference
   pixel buffers to a 256-color palette using the same algorithm.  If
   the resulting indexed images match byte-for-byte, the SUP encoding
   downstream is guaranteed to match.  This is the actual bar for "PGS
   output identical to desktop."

## Files

* `make_reference.py` — generates the reference frame.html + Playwright
  screenshot reference.png + raw RGBA buffer reference.bin.
* `index.html` — standalone browser test page; loads frame.html, renders
  via foreignObject → canvas, downloads browser.png + browser.bin.
* `diff.py` — pixel-level + palette-quantized comparison.
* `serve.sh` — `python -m http.server 8001` from this directory (needed
  so the browser can fetch frame.html + fonts under same origin without
  CORS taint on getImageData).
