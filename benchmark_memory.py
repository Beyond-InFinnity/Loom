#!/usr/bin/env python3
"""Benchmark PGS memory management strategies.

Tests 6 strategies at 720p (200 frames) and 4K (787 frames), measuring:
- Total wall-clock time
- Peak memory (Python RSS + Playwright child tree RSS)
- Page recycle count
- Per-frame render time: mean, p50, p95, p99
- Completion status

Usage:
    python benchmark_memory.py [--strategy STRATEGY] [--resolution RES]

Without args, runs all strategies × both resolutions.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import gc
import io
import json
import os
import statistics
import sys
import time
import threading
import traceback

sys.path.insert(0, os.path.dirname(__file__))

import psutil

from app.memory_manager import PlaywrightMemoryManager, StrategyName, get_browser_pid
from app.rasterize import (
    PGSFrameEvent,
    _build_fullframe_html,
    _color_css,
    _build_text_shadow_css,
)
from app.sup_writer import DisplaySet, SupWriter
import pysubs2

# ── Test configurations ──────────────────────────────────────────────

RESOLUTIONS = {
    '720p': (1280, 720, 200, 720 / 1080),
    '4k': (3840, 2160, 787, 2160 / 1080),
}

STRATEGIES: list[StrategyName] = [
    'fixed_100', 'fixed_500',
    'child_rss', 'system_avail',
    'render_time', 'combined',
]


def _make_styles():
    """Build a minimal styles dict matching the app's structure."""
    return {
        'Bottom': {
            'enabled': True,
            'fontname': 'Arial',
            'fontsize': 48,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 3.0, 'shadow': 1.5,
            'alignment': 2, 'marginv': 30,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'Top': {
            'enabled': True,
            'fontname': 'Noto Sans CJK JP',
            'fontsize': 52,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 2.5, 'shadow': 1.5,
            'alignment': 8, 'marginv': 90,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'Romanized': {
            'enabled': True,
            'fontname': 'Arial',
            'fontsize': 30,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(200, 200, 200, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 1.5, 'shadow': 1.5,
            'alignment': 8, 'marginv': 10,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'Annotation': {
            'enabled': True,
            'fontname': 'Noto Sans CJK JP',
            'fontsize': 22,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 1.0, 'shadow': 1.5,
            'alignment': 8, 'marginv': 10,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'vertical_offset': 0,
        'romanized_gap': 0,
        'annotation_gap': 2,
    }


def _generate_events(n_frames: int) -> list[PGSFrameEvent]:
    """Generate synthetic subtitle events with representative content."""
    events = []
    # Cycle through different text complexities to simulate real subtitles
    samples = [
        ('Hello, world!', '<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>テスト', 'kanji tesuto'),
        ('This is a longer subtitle line with more text', '<ruby>食<rt>た</rt></ruby>べ<ruby>物<rt>もの</rt></ruby>を<ruby>買<rt>か</rt></ruby>いました', 'tabemono wo kaimashita'),
        ('What are you doing?', '<ruby>何<rt>なに</rt></ruby>をしていますか？', 'nani wo shiteimasu ka?'),
        ('The quick brown fox', '<ruby>速<rt>はや</rt></ruby>い<ruby>茶色<rt>ちゃいろ</rt></ruby>の<ruby>狐<rt>きつね</rt></ruby>', 'hayai chairo no kitsune'),
        ('Multiple lines\\NSecond line here', '<ruby>一<rt>いち</rt></ruby><ruby>行<rt>ぎょう</rt></ruby><ruby>目<rt>め</rt></ruby>\\N<ruby>二<rt>に</rt></ruby><ruby>行<rt>ぎょう</rt></ruby><ruby>目<rt>め</rt></ruby>', 'ichigyoume\\nigyoume'),
    ]

    for i in range(n_frames):
        bottom, top, romaji = samples[i % len(samples)]
        events.append(PGSFrameEvent(
            start_ms=i * 3000,
            end_ms=i * 3000 + 2500,
            bottom_text=bottom,
            top_html=top,
            romaji_text=romaji,
        ))
    return events


# ── Benchmark runner ─────────────────────────────────────────────────

def run_benchmark(
    strategy: StrategyName,
    resolution: str,
    events: list[PGSFrameEvent],
    canvas_width: int,
    canvas_height: int,
    scale: float,
    timeout_seconds: int = 600,
) -> dict:
    """Run a single benchmark: one strategy × one resolution.

    Returns a dict with all metrics.
    """
    from PIL import Image

    styles = _make_styles()
    page_html = _build_fullframe_html(styles, canvas_width, canvas_height, scale)
    total = len(events)

    result = {
        'strategy': strategy,
        'resolution': resolution,
        'canvas': f'{canvas_width}x{canvas_height}',
        'total_frames': total,
        'completed_frames': 0,
        'completed': False,
        'crashed': False,
        'crash_reason': '',
        'total_time_s': 0.0,
        'peak_python_rss_mb': 0.0,
        'peak_child_rss_mb': 0.0,
        'peak_combined_rss_mb': 0.0,
        'recycle_count': 0,
        'frame_times': [],
        'mean_frame_ms': 0.0,
        'p50_frame_ms': 0.0,
        'p95_frame_ms': 0.0,
        'p99_frame_ms': 0.0,
    }

    # Strategy-specific child_rss thresholds
    child_rss_kwargs = {}
    if strategy == 'child_rss':
        # Test at 2GB threshold (primary test)
        child_rss_kwargs['child_rss_threshold'] = 2 * 1024**3

    _UPDATE_JS = '''(args) => {
        document.getElementById("bottom").innerHTML = args[0] || "";
        document.getElementById("top").innerHTML = args[1] || "";
        document.getElementById("romaji").innerHTML = args[2] || "";
        document.getElementById("preserved").innerHTML = args[3] || "";
    }'''

    import tempfile
    sup_path = tempfile.mktemp(suffix='.sup')

    async def _run():
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            browser_pid = get_browser_pid(browser)

            mgr = PlaywrightMemoryManager(
                strategy=strategy,
                browser_pid=browser_pid,
                **child_rss_kwargs,
            )

            # Create single page (sequential, not parallel — isolates memory behavior)
            ctx = await browser.new_context(
                viewport={'width': canvas_width, 'height': canvas_height},
            )
            page = await ctx.new_page()
            await page.set_content(page_html, wait_until='domcontentloaded')
            frame_el = page.locator('.frame')

            writer = SupWriter(sup_path, canvas_width, canvas_height)
            frame_times = []

            try:
                for i, event in enumerate(events):
                    t0 = time.monotonic()

                    bottom = (event.bottom_text or '').replace('\\N', '<br>').replace('\n', '<br>')
                    top = (event.top_html or '').replace('\\N', '<br>').replace('\n', '<br>')
                    romaji = (event.romaji_text or '').replace('\\N', '<br>').replace('\n', '<br>')

                    await page.evaluate(_UPDATE_JS, [bottom, top, romaji, ''])
                    png_bytes = await frame_el.screenshot(type='png', omit_background=True)

                    img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
                    bbox = img.getbbox()
                    if bbox:
                        cropped = img.crop(bbox)
                        ds = DisplaySet(
                            start_ms=event.start_ms,
                            end_ms=event.end_ms,
                            image=cropped,
                            x=bbox[0], y=bbox[1],
                            canvas_width=canvas_width,
                            canvas_height=canvas_height,
                        )
                        writer.write(ds)
                    del img, png_bytes

                    elapsed = time.monotonic() - t0
                    frame_times.append(elapsed)

                    decision = mgr.should_recycle(frame_index=i, render_time=elapsed)
                    if decision.recycle:
                        # Recycle: close page+context, reopen
                        await page.close()
                        await ctx.close()
                        ctx = await browser.new_context(
                            viewport={'width': canvas_width, 'height': canvas_height},
                        )
                        page = await ctx.new_page()
                        await page.set_content(page_html, wait_until='domcontentloaded')
                        frame_el = page.locator('.frame')
                        mgr.notify_recycled()
                    if decision.do_gc:
                        gc.collect()

                    result['completed_frames'] = i + 1

                    # Progress
                    if (i + 1) % 50 == 0 or i == total - 1:
                        mem = psutil.Process(os.getpid()).memory_info().rss / (1024**2)
                        print(f'  [{strategy}/{resolution}] Frame {i+1}/{total} '
                              f'({elapsed*1000:.0f}ms, RSS={mem:.0f}MB, '
                              f'recycles={mgr.recycle_count})')

                result['completed'] = True

            except Exception as e:
                result['crashed'] = True
                result['crash_reason'] = str(e)
                print(f'  [{strategy}/{resolution}] CRASHED at frame '
                      f'{result["completed_frames"]}: {e}')

            finally:
                writer.close()
                result['frame_times'] = frame_times
                result['recycle_count'] = mgr.recycle_count
                result['peak_child_rss_mb'] = mgr.peak_child_rss_bytes / (1024**2)
                result['peak_python_rss_mb'] = mgr.peak_python_rss_bytes / (1024**2)
                result['peak_combined_rss_mb'] = (
                    result['peak_child_rss_mb'] + result['peak_python_rss_mb']
                )

                await page.close()
                await ctx.close()
                await browser.close()

        # Clean up temp file
        try:
            os.unlink(sup_path)
        except OSError:
            pass

    wall_start = time.monotonic()

    # Run async in a thread (same pattern as rasterize.py)
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
        t.join(timeout=timeout_seconds)
        if t.is_alive():
            result['crashed'] = True
            result['crash_reason'] = f'Timeout after {timeout_seconds}s'
        elif exc_holder[0]:
            result['crashed'] = True
            result['crash_reason'] = str(exc_holder[0])
    else:
        try:
            asyncio.run(_run())
        except Exception as e:
            result['crashed'] = True
            result['crash_reason'] = str(e)

    result['total_time_s'] = time.monotonic() - wall_start

    # Compute percentiles from frame times
    ft = result['frame_times']
    if ft:
        ft_ms = [t * 1000 for t in ft]
        result['mean_frame_ms'] = statistics.mean(ft_ms)
        sorted_ft = sorted(ft_ms)
        n = len(sorted_ft)
        result['p50_frame_ms'] = sorted_ft[n // 2]
        result['p95_frame_ms'] = sorted_ft[int(n * 0.95)]
        result['p99_frame_ms'] = sorted_ft[int(n * 0.99)]

    # Don't serialize the raw frame times in the summary (too big)
    result.pop('frame_times', None)

    return result


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Benchmark PGS memory strategies')
    parser.add_argument('--strategy', choices=STRATEGIES, default=None,
                        help='Run only this strategy (default: all)')
    parser.add_argument('--resolution', choices=list(RESOLUTIONS.keys()), default=None,
                        help='Run only this resolution (default: all)')
    parser.add_argument('--output', default='/home/connor/benchmark_results.json',
                        help='Path to write JSON results')
    args = parser.parse_args()

    strategies = [args.strategy] if args.strategy else STRATEGIES
    resolutions = [args.resolution] if args.resolution else list(RESOLUTIONS.keys())

    all_results = []

    for res_name in resolutions:
        cw, ch, n_frames, scale = RESOLUTIONS[res_name]
        events = _generate_events(n_frames)
        print(f'\n{"="*60}')
        print(f'Resolution: {res_name} ({cw}x{ch}), {n_frames} frames, scale={scale:.2f}')
        print(f'{"="*60}')

        for strat in strategies:
            print(f'\n--- Strategy: {strat} ---')
            result = run_benchmark(
                strategy=strat,
                resolution=res_name,
                events=events,
                canvas_width=cw,
                canvas_height=ch,
                scale=scale,
            )
            all_results.append(result)

            status = 'PASS' if result['completed'] else 'FAIL'
            print(f'  Result: {status} | Time: {result["total_time_s"]:.1f}s | '
                  f'Peak mem: {result["peak_combined_rss_mb"]:.0f}MB | '
                  f'Recycles: {result["recycle_count"]} | '
                  f'Mean frame: {result["mean_frame_ms"]:.1f}ms')

            # Force GC between strategies to get cleaner measurements
            gc.collect()

    # Write results
    with open(args.output, 'w') as f:
        json.dump(all_results, f, indent=2)
    print(f'\nResults written to {args.output}')

    # Print summary table
    print(f'\n{"="*100}')
    print('SUMMARY TABLE')
    print(f'{"="*100}')
    header = f'{"Strategy":<15} {"Res":<5} {"Status":<8} {"Time(s)":<9} {"PeakMem(MB)":<13} {"Recycles":<10} {"Mean(ms)":<10} {"P50(ms)":<10} {"P95(ms)":<10} {"P99(ms)":<10}'
    print(header)
    print('-' * len(header))
    for r in all_results:
        status = 'PASS' if r['completed'] else f'FAIL@{r["completed_frames"]}'
        print(f'{r["strategy"]:<15} {r["resolution"]:<5} {status:<8} '
              f'{r["total_time_s"]:<9.1f} {r["peak_combined_rss_mb"]:<13.0f} '
              f'{r["recycle_count"]:<10} {r["mean_frame_ms"]:<10.1f} '
              f'{r["p50_frame_ms"]:<10.1f} {r["p95_frame_ms"]:<10.1f} '
              f'{r["p99_frame_ms"]:<10.1f}')


if __name__ == '__main__':
    main()
