# app/rasterize.py
"""Rasterize subtitle frames to transparent PNGs via headless Chromium.

Uses Playwright to render full-frame subtitle composites (Bottom, Top with
<ruby> annotations, Romanized) at the target video resolution.  All enabled
layers are rendered into a single bitmap per event, producing PGS-ready
display sets.

rasterize_pgs_frames() uses up to 4 parallel browser pages for speed (used by
tests and short renders).

rasterize_pgs_to_file() uses N concurrent browser pages (default 3) sharing
one Chromium process for parallel rendering, with a reordering buffer that
feeds a single consumer writing .sup incrementally via SupWriter in strict
timestamp order.  Set num_workers=1 for sequential fallback on memory-
constrained systems.

Graceful degradation: if Playwright is not installed, is_playwright_available()
returns False and the caller can skip PGS generation.

Public API
----------
is_playwright_available()
    Check if Playwright can be imported.

PGSFrameEvent
    Dataclass: start_ms, end_ms, bottom_text, top_html, romaji_text.

rasterize_pgs_frames(events, styles, ...) -> list[DisplaySet]
    Render full-frame subtitle composites to transparent PNGs (all in memory).

rasterize_pgs_to_file(events, styles, ..., output_path) -> int
    Memory-bounded: render in batches of 50, write .sup incrementally via
    SupWriter.  Single browser page, no recycling.
"""

from __future__ import annotations

import asyncio
import gc
import heapq
import io
import logging
import os
import time as _time
import threading
from dataclasses import dataclass

logger = logging.getLogger(__name__)


def _log_memory(label: str) -> None:
    """Log Python RSS and system available memory (best-effort)."""
    try:
        import psutil
        proc = psutil.Process()
        rss_mb = proc.memory_info().rss / (1024 ** 2)
        avail_mb = psutil.virtual_memory().available / (1024 ** 2)
        logger.info(f"[memory] {label}: Python RSS={rss_mb:.0f}MB, "
                    f"system available={avail_mb:.0f}MB")
    except Exception:
        pass

from .sup_writer import DisplaySet, split_regions, _quantize_image


@dataclass
class PGSFrameEvent:
    """One subtitle frame for PGS rasterization.

    Each event represents a single time window with all enabled subtitle
    layers.  The rasterizer renders all layers into one composite bitmap.

    Attributes
    ----------
    start_ms : int
        Display start time in milliseconds.
    end_ms : int
        Display end time in milliseconds.
    bottom_text : str | None
        User's native language text (None if Bottom disabled or no overlap).
    top_html : str
        Foreign / media language text — <ruby> HTML if annotation enabled,
        else plain text.
    romaji_text : str | None
        Romanized text (None if Romanized disabled).
    """
    start_ms: int
    end_ms: int
    bottom_text: str | None
    top_html: str
    romaji_text: str | None
    preserved_html: str | None = None


def is_playwright_available() -> bool:
    """Check if Playwright can be imported (does not verify browser install)."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
        return True
    except ImportError:
        return False


def _build_text_shadow_css(config: dict, scale: float) -> str:
    """Build CSS text-shadow value from any layer's style config.

    Replicates the outline / shadow / glow logic from preview.py, but at
    output resolution (no preview font scaling).

    Parameters
    ----------
    config : dict
        Style config dict (1080-scale values).
    scale : float
        Output scale factor (canvas_height / 1080).
    """
    shadow_parts = []

    # Outline - 8-directional text-shadow (same as preview.py)
    if not config.get('outline_none', True):
        outline = config.get('outline', 1.0) * scale
        oc = config.get('outlinecolor')
        if oc:
            oc_rgba = f"rgba({oc.r},{oc.g},{oc.b},{(255 - oc.a) / 255.0})"
        else:
            oc_rgba = "rgba(0,0,0,1)"
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx != 0 or dy != 0:
                    shadow_parts.append(
                        f"{dx}px {dy}px {outline:.1f}px {oc_rgba}"
                    )

    # Drop shadow
    if not config.get('shadow_none', True):
        shadow = config.get('shadow', 1.5) * scale
        oc = config.get('outlinecolor')
        if oc:
            s_rgba = f"rgba({oc.r},{oc.g},{oc.b},0.8)"
        else:
            s_rgba = "rgba(0,0,0,0.8)"
        shadow_parts.append(f"{shadow:.1f}px {shadow:.1f}px 3px {s_rgba}")

    # Glow
    if not config.get('glow_none', True):
        glow_r = config.get('glow_radius', 5) * scale
        glow_hex = config.get('glow_color_hex', '#ffff00')
        gr = int(glow_hex[1:3], 16)
        gg = int(glow_hex[3:5], 16)
        gb = int(glow_hex[5:7], 16)
        shadow_parts.append(f"0 0 {glow_r:.1f}px rgba({gr},{gg},{gb},0.9)")
        shadow_parts.append(f"0 0 {glow_r * 2:.1f}px rgba({gr},{gg},{gb},0.5)")

    if shadow_parts:
        return f"text-shadow: {', '.join(shadow_parts)};"
    return ""


def _color_css(config: dict) -> str:
    """Extract CSS color from a style config's primarycolor."""
    pc = config.get('primarycolor')
    if pc:
        opacity = (255 - pc.a) / 255.0
        return f"rgba({pc.r},{pc.g},{pc.b},{opacity})"
    return "white"


