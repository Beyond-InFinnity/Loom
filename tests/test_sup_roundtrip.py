"""Round-trip tests for sup_writer.py ↔ ocr.py _parse_sup().

Generates DisplaySets with known images, writes to .sup via sup_writer,
reads back with _parse_sup(), and verifies timing, dimensions, and pixel data.
"""

import os
import sys
import tempfile

# Add project root to path so we can import app modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from PIL import Image
import numpy as np
from app.sup_writer import (
    DisplaySet, write_sup, SupWriter, _encode_rle, _encode_rle_python,
    _rgb_to_ycbcr, _quantize_image, split_regions, _build_show_segments,
    _ALPHA_CLAMP_THRESHOLD,
)
from app.ocr import _parse_sup, _decode_rle, _ycbcr_to_rgb


def test_rle_roundtrip_simple():
    """Encode a simple palette-indexed row, decode it, compare."""
    width, height = 10, 3
    # Row 0: 5 transparent, 5 color-1
    # Row 1: all color-2
    # Row 2: alternating color-1 / color-3
    indices = (
        [0, 0, 0, 0, 0, 1, 1, 1, 1, 1] +
        [2] * 10 +
        [1, 3, 1, 3, 1, 3, 1, 3, 1, 3]
    )
    encoded = _encode_rle(indices, width, height)
    decoded = _decode_rle(encoded, width, height)
    assert decoded == indices, f"RLE roundtrip failed:\n  expected {indices}\n  got      {decoded}"
    print("  [PASS] RLE roundtrip (simple)")


def test_rle_roundtrip_long_runs():
    """Test runs longer than 63 pixels (triggers extended encoding)."""
    width = 200
    height = 2
    # Row 0: 200 transparent pixels (tests extended transparent run)
    # Row 1: 200 pixels of color 5 (tests extended color run)
    indices = [0] * width + [5] * width
    encoded = _encode_rle(indices, width, height)
    decoded = _decode_rle(encoded, width, height)
    assert decoded == indices, "RLE roundtrip failed for long runs"
    print("  [PASS] RLE roundtrip (long runs)")


def test_rle_roundtrip_single_pixels():
    """Test single non-zero pixels (direct byte encoding)."""
    width, height = 5, 1
    indices = [1, 2, 3, 4, 5]
    encoded = _encode_rle(indices, width, height)
    decoded = _decode_rle(encoded, width, height)
    assert decoded == indices, f"RLE roundtrip failed for singles:\n  {indices}\n  {decoded}"
    print("  [PASS] RLE roundtrip (single pixels)")


def test_ycbcr_roundtrip():
    """Convert RGB → YCbCr → RGB, verify colors within ±2."""
    test_colors = [
        (255, 0, 0),      # red
        (0, 255, 0),      # green
        (0, 0, 255),      # blue
        (255, 255, 255),  # white
        (0, 0, 0),        # black
        (128, 128, 128),  # gray
        (255, 255, 0),    # yellow
        (64, 192, 128),   # teal-ish
    ]
    for r, g, b in test_colors:
        y, cb, cr = _rgb_to_ycbcr(r, g, b)
        r2, g2, b2 = _ycbcr_to_rgb(y, cb, cr)
        for orig, conv, ch in [(r, r2, 'R'), (g, g2, 'G'), (b, b2, 'B')]:
            assert abs(orig - conv) <= 2, (
                f"YCbCr roundtrip drift for ({r},{g},{b}) ch={ch}: "
                f"{orig} → {conv} (delta {abs(orig-conv)})"
            )
    print("  [PASS] YCbCr roundtrip (all colors within ±2)")


def test_sup_roundtrip_solid_rect():
    """Write a solid-color rectangle, read back, verify timing and dimensions."""
    # Create a 40×20 solid red rectangle with full opacity
    img = Image.new('RGBA', (40, 20), (255, 0, 0, 255))
    ds = DisplaySet(
        start_ms=1000,
        end_ms=3000,
        image=img,
        x=100,
        y=200,
        canvas_width=1920,
        canvas_height=1080,
    )

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup([ds], tmp_path)
        results = _parse_sup(tmp_path)

        assert len(results) >= 1, f"Expected ≥1 display set, got {len(results)}"
        start_ms, end_ms, result_img = results[0]

        # Timing: PTS is stored as ms = pts // 90, so 1000ms → pts=90000 → 90000//90=1000
        assert start_ms == 1000, f"Start time: expected 1000, got {start_ms}"

        # Dimensions
        assert result_img.size == (40, 20), f"Image size: expected (40,20), got {result_img.size}"

        # All pixels should be approximately red with full opacity
        px = result_img.load()
        r, g, b, a = px[20, 10]  # center pixel
        assert a > 200, f"Center pixel alpha too low: {a}"
        assert r > 200, f"Center pixel red too low: {r}"
        assert g < 50, f"Center pixel green too high: {g}"
        assert b < 50, f"Center pixel blue too high: {b}"

        print("  [PASS] SUP roundtrip (solid rectangle)")
    finally:
        os.unlink(tmp_path)


def test_sup_roundtrip_transparent_bg():
    """Write an image with transparent background and colored text-like pixels."""
    # 60×30 image: transparent background with a white stripe in the middle
    img = Image.new('RGBA', (60, 30), (0, 0, 0, 0))
    for x in range(60):
        for y in range(12, 18):
            img.putpixel((x, y), (255, 255, 255, 255))

    ds = DisplaySet(
        start_ms=5000,
        end_ms=8000,
        image=img,
        x=50,
        y=100,
        canvas_width=1920,
        canvas_height=1080,
    )

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup([ds], tmp_path)
        results = _parse_sup(tmp_path)

        assert len(results) >= 1, f"Expected ≥1 display set, got {len(results)}"
        start_ms, end_ms, result_img = results[0]

        assert start_ms == 5000, f"Start time: expected 5000, got {start_ms}"
        assert result_img.size == (60, 30), f"Size: expected (60,30), got {result_img.size}"

        px = result_img.load()
        # Transparent corner
        _, _, _, a = px[0, 0]
        assert a == 0, f"Corner should be transparent, got alpha={a}"
        # White stripe center
        r, g, b, a = px[30, 15]
        assert a > 200 and r > 200 and g > 200 and b > 200, (
            f"Stripe center should be white/opaque, got ({r},{g},{b},{a})"
        )

        print("  [PASS] SUP roundtrip (transparent background)")
    finally:
        os.unlink(tmp_path)


