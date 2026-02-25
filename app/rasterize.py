# app/rasterize.py
"""Rasterize subtitle frames to transparent PNGs via headless Chromium.

Uses Playwright to render full-frame subtitle composites (Bottom, Top with
<ruby> annotations, Romanized) at the target video resolution.  All enabled
layers are rendered into a single bitmap per event, producing PGS-ready
display sets.

4-worker parallelism: one Chromium browser, 4 browser contexts/pages, events
partitioned across workers via ThreadPoolExecutor.

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
    SupWriter, recycle Playwright pages every 100 frames.
"""

from __future__ import annotations

import asyncio
import io
import threading
from dataclasses import dataclass

from .sup_writer import DisplaySet


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
        Native language text (None if Bottom disabled or no overlap).
    top_html : str
        Target language text — <ruby> HTML if annotation enabled,
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

    page_html = _build_fullframe_html(styles, canvas_width, canvas_height, scale,
                                       annotation_render_mode=annotation_render_mode)

    total = len(events)
    results = [None] * total
    progress_counter = [0]

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

            await page.evaluate(_UPDATE_JS, [bottom, top, romaji, preserved])

            # Screenshot the full frame with transparent background
            png_bytes = await frame_el.screenshot(type='png', omit_background=True)

            img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
            bbox = img.getbbox()

            if bbox:
                cropped = img.crop(bbox)
                results[global_idx] = DisplaySet(
                    start_ms=event.start_ms,
                    end_ms=event.end_ms,
                    image=cropped,
                    x=bbox[0],
                    y=bbox[1],
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )

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
                    viewport={'width': canvas_width, 'height': canvas_height},
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

    # Filter out None entries (events with no visible content)
    return [ds for ds in results if ds is not None]


# ── Streaming rendering constants ────────────────────────────────────
_BATCH_SIZE = 50        # frames per SUP-write batch (bounds pending PIL images)


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
) -> int:
    """Render PGS frames and write to .sup file incrementally.

    Memory-bounded alternative to ``rasterize_pgs_frames()`` + ``write_sup()``.
    Processes events in batches of *batch_size*, writes each batch's display
    sets to disk immediately via ``SupWriter``, which releases PIL images after
    flushing.  Playwright pages are created once and reused for all frames.

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
        Number of frames per batch (default 50).

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

    page_html = _build_fullframe_html(styles, canvas_width, canvas_height, scale,
                                       annotation_render_mode=annotation_render_mode)

    total = len(events)
    progress_counter = [0]
    writer = SupWriter(output_path, canvas_width, canvas_height)

    _UPDATE_JS = '''(args) => {
        document.getElementById("bottom").innerHTML = args[0] || "";
        document.getElementById("top").innerHTML = args[1] || "";
        document.getElementById("romaji").innerHTML = args[2] || "";
        document.getElementById("preserved").innerHTML = args[3] || "";
    }'''

    async def _process_batch_chunk(page, chunk, batch_results):
        """Process a chunk of (batch_index, event) pairs on one page."""
        frame_el = page.locator('.frame')

        for batch_idx, event in chunk:
            bottom = (event.bottom_text or '').replace('\\N', '<br>').replace('\n', '<br>')
            top = (event.top_html or '').replace('\\N', '<br>').replace('\n', '<br>')
            romaji = (event.romaji_text or '').replace('\\N', '<br>').replace('\n', '<br>')
            preserved = event.preserved_html or ''

            await page.evaluate(_UPDATE_JS, [bottom, top, romaji, preserved])
            png_bytes = await frame_el.screenshot(type='png', omit_background=True)

            img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
            bbox = img.getbbox()

            if bbox:
                cropped = img.crop(bbox)
                batch_results[batch_idx] = DisplaySet(
                    start_ms=event.start_ms,
                    end_ms=event.end_ms,
                    image=cropped,
                    x=bbox[0],
                    y=bbox[1],
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
            # Release full-frame image immediately
            del img, png_bytes

            progress_counter[0] += 1
            if progress_callback:
                progress_callback(progress_counter[0], total)

    async def _create_pages(browser, n):
        """Create n fresh browser pages loaded with the template HTML."""
        pages = []
        for _ in range(n):
            ctx = await browser.new_context(
                viewport={'width': canvas_width, 'height': canvas_height},
            )
            page = await ctx.new_page()
            await page.set_content(page_html, wait_until='domcontentloaded')
            pages.append((ctx, page))
        return pages

    async def _close_pages(pages):
        """Close all pages and their contexts."""
        for ctx, page in pages:
            await page.close()
            await ctx.close()

    async def _run():
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            num_workers = min(4, total)
            pages = await _create_pages(browser, num_workers)

            for batch_start in range(0, total, batch_size):
                batch_end = min(batch_start + batch_size, total)
                batch_events = events[batch_start:batch_end]
                batch_len = len(batch_events)
                batch_results = [None] * batch_len

                # Partition batch events across workers
                active_workers = min(num_workers, batch_len)
                chunks = [[] for _ in range(active_workers)]
                for i, event in enumerate(batch_events):
                    chunks[i % active_workers].append((i, event))

                # Process batch concurrently
                tasks = []
                for w in range(active_workers):
                    if chunks[w]:
                        tasks.append(_process_batch_chunk(
                            pages[w][1], chunks[w], batch_results,
                        ))
                await asyncio.gather(*tasks)

                # Write visible results to SUP in chronological order
                # (SupWriter releases PIL images after flushing each to disk)
                for ds in batch_results:
                    if ds is not None:
                        writer.write(ds)

            await _close_pages(pages)
            await browser.close()

    # Run the async event loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
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

    writer.close()
    return writer.count