def _build_fullframe_html(styles: dict, canvas_width: int,
                          canvas_height: int, scale: float,
                          annotation_render_mode: str = 'ruby') -> str:
    """Build the full-frame HTML page template for PGS rasterization.

    Creates a viewport-sized container with 3 absolutely-positioned divs
    (#bottom, #top, #romaji) matching the layout from preview.py.
    Annotation ruby/interlinear/inline is rendered inline with the Top div's HTML.

    The divs start with empty innerHTML -- updated per-event via JS.
    """
    v_offset = styles.get('vertical_offset', 0)
    rom_gap = styles.get('romanized_gap', 0)
    ann_gap = styles.get('annotation_gap', 2)

    # --- Bottom layer CSS ---
    bottom_cfg = styles.get('Bottom', {})
    bottom_fontsize = bottom_cfg.get('fontsize', 48) * scale
    bottom_marginv = bottom_cfg.get('marginv', 40) * scale
    bottom_css = (
        f"font-family: '{bottom_cfg.get('fontname', 'Arial')}', 'Noto Sans CJK JP', sans-serif;"
        f"font-size: {bottom_fontsize:.1f}px;"
        f"font-weight: {'bold' if bottom_cfg.get('bold') else 'normal'};"
        f"font-style: {'italic' if bottom_cfg.get('italic') else 'normal'};"
        f"color: {_color_css(bottom_cfg)};"
        f"bottom: {bottom_marginv:.1f}px;"
        f"{_build_text_shadow_css(bottom_cfg, scale)}"
    )

    # --- Top layer CSS ---
    top_cfg = styles.get('Top', {})
    top_fontsize = top_cfg.get('fontsize', 52) * scale
    top_marginv = (top_cfg.get('marginv', 90) + v_offset) * scale
    top_css = (
        f"font-family: '{top_cfg.get('fontname', 'Arial')}', 'Noto Sans CJK JP', sans-serif;"
        f"font-size: {top_fontsize:.1f}px;"
        f"font-weight: {'bold' if top_cfg.get('bold') else 'normal'};"
        f"font-style: {'italic' if top_cfg.get('italic') else 'normal'};"
        f"color: {_color_css(top_cfg)};"
        f"top: {top_marginv:.1f}px;"
        f"{_build_text_shadow_css(top_cfg, scale)}"
    )

    # --- Romanized layer CSS ---
    rom_cfg = styles.get('Romanized', {})
    rom_fontsize = rom_cfg.get('fontsize', 30) * scale
    rom_marginv = (rom_cfg.get('marginv', 10) + v_offset - rom_gap) * scale
    rom_css = (
        f"font-family: '{rom_cfg.get('fontname', 'Arial')}', 'Noto Sans CJK JP', sans-serif;"
        f"font-size: {rom_fontsize:.1f}px;"
        f"font-weight: {'bold' if rom_cfg.get('bold') else 'normal'};"
        f"font-style: {'italic' if rom_cfg.get('italic') else 'normal'};"
        f"color: {_color_css(rom_cfg)};"
        f"top: {rom_marginv:.1f}px;"
        f"{_build_text_shadow_css(rom_cfg, scale)}"
    )

    # --- Annotation <rt> CSS (inline with Top) ---
    ann_cfg = styles.get('Annotation', {})
    ann_fontsize = ann_cfg.get('fontsize', 22) * scale
    ann_fontname = ann_cfg.get('fontname', 'Arial')
    ann_bold = 'bold' if ann_cfg.get('bold', False) else 'normal'
    ann_italic = 'italic' if ann_cfg.get('italic', False) else 'normal'
    ann_color = _color_css(ann_cfg)
    ann_text_shadow = _build_text_shadow_css(ann_cfg, scale)

    return f'''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ background: transparent; overflow: hidden;
             width: {canvas_width}px; height: {canvas_height}px; }}
.frame {{
    position: relative;
    width: {canvas_width}px;
    height: {canvas_height}px;
}}
.layer {{
    position: absolute;
    width: 100%;
    text-align: center;
    white-space: pre-wrap;
    padding: 0 10px;
    box-sizing: border-box;
}}
#bottom {{ {bottom_css} }}
#top {{ {top_css} }}
#romaji {{ {rom_css} }}
#top rt {{
    color: {ann_color};
    font-family: '{ann_fontname}', 'Noto Sans CJK JP', sans-serif;
    font-size: {ann_fontsize:.1f}px;
    font-weight: {ann_bold};
    font-style: {ann_italic};
    transform: translateY(-{ann_gap * scale:.1f}px);
    {ann_text_shadow}
}}
/* Interlinear annotation mode: inline-block two-row containers */
#top .ilb {{
    display: inline-block;
    text-align: center;
    vertical-align: bottom;
    line-height: 1.1;
}}
#top .ilb-r {{
    display: block;
    color: {ann_color};
    font-family: '{ann_fontname}', 'Noto Sans CJK JP', sans-serif;
    font-size: {ann_fontsize:.1f}px;
    font-weight: {ann_bold};
    font-style: {ann_italic};
    transform: translateY(-{ann_gap * scale:.1f}px);
    {ann_text_shadow}
}}
#top .ilb-b {{
    display: block;
}}
</style></head>
<body><div class="frame">
  <div id="bottom" class="layer"></div>
  <div id="top" class="layer"></div>
  <div id="romaji" class="layer"></div>
  <div id="preserved" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>
</div></body></html>'''