def test_sup_multiple_display_sets():
    """Write multiple display sets and verify all are recovered."""
    display_sets = []
    for i in range(5):
        img = Image.new('RGBA', (30, 15), (50 * i, 100, 200, 255))
        ds = DisplaySet(
            start_ms=i * 2000,
            end_ms=i * 2000 + 1500,
            image=img,
            x=100 + i * 10,
            y=50,
            canvas_width=1920,
            canvas_height=1080,
        )
        display_sets.append(ds)

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup(display_sets, tmp_path)
        results = _parse_sup(tmp_path)

        # _parse_sup skips empty display sets (clear sets have no objects),
        # so we should get exactly 5 non-empty results
        assert len(results) == 5, f"Expected 5 display sets, got {len(results)}"

        for i, (start_ms, end_ms, result_img) in enumerate(results):
            expected_start = i * 2000
            assert start_ms == expected_start, (
                f"DS {i}: expected start {expected_start}, got {start_ms}"
            )
            assert result_img.size == (30, 15), (
                f"DS {i}: expected size (30,15), got {result_img.size}"
            )

        print("  [PASS] SUP roundtrip (5 display sets)")
    finally:
        os.unlink(tmp_path)


def test_quantize_preserves_transparency():
    """Quantization must map fully-transparent pixels to index 0."""
    img = Image.new('RGBA', (10, 10), (0, 0, 0, 0))
    # Add a few colored pixels
    img.putpixel((5, 5), (255, 0, 0, 255))
    img.putpixel((6, 5), (0, 255, 0, 200))

    indices, palette = _quantize_image(img)

    # All transparent pixels should be index 0
    transparent_count = sum(1 for idx in indices if idx == 0)
    assert transparent_count >= 97, (
        f"Expected ≥97 transparent pixels (index 0), got {transparent_count}"
    )

    # Palette index 0 should be transparent
    y, cb, cr, a = palette[0]
    assert a == 0, f"Palette index 0 alpha should be 0, got {a}"

    print("  [PASS] Quantization preserves transparency")


