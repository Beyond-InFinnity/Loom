"""Smoke tests for rasterize.py — Playwright-based full-frame subtitle rasterizer.

Tests that the rasterizer produces DisplaySets with correct properties
from PGSFrameEvent input.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pysubs2
from app.rasterize import (
    PGSFrameEvent, rasterize_pgs_frames, is_playwright_available,
)
from app.sup_writer import write_sup
from app.ocr import _parse_sup


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
            'long_vowel_mode': 'macrons',
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
    }


def test_is_playwright_available():
    assert is_playwright_available(), "Playwright should be available after install"
    print("  [PASS] is_playwright_available()")


def test_rasterize_single_frame():
    """Rasterize a single full-frame subtitle event with all layers."""
    events = [PGSFrameEvent(
        start_ms=1000,
        end_ms=3000,
        bottom_text="Hello, world!",
        top_html='<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>テスト',
        romaji_text="kanji tesuto",
    )]

    styles = _make_styles()
    display_sets = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
    )

    assert len(display_sets) == 1, f"Expected 1 display set, got {len(display_sets)}"
    ds = display_sets[0]
    assert ds.start_ms == 1000
    assert ds.end_ms == 3000
    assert ds.canvas_width == 1920
    assert ds.canvas_height == 1080
    assert ds.image.mode == 'RGBA'
    assert ds.image.width > 0
    assert ds.image.height > 0
    print(f"  [PASS] Rasterize single frame (image: {ds.image.size}, pos=({ds.x},{ds.y}))")


def test_rasterize_multiple_events():
    """Rasterize multiple events, verify all produce display sets."""
    events = []
    for i in range(5):
        events.append(PGSFrameEvent(
            start_ms=i * 2000,
            end_ms=i * 2000 + 1500,
            bottom_text=f"Line {i}",
            top_html=f'<ruby>字<rt>じ</rt></ruby> line {i}',
            romaji_text=f"ji line {i}",
        ))

    styles = _make_styles()
    display_sets = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
    )

    assert len(display_sets) == 5, f"Expected 5, got {len(display_sets)}"
    for i, ds in enumerate(display_sets):
        assert ds.start_ms == i * 2000
        assert ds.end_ms == i * 2000 + 1500
    print(f"  [PASS] Rasterize multiple events ({len(display_sets)} display sets)")


def test_rasterize_empty_text_skipped():
    """Events with no visible text should produce no display sets."""
    events = [PGSFrameEvent(
        start_ms=0, end_ms=1000,
        bottom_text=None,
        top_html='',
        romaji_text=None,
    )]

    styles = _make_styles()
    display_sets = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
    )

    assert len(display_sets) == 0, f"Expected 0 (empty event), got {len(display_sets)}"
    print("  [PASS] Empty text skipped")


def test_progress_callback():
    """Progress callback is called with correct counts."""
    events = [
        PGSFrameEvent(start_ms=0, end_ms=1000,
                       bottom_text="A", top_html="B", romaji_text="C"),
        PGSFrameEvent(start_ms=1000, end_ms=2000,
                       bottom_text="D", top_html="E", romaji_text="F"),
    ]

    progress_log = []
    def on_progress(completed, total):
        progress_log.append((completed, total))

    styles = _make_styles()
    rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
        progress_callback=on_progress,
    )

    assert len(progress_log) == 2
    assert progress_log[-1] == (2, 2)
    print("  [PASS] Progress callback")


def test_full_pipeline_rasterize_to_sup():
    """Full pipeline: rasterize → write_sup → parse_sup → verify."""
    events = [PGSFrameEvent(
        start_ms=2000,
        end_ms=5000,
        bottom_text="Hello",
        top_html='<ruby>食<rt>た</rt></ruby>べる',
        romaji_text="taberu",
    )]

    styles = _make_styles()
    display_sets = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
    )

    assert len(display_sets) == 1

    # Write to .sup
    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup(display_sets, tmp_path)

        # Read back
        results = _parse_sup(tmp_path)
        assert len(results) >= 1, f"Expected >=1 from parse, got {len(results)}"

        start_ms, end_ms, img = results[0]
        assert start_ms == 2000, f"Start: expected 2000, got {start_ms}"
        assert img.size[0] > 0 and img.size[1] > 0, "Image should have content"

        print(f"  [PASS] Full pipeline: rasterize -> SUP -> parse (image: {img.size})")
    finally:
        os.unlink(tmp_path)


def test_scaled_output():
    """Test rasterization at 2x scale (simulating 2160p output)."""
    events = [PGSFrameEvent(
        start_ms=0, end_ms=1000,
        bottom_text="Test",
        top_html='<ruby>字<rt>じ</rt></ruby>',
        romaji_text="ji",
    )]

    styles = _make_styles()

    ds_1x = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=1920,
        canvas_height=1080,
        scale=1.0,
    )

    ds_2x = rasterize_pgs_frames(
        events,
        styles=styles,
        canvas_width=3840,
        canvas_height=2160,
        scale=2.0,
    )

    assert len(ds_1x) == 1 and len(ds_2x) == 1
    # 2x image should be roughly 2x the dimensions
    ratio_w = ds_2x[0].image.width / ds_1x[0].image.width
    ratio_h = ds_2x[0].image.height / ds_1x[0].image.height
    assert 1.5 < ratio_w < 2.5, f"Width ratio: {ratio_w:.2f}"
    assert 1.5 < ratio_h < 2.5, f"Height ratio: {ratio_h:.2f}"
    print(f"  [PASS] Scaled output: 1x={ds_1x[0].image.size}, 2x={ds_2x[0].image.size}")


def test_4k_renders_at_1080p_and_upscales():
    """4K target renders at reduced viewport and upscales — including non-16:9."""
    events = [PGSFrameEvent(
        start_ms=0, end_ms=1000,
        bottom_text="Test",
        top_html='<ruby>字<rt>じ</rt></ruby>',
        romaji_text="ji",
    )]

    styles = _make_styles()

    # --- Standard 16:9 (3840×2160) ---
    ds_1080 = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=1920, canvas_height=1080, scale=1.0,
    )
    ds_4k = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=3840, canvas_height=2160, scale=2.0,
    )

    assert len(ds_1080) == 1 and len(ds_4k) == 1
    s1, s4 = ds_1080[0], ds_4k[0]

    assert s4.canvas_width == 3840
    assert s4.canvas_height == 2160
    assert abs(s4.image.width - s1.image.width * 2) <= 1
    assert abs(s4.image.height - s1.image.height * 2) <= 1

    # --- Cinematic aspect ratio (3840×2064, like GitS) ---
    # render_height should be round(2064 * 1920 / 3840) = 1032, not 1080
    ds_cine = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=3840, canvas_height=2064, scale=2064 / 1080,
    )

    assert len(ds_cine) == 1
    sc = ds_cine[0]

    assert sc.canvas_width == 3840
    assert sc.canvas_height == 2064

    # Bitmap must fit within the cinematic canvas
    assert sc.x + sc.image.width <= 3840, (
        f"bitmap overflows x: x={sc.x}, w={sc.image.width}")
    assert sc.y + sc.image.height <= 2064, (
        f"bitmap overflows y: y={sc.y}, h={sc.image.height}")

    # Dimensions should be 2x the equivalent 1920×1032 render (within rounding).
    # Phase 2 renders at render_scale=1.0 (full 1080p font sizes), so the
    # reference must also use scale=1.0 to produce matching CSS layout.
    ds_1032 = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=1920, canvas_height=1032, scale=1.0,
    )
    assert len(ds_1032) == 1
    sr = ds_1032[0]
    assert abs(sc.image.width - sr.image.width * 2) <= 1, (
        f"cine width: render={sr.image.width}, upscaled={sc.image.width}")
    assert abs(sc.image.height - sr.image.height * 2) <= 1, (
        f"cine height: render={sr.image.height}, upscaled={sc.image.height}")

    print(f"  [PASS] 4K renders at 1080p and upscales "
          f"(16:9={s4.image.size}, cine={sc.image.size}, "
          f"render@1032={sr.image.size})")


def test_4k_coordinates_scale_proportionally():
    """Scaled x/y coordinates are proportional between 1080p and 4K."""
    events = [PGSFrameEvent(
        start_ms=0, end_ms=1000,
        bottom_text="Subtitle at bottom",
        top_html='<ruby>上<rt>うえ</rt></ruby>のテキスト',
        romaji_text="ue no tekisuto",
    )]

    styles = _make_styles()

    ds_1080 = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=1920, canvas_height=1080, scale=1.0,
    )
    ds_4k = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=3840, canvas_height=2160, scale=2.0,
    )

    assert len(ds_1080) == 1 and len(ds_4k) == 1
    s1, s4 = ds_1080[0], ds_4k[0]

    # x/y should be 2x (within rounding tolerance of 1px)
    assert abs(s4.x - round(s1.x * 2)) <= 1, f"x: 1080p={s1.x}, 4K={s4.x}"
    assert abs(s4.y - round(s1.y * 2)) <= 1, f"y: 1080p={s1.y}, 4K={s4.y}"

    print(f"  [PASS] 4K coordinates scale proportionally "
          f"(1080p=({s1.x},{s1.y}), 4K=({s4.x},{s4.y}))")


def test_720p_no_upscale():
    """720p target renders natively — no upscale path activated."""
    events = [PGSFrameEvent(
        start_ms=0, end_ms=1000,
        bottom_text="Test",
        top_html="テスト",
        romaji_text="tesuto",
    )]

    styles = _make_styles()
    ds = rasterize_pgs_frames(
        events, styles=styles,
        canvas_width=1280, canvas_height=720, scale=720/1080,
    )

    assert len(ds) == 1
    assert ds[0].canvas_width == 1280
    assert ds[0].canvas_height == 720
    # Image must fit within 720p canvas
    assert ds[0].image.width <= 1280
    assert ds[0].image.height <= 720
    assert ds[0].x + ds[0].image.width <= 1280
    assert ds[0].y + ds[0].image.height <= 720

    print(f"  [PASS] 720p renders natively (image={ds[0].image.size})")


if __name__ == '__main__':
    print("Running rasterizer tests...\n")
    test_is_playwright_available()
    test_rasterize_single_frame()
    test_rasterize_multiple_events()
    test_rasterize_empty_text_skipped()
    test_progress_callback()
    test_full_pipeline_rasterize_to_sup()
    test_scaled_output()
    test_4k_renders_at_1080p_and_upscales()
    test_4k_coordinates_scale_proportionally()
    test_720p_no_upscale()
    print("\nAll tests passed!")
