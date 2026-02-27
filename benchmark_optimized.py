#!/usr/bin/env python3
"""Benchmark Phase 1 (frame dedup) + Phase 2 (1080p render + upscale).

Tests the actual rasterize_pgs_to_file() code path at 4K (787 frames)
and 1080p (200 frames) to compare against the original benchmark_memory.py
baseline which bypassed both optimizations.

Baseline (combined strategy, 4K):
    874.6s total, 1107ms mean, 993ms p50, 1771ms p95

Usage:
    python benchmark_optimized.py
"""

from __future__ import annotations

import gc
import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))

import psutil

from app.rasterize import PGSFrameEvent, rasterize_pgs_to_file
import pysubs2


# ── Reuse the same test data as benchmark_memory.py ──────────────────

RESOLUTIONS = {
    '1080p': (1920, 1080, 200, 1080 / 1080),
    '4k': (3840, 2160, 787, 2160 / 1080),
}


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
    """Generate synthetic subtitle events with representative content.

    Same 5-sample cycle as benchmark_memory.py — with 787 frames this
    produces 5 unique content strings, cycling 157× each + 2 extra.
    Phase 1 cache should yield (787 - 5) = 782 cache hits.
    """
    samples = [
        ('Hello, world!', '<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>テスト', 'kanji tesuto'),
        ('This is a longer subtitle line with more text', '<ruby>食<rt>た</rt></ruby>べ<ruby>物<rt>もの</rt></ruby>を<ruby>買<rt>か</rt></ruby>いました', 'tabemono wo kaimashita'),
        ('What are you doing?', '<ruby>何<rt>なに</rt></ruby>をしていますか？', 'nani wo shiteimasu ka?'),
        ('The quick brown fox', '<ruby>速<rt>はや</rt></ruby>い<ruby>茶色<rt>ちゃいろ</rt></ruby>の<ruby>狐<rt>きつね</rt></ruby>', 'hayai chairo no kitsune'),
        ('Multiple lines\\NSecond line here', '<ruby>一<rt>いち</rt></ruby><ruby>行<rt>ぎょう</rt></ruby><ruby>目<rt>め</rt></ruby>\\N<ruby>二<rt>に</rt></ruby><ruby>行<rt>ぎょう</rt></ruby><ruby>目<rt>め</rt></ruby>', 'ichigyoume\\nigyoume'),
    ]

    events = []
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