def rasterize_pgs_frames(
    events: list[PGSFrameEvent],
    styles: dict,
    canvas_width: int,
    canvas_height: int,
    scale: float = 1.0,
    progress_callback=None,
    annotation_render_mode: str = 'ruby',
) -> list[DisplaySet]:
    """Render full-frame subtitle composites to transparent PNGs.

    Launches one Playwright Chromium browser, creates 4 parallel pages,
    and distributes events across workers.  Each worker updates its page's
    innerHTML and screenshots the frame div.

    Parameters
    ----------
    events : list[PGSFrameEvent]
        Subtitle frame events in chronological order.
    styles : dict
        Full style config from st.session_state.styles.
    canvas_width, canvas_height : int
        Output video dimensions in pixels.
    scale : float
        Output scale factor (canvas_height / 1080).
    progress_callback : callable | None
        Optional ``callback(completed, total)`` for UI progress bar.

    Returns
    -------
    list[DisplaySet]
        One per event that produced visible content.

    Raises
    ------
    ImportError
        If Playwright is not installed.
    """
    if not events:
        return []

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ImportError(
            "Playwright is required for PGS rasterization.\n"
            "Install:  pip install playwright && playwright install chromium"
        )

    from PIL import Image

    # Render at 1080p-width max, upscale to target if needed.
    # Derive render_height from aspect ratio (not hardcoded 1080) to support
    # cinematic ratios like 3840×2064 (1.86:1).
    if canvas_width > 1920:
        render_width = 1920
        render_height = round(canvas_height * 1920 / canvas_width)
        render_scale = 1.0
        upscale_factor = canvas_width / 1920
    else:
        render_width, render_height = canvas_width, canvas_height
        render_scale = scale
        upscale_factor = 1.0

    logger.info(
        f"[rasterize_pgs_frames] Render config: "
        f"canvas={canvas_width}x{canvas_height}, "
        f"render={render_width}x{render_height}, "
        f"upscale_factor={upscale_factor}, scale_arg={scale}"
    )

    page_html = _build_fullframe_html(styles, render_width, render_height, render_scale,
                                       annotation_render_mode=annotation_render_mode)

    total = len(events)
    results = [None] * total
    progress_counter = [0]
    cache_hits = [0]
    cache_misses = [0]
    empty_skips = [0]
    first_ds_logged = [False]
    frame_cache = {}   # content tuple → (png_bytes, x, y, w, h) or None

    # JS function to update all layer divs at once (4 args: bottom, top, romaji, preserved)
    _UPDATE_JS = '''(args) => {
        document.getElementById("bottom").innerHTML = args[0] || "";
        document.getElementById("top").innerHTML = args[1] || "";
        document.getElementById("romaji").innerHTML = args[2] || "";
        document.getElementById("preserved").innerHTML = args[3] || "";
    }'''

    async def _process_chunk(page, chunk):
        """Process a chunk of (global_index, event) pairs on one page."""
        frame_el = page.locator('.frame')

        for global_idx, event in chunk:
            # Convert \N line breaks to <br> for HTML rendering
            bottom = (event.bottom_text or '').replace('\\N', '<br>').replace('\n', '<br>')
            top = (event.top_html or '').replace('\\N', '<br>').replace('\n', '<br>')
            romaji = (event.romaji_text or '').replace('\\N', '<br>').replace('\n', '<br>')
            preserved = event.preserved_html or ''

            content_key = (bottom, top, romaji, preserved)

            # Skip empty frames — no visible content possible
            if not any(content_key):
                empty_skips[0] += 1
                logger.debug(f"Frame {global_idx}: empty_skip")
                progress_counter[0] += 1
                if progress_callback:
                    progress_callback(progress_counter[0], total)
                continue

            # Reuse cached bitmap for duplicate content (stored at render resolution)
            if content_key in frame_cache:
                cache_hits[0] += 1
                logger.debug(f"Frame {global_idx}: cache_hit")
                cached = frame_cache[content_key]
                if cached is not None:
                    png_bytes_cached, cx, cy, cw, ch = cached
                    cached_img = Image.open(io.BytesIO(png_bytes_cached)).copy()
                    if upscale_factor > 1.0:
                        uw = round(cw * upscale_factor)
                        uh = round(ch * upscale_factor)
                        out_img = cached_img.resize((uw, uh), Image.LANCZOS)
                        out_x = round(cx * upscale_factor)
                        out_y = round(cy * upscale_factor)
                    else:
                        out_img = cached_img
                        out_x, out_y = cx, cy
                    results[global_idx] = DisplaySet(
                        start_ms=event.start_ms,
                        end_ms=event.end_ms,
                        image=out_img,
                        x=out_x, y=out_y,
                        canvas_width=canvas_width,
                        canvas_height=canvas_height,
                    )
                progress_counter[0] += 1
                if progress_callback:
                    progress_callback(progress_counter[0], total)
                continue

            cache_misses[0] += 1
            logger.debug(f"Frame {global_idx}: cache_miss (rendering)")
            await page.evaluate(_UPDATE_JS, [bottom, top, romaji, preserved])

            # Screenshot the full frame with transparent background
            png_bytes = await frame_el.screenshot(type='png', omit_background=True)

            img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
            bbox = img.getbbox()

            if bbox:
                cropped = img.crop(bbox)
                # Cache stores compressed PNG bytes at render resolution
                buf = io.BytesIO()
                cropped.save(buf, format='PNG')
                frame_cache[content_key] = (buf.getvalue(), bbox[0], bbox[1], cropped.width, cropped.height)
                del buf
                if upscale_factor > 1.0:
                    uw = round(cropped.width * upscale_factor)
                    uh = round(cropped.height * upscale_factor)
                    cropped = cropped.resize((uw, uh), Image.LANCZOS)
                    out_x = round(bbox[0] * upscale_factor)
                    out_y = round(bbox[1] * upscale_factor)
                else:
                    out_x, out_y = bbox[0], bbox[1]
                # Log first DisplaySet for diagnostics
                if not first_ds_logged[0]:
                    first_ds_logged[0] = True
                    logger.info(
                        f"[rasterize_pgs_frames] First DisplaySet: "
                        f"canvas={canvas_width}x{canvas_height}, "
                        f"object_bitmap={cropped.width}x{cropped.height}, "
                        f"position=({out_x},{out_y})"
                    )
                results[global_idx] = DisplaySet(
                    start_ms=event.start_ms,
                    end_ms=event.end_ms,
                    image=cropped,
                    x=out_x,
                    y=out_y,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
            else:
                frame_cache[content_key] = None
            del img, png_bytes

            progress_counter[0] += 1
            if progress_callback:
                progress_callback(progress_counter[0], total)

    async def _run():
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            num_workers = min(4, total)
            pages = []
            for _ in range(num_workers):
                ctx = await browser.new_context(
                    viewport={'width': render_width, 'height': render_height},
                )
                page = await ctx.new_page()
                await page.set_content(page_html, wait_until='domcontentloaded')
                pages.append(page)

            # Partition events into chunks with global indices
            indexed_events = list(enumerate(events))
            chunks = [[] for _ in range(num_workers)]
            for i, item in enumerate(indexed_events):
                chunks[i % num_workers].append(item)

            # Run all chunks concurrently via asyncio.gather
            tasks = []
            for worker_idx in range(num_workers):
                if chunks[worker_idx]:
                    tasks.append(_process_chunk(pages[worker_idx],
                                                chunks[worker_idx]))
            await asyncio.gather(*tasks)

            await browser.close()

    # Run the async event loop.  If we're already inside an event loop
    # (e.g. Streamlit), run in a new thread with its own loop.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # Can't call asyncio.run() from inside a running loop.
        # Spawn a background thread with a fresh event loop.
        exc_holder = [None]
        def _thread_target():
            try:
                asyncio.run(_run())
            except Exception as e:
                exc_holder[0] = e
        t = threading.Thread(target=_thread_target)
        t.start()
        t.join()
        if exc_holder[0]:
            raise exc_holder[0]
    else:
        asyncio.run(_run())

    logger.info(
        f"[rasterize_pgs_frames] Cache stats: {cache_hits[0]} hits, "
        f"{cache_misses[0]} misses, {empty_skips[0]} empty skips "
        f"out of {total} total frames"
    )

    # Filter out None entries (events with no visible content)
    return [ds for ds in results if ds is not None]


# ── Streaming rendering constants ────────────────────────────────────
_BATCH_SIZE = 50        # gc.collect() interval for consumer (bounds garbage)
_SENTINEL = object()    # poison pill for worker shutdown


def rasterize_pgs_to_file(
    events: list[PGSFrameEvent],
    styles: dict,
    canvas_width: int,
    canvas_height: int,
    output_path: str,
    scale: float = 1.0,
    progress_callback=None,
    annotation_render_mode: str = 'ruby',
    batch_size: int = _BATCH_SIZE,
    num_workers: int = 1,
    debug_dump_dir: str | None = None,
    debug_dump_frames: int = 20,
) -> int:
    """Render PGS frames and write to .sup file incrementally.

    Memory-bounded streaming renderer.  When *num_workers* > 1, uses N
    concurrent Playwright browser pages sharing a single Chromium browser
    instance, a reordering buffer (min-heap), and a consumer coroutine that
    writes display sets to the SupWriter in strict timestamp order.

    When *num_workers* == 1, falls back to a simple sequential loop (useful
    for testing, debugging, and memory-constrained systems).

    Parameters
    ----------
    events : list[PGSFrameEvent]
        Subtitle frame events in chronological order.
    styles : dict
        Full style config from st.session_state.styles.
    canvas_width, canvas_height : int
        Output video dimensions in pixels.
    output_path : str
        Path to write the .sup file.
    scale : float
        Output scale factor (canvas_height / 1080).
    progress_callback : callable | None
        Optional ``callback(completed, total)`` for UI progress bar.
    annotation_render_mode : str
        Annotation HTML mode: ``'ruby'``, ``'interlinear'``, ``'inline'``.
    batch_size : int
        GC interval in frames (default 50).
    num_workers : int
        Number of concurrent browser pages (default 3).  Set to 1 for
        sequential rendering.
    debug_dump_dir : str | None
        If set, dump intermediate rendering artifacts for the first
        *debug_dump_frames* frames to this directory for diagnosis.
        Saves: HTML template, raw screenshots, cropped images, split regions.
    debug_dump_frames : int
        Number of frames to dump when debug_dump_dir is set (default 20).

    Returns
    -------
    int
        Number of visible display sets written.
    """
    if not events:
        return 0

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ImportError(
            "Playwright is required for PGS rasterization.\n"
            "Install:  pip install playwright && playwright install chromium"
        )

    from PIL import Image
    from .sup_writer import SupWriter

    # Render at 1080p-width max, upscale to target if needed.
    # Derive render_height from aspect ratio (not hardcoded 1080) to support
    # cinematic ratios like 3840×2064 (1.86:1).
    if canvas_width > 1920:
        render_width = 1920
        render_height = round(canvas_height * 1920 / canvas_width)
        render_scale = 1.0
        upscale_factor = canvas_width / 1920
    else:
        render_width, render_height = canvas_width, canvas_height
        render_scale = scale
        upscale_factor = 1.0

    effective_workers = min(num_workers, len(events))

    print(
        f"[RASTERIZE START] num_workers={effective_workers} "
        f"(requested={num_workers}), "
        f"canvas={canvas_width}x{canvas_height}, "
        f"render={render_width}x{render_height}, "
        f"upscale={upscale_factor:.2f}x, "
        f"total_frames={len(events)}, "
        f"path={'sequential' if effective_workers <= 1 else 'parallel'}"
    )
    _wall_start = _time.monotonic()

    page_html = _build_fullframe_html(styles, render_width, render_height, render_scale,
                                       annotation_render_mode=annotation_render_mode)

    # ── Debug dump setup ──────────────────────────────────────────────
    # Also check env var as fallback: PGS_DEBUG_DUMP=/path/to/dir
    _dump_dir = debug_dump_dir or os.environ.get('PGS_DEBUG_DUMP')
    _dump_max = debug_dump_frames
    _dump_count = [0]  # mutable counter for frames dumped
    if _dump_dir:
        os.makedirs(_dump_dir, exist_ok=True)
        # Save HTML template
        with open(os.path.join(_dump_dir, 'frame_template.html'), 'w') as f:
            f.write(page_html)
        # Save style config summary
        with open(os.path.join(_dump_dir, 'style_config.txt'), 'w') as f:
            for layer_name in ['Bottom', 'Top', 'Romanized', 'Annotation']:
                cfg = styles.get(layer_name, {})
                if not isinstance(cfg, dict):
                    continue
                f.write(f"=== {layer_name} ===\n")
                for key in ['outline_none', 'outline', 'outlinecolor',
                            'shadow_none', 'shadow',
                            'glow_none', 'glow_radius', 'glow_color_hex',
                            'primarycolor', 'opacity']:
                    if key in cfg:
                        f.write(f"  {key}: {cfg[key]}\n")
                f.write(f"  text_shadow_css: {_build_text_shadow_css(cfg, render_scale)}\n\n")
        print(f"[DEBUG DUMP] Saving first {_dump_max} frames to {_dump_dir}")

    total = len(events)
    cache_hits = [0]
    cache_misses = [0]
    empty_skips = [0]
    first_ds_logged = [False]
    _frames_completed = [0]   # for progress logging
    writer = SupWriter(output_path, canvas_width, canvas_height)

    _UPDATE_JS = '''(args) => {
        document.getElementById("bottom").innerHTML = args[0] || "";
        document.getElementById("top").innerHTML = args[1] || "";
        document.getElementById("romaji").innerHTML = args[2] || "";
        document.getElementById("preserved").innerHTML = args[3] || "";
    }'''

    frame_cache = {}   # content tuple → (png_bytes, x, y, w, h) or None

    # ── Shared render logic ──────────────────────────────────────────

    async def _render_frame(page, frame_el, event, frame_idx):
        """Render a single frame.  Returns (ds_list, content_key).

        After cropping the screenshot to non-transparent bounds, splits the
        bitmap into up to 2 vertically-separated regions via split_regions().
        Each region becomes an independent PGS object.

        Returns ([], None) for empty/invisible frames.
        content_key is (bottom, top, romaji, preserved) — used for epoch management.
        """
        _detail = frame_idx < 10   # detailed timing for first 10 frames
        if _detail:
            _t0 = _time.monotonic()

        bottom = (event.bottom_text or '').replace('\\N', '<br>').replace('\n', '<br>')
        top = (event.top_html or '').replace('\\N', '<br>').replace('\n', '<br>')
        romaji = (event.romaji_text or '').replace('\\N', '<br>').replace('\n', '<br>')
        preserved = event.preserved_html or ''

        content_key = (bottom, top, romaji, preserved)

        # Skip empty frames — no visible content possible
        if not any(content_key):
            empty_skips[0] += 1
            if _detail:
                print(f"[FRAME {frame_idx}] empty_skip")
            return [], None

        # Should this frame be debug-dumped?
        _do_dump = bool(_dump_dir and _dump_count[0] < _dump_max)

        # ── Helper: build DisplaySet list from a cropped image ──
        def _make_display_sets(cropped_img, crop_x, crop_y):
            """Upscale if needed, split regions, return list of DisplaySets."""
            if upscale_factor > 1.0:
                uw = round(cropped_img.width * upscale_factor)
                uh = round(cropped_img.height * upscale_factor)
                out_img = cropped_img.resize((uw, uh), Image.LANCZOS)
                out_x = round(crop_x * upscale_factor)
                out_y = round(crop_y * upscale_factor)
            else:
                out_img = cropped_img
                out_x, out_y = crop_x, crop_y

            # Split into 1 or 2 regions
            regions = split_regions(out_img, out_x, out_y, canvas_height=canvas_height)

            if not first_ds_logged[0]:
                first_ds_logged[0] = True
                dims = " + ".join(f"{r[0].width}x{r[0].height}" for r in regions)
                print(
                    f"[RASTERIZE] First DisplaySet: "
                    f"canvas={canvas_width}x{canvas_height}, "
                    f"regions={len(regions)} ({dims}), "
                    f"full_crop={out_img.width}x{out_img.height}"
                )

            # Debug dump: save each split region + alpha edge analysis + quantized preview
            if _do_dump:
                import numpy as _np
                for j, (sub_img, sx, sy) in enumerate(regions):
                    sub_img.save(os.path.join(
                        _dump_dir, f"frame_{frame_idx:04d}_region_{j}.png"))

                    # Analyze alpha at region edges (top/bottom 3 rows)
                    _raw = _np.frombuffer(sub_img.tobytes(), dtype=_np.uint8
                                          ).reshape(sub_img.height, sub_img.width, 4)
                    _a = _raw[:, :, 3]
                    _edge_info = []
                    for _row_label, _row_idx in [("top0", 0), ("top1", 1), ("top2", 2),
                                                  ("bot2", -3), ("bot1", -2), ("bot0", -1)]:
                        if abs(_row_idx) <= _a.shape[0] and _row_idx < _a.shape[0]:
                            _row = _a[_row_idx]
                            _nz = int(_np.count_nonzero(_row))
                            _max_a = int(_row.max()) if _nz > 0 else 0
                            _mean_a = float(_row[_row > 0].mean()) if _nz > 0 else 0
                            _edge_info.append(
                                f"    {_row_label}: {_nz} non-zero px, "
                                f"max_alpha={_max_a}, mean_alpha={_mean_a:.1f}")

                    # Quantize and reconstruct to show what PGS will actually render
                    q_indices, q_palette = _quantize_image(sub_img)
                    _q_arr = q_indices.reshape(sub_img.height, sub_img.width)
                    # Reconstruct RGBA from palette (YCbCr→RGB conversion)
                    _recon = _np.zeros((sub_img.height, sub_img.width, 4), dtype=_np.uint8)
                    for _pi in range(256):
                        _mask = (_q_arr == _pi)
                        if not _np.any(_mask):
                            continue
                        _y, _cb, _cr, _pa = q_palette[_pi]
                        # YCbCr→RGB (BT.601)
                        _rr = max(0, min(255, round(_y + 1.402 * (_cr - 128))))
                        _gg = max(0, min(255, round(_y - 0.344136 * (_cb - 128) - 0.714136 * (_cr - 128))))
                        _bb = max(0, min(255, round(_y + 1.772 * (_cb - 128))))
                        _recon[_mask] = [_rr, _gg, _bb, _pa]
                    _q_img = Image.fromarray(_recon, 'RGBA')
                    _q_img.save(os.path.join(
                        _dump_dir, f"frame_{frame_idx:04d}_region_{j}_quantized.png"))

                    # Compare edge alpha before vs after quantization
                    _qa = _recon[:, :, 3]
                    _q_edge_info = []
                    for _row_label, _row_idx in [("top0", 0), ("top1", 1), ("top2", 2),
                                                  ("bot2", -3), ("bot1", -2), ("bot0", -1)]:
                        if abs(_row_idx) <= _qa.shape[0] and _row_idx < _qa.shape[0]:
                            _qrow = _qa[_row_idx]
                            _qnz = int(_np.count_nonzero(_qrow))
                            _qmax = int(_qrow.max()) if _qnz > 0 else 0
                            _qmean = float(_qrow[_qrow > 0].mean()) if _qnz > 0 else 0
                            _q_edge_info.append(
                                f"    {_row_label}: {_qnz} non-zero px, "
                                f"max_alpha={_qmax}, mean_alpha={_qmean:.1f}")

                    with open(os.path.join(
                            _dump_dir, f"frame_{frame_idx:04d}_region_{j}_edges.txt"), 'w') as _ef:
                        _ef.write(f"Region {j}: {sub_img.width}x{sub_img.height} "
                                  f"at ({sx},{sy})\n\n")
                        _ef.write("=== Original RGBA edge alpha ===\n")
                        _ef.write("\n".join(_edge_info) + "\n\n")
                        _ef.write("=== After PGS quantization ===\n")
                        _ef.write("\n".join(_q_edge_info) + "\n\n")
                        # Flag potential artifacts: edge alpha inflation
                        _ef.write("=== Alpha inflation check ===\n")
                        for _row_label, _row_idx in [("top0", 0), ("bot0", -1)]:
                            if abs(_row_idx) <= _a.shape[0] and _row_idx < _a.shape[0]:
                                _orig_row = _a[_row_idx]
                                _q_row = _qa[_row_idx]
                                _inflated = int(_np.sum((_q_row > _orig_row) & (_orig_row > 0)))
                                _max_inflate = 0
                                if _inflated > 0:
                                    _diffs = (_q_row.astype(int) - _orig_row.astype(int))
                                    _max_inflate = int(_diffs[_diffs > 0].max())
                                _ef.write(
                                    f"    {_row_label}: {_inflated} pixels with alpha inflation, "
                                    f"max increase={_max_inflate}\n")

            ds_list = []
            for sub_img, sx, sy in regions:
                ds_list.append(DisplaySet(
                    start_ms=event.start_ms, end_ms=event.end_ms,
                    image=sub_img, x=sx, y=sy,
                    canvas_width=canvas_width, canvas_height=canvas_height,
                ))
            return ds_list

        # Reuse cached bitmap for duplicate content (stored at render resolution)
        if content_key in frame_cache:
            cache_hits[0] += 1
            if _detail:
                _tc0 = _time.monotonic()
            cached = frame_cache[content_key]
            if cached is None:
                if _detail:
                    print(f"[FRAME {frame_idx}] cache=HIT (empty cached) total={(_time.monotonic()-_t0)*1000:.0f}ms")
                return [], content_key
            png_bytes_cached, cx, cy, cw, ch = cached
            cached_img = Image.open(io.BytesIO(png_bytes_cached)).copy()
            result = _make_display_sets(cached_img, cx, cy)
            if _detail:
                _tc1 = _time.monotonic()
                print(
                    f"[FRAME {frame_idx}] cache=HIT "
                    f"regions={len(result)} "
                    f"total={(_tc1-_t0)*1000:.0f}ms"
                )
            return result, content_key

        cache_misses[0] += 1
        if _detail:
            _tr0 = _time.monotonic()
        await page.evaluate(_UPDATE_JS, [bottom, top, romaji, preserved])
        png_bytes = await frame_el.screenshot(type='png', omit_background=True)
        if _detail:
            _tr1 = _time.monotonic()

        # Debug dump: raw screenshot (full canvas, before crop)
        if _do_dump:
            with open(os.path.join(_dump_dir, f"frame_{frame_idx:04d}_raw.png"), 'wb') as _rf:
                _rf.write(png_bytes)

        img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
        bbox = img.getbbox()

        if bbox:
            cropped = img.crop(bbox)

            # Debug dump: cropped image + info
            if _do_dump:
                cropped.save(os.path.join(
                    _dump_dir, f"frame_{frame_idx:04d}_cropped.png"))
                with open(os.path.join(
                        _dump_dir, f"frame_{frame_idx:04d}_info.txt"), 'w') as _inf:
                    _inf.write(f"Frame {frame_idx}\n")
                    _inf.write(f"Event: {event.start_ms}ms - {event.end_ms}ms\n")
                    _inf.write(f"Canvas: {render_width}x{render_height}\n")
                    _inf.write(f"Upscale: {upscale_factor:.2f}x\n")
                    _inf.write(f"BBox: {bbox}\n")
                    _inf.write(f"Cropped: {cropped.width}x{cropped.height}\n")
                    _inf.write(f"Content:\n")
                    _inf.write(f"  bottom: {repr(bottom[:100])}\n")
                    _inf.write(f"  top:    {repr(top[:100])}\n")
                    _inf.write(f"  romaji: {repr(romaji[:100])}\n")
                    _inf.write(f"  preserved: {repr(preserved[:100])}\n")
                _dump_count[0] += 1

            # Cache stores compressed PNG bytes at render resolution
            buf = io.BytesIO()
            cropped.save(buf, format='PNG')
            frame_cache[content_key] = (buf.getvalue(), bbox[0], bbox[1], cropped.width, cropped.height)
            del buf
            if _detail:
                _tu0 = _time.monotonic()
            result = _make_display_sets(cropped, bbox[0], bbox[1])
            if _detail:
                _tu1 = _time.monotonic()
                print(
                    f"[FRAME {frame_idx}] cache=MISS "
                    f"render={(_tr1-_tr0)*1000:.0f}ms "
                    f"regions={len(result)} "
                    f"upscale+split={(_tu1-_tu0)*1000:.0f}ms "
                    f"total={(_tu1-_t0)*1000:.0f}ms"
                )
            del img, png_bytes
            return result, content_key
        else:
            frame_cache[content_key] = None
            del img, png_bytes
            if _detail:
                print(
                    f"[FRAME {frame_idx}] cache=MISS (no bbox) "
                    f"render={(_tr1-_tr0)*1000:.0f}ms "
                    f"total={(_time.monotonic()-_t0)*1000:.0f}ms"
                )
            return [], content_key

    def _derive_region_keys(content_key, num_regions):
        """Derive per-region content keys from the full frame content key.

        For 2 regions: region 0 (top) = (top, romaji, preserved),
                       region 1 (bottom) = (bottom,).
        """
        if content_key is None or num_regions < 1:
            return None
        if num_regions == 1:
            return [content_key]
        bottom, top, romaji, preserved = content_key
        return [(top, romaji, preserved), (bottom,)]

    # ── Sequential path (num_workers=1) ──────────────────────────────

    async def _run_sequential():
        _log_memory("before browser launch")
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            ctx = await browser.new_context(
                viewport={'width': render_width, 'height': render_height},
            )
            page = await ctx.new_page()
            await page.set_content(page_html, wait_until='domcontentloaded')
            frame_el = page.locator('.frame')

            _log_memory("after browser launch (1 page)")

            frames_written = 0
            for i, event in enumerate(events):
                ds_list, content_key = await _render_frame(page, frame_el, event, i)

                if ds_list:
                    # Build region tuples for multi-object encoding
                    regions = [(ds.image, ds.x, ds.y) for ds in ds_list]
                    region_keys = _derive_region_keys(content_key, len(regions))
                    # Use first DS as the primary (timing/canvas), pass all as regions
                    writer.write(ds_list[0], extra_regions=regions,
                                 region_content_keys=region_keys)
                    frames_written += 1

                _frames_completed[0] = i + 1

                if progress_callback:
                    progress_callback(i + 1, total)

                # Progress line every 50 frames
                if (i + 1) % 50 == 0:
                    _elapsed = _time.monotonic() - _wall_start
                    _fps = (i + 1) / _elapsed if _elapsed > 0 else 0
                    _projected = total / _fps if _fps > 0 else 0
                    try:
                        import psutil as _ps
                        _rss = _ps.Process().memory_info().rss / (1024**2)
                        _avail = _ps.virtual_memory().available / (1024**2)
                    except Exception:
                        _rss = _avail = -1
                    print(
                        f"[PROGRESS] {i+1}/{total} frames in {_elapsed:.1f}s "
                        f"({_fps:.2f} fps), projected {_projected:.0f}s total, "
                        f"RSS={_rss:.0f}MB, avail={_avail:.0f}MB, "
                        f"cache_entries={len(frame_cache)}"
                    )

                # GC at batch boundaries
                if (i + 1) % batch_size == 0:
                    gc.collect()

            await page.close()
            await ctx.close()
            await browser.close()
            _log_memory("after browser close")

    # ── Parallel path (num_workers>1) ────────────────────────────────
    #
    # Architecture:
    #   Frame Queue (asyncio.Queue)
    #       ├──> Worker 0 (page 0) ──┐
    #       ├──> Worker 1 (page 1) ──┤──> Reorder Heap ──> Consumer ──> SupWriter
    #       └──> Worker 2 (page 2) ──┘
    #
    # Workers render frames and push (frame_index, result) into a min-heap.
    # The consumer drains the heap in strict index order and writes to SupWriter.
    # asyncio is single-threaded cooperative — no locks needed on frame_cache.

    async def _run_parallel():
        _log_memory("before browser launch")
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            # Create N pages on a single shared browser instance.
            # Each page at 1080p adds ~50-100MB incremental (vs ~200MB for
            # a separate browser).
            pages = []
            for _ in range(effective_workers):
                ctx = await browser.new_context(
                    viewport={'width': render_width, 'height': render_height},
                )
                page = await ctx.new_page()
                await page.set_content(page_html, wait_until='domcontentloaded')
                pages.append((ctx, page))

            _log_memory(f"after browser launch ({effective_workers} pages)")

            # Shared concurrency primitives
            queue: asyncio.Queue = asyncio.Queue()
            reorder_heap: list[tuple[int, ...]] = []   # min-heap of (frame_idx, seq, result)
            heap_seq = [0]          # tie-breaker for heapq (avoids comparing DisplaySets)
            heap_cond = asyncio.Condition()
            worker_error: list[BaseException | None] = [None]

            async def _worker(w_page, w_frame_el, worker_id):
                """Pull frames from queue, render, push results to reorder heap."""
                while True:
                    item = await queue.get()
                    if item is _SENTINEL:
                        queue.task_done()
                        break

                    frame_idx, event = item
                    try:
                        ds = await _render_frame(w_page, w_frame_el, event, frame_idx)
                    except Exception as exc:
                        # Push error into heap so consumer can detect it
                        async with heap_cond:
                            if worker_error[0] is None:
                                worker_error[0] = exc
                            s = heap_seq[0]; heap_seq[0] = s + 1
                            heapq.heappush(reorder_heap, (frame_idx, s, exc))
                            heap_cond.notify()
                        queue.task_done()
                        # Drain remaining queue items to unblock shutdown
                        while True:
                            drain_item = await queue.get()
                            queue.task_done()
                            if drain_item is _SENTINEL:
                                break
                        return

                    async with heap_cond:
                        s = heap_seq[0]; heap_seq[0] = s + 1
                        heapq.heappush(reorder_heap, (frame_idx, s, ds))
                        heap_cond.notify()
                    queue.task_done()

            async def _consumer():
                """Drain reorder heap in strict frame order → SupWriter."""
                next_expected = 0
                while next_expected < total:
                    async with heap_cond:
                        # Wait until the heap has our next expected frame
                        while (not reorder_heap
                               or reorder_heap[0][0] != next_expected):
                            if worker_error[0] is not None:
                                raise worker_error[0]
                            await heap_cond.wait()

                        _, _, result = heapq.heappop(reorder_heap)

                    # Check for error result
                    if isinstance(result, BaseException):
                        raise result

                    ds_list, content_key = result
                    if ds_list:
                        regions = [(ds.image, ds.x, ds.y) for ds in ds_list]
                        region_keys = _derive_region_keys(content_key, len(regions))
                        writer.write(ds_list[0], extra_regions=regions,
                                     region_content_keys=region_keys)

                    next_expected += 1
                    _frames_completed[0] = next_expected
                    if progress_callback:
                        progress_callback(next_expected, total)

                    # Progress line every 50 frames
                    if next_expected % 50 == 0:
                        _elapsed = _time.monotonic() - _wall_start
                        _fps = next_expected / _elapsed if _elapsed > 0 else 0
                        _projected = total / _fps if _fps > 0 else 0
                        try:
                            import psutil as _ps
                            _rss = _ps.Process().memory_info().rss / (1024**2)
                            _avail = _ps.virtual_memory().available / (1024**2)
                        except Exception:
                            _rss = _avail = -1
                        print(
                            f"[PROGRESS] {next_expected}/{total} frames in "
                            f"{_elapsed:.1f}s ({_fps:.2f} fps), "
                            f"projected {_projected:.0f}s total, "
                            f"RSS={_rss:.0f}MB, avail={_avail:.0f}MB, "
                            f"cache_entries={len(frame_cache)}"
                        )

                    # GC at batch boundaries
                    if next_expected % batch_size == 0:
                        gc.collect()

            # Enqueue all frames
            for i, event in enumerate(events):
                queue.put_nowait((i, event))
            # Sentinel for each worker
            for _ in range(effective_workers):
                queue.put_nowait(_SENTINEL)

            # Start workers and consumer as concurrent tasks
            worker_tasks = []
            for w_id, (w_ctx, w_page) in enumerate(pages):
                w_frame_el = w_page.locator('.frame')
                worker_tasks.append(
                    asyncio.create_task(_worker(w_page, w_frame_el, w_id))
                )
            consumer_task = asyncio.create_task(_consumer())

            # Wait for consumer to finish processing all frames
            consumer_error = None
            try:
                await consumer_task
            except Exception as e:
                consumer_error = e

            # Cancel remaining workers and wait for them to finish
            for wt in worker_tasks:
                wt.cancel()
            await asyncio.gather(*worker_tasks, return_exceptions=True)

            # Cleanup
            for w_ctx, w_page in pages:
                await w_page.close()
                await w_ctx.close()
            await browser.close()
            _log_memory("after browser close")

            if consumer_error is not None:
                raise consumer_error

    # ── Dispatch and run ─────────────────────────────────────────────

    _run_fn = _run_sequential if effective_workers <= 1 else _run_parallel

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        exc_holder = [None]
        def _thread_target():
            try:
                asyncio.run(_run_fn())
            except Exception as e:
                exc_holder[0] = e
        t = threading.Thread(target=_thread_target)
        t.start()
        t.join()
        if exc_holder[0]:
            raise exc_holder[0]
    else:
        asyncio.run(_run_fn())

    _wall_elapsed = _time.monotonic() - _wall_start
    print(
        f"[RASTERIZE DONE] {_wall_elapsed:.1f}s wall, "
        f"{cache_hits[0]} cache hits, {cache_misses[0]} misses, "
        f"{empty_skips[0]} empty skips, "
        f"{len(frame_cache)} unique frames cached"
    )

    writer.close()
    return writer.count
