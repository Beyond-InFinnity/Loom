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
from app.sup_writer import (
    DisplaySet, write_sup, SupWriter, _encode_rle, _rgb_to_ycbcr, _quantize_image,
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


if __name__ == '__main__':
    print("Running SUP writer round-trip tests...\n")
    test_rle_roundtrip_simple()
    test_rle_roundtrip_long_runs()
    test_rle_roundtrip_single_pixels()
    test_ycbcr_roundtrip()
    test_quantize_preserves_transparency()
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
    print("\nAll tests passed!")