def run_benchmark(res_name: str) -> dict:
    """Run a single benchmark via rasterize_pgs_to_file().

    Uses the real optimized code path (Phase 1 cache + Phase 2 upscale).
    """
    import logging
    logging.basicConfig(
        level=logging.INFO,
        format='  %(name)s - %(levelname)s - %(message)s',
    )

    cw, ch, n_frames, scale = RESOLUTIONS[res_name]
    events = _generate_events(n_frames)
    styles = _make_styles()

    sup_fd = tempfile.NamedTemporaryFile(delete=False, suffix='.sup')
    sup_path = sup_fd.name
    sup_fd.close()

    # Track per-frame progress timestamps for timing analysis
    frame_timestamps = []

    def _progress_cb(completed, total):
        frame_timestamps.append(time.monotonic())

    print(f"\n{'='*60}")
    print(f"Resolution: {res_name} ({cw}x{ch}), {n_frames} frames, scale={scale:.2f}")
    print(f"{'='*60}")
    print(f"  Calling rasterize_pgs_to_file(canvas_width={cw}, "
          f"canvas_height={ch}, scale={scale})")

    # Measure peak memory via polling in the progress callback
    proc = psutil.Process(os.getpid())
    peak_rss_mb = [proc.memory_info().rss / (1024**2)]

    def _progress_with_mem(completed, total):
        frame_timestamps.append(time.monotonic())
        if completed % 50 == 0 or completed == total:
            rss = proc.memory_info().rss / (1024**2)
            if rss > peak_rss_mb[0]:
                peak_rss_mb[0] = rss
            elapsed = time.monotonic() - wall_start
            print(f"  [{res_name}] Frame {completed}/{total} "
                  f"(RSS={rss:.0f}MB, elapsed={elapsed:.1f}s)",
                  flush=True)

    wall_start = time.monotonic()

    count = rasterize_pgs_to_file(
        events,
        styles=styles,
        canvas_width=cw,
        canvas_height=ch,
        output_path=sup_path,
        scale=scale,
        progress_callback=_progress_with_mem,
    )

    wall_end = time.monotonic()
    total_time = wall_end - wall_start

    # Compute per-frame times from timestamps
    frame_times_ms = []
    if len(frame_timestamps) > 1:
        # First frame: wall_start → first timestamp
        frame_times_ms.append((frame_timestamps[0] - wall_start) * 1000)
        for i in range(1, len(frame_timestamps)):
            frame_times_ms.append(
                (frame_timestamps[i] - frame_timestamps[i - 1]) * 1000
            )

    # Stats
    if frame_times_ms:
        sorted_ft = sorted(frame_times_ms)
        n = len(sorted_ft)
        mean_ms = statistics.mean(sorted_ft)
        p50 = sorted_ft[n // 2]
        p95 = sorted_ft[int(n * 0.95)]
        p99 = sorted_ft[int(n * 0.99)]
    else:
        mean_ms = p50 = p95 = p99 = 0.0

    # Check output file size (don't parse — 787 4K bitmaps will OOM)
    sup_size = os.path.getsize(sup_path) if os.path.exists(sup_path) else 0

    # Cleanup
    try:
        os.unlink(sup_path)
    except OSError:
        pass

    result = {
        'resolution': res_name,
        'canvas': f'{cw}x{ch}',
        'total_frames': n_frames,
        'ds_written': count,
        'total_time_s': total_time,
        'mean_frame_ms': mean_ms,
        'p50_frame_ms': p50,
        'p95_frame_ms': p95,
        'p99_frame_ms': p99,
        'peak_python_rss_mb': peak_rss_mb[0],
        'sup_file_size_mb': sup_size / (1024**2),
    }

    print(f"\n--- Results ({res_name}) ---")
    print(f"  Total time:       {total_time:.1f}s")
    print(f"  DS written:       {count}/{n_frames}")
    print(f"  Mean frame time:  {mean_ms:.1f}ms")
    print(f"  P50 frame time:   {p50:.1f}ms")
    print(f"  P95 frame time:   {p95:.1f}ms")
    print(f"  P99 frame time:   {p99:.1f}ms")
    print(f"  Peak Python RSS:  {peak_rss_mb[0]:.0f}MB")
    print(f"  SUP file size:    {sup_size / (1024**2):.1f}MB")
    sys.stdout.flush()

    return result


# ── Main ─────────────────────────────────────────────────────────────

def main():
    print("Benchmark: Phase 1 (frame dedup cache) + Phase 2 (1080p render + upscale)")
    print("Using rasterize_pgs_to_file() — the actual optimized code path")
    print()

    results = {}

    # Run 4K first (the key comparison)
    results['4k'] = run_benchmark('4k')
    gc.collect()

    # Run 1080p for reference
    results['1080p'] = run_benchmark('1080p')

    # Comparison table
    print(f"\n{'='*80}")
    print("COMPARISON: Optimized vs Baseline")
    print(f"{'='*80}")
    print()
    print("4K (787 frames):")
    r = results['4k']
    print(f"  {'Metric':<20} {'Baseline':<15} {'Optimized':<15} {'Speedup'}")
    print(f"  {'-'*65}")
    print(f"  {'Total time (s)':<20} {'874.6':<15} {r['total_time_s']:<15.1f} "
          f"{874.6 / r['total_time_s']:.1f}x" if r['total_time_s'] > 0 else "")
    print(f"  {'Mean frame (ms)':<20} {'1107':<15} {r['mean_frame_ms']:<15.1f} "
          f"{1107 / r['mean_frame_ms']:.1f}x" if r['mean_frame_ms'] > 0 else "")
    print(f"  {'P50 (ms)':<20} {'993':<15} {r['p50_frame_ms']:<15.1f}")
    print(f"  {'P95 (ms)':<20} {'1771':<15} {r['p95_frame_ms']:<15.1f}")
    print()

    if '1080p' in results:
        r2 = results['1080p']
        print("1080p (200 frames) — reference, no upscale path:")
        print(f"  Total time: {r2['total_time_s']:.1f}s, "
              f"Mean: {r2['mean_frame_ms']:.1f}ms, "
              f"P50: {r2['p50_frame_ms']:.1f}ms")

    print()
    print("Interpretation:")
    print("  If Phase 2 is WORKING:  4K mean ~50-150ms (render at 1080p + upscale)")
    print("  If Phase 2 is BROKEN:   4K mean ~1100ms (rendering at native 4K)")
    print("  Phase 1 cache with 5 unique samples / 787 frames: expect ~782 hits")


if __name__ == '__main__':
    main()