def test_alpha_clamp_prevents_inflation():
    """Near-zero alpha glow fringe pixels must be clamped to transparent.

    Simulates the real artifact: a glow gradient produces pixels at alpha 1–7
    alongside opaque text at alpha 255 with the same RGB color.  Without the
    clamp, PIL quantize(method=2) clusters them together, inflating the faint
    pixels' alpha to the cluster average.  With the clamp, faint pixels become
    fully transparent before quantization.
    """
    w, h = 200, 50
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))

    # Opaque red text block (center)
    for x in range(60, 140):
        for y in range(15, 35):
            img.putpixel((x, y), (255, 50, 50, 255))

    # Faint red glow fringe (alpha 1–7) around the text edges
    faint_pixels = []
    for x in range(50, 150):
        for y in [12, 13, 14, 35, 36, 37]:
            alpha = max(1, 7 - abs(y - 24) // 5)
            if alpha < _ALPHA_CLAMP_THRESHOLD:
                img.putpixel((x, y), (255, 50, 50, alpha))
                faint_pixels.append((x, y))

    indices, palette = _quantize_image(img)
    idx_2d = indices.reshape(h, w)

    # ALL faint-alpha pixels must be mapped to index 0 (transparent)
    for x, y in faint_pixels:
        assert idx_2d[y, x] == 0, (
            f"Faint pixel at ({x},{y}) mapped to palette index {idx_2d[y, x]} "
            f"instead of 0 (transparent) — alpha inflation not prevented"
        )

    # Opaque text pixels must still be non-transparent
    assert idx_2d[25, 100] != 0, "Opaque text pixel incorrectly made transparent"

    # Verify no palette entry has inflated alpha for faint-pixel indices
    # (All faint pixels should be index 0, so this is a belt-and-suspenders check)
    for x, y in faint_pixels:
        idx = idx_2d[y, x]
        if idx != 0:
            _, _, _, pa = palette[idx]
            assert pa < _ALPHA_CLAMP_THRESHOLD, (
                f"Palette entry {idx} has alpha {pa} — inflation detected"
            )

    print("  [PASS] Alpha clamp prevents glow fringe inflation")


def test_ods_fragmentation_large_bitmap():
    """Full-frame 1920x1080 bitmap forces ODS fragmentation (>65535 bytes)."""
    # Create a large image with varied colors to prevent RLE from compressing
    # it small enough to fit in a single segment.  A gradient across 1920 columns
    # guarantees that every pixel differs from its neighbor, producing RLE data
    # that exceeds the 65535-byte segment payload limit.
    img = Image.new('RGBA', (1920, 200), (0, 0, 0, 0))
    pixels = img.load()
    for y in range(200):
        for x in range(1920):
            r = (x * 7 + y * 3) % 256
            g = (x * 3 + y * 7) % 256
            b = (x + y) % 256
            pixels[x, y] = (r, g, b, 255)

    ds = DisplaySet(
        start_ms=1000, end_ms=3000,
        image=img, x=0, y=440,
        canvas_width=1920, canvas_height=1080,
    )

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup([ds], tmp_path)

        # Verify the file was written and is non-empty
        assert os.path.getsize(tmp_path) > 0, "SUP file is empty"

        # Parse it back — the decoder must reassemble fragmented ODS
        results = _parse_sup(tmp_path)
        assert len(results) >= 1, f"Expected >=1, got {len(results)}"

        start_ms, end_ms, result_img = results[0]
        assert start_ms == 1000, f"Expected start 1000, got {start_ms}"
        assert result_img.size[0] > 0 and result_img.size[1] > 0

        print(f"  [PASS] ODS fragmentation (file: {os.path.getsize(tmp_path)} bytes, "
              f"image: {result_img.size})")
    finally:
        os.unlink(tmp_path)


def test_pgs_seek_safety():
    """Every PCS must be Epoch Start (0x80) and PTS must be monotonic.

    Also tests the edge case of abutting events (end_ms == next start_ms)
    where the clear PTS must be nudged before the next show PTS.
    """
    import struct as s

    # Create events where event 1 ends at exactly the same ms event 2 starts
    display_sets = []
    for i in range(3):
        img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
        display_sets.append(DisplaySet(
            start_ms=i * 2000,
            end_ms=(i + 1) * 2000,   # abutting: end == next start
            image=img, x=100, y=500,
            canvas_width=1920, canvas_height=1080,
        ))

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup(display_sets, tmp_path)

        # Parse the raw binary to inspect PCS segments
        with open(tmp_path, 'rb') as f:
            raw = f.read()

        pos = 0
        pcs_records = []  # (pts, comp_state, num_objects)
        all_pts = []

        while pos + 13 <= len(raw):
            magic = raw[pos:pos+2]
            if magic != b'PG':
                break
            pts = s.unpack_from('>I', raw, pos + 2)[0]
            seg_type = raw[pos + 10]
            seg_size = s.unpack_from('>H', raw, pos + 11)[0]
            all_pts.append(pts)

            if seg_type == 0x16:  # PCS
                # comp_state is at offset 7 within PCS data (after w,h,fps,comp_num)
                pcs_data = raw[pos + 13: pos + 13 + seg_size]
                comp_state = pcs_data[7]
                num_objects = pcs_data[10]
                pcs_records.append((pts, comp_state, num_objects))

            pos += 13 + seg_size

        # Check 1: every PCS has composition_state == 0x80 (Epoch Start)
        for pts, cs, nobj in pcs_records:
            assert cs == 0x80, (
                f"PCS at PTS={pts} has comp_state=0x{cs:02X}, expected 0x80 (Epoch Start)"
            )

        # Check 2: PTS values across all segments are monotonically non-decreasing
        # (segments within the same display set share PTS, but across display sets
        # the PTS must strictly increase)
        pcs_pts_list = [pts for pts, _, _ in pcs_records]
        for j in range(1, len(pcs_pts_list)):
            assert pcs_pts_list[j] > pcs_pts_list[j - 1], (
                f"PCS PTS not strictly increasing: [{j-1}]={pcs_pts_list[j-1]}, "
                f"[{j}]={pcs_pts_list[j]}"
            )

        # Check 3: we have 6 PCS (3 show + 3 clear)
        assert len(pcs_records) == 6, f"Expected 6 PCS, got {len(pcs_records)}"

        # Check 4: show/clear pattern (objects > 0 then 0)
        for j in range(0, len(pcs_records), 2):
            assert pcs_records[j][2] > 0, f"PCS {j} should be show (objects>0)"
            assert pcs_records[j + 1][2] == 0, f"PCS {j+1} should be clear (objects==0)"

        print(f"  [PASS] PGS seek safety (6 PCS, all Epoch Start, PTS monotonic)")
    finally:
        os.unlink(tmp_path)


def test_pts_anchor_when_events_start_late():
    """When the first event starts after 0ms, a PTS=0 anchor must be emitted.

    Without this anchor, ffmpeg subtracts the first PTS when muxing .sup → MKV,
    shifting all events earlier and making them display at the wrong time.
    """
    import struct as s

    img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
    display_sets = [
        DisplaySet(start_ms=26000, end_ms=28000, image=img, x=100, y=500,
                   canvas_width=1920, canvas_height=1080),
        DisplaySet(start_ms=30000, end_ms=32000, image=img, x=100, y=500,
                   canvas_width=1920, canvas_height=1080),
    ]

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup(display_sets, tmp_path)

        with open(tmp_path, 'rb') as f:
            raw = f.read()

        pos = 0
        pcs_records = []
        while pos + 13 <= len(raw):
            magic = raw[pos:pos+2]
            if magic != b'PG':
                break
            pts = s.unpack_from('>I', raw, pos + 2)[0]
            seg_type = raw[pos + 10]
            seg_size = s.unpack_from('>H', raw, pos + 11)[0]
            if seg_type == 0x16:
                pcs_data = raw[pos + 13: pos + 13 + seg_size]
                num_objects = pcs_data[10]
                pcs_records.append((pts, num_objects))
            pos += 13 + seg_size

        # First PCS must be at PTS=0 (the anchor) with 0 objects
        assert pcs_records[0] == (0, 0), (
            f"Expected anchor PCS at (PTS=0, objects=0), got {pcs_records[0]}"
        )

        # Second PCS is the first real show at 26000ms = 2340000 ticks
        assert pcs_records[1][0] == 26000 * 90, (
            f"Expected first show PCS at PTS={26000*90}, got {pcs_records[1][0]}"
        )
        assert pcs_records[1][1] > 0, "First show PCS should have objects"

        # Total: 1 anchor + 2*(show+clear) = 5 PCS
        assert len(pcs_records) == 5, f"Expected 5 PCS, got {len(pcs_records)}"

        # Verify PTS monotonicity
        pts_list = [p for p, _ in pcs_records]
        for j in range(1, len(pts_list)):
            assert pts_list[j] > pts_list[j - 1], (
                f"PTS not increasing: [{j-1}]={pts_list[j-1]}, [{j}]={pts_list[j]}"
            )

        print("  [PASS] PTS anchor emitted when events start late")
    finally:
        os.unlink(tmp_path)


def test_no_anchor_when_events_start_at_zero():
    """When the first event starts at 0ms, no anchor should be emitted."""
    import struct as s

    img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
    ds = DisplaySet(start_ms=0, end_ms=2000, image=img, x=100, y=500,
                    canvas_width=1920, canvas_height=1080)

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        write_sup([ds], tmp_path)

        with open(tmp_path, 'rb') as f:
            raw = f.read()

        pos = 0
        pcs_records = []
        while pos + 13 <= len(raw):
            magic = raw[pos:pos+2]
            if magic != b'PG':
                break
            pts = s.unpack_from('>I', raw, pos + 2)[0]
            seg_type = raw[pos + 10]
            seg_size = s.unpack_from('>H', raw, pos + 11)[0]
            if seg_type == 0x16:
                pcs_data = raw[pos + 13: pos + 13 + seg_size]
                num_objects = pcs_data[10]
                pcs_records.append((pts, num_objects))
            pos += 13 + seg_size

        # No anchor — first PCS is the show at PTS=0
        assert pcs_records[0] == (0, 1), (
            f"Expected show PCS at (PTS=0, objects=1), got {pcs_records[0]}"
        )
        # Only 2 PCS: 1 show + 1 clear
        assert len(pcs_records) == 2, f"Expected 2 PCS, got {len(pcs_records)}"

        print("  [PASS] No anchor when events start at 0ms")
    finally:
        os.unlink(tmp_path)


def test_sup_writer_streaming_roundtrip():
    """SupWriter produces identical output to write_sup() for the same input."""
    from app.sup_writer import SupWriter

    display_sets = []
    for i in range(5):
        img = Image.new('RGBA', (60, 30), ((i * 50) % 256, 100, 50, 255))
        display_sets.append(DisplaySet(
            start_ms=5000 + i * 3000,
            end_ms=5000 + i * 3000 + 2500,
            image=img, x=100, y=500,
            canvas_width=1920, canvas_height=1080,
        ))

    # Write with write_sup()
    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        batch_path = f.name
    write_sup(display_sets, batch_path)

    # Write with SupWriter (streaming)
    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        stream_path = f.name
    writer = SupWriter(stream_path, 1920, 1080)
    for ds in display_sets:
        writer.write(ds)
    writer.close()

    try:
        batch_data = open(batch_path, 'rb').read()
        stream_data = open(stream_path, 'rb').read()
        assert batch_data == stream_data, (
            f"Streaming output ({len(stream_data)} bytes) differs from "
            f"batch output ({len(batch_data)} bytes)"
        )
        assert writer.count == 5

        # Verify round-trip through parser
        results = _parse_sup(stream_path)
        assert len(results) >= 5, f"Expected >=5 display sets, got {len(results)}"

        print(f"  [PASS] SupWriter streaming matches write_sup() ({len(stream_data)} bytes)")
    finally:
        os.unlink(batch_path)
        os.unlink(stream_path)


def test_sup_writer_context_manager():
    """SupWriter works as a context manager."""
    from app.sup_writer import SupWriter

    img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
    ds = DisplaySet(start_ms=1000, end_ms=3000, image=img, x=0, y=0,
                    canvas_width=1920, canvas_height=1080)

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        with SupWriter(tmp_path, 1920, 1080) as w:
            w.write(ds)
        # File should be flushed and closed after exiting context
        assert w.count == 1
        assert os.path.getsize(tmp_path) > 0

        results = _parse_sup(tmp_path)
        assert len(results) >= 1
        print("  [PASS] SupWriter context manager flushes on exit")
    finally:
        os.unlink(tmp_path)


def test_sup_writer_anchor_late_start():
    """SupWriter emits PTS=0 anchor when first event starts after 0ms."""
    import struct as s
    from app.sup_writer import SupWriter

    img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
    ds = DisplaySet(start_ms=10000, end_ms=12000, image=img, x=100, y=500,
                    canvas_width=1920, canvas_height=1080)

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        with SupWriter(tmp_path, 1920, 1080) as w:
            w.write(ds)

        with open(tmp_path, 'rb') as f:
            raw = f.read()

        # Parse PCS records
        pos = 0
        pcs_records = []
        while pos + 13 <= len(raw):
            magic = raw[pos:pos+2]
            if magic != b'PG':
                break
            pts = s.unpack_from('>I', raw, pos + 2)[0]
            seg_type = raw[pos + 10]
            seg_size = s.unpack_from('>H', raw, pos + 11)[0]
            if seg_type == 0x16:
                pcs_data = raw[pos + 13: pos + 13 + seg_size]
                num_objects = pcs_data[10]
                pcs_records.append((pts, num_objects))
            pos += 13 + seg_size

        # First PCS = anchor at PTS=0 with 0 objects
        assert pcs_records[0] == (0, 0), f"Expected anchor, got {pcs_records[0]}"
        # Second PCS = show at 10000ms
        assert pcs_records[1][0] == 10000 * 90
        assert pcs_records[1][1] > 0
        print("  [PASS] SupWriter anchor emitted for late start")
    finally:
        os.unlink(tmp_path)


def test_sup_writer_image_released_after_flush():
    """SupWriter sets ds.image = None after flushing to disk."""
    from app.sup_writer import SupWriter

    ds1 = DisplaySet(
        start_ms=1000, end_ms=3000,
        image=Image.new('RGBA', (40, 20), (200, 100, 50, 255)),
        x=0, y=0, canvas_width=1920, canvas_height=1080,
    )
    ds2 = DisplaySet(
        start_ms=4000, end_ms=6000,
        image=Image.new('RGBA', (40, 20), (100, 200, 50, 255)),
        x=0, y=0, canvas_width=1920, canvas_height=1080,
    )

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        with SupWriter(tmp_path, 1920, 1080) as w:
            w.write(ds1)
            # ds1 is now pending — image still needed
            assert ds1.image is not None, "ds1 image released too early"
            w.write(ds2)
            # ds1 is now flushed — image should be released
            assert ds1.image is None, "ds1 image not released after flush"
            # ds2 is now pending — image still needed
            assert ds2.image is not None, "ds2 image released too early"
        # After close(), ds2 is flushed — image should be released
        assert ds2.image is None, "ds2 image not released after close"
        assert w.count == 2
        print("  [PASS] SupWriter releases images after flushing")
    finally:
        os.unlink(tmp_path)


def test_numpy_rle_matches_python_rle():
    """Numpy-accelerated RLE encoder produces byte-identical output to Python reference."""
    # Test 1: Simple mixed patterns
    width, height = 10, 3
    indices = (
        [0, 0, 0, 0, 0, 1, 1, 1, 1, 1] +
        [2] * 10 +
        [1, 3, 1, 3, 1, 3, 1, 3, 1, 3]
    )
    assert _encode_rle(indices, width, height) == _encode_rle_python(indices, width, height)

    # Test 2: Long runs (extended encoding)
    width2 = 200
    indices2 = [0] * width2 + [5] * width2
    assert _encode_rle(indices2, width2, 2) == _encode_rle_python(indices2, width2, 2)

    # Test 3: Single pixels (direct byte encoding)
    indices3 = [1, 2, 3, 4, 5]
    assert _encode_rle(indices3, 5, 1) == _encode_rle_python(indices3, 5, 1)

    # Test 4: All transparent
    indices4 = [0] * 500
    assert _encode_rle(indices4, 50, 10) == _encode_rle_python(indices4, 50, 10)

    # Test 5: Very long run exceeding 16383 (PGS max run length)
    indices5 = [7] * 20000
    assert _encode_rle(indices5, 20000, 1) == _encode_rle_python(indices5, 20000, 1)

    # Test 6: Realistic subtitle-like bitmap (large transparent area + small content)
    width6, height6 = 1920, 100
    indices6 = []
    for row in range(height6):
        if 40 <= row < 60:
            # Content rows: some colored pixels in the middle
            indices6.extend([0] * 700)
            indices6.extend([3] * 520)
            indices6.extend([0] * 700)
        else:
            indices6.extend([0] * width6)
    assert _encode_rle(indices6, width6, height6) == _encode_rle_python(indices6, width6, height6)

    print("  [PASS] Numpy RLE matches Python RLE (6 test patterns)")


def test_numpy_rle_roundtrip_with_quantized_image():
    """Numpy RLE from a real quantized image round-trips through decode correctly."""
    # Create an image resembling real subtitle content: text-like colored pixels
    # on transparent background with anti-aliased edges
    img = Image.new('RGBA', (400, 100), (0, 0, 0, 0))
    pixels = img.load()
    # Draw some "text-like" content
    for y in range(30, 70):
        for x in range(50, 350):
            if (x + y) % 7 < 3:
                pixels[x, y] = (255, 255, 255, 255)
            elif (x + y) % 7 == 3:
                pixels[x, y] = (255, 255, 255, 128)  # anti-aliased edge

    indices, palette = _quantize_image(img)
    indices_list = indices.tolist() if hasattr(indices, 'tolist') else list(indices)

    # Encode with numpy, decode, compare
    encoded = _encode_rle(indices_list, 400, 100)
    decoded = _decode_rle(encoded, 400, 100)
    assert decoded == indices_list, "Numpy RLE from quantized image failed round-trip"

    # Verify byte-identical to Python reference
    python_encoded = _encode_rle_python(indices_list, 400, 100)
    assert encoded == python_encoded, (
        f"Numpy ({len(encoded)} bytes) != Python ({len(python_encoded)} bytes)"
    )

    print("  [PASS] Numpy RLE round-trip with quantized image")


def test_split_regions_two_regions():
    """Bitmap with top and bottom content separated by large gap splits into 2 regions."""
    # 2400×1972 image: content at top (rows 10–110) and bottom (rows 1850–1950),
    # transparent gap of ~1740 rows in between.
    img = Image.new('RGBA', (2400, 1972), (0, 0, 0, 0))
    px = img.load()
    # Top cluster: white text
    for y in range(10, 110):
        for x in range(200, 2200):
            if (x + y) % 5 < 2:
                px[x, y] = (255, 255, 255, 255)
    # Bottom line: yellow text
    for y in range(1850, 1950):
        for x in range(300, 2100):
            if (x + y) % 4 < 2:
                px[x, y] = (255, 255, 0, 255)

    regions = split_regions(img, 100, 50)
    assert len(regions) == 2, f"Expected 2 regions, got {len(regions)}"

    top_img, top_x, top_y = regions[0]
    bot_img, bot_x, bot_y = regions[1]

    # Top region should be roughly rows 10–110, x 200–2200
    assert top_img.height < 200, f"Top region too tall: {top_img.height}"
    assert top_y < 200, f"Top region y too large: {top_y}"

    # Bottom region should be roughly rows 1850–1950
    assert bot_img.height < 200, f"Bottom region too tall: {bot_img.height}"
    assert bot_y > 1800, f"Bottom region y too small: {bot_y}"

    # Total pixels should be much less than original
    total_pixels = top_img.width * top_img.height + bot_img.width * bot_img.height
    original_pixels = 2400 * 1972
    assert total_pixels < original_pixels * 0.2, (
        f"Split didn't reduce pixels enough: {total_pixels} vs {original_pixels}"
    )

    print(f"  [PASS] 2-region split: top={top_img.width}x{top_img.height}@({top_x},{top_y}), "
          f"bottom={bot_img.width}x{bot_img.height}@({bot_x},{bot_y}), "
          f"pixel reduction: {original_pixels/total_pixels:.1f}x")


def test_split_regions_single_region():
    """Bitmap with only bottom content produces 1 region (no split)."""
    img = Image.new('RGBA', (1920, 1080), (0, 0, 0, 0))
    px = img.load()
    # Only content at bottom
    for y in range(950, 1050):
        for x in range(200, 1720):
            px[x, y] = (255, 255, 255, 255)

    regions = split_regions(img, 0, 0)
    assert len(regions) == 1, f"Expected 1 region, got {len(regions)}"
    print("  [PASS] Single content region → no split")


def test_split_regions_small_gap_no_split():
    """Top cluster elements separated by small gaps (< 50 rows) don't split."""
    # Simulate romaji at top, then 30-row gap, then furigana/kanji text
    img = Image.new('RGBA', (1920, 400), (0, 0, 0, 0))
    px = img.load()
    # Romaji: rows 10–40
    for y in range(10, 40):
        for x in range(200, 1720):
            if x % 3 == 0:
                px[x, y] = (255, 255, 255, 255)
    # 30-row transparent gap (rows 40–70) — less than min_gap=50
    # Furigana + kanji: rows 70–200
    for y in range(70, 200):
        for x in range(200, 1720):
            if x % 3 == 0:
                px[x, y] = (255, 255, 255, 255)

    regions = split_regions(img, 0, 0)
    assert len(regions) == 1, f"Expected 1 region (gap < 50), got {len(regions)}"
    print("  [PASS] Small gap (30 rows) does not trigger split")


def test_split_regions_same_half_no_split():
    """Two top-half clusters with gap > 50 rows but both in top 25% → 1 region."""
    # Romaji at rows 10–40, gap 60 rows, Japanese at rows 100–170
    img = Image.new('RGBA', (1920, 200), (0, 0, 0, 0))
    px = img.load()
    for row in range(10, 40):
        for col in range(200, 1720):
            if col % 3 == 0:
                px[col, row] = (255, 255, 255, 255)
    for row in range(100, 170):
        for col in range(200, 1720):
            if col % 3 == 0:
                px[col, row] = (255, 255, 255, 255)

    # Gap = 60 rows (≥ 50), gap midpoint at canvas y = 0 + (40+100)/2 = 70 → 6.5%
    # Outside middle band → should NOT split
    regions = split_regions(img, 0, 0, canvas_height=1080)
    assert len(regions) == 1, f"Expected 1 region (same-half guard), got {len(regions)}"

    # Backward compat: canvas_height=None → still splits
    regions_no_guard = split_regions(img, 0, 0, canvas_height=None)
    assert len(regions_no_guard) == 2, (
        f"Expected 2 regions without guard, got {len(regions_no_guard)}"
    )
    print("  [PASS] Same-half clusters → no split (canvas-aware guard)")


def test_split_regions_cross_half_splits():
    """Top cluster + bottom cluster spanning the canvas midpoint → 2 regions."""
    img = Image.new('RGBA', (1920, 1080), (0, 0, 0, 0))
    px = img.load()
    # Top cluster: rows 10–160
    for row in range(10, 160):
        for col in range(200, 1720):
            if col % 5 == 0:
                px[col, row] = (255, 255, 255, 255)
    # Bottom cluster: rows 850–950
    for row in range(850, 950):
        for col in range(200, 1720):
            if col % 5 == 0:
                px[col, row] = (255, 255, 255, 255)

    # Gap midpoint at canvas y = 0 + (160+850)/2 = 505 → 46.8%, inside 25–75% band
    regions = split_regions(img, 0, 0, canvas_height=1080)
    assert len(regions) == 2, f"Expected 2 regions (cross-half), got {len(regions)}"
    print("  [PASS] Cross-half clusters → 2 regions (split allowed)")


def test_split_regions_bottom_half_no_split():
    """Two bottom-half clusters with gap > 50 rows but both below 75% → 1 region."""
    # Two clusters at bottom of canvas, placed via y offset
    img = Image.new('RGBA', (1920, 200), (0, 0, 0, 0))
    px = img.load()
    # Cluster A: rows 0–50 in image (canvas y = 800–850)
    for row in range(0, 50):
        for col in range(200, 1720):
            if col % 3 == 0:
                px[col, row] = (255, 255, 255, 255)
    # 70-row gap (rows 50–120)
    # Cluster B: rows 120–170 in image (canvas y = 920–970)
    for row in range(120, 170):
        for col in range(200, 1720):
            if col % 3 == 0:
                px[col, row] = (255, 255, 255, 255)

    # Gap midpoint at canvas y = 800 + (50+120)/2 = 885 → 81.9%, outside band
    regions = split_regions(img, 0, 800, canvas_height=1080)
    assert len(regions) == 1, f"Expected 1 region (bottom-half guard), got {len(regions)}"
    print("  [PASS] Bottom-half clusters → no split (canvas-aware guard)")


def test_two_object_pgs_structure():
    """2-object display set has valid PGS structure: PCS with 2 objects, 2 windows, 2 ODS."""
    import struct as s

    # Create a DisplaySet with 2 regions
    top_img = Image.new('RGBA', (200, 50), (255, 255, 255, 255))
    bot_img = Image.new('RGBA', (180, 40), (255, 255, 0, 255))

    ds = DisplaySet(
        start_ms=5000, end_ms=7000,
        image=top_img,  # primary image (used if no extra_regions)
        x=100, y=50,
        canvas_width=1920, canvas_height=1080,
    )
    regions = [
        (top_img, 100, 50),
        (bot_img, 120, 900),
    ]

    segments = _build_show_segments(ds, comp_number=0, extra_regions=regions)

    # Concatenate all segment bytes
    raw = b''.join(segments)

    # Parse and validate PGS structure
    pos = 0
    seg_types = []
    pcs_data_bytes = None
    wds_data_bytes = None
    ods_count = 0

    while pos + 13 <= len(raw):
        magic = raw[pos:pos+2]
        assert magic == b'PG', f"Bad magic at offset {pos}"
        seg_type = raw[pos + 10]
        seg_size = s.unpack_from('>H', raw, pos + 11)[0]
        seg_data = raw[pos + 13: pos + 13 + seg_size]
        seg_types.append(seg_type)

        if seg_type == 0x16:  # PCS
            pcs_data_bytes = seg_data
        elif seg_type == 0x17:  # WDS
            wds_data_bytes = seg_data
        elif seg_type == 0x15:  # ODS
            ods_count += 1

        pos += 13 + seg_size

    # PCS: check num_composition_objects == 2
    assert pcs_data_bytes is not None, "No PCS segment found"
    num_objects = pcs_data_bytes[10]
    assert num_objects == 2, f"Expected 2 composition objects in PCS, got {num_objects}"

    # WDS: check 2 windows
    assert wds_data_bytes is not None, "No WDS segment found"
    num_windows = wds_data_bytes[0]
    assert num_windows == 2, f"Expected 2 windows in WDS, got {num_windows}"

    # ODS: should have at least 2 ODS segments (one per object, possibly fragmented)
    assert ods_count >= 2, f"Expected ≥2 ODS segments, got {ods_count}"

    # Segment order: PCS, WDS, PDS, ODS..., END
    assert seg_types[0] == 0x16, "First segment should be PCS"
    assert seg_types[1] == 0x17, "Second segment should be WDS"
    assert seg_types[2] == 0x14, "Third segment should be PDS"
    assert seg_types[-1] == 0x80, "Last segment should be END"

    print(f"  [PASS] 2-object PGS structure valid: {num_objects} objects, "
          f"{num_windows} windows, {ods_count} ODS segments")


def test_two_object_sup_roundtrip():
    """Write a 2-object display set via SupWriter, read back, verify both objects."""
    # Create image with top and bottom content separated by large gap
    img = Image.new('RGBA', (400, 500), (0, 0, 0, 0))
    px = img.load()
    # Top content: rows 10–60
    for y in range(10, 60):
        for x in range(50, 350):
            px[x, y] = (255, 0, 0, 255)
    # Large transparent gap: rows 60–400
    # Bottom content: rows 400–450
    for y in range(400, 450):
        for x in range(80, 320):
            px[x, y] = (0, 255, 0, 255)

    # Split into regions
    regions = split_regions(img, 100, 200)
    assert len(regions) == 2, f"Expected 2 regions for test setup, got {len(regions)}"

    ds = DisplaySet(
        start_ms=3000, end_ms=5000,
        image=regions[0][0],  # first region image
        x=regions[0][1], y=regions[0][2],
        canvas_width=1920, canvas_height=1080,
    )

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        region_tuples = [(r[0], r[1], r[2]) for r in regions]
        writer = SupWriter(tmp_path, 1920, 1080)
        writer.write(ds, extra_regions=region_tuples)
        writer.close()

        assert writer.count == 1
        assert os.path.getsize(tmp_path) > 0

        # Parse and verify we get at least 1 visible display set back
        results = _parse_sup(tmp_path)
        assert len(results) >= 1, f"Expected >=1 display set, got {len(results)}"

        print(f"  [PASS] 2-object SupWriter round-trip ({os.path.getsize(tmp_path)} bytes)")
    finally:
        os.unlink(tmp_path)


# ── Epoch management tests ───────────────────────────────────────────

def _parse_pcs_records(raw_bytes):
    """Parse raw .sup binary and extract PCS records for epoch tests.

    Returns list of dicts with keys: pts, comp_state, num_objects, seg_types_in_ds.
    Also returns list of all (seg_type, seg_size, seg_data) tuples.
    """
    import struct as s
    pos = 0
    all_segments = []
    while pos + 13 <= len(raw_bytes):
        magic = raw_bytes[pos:pos+2]
        if magic != b'PG':
            break
        pts = s.unpack_from('>I', raw_bytes, pos + 2)[0]
        seg_type = raw_bytes[pos + 10]
        seg_size = s.unpack_from('>H', raw_bytes, pos + 11)[0]
        seg_data = raw_bytes[pos + 13: pos + 13 + seg_size]
        all_segments.append((seg_type, pts, seg_size, seg_data))
        pos += 13 + seg_size

    # Group segments into display sets (PCS starts a new DS)
    pcs_records = []
    current_ds_segs = []
    for seg_type, pts, seg_size, seg_data in all_segments:
        if seg_type == 0x16:  # PCS
            if current_ds_segs:
                pass  # previous DS closed implicitly
            current_ds_segs = [seg_type]
            comp_state = seg_data[7] if len(seg_data) > 7 else 0
            num_objects = seg_data[10] if len(seg_data) > 10 else 0
            pcs_records.append({
                'pts': pts,
                'comp_state': comp_state,
                'num_objects': num_objects,
                'ds_seg_types': current_ds_segs,
            })
        else:
            current_ds_segs.append(seg_type)

    return pcs_records, all_segments


def _make_two_region_ds(start_ms, end_ms, top_color, bot_color):
    """Helper: create a DisplaySet + 2-region tuple for epoch tests."""
    top_img = Image.new('RGBA', (200, 50), top_color)
    bot_img = Image.new('RGBA', (180, 40), bot_color)
    ds = DisplaySet(
        start_ms=start_ms, end_ms=end_ms,
        image=top_img, x=100, y=50,
        canvas_width=1920, canvas_height=1080,
    )
    regions = [(top_img, 100, 50), (bot_img, 120, 900)]
    return ds, regions


def test_epoch_normal_one_object_changed():
    """Two abutting 2-object events: same bottom, different top → Normal update."""
    ds1, regions1 = _make_two_region_ds(1000, 3000, (255, 0, 0, 255), (0, 255, 0, 255))
    ds2, regions2 = _make_two_region_ds(3000, 5000, (0, 0, 255, 255), (0, 255, 0, 255))

    # Region keys: region 0 = top, region 1 = bottom
    keys1 = [('top_v1',), ('bottom_v1',)]
    keys2 = [('top_v2',), ('bottom_v1',)]  # only top changed

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        writer.write(ds1, extra_regions=regions1, region_content_keys=keys1)
        writer.write(ds2, extra_regions=regions2, region_content_keys=keys2)
        writer.close()

        # Check stats
        assert writer.stats['epoch_start'] >= 1, f"Expected >=1 ES, got {writer.stats}"
        assert writer.stats['normal'] >= 1, f"Expected >=1 Normal, got {writer.stats}"

        # Parse raw binary
        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, all_segs = _parse_pcs_records(raw)

        # Find the show PCS records (num_objects > 0)
        show_pcs = [p for p in pcs_records if p['num_objects'] > 0]
        assert len(show_pcs) >= 2, f"Expected >=2 show PCS, got {len(show_pcs)}"

        # First show should be Epoch Start
        assert show_pcs[0]['comp_state'] == 0x80, (
            f"First show comp_state=0x{show_pcs[0]['comp_state']:02X}, expected 0x80")

        # Second show should be Normal (0x00)
        assert show_pcs[1]['comp_state'] == 0x00, (
            f"Second show comp_state=0x{show_pcs[1]['comp_state']:02X}, expected 0x00")

        # Count ODS segments in the Normal display set
        # Find the segment range for the second show PCS
        normal_ds_segs = show_pcs[1]['ds_seg_types']
        ods_count = sum(1 for t in normal_ds_segs if t == 0x15)
        assert ods_count >= 1, f"Normal DS should have >=1 ODS, got {ods_count}"
        # Normal should NOT have 2 ODS (unchanged object not re-encoded)
        # Note: ODS fragmentation could produce >1 for a single object
        # We verify by checking there's no WDS (Normal omits it)
        assert 0x17 not in normal_ds_segs, "Normal DS should not have WDS"

        print(f"  [PASS] Epoch Normal: one object changed (stats={writer.stats})")
    finally:
        os.unlink(tmp_path)


def test_epoch_skip_identical_content():
    """Two abutting events with identical content keys → second is skipped."""
    ds1, regions1 = _make_two_region_ds(1000, 3000, (255, 0, 0, 255), (0, 255, 0, 255))
    ds2, regions2 = _make_two_region_ds(3000, 5000, (255, 0, 0, 255), (0, 255, 0, 255))

    keys = [('top_v1',), ('bottom_v1',)]

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        writer.write(ds1, extra_regions=regions1, region_content_keys=keys)
        writer.write(ds2, extra_regions=regions2, region_content_keys=keys)
        writer.close()

        assert writer.stats['skipped'] >= 1, f"Expected >=1 skip, got {writer.stats}"

        # Parse: should have only 1 show + 1 clear (second show skipped)
        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, _ = _parse_pcs_records(raw)
        show_pcs = [p for p in pcs_records if p['num_objects'] > 0]
        assert len(show_pcs) == 1, f"Expected 1 show PCS (second skipped), got {len(show_pcs)}"

        print(f"  [PASS] Epoch Skip: identical content (stats={writer.stats})")
    finally:
        os.unlink(tmp_path)


def test_epoch_clear_after_content():
    """Single event → clear.  Clear PCS must be Epoch Start (0x80)."""
    ds1, regions1 = _make_two_region_ds(1000, 3000, (255, 0, 0, 255), (0, 255, 0, 255))
    keys = [('top_v1',), ('bottom_v1',)]

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        writer.write(ds1, extra_regions=regions1, region_content_keys=keys)
        writer.close()

        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, _ = _parse_pcs_records(raw)
        clear_pcs = [p for p in pcs_records if p['num_objects'] == 0 and p['pts'] > 0]
        assert len(clear_pcs) >= 1, f"Expected >=1 clear PCS, got {len(clear_pcs)}"
        for cp in clear_pcs:
            assert cp['comp_state'] == 0x80, (
                f"Clear PCS at PTS={cp['pts']} has comp_state=0x{cp['comp_state']:02X}, "
                f"expected 0x80 (Epoch Start for seek safety)")

        print(f"  [PASS] Epoch Clear: Epoch Start for seek safety")
    finally:
        os.unlink(tmp_path)


def test_epoch_start_after_gap():
    """Two events with gap → both shows must be Epoch Start."""
    ds1, regions1 = _make_two_region_ds(1000, 3000, (255, 0, 0, 255), (0, 255, 0, 255))
    ds2, regions2 = _make_two_region_ds(5000, 7000, (0, 0, 255, 255), (0, 255, 0, 255))

    keys1 = [('top_v1',), ('bottom_v1',)]
    keys2 = [('top_v2',), ('bottom_v1',)]

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        writer.write(ds1, extra_regions=regions1, region_content_keys=keys1)
        writer.write(ds2, extra_regions=regions2, region_content_keys=keys2)
        writer.close()

        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, _ = _parse_pcs_records(raw)
        show_pcs = [p for p in pcs_records if p['num_objects'] > 0]
        assert len(show_pcs) == 2, f"Expected 2 show PCS, got {len(show_pcs)}"

        # Both shows must be Epoch Start (gap > 50ms → clear between them → epoch reset)
        for i, sp in enumerate(show_pcs):
            assert sp['comp_state'] == 0x80, (
                f"Show {i} comp_state=0x{sp['comp_state']:02X}, expected 0x80 "
                f"(gap between events should reset epoch)")

        print(f"  [PASS] Epoch Start after gap (stats={writer.stats})")
    finally:
        os.unlink(tmp_path)


def test_epoch_acquisition_point_periodic():
    """Chain of 15+ abutting events → at least one AP appears."""
    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        for i in range(16):
            start = 1000 + i * 2000
            end = start + 2000
            # Alternate top text to ensure changes (not skipped)
            top_color = (255, 0, 0, 255) if i % 2 == 0 else (0, 0, 255, 255)
            ds, regions = _make_two_region_ds(start, end, top_color, (0, 255, 0, 255))
            keys = [(f'top_v{i}',), ('bottom_v1',)]
            writer.write(ds, extra_regions=regions, region_content_keys=keys)
        writer.close()

        assert writer.stats['acquisition_point'] >= 1, (
            f"Expected >=1 AP in 16 abutting events, got {writer.stats}")

        # Verify at least one PCS with comp_state == 0x40
        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, _ = _parse_pcs_records(raw)
        ap_pcs = [p for p in pcs_records if p['comp_state'] == 0x40 and p['num_objects'] > 0]
        assert len(ap_pcs) >= 1, f"Expected >=1 AP PCS in binary, got {len(ap_pcs)}"

        print(f"  [PASS] Epoch AP periodic (stats={writer.stats})")
    finally:
        os.unlink(tmp_path)


def test_epoch_backward_compatible_no_keys():
    """SupWriter without region_content_keys → all PCS are Epoch Start."""
    import struct as s

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        for i in range(3):
            img = Image.new('RGBA', (40, 20), (200, 100, 50, 255))
            ds = DisplaySet(
                start_ms=i * 3000 + 1000, end_ms=i * 3000 + 2500,
                image=img, x=100, y=500,
                canvas_width=1920, canvas_height=1080,
            )
            writer.write(ds)  # no region_content_keys
        writer.close()

        with open(tmp_path, 'rb') as f:
            raw = f.read()
        pcs_records, _ = _parse_pcs_records(raw)

        # All PCS must be Epoch Start (backward compatible)
        for p in pcs_records:
            assert p['comp_state'] == 0x80, (
                f"PCS at PTS={p['pts']} has comp_state=0x{p['comp_state']:02X}, "
                f"expected 0x80 (backward compatible = all Epoch Start)")

        # Stats should all be zero (old path doesn't touch stats)
        assert writer.stats['normal'] == 0
        assert writer.stats['acquisition_point'] == 0
        assert writer.stats['skipped'] == 0

        print(f"  [PASS] Epoch backward compatible: no keys → all Epoch Start")
    finally:
        os.unlink(tmp_path)


if __name__ == '__main__':
    print("Running SUP writer round-trip tests...\n")
    test_rle_roundtrip_simple()
    test_rle_roundtrip_long_runs()
    test_rle_roundtrip_single_pixels()
    test_ycbcr_roundtrip()
    test_quantize_preserves_transparency()
    test_alpha_clamp_prevents_inflation()
    test_sup_roundtrip_solid_rect()
    test_sup_roundtrip_transparent_bg()
    test_sup_multiple_display_sets()
    test_ods_fragmentation_large_bitmap()
    test_pgs_seek_safety()
    test_pts_anchor_when_events_start_late()
    test_no_anchor_when_events_start_at_zero()
    test_sup_writer_streaming_roundtrip()
    test_sup_writer_context_manager()
    test_sup_writer_anchor_late_start()
    test_sup_writer_image_released_after_flush()
    test_numpy_rle_matches_python_rle()
    test_numpy_rle_roundtrip_with_quantized_image()
    test_split_regions_two_regions()
    test_split_regions_single_region()
    test_split_regions_small_gap_no_split()
    test_split_regions_same_half_no_split()
    test_split_regions_cross_half_splits()
    test_split_regions_bottom_half_no_split()
    test_two_object_pgs_structure()
    test_two_object_sup_roundtrip()
    test_epoch_normal_one_object_changed()
    test_epoch_skip_identical_content()
    test_epoch_clear_after_content()
    test_epoch_start_after_gap()
    test_epoch_acquisition_point_periodic()
    test_epoch_backward_compatible_no_keys()
    print("\nAll tests passed!")
