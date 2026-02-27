# app/sup_writer.py
"""PGS (Presentation Graphic Stream) SUP writer.

Produces .sup files — the inverse of _parse_sup() in ocr.py.  Each display
set becomes a sequence of PGS segments (PCS, WDS, PDS, ODS, END) that
encodes a single RGBA bitmap at a specific position and time on the video
canvas.  A "clear" display set is emitted after each visible one to erase
the image at its end timestamp.

The binary format follows the Blu-ray PGS specification.  Segment header:

    2 bytes  "PG" magic (0x5047)
    4 bytes  PTS  (uint32 big-endian, 90 kHz clock)
    4 bytes  DTS  (uint32 big-endian, always 0)
    1 byte   segment type
    2 bytes  segment data size (uint16 big-endian)
    N bytes  segment data

Public API
----------
write_sup(display_sets, output_path)
    Write a list of DisplaySet objects to a .sup file (batch mode).

SupWriter(path, canvas_width, canvas_height)
    Streaming writer — accepts display sets one at a time via write(ds),
    flushes to disk incrementally.  Memory-bounded for large frame counts.

DisplaySet
    Dataclass holding timing, RGBA image, position, and canvas dimensions.
"""

from __future__ import annotations

import struct
import time as _time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

# ── PGS segment types ─────────────────────────────────────────────────
_SEG_PCS = 0x16  # Presentation Composition Segment
_SEG_WDS = 0x17  # Window Definition Segment
_SEG_PDS = 0x14  # Palette Definition Segment
_SEG_ODS = 0x15  # Object Definition Segment
_SEG_END = 0x80  # End of Display Set Segment

_PG_MAGIC = b'PG'

# PCS composition_state values
_COMP_EPOCH_START = 0x80  # new display epoch — fully self-contained, seek-safe
_COMP_NORMAL = 0x00       # incremental update within an epoch
_COMP_ACQUISITION_POINT = 0x40  # full reference point within an epoch (for seeking)
_AP_INTERVAL = 12         # emit Acquisition Point every N display sets for seek safety


@dataclass
class DisplaySet:
    """One visible annotation bitmap on the video canvas.

    Attributes
    ----------
    start_ms : int
        Display start time in milliseconds.
    end_ms : int
        Display end time in milliseconds.
    image : PILImage
        RGBA PIL Image, cropped to content bounds.
    x : int
        Horizontal position on the video canvas (left edge of image).
    y : int
        Vertical position on the video canvas (top edge of image).
    canvas_width : int
        Video canvas width in pixels.
    canvas_height : int
        Video canvas height in pixels.
    """
    start_ms: int
    end_ms: int
    image: "PILImage"
    x: int
    y: int
    canvas_width: int
    canvas_height: int


# ── Color conversion ──────────────────────────────────────────────────

def _rgb_to_ycbcr(r: int, g: int, b: int) -> tuple[int, int, int]:
    """Convert RGB to YCbCr using BT.601 (inverse of _ycbcr_to_rgb in ocr.py).

    Uses full-range values (0–255 for all channels) to match the decoder in
    ocr.py which does not apply studio-range offsets.
    """
    y = max(0, min(255, int(round(0.299 * r + 0.587 * g + 0.114 * b))))
    cb = max(0, min(255, int(round(-0.169 * r - 0.331 * g + 0.500 * b + 128))))
    cr = max(0, min(255, int(round(0.500 * r - 0.419 * g - 0.081 * b + 128))))
    return y, cb, cr


# ── RLE encoding ──────────────────────────────────────────────────────

def _encode_rle_python(indices, width: int, height: int) -> bytes:
    """Pure-Python RLE encoder (reference implementation for regression tests).

    Kept as the ground-truth encoder.  Production code uses _encode_rle()
    which is numpy-accelerated.
    """
    out = bytearray()

    for row in range(height):
        row_start = row * width
        col = 0
        while col < width:
            color = indices[row_start + col]
            run = 1
            while col + run < width and indices[row_start + col + run] == color:
                run += 1
                if run >= 16383:
                    break

            if color == 0:
                if run < 64:
                    out.append(0x00)
                    out.append(run & 0x3F)
                else:
                    out.append(0x00)
                    out.append(0x40 | ((run >> 8) & 0x3F))
                    out.append(run & 0xFF)
            else:
                if run == 1:
                    out.append(color)
                elif run < 64:
                    out.append(0x00)
                    out.append(0x80 | (run & 0x3F))
                    out.append(color)
                else:
                    out.append(0x00)
                    out.append(0xC0 | ((run >> 8) & 0x3F))
                    out.append(run & 0xFF)
                    out.append(color)

            col += run

        out.append(0x00)
        out.append(0x00)

    return bytes(out)


def _encode_rle_row(row_data: np.ndarray) -> bytearray:
    """RLE-encode a single row (numpy array of uint8 palette indices).

    Uses np.diff() to find run boundaries in one C-level pass, then iterates
    over the (much smaller) list of runs to emit PGS RLE opcodes.
    """
    out = bytearray()
    width = len(row_data)
    if width == 0:
        out.append(0x00)
        out.append(0x00)
        return out

    # Find positions where value changes — O(width) in C
    changes = np.flatnonzero(np.diff(row_data))  # indices where row_data[i] != row_data[i+1]
    # Build run starts/ends
    if len(changes) == 0:
        # Entire row is one run
        run_lengths_arr = np.array([width], dtype=np.int32)
        run_values_arr = np.array([row_data[0]], dtype=np.uint8)
    else:
        run_starts = np.empty(len(changes) + 1, dtype=np.int32)
        run_starts[0] = 0
        run_starts[1:] = changes + 1
        run_ends = np.empty(len(changes) + 1, dtype=np.int32)
        run_ends[:-1] = changes + 1
        run_ends[-1] = width
        run_lengths_arr = run_ends - run_starts
        run_values_arr = row_data[run_starts]

    # Convert to Python lists for the opcode loop (small — typically 10-100 runs)
    run_lengths = run_lengths_arr.tolist()
    run_values = run_values_arr.tolist()

    for color, run in zip(run_values, run_lengths):
        # Clamp runs to 16383 max (PGS limit), emit multiple opcodes if needed
        pos = 0
        while pos < run:
            chunk = min(run - pos, 16383)
            if color == 0:
                if chunk < 64:
                    out.append(0x00)
                    out.append(chunk & 0x3F)
                else:
                    out.append(0x00)
                    out.append(0x40 | ((chunk >> 8) & 0x3F))
                    out.append(chunk & 0xFF)
            else:
                if chunk == 1:
                    out.append(color)
                elif chunk < 64:
                    out.append(0x00)
                    out.append(0x80 | (chunk & 0x3F))
                    out.append(color)
                else:
                    out.append(0x00)
                    out.append(0xC0 | ((chunk >> 8) & 0x3F))
                    out.append(chunk & 0xFF)
                    out.append(color)
            pos += chunk

    # End of line
    out.append(0x00)
    out.append(0x00)
    return out


def _encode_rle(indices, width: int, height: int) -> bytes:
    """RLE-encode palette indices into PGS bitmap data (numpy-accelerated).

    Uses numpy to find run boundaries per row in C, then emits PGS RLE
    opcodes from the (much smaller) run list.  The output is byte-identical
    to _encode_rle_python().

    Parameters
    ----------
    indices : list[int] | np.ndarray
        Flat palette indices, length = width * height.
    width, height : int
        Image dimensions.

    Returns
    -------
    bytes
        PGS RLE-encoded bitmap data.
    """
    arr = np.asarray(indices, dtype=np.uint8).reshape(height, width)
    out = bytearray()
    for row_idx in range(height):
        out += _encode_rle_row(arr[row_idx])
    return bytes(out)


# ── Palette quantization ─────────────────────────────────────────────

# Alpha threshold for pre-quantization clamping.  Pixels with alpha below
# this value are zeroed to fully transparent BEFORE palette quantization.
# This prevents near-invisible glow fringe pixels (alpha 1–7) from being
# clustered with opaque text during median-cut quantization, which would
# inflate their alpha to the cluster's average (e.g. alpha 3 → 180).
_ALPHA_CLAMP_THRESHOLD = 8

def _quantize_image(image: "PILImage", max_colors: int = 255) -> tuple[np.ndarray, list[tuple[int, int, int, int]]]:
    """Quantize an RGBA image to at most *max_colors* colors + transparent.

    Returns
    -------
    indices : np.ndarray (dtype=uint8)
        Flat array of palette indices (0 = fully transparent, 1–max_colors = colors).
    palette : list[(Y, Cb, Cr, Alpha)]
        256-entry palette in PGS format.  Index 0 is always (16, 128, 128, 0)
        representing fully transparent.
    """
    img = image.convert('RGBA')

    # Clamp near-zero alpha pixels to fully transparent before quantization.
    # CSS text-shadow glow creates smooth alpha gradients at text edges.
    # Without this clamp, PIL quantize(method=2) clusters faint fringe pixels
    # (alpha 1–7) with opaque text sharing similar RGB values, inflating
    # their alpha to the cluster average and creating visible colored halos
    # at region boundaries.
    raw = np.frombuffer(img.tobytes(), dtype=np.uint8).reshape(-1, 4).copy()
    faint_mask = (raw[:, 3] > 0) & (raw[:, 3] < _ALPHA_CLAMP_THRESHOLD)
    if np.any(faint_mask):
        raw[faint_mask] = 0
        from PIL import Image as _PILImage
        img = _PILImage.frombytes('RGBA', img.size, raw.tobytes())

    # Extract alpha channel as numpy array — one C-level copy
    alpha = np.frombuffer(img.tobytes(), dtype=np.uint8).reshape(-1, 4)[:, 3]

    # Quantize to max_colors colors (PIL C implementation)
    quantized = img.quantize(colors=max_colors, method=2, dither=0)
    q_palette_flat = quantized.getpalette(rawmode='RGBA')
    if q_palette_flat is None:
        q_palette_rgb = quantized.getpalette()
        if q_palette_rgb is None:
            q_palette_flat = [0, 0, 0, 0] * 256
        else:
            q_palette_flat = []
            for i in range(0, len(q_palette_rgb), 3):
                q_palette_flat.extend([q_palette_rgb[i], q_palette_rgb[i+1],
                                       q_palette_rgb[i+2], 255])

    # Build palette tuples from flat list
    q_colors = []
    for i in range(0, min(len(q_palette_flat), 256 * 4), 4):
        q_colors.append((q_palette_flat[i], q_palette_flat[i+1],
                         q_palette_flat[i+2], q_palette_flat[i+3]))

    # Get quantized pixel indices as numpy array via tobytes() (avoids deprecated getdata())
    q_data = np.frombuffer(quantized.tobytes(), dtype=np.uint8)

    # Build PGS palette: index 0 = transparent, 1–255 = quantized colors
    pgs_palette = [(16, 128, 128, 0)]
    for rgba in q_colors:
        r, g, b, a = rgba
        y, cb, cr = _rgb_to_ycbcr(r, g, b)
        pgs_palette.append((y, cb, cr, a))
    while len(pgs_palette) < 256:
        pgs_palette.append((16, 128, 128, 0))

    # Vectorized index remapping: transparent pixels → 0, others → q_data + 1
    # Replaces 4.7M-iteration Python for loop with three numpy C-level ops
    indices = np.where(alpha == 0, np.uint8(0), q_data + np.uint8(1))

    return indices, pgs_palette


# ── Segment builders ─────────────────────────────────────────────────

def _make_segment(seg_type: int, pts_90khz: int, data: bytes) -> bytes:
    """Build a complete PGS segment with header."""
    header = struct.pack('>2sIIBH',
                         _PG_MAGIC,
                         pts_90khz & 0xFFFFFFFF,
                         0,                      # DTS = 0 always
                         seg_type,
                         len(data))
    return header + data


def _make_pcs(canvas_width: int, canvas_height: int, comp_number: int,
              comp_state: int, palette_update: bool, palette_id: int,
              objects: list[tuple[int, int, int, int, int]]) -> bytes:
    """Build PCS (Presentation Composition Segment) payload.

    Parameters
    ----------
    objects : list of (object_id, window_id, x, y, crop_flag)
        Each entry is one object reference.  crop_flag is always 0.
    """
    data = bytearray()
    # Video dimensions
    data += struct.pack('>HH', canvas_width, canvas_height)
    # Frame rate (always 0x10 = 23.976 fps — typical, but ignored by most decoders)
    data.append(0x10)
    # Composition number (uint16)
    data += struct.pack('>H', comp_number & 0xFFFF)
    # Composition state
    data.append(comp_state)
    # Palette update flag
    data.append(0x80 if palette_update else 0x00)
    # Palette ID
    data.append(palette_id)
    # Number of composition objects
    data.append(len(objects))
    # Object references
    for obj_id, window_id, x, y, crop_flag in objects:
        data += struct.pack('>H', obj_id)
        data.append(window_id)
        data.append(crop_flag)
        data += struct.pack('>HH', x, y)
    return bytes(data)


def _make_wds(windows: list[tuple[int, int, int, int, int]]) -> bytes:
    """Build WDS (Window Definition Segment) payload.

    Parameters
    ----------
    windows : list of (window_id, x, y, width, height)
    """
    data = bytearray()
    data.append(len(windows))
    for win_id, x, y, w, h in windows:
        data.append(win_id)
        data += struct.pack('>HHHH', x, y, w, h)
    return bytes(data)


def _make_pds(palette_id: int, palette_version: int,
              entries: list[tuple[int, int, int, int, int]]) -> bytes:
    """Build PDS (Palette Definition Segment) payload.

    Parameters
    ----------
    entries : list of (index, Y, Cr, Cb, Alpha)
        Note the Cr/Cb order matches the PGS spec and _parse_sup() in ocr.py.
    """
    data = bytearray()
    data.append(palette_id)
    data.append(palette_version)
    for idx, y_val, cr_val, cb_val, alpha in entries:
        data.append(idx)
        data.append(y_val)
        data.append(cr_val)
        data.append(cb_val)
        data.append(alpha)
    return bytes(data)


def _make_ods(object_id: int, version: int, is_first: bool, is_last: bool,
              width: int, height: int, rle_data: bytes) -> bytes:
    """Build ODS (Object Definition Segment) payload.

    Parameters
    ----------
    is_first, is_last : bool
        Sequence flags.  For single-fragment objects, both are True.
    """
    data = bytearray()
    data += struct.pack('>H', object_id)
    data.append(version)
    # Sequence flag: 0x80 = first, 0x40 = last, 0xC0 = first+last (single fragment)
    seq_flag = 0
    if is_first:
        seq_flag |= 0x80
    if is_last:
        seq_flag |= 0x40
    data.append(seq_flag)
    # Object data length (3 bytes big-endian): RLE data + 4 bytes for width+height
    obj_data_len = len(rle_data) + 4
    data.append((obj_data_len >> 16) & 0xFF)
    data.append((obj_data_len >> 8) & 0xFF)
    data.append(obj_data_len & 0xFF)
    # Width and height (only in first fragment)
    data += struct.pack('>HH', width, height)
    data += rle_data
    return bytes(data)


# ── ODS fragmentation ────────────────────────────────────────────────

# PGS segment data size is a uint16 (max 65535 bytes).  Full-frame bitmaps
# at 1080p+ routinely exceed this.  The spec allows splitting a single ODS
# object into multiple segments: the first fragment carries the total data
# length + dimensions; continuation fragments carry only raw RLE chunks.

_MAX_SEG_PAYLOAD = 65535
_ODS_FIRST_OVERHEAD = 11   # obj_id(2) + ver(1) + seq(1) + data_len(3) + w(2) + h(2)
_ODS_CONT_OVERHEAD = 4     # obj_id(2) + ver(1) + seq(1)


def _build_ods_segments(object_id: int, version: int,
                        width: int, height: int,
                        rle_data: bytes, pts_90khz: int) -> list[bytes]:
    """Build one or more ODS segments, fragmenting if payload > 65535 bytes."""
    total_first_payload = _ODS_FIRST_OVERHEAD + len(rle_data)

    if total_first_payload <= _MAX_SEG_PAYLOAD:
        # Single fragment — fits in one segment
        ods_data = _make_ods(object_id, version, True, True,
                             width, height, rle_data)
        return [_make_segment(_SEG_ODS, pts_90khz, ods_data)]

    # ── Multi-fragment ODS ───────────────────────────────────────────
    segments = []
    first_rle_max = _MAX_SEG_PAYLOAD - _ODS_FIRST_OVERHEAD
    cont_rle_max = _MAX_SEG_PAYLOAD - _ODS_CONT_OVERHEAD

    # First fragment: includes total data length + dimensions
    first_chunk = rle_data[:first_rle_max]
    remaining = rle_data[first_rle_max:]

    data = bytearray()
    data += struct.pack('>H', object_id)
    data.append(version)
    data.append(0x80)  # first fragment, not last
    # obj_data_len = total RLE across ALL fragments + 4 (width + height)
    obj_data_len = len(rle_data) + 4
    data.append((obj_data_len >> 16) & 0xFF)
    data.append((obj_data_len >> 8) & 0xFF)
    data.append(obj_data_len & 0xFF)
    data += struct.pack('>HH', width, height)
    data += first_chunk
    segments.append(_make_segment(_SEG_ODS, pts_90khz, bytes(data)))

    # Continuation fragments
    offset = 0
    while offset < len(remaining):
        chunk_end = min(offset + cont_rle_max, len(remaining))
        is_last = (chunk_end == len(remaining))
        chunk = remaining[offset:chunk_end]

        data = bytearray()
        data += struct.pack('>H', object_id)
        data.append(version)
        data.append(0x40 if is_last else 0x00)
        data += chunk
        segments.append(_make_segment(_SEG_ODS, pts_90khz, bytes(data)))
        offset = chunk_end

    return segments


# ── Region splitting ────────────────────────────────────────────────

# Minimum vertical gap (in transparent rows) to trigger a 2-object split.
# Gaps smaller than this are treated as part of the same region — prevents
# splitting within the top cluster (between romaji and furigana/kanji, typically
# 5–20 transparent rows).
_MIN_SPLIT_GAP = 50


def split_regions(image: "PILImage", x: int, y: int,
                  min_gap: int = _MIN_SPLIT_GAP,
                  canvas_height: int | None = None,
                  ) -> list[tuple["PILImage", int, int]]:
    """Split an RGBA bitmap into 1 or 2 vertically-separated content regions.

    Scans row alpha to find the largest vertical gap of fully-transparent rows.
    If the gap >= *min_gap*, splits into two tightly-cropped sub-images, each
    with its own (x, y) canvas position.  Otherwise returns the original image
    as a single region.

    Parameters
    ----------
    image : PILImage
        RGBA cropped bitmap (output of getbbox() crop).
    x, y : int
        Canvas position of the top-left corner of *image*.
    min_gap : int
        Minimum transparent gap (in rows) to trigger a split.
    canvas_height : int or None
        Full canvas height in pixels.  When provided, the split is suppressed
        if the gap midpoint falls outside the middle band (25 %–75 % of the
        canvas) — i.e. both content clusters are in the same screen half and
        should stay as one region.  ``None`` disables the guard (backward
        compatible).

    Returns
    -------
    list of (sub_image, sub_x, sub_y)
        1 or 2 regions.  Each sub_image is tightly cropped on its own rows.
        sub_x may differ from *x* if the horizontal content bounds differ per
        region (we re-crop horizontally too).
    """
    w, h = image.size
    if h < min_gap * 2:
        # Image too short to possibly contain a gap worth splitting
        return [(image, x, y)]

    # Per-row content mask: True if ANY pixel in the row has alpha > 0
    alpha = np.frombuffer(image.tobytes(), dtype=np.uint8).reshape(h, w, 4)[:, :, 3]
    row_has_content = np.any(alpha > 0, axis=1)  # shape: (h,)

    # Find contiguous blocks of content rows
    # Pad with False to detect edges at boundaries
    padded = np.concatenate(([False], row_has_content, [False]))
    diffs = np.diff(padded.astype(np.int8))
    block_starts = np.flatnonzero(diffs == 1)   # transition 0→1
    block_ends = np.flatnonzero(diffs == -1)     # transition 1→0 (exclusive)

    if len(block_starts) == 0:
        # No content at all
        return [(image, x, y)]

    if len(block_starts) == 1:
        # Single content block — no gap to split on
        return [(image, x, y)]

    # Find the largest gap between consecutive content blocks
    # gap between block_ends[i] and block_starts[i+1]
    gaps = block_starts[1:] - block_ends[:-1]
    best_gap_idx = int(np.argmax(gaps))
    best_gap_size = int(gaps[best_gap_idx])

    if best_gap_size < min_gap:
        # Largest gap is too small — keep as single region
        return [(image, x, y)]

    # Split at the best gap
    split_top_end = int(block_ends[best_gap_idx])       # last content row of top region (exclusive)
    split_bot_start = int(block_starts[best_gap_idx + 1])  # first content row of bottom region

    # Canvas-aware guard: suppress split when both clusters are in the same
    # screen half (gap midpoint outside 25%–75% of canvas height).
    if canvas_height is not None:
        gap_mid_canvas = y + (split_top_end + split_bot_start) / 2.0
        mid_lo = canvas_height * 0.25
        mid_hi = canvas_height * 0.75
        if not (mid_lo <= gap_mid_canvas <= mid_hi):
            return [(image, x, y)]

    # Merge blocks: top region = all blocks up to and including best_gap_idx
    #               bottom region = all blocks after
    top_row_start = int(block_starts[0])
    top_row_end = split_top_end
    bot_row_start = split_bot_start
    bot_row_end = int(block_ends[-1])

    # Crop each region (vertically from row bounds, re-crop horizontally via getbbox)
    regions = []
    for row_start, row_end in [(top_row_start, top_row_end),
                                (bot_row_start, bot_row_end)]:
        sub_img = image.crop((0, row_start, w, row_end))
        # Re-crop horizontally to tight content bounds
        sub_bbox = sub_img.getbbox()
        if sub_bbox is None:
            continue  # empty after crop (shouldn't happen)
        tight = sub_img.crop(sub_bbox)
        sub_x = x + sub_bbox[0]
        sub_y = y + row_start + sub_bbox[1]
        regions.append((tight, sub_x, sub_y))

    if len(regions) == 0:
        return [(image, x, y)]

    return regions


# ── Display set assembly ─────────────────────────────────────────────

_encode_detail_count = [0]   # module-level counter for per-frame timing


def _build_show_segments(ds: DisplaySet, comp_number: int,
                         extra_regions: list[tuple["PILImage", int, int]] | None = None
                         ) -> list[bytes]:
    """Build all segments for a "show" display set.

    When *extra_regions* is None (default), encodes ``ds.image`` as a single
    PGS object — identical to the original single-object path.

    When *extra_regions* is a list of ``(image, x, y)`` tuples (1 or 2 items),
    each region becomes an independent PGS object with its own ODS.  The palette
    is shared: all regions are combined into one image for quantization, then the
    quantized indices are sliced back to per-region arrays for RLE encoding.

    Parameters
    ----------
    ds : DisplaySet
        Provides timing, canvas dimensions.  ``ds.image`` is used for the
        single-object fallback.
    comp_number : int
        PGS composition number (auto-incrementing).
    extra_regions : list of (PILImage, x, y) | None
        If provided, overrides ds.image.  Each tuple is one object region.
    """
    _detail = _encode_detail_count[0] < 10
    if _detail:
        _t0 = _time.monotonic()
        _idx = _encode_detail_count[0]
    _encode_detail_count[0] += 1

    pts = int(ds.start_ms * 90)

    # ── Determine regions ────────────────────────────────────────────
    if extra_regions is not None and len(extra_regions) >= 1:
        regions = extra_regions[:2]   # PGS max: 2 objects
    else:
        regions = [(ds.image, ds.x, ds.y)]

    num_objects = len(regions)

    if num_objects == 1:
        # ── Single-object fast path (unchanged logic) ────────────────
        img0, x0, y0 = regions[0]
        if _detail:
            _tq0 = _time.monotonic()
        indices, palette = _quantize_image(img0)
        w, h = img0.size
        if _detail:
            _tq1 = _time.monotonic()
            _tr0 = _time.monotonic()
        rle_data = _encode_rle(indices, w, h)
        if _detail:
            _tr1 = _time.monotonic()
            _ts0 = _time.monotonic()

        pcs_data = _make_pcs(
            ds.canvas_width, ds.canvas_height,
            comp_number, _COMP_EPOCH_START,
            palette_update=False, palette_id=0,
            objects=[(0, 0, x0, y0, 0)],
        )
        wds_data = _make_wds([(0, x0, y0, w, h)])
        pal_entries = []
        for i, (y_val, cb_val, cr_val, a) in enumerate(palette):
            if a > 0 or i == 0:
                pal_entries.append((i, y_val, cr_val, cb_val, a))
        pds_data = _make_pds(0, 0, pal_entries)
        ods_segments = _build_ods_segments(0, 0, w, h, rle_data, pts)

        segments = [
            _make_segment(_SEG_PCS, pts, pcs_data),
            _make_segment(_SEG_WDS, pts, wds_data),
            _make_segment(_SEG_PDS, pts, pds_data),
            *ods_segments,
            _make_segment(_SEG_END, pts, b''),
        ]
        if _detail:
            _ts1 = _time.monotonic()
            print(
                f"[ENCODE {_idx}] 1obj "
                f"quantize={(_tq1-_tq0)*1000:.0f}ms "
                f"rle={(_tr1-_tr0)*1000:.0f}ms "
                f"segments={(_ts1-_ts0)*1000:.0f}ms "
                f"total={(_ts1-_t0)*1000:.0f}ms "
                f"bitmap={w}x{h} "
                f"rle_bytes={len(rle_data)} "
                f"pixels={w*h}"
            )
        return segments

    # ── 2-object path ────────────────────────────────────────────────
    # Quantize each region independently (subtitle text uses few colors,
    # so each region's 255-color palette is more than adequate).
    if _detail:
        _tq0 = _time.monotonic()

    region_data = []  # list of (indices, palette, w, h, x, y)
    for img_r, xr, yr in regions:
        idx_r, pal_r = _quantize_image(img_r)
        wr, hr = img_r.size
        region_data.append((idx_r, pal_r, wr, hr, xr, yr))

    if _detail:
        _tq1 = _time.monotonic()
        _tr0 = _time.monotonic()

    rle_list = []
    for idx_r, pal_r, wr, hr, xr, yr in region_data:
        rle_list.append(_encode_rle(idx_r, wr, hr))

    if _detail:
        _tr1 = _time.monotonic()
        _ts0 = _time.monotonic()

    # PCS: 2 composition objects
    pcs_objects = []
    wds_windows = []
    for obj_id, (idx_r, pal_r, wr, hr, xr, yr) in enumerate(region_data):
        pcs_objects.append((obj_id, obj_id, xr, yr, 0))
        wds_windows.append((obj_id, xr, yr, wr, hr))

    pcs_data = _make_pcs(
        ds.canvas_width, ds.canvas_height,
        comp_number, _COMP_EPOCH_START,
        palette_update=False, palette_id=0,
        objects=pcs_objects,
    )
    wds_data = _make_wds(wds_windows)

    # PDS: use palette from the first region (both are small subtitle palettes).
    # The second region is quantized independently; it gets its own ODS indices
    # against its own palette.  PGS spec allows only 1 palette per display set,
    # but each ODS object_id maps to the same palette_id.  Since both regions
    # are quantized independently, we emit both palettes merged: first region's
    # colors in indices 1–255, second region in palette_id=1 ... but actually
    # the PGS spec says ONE palette per display set.  So we need to do a
    # combined quantization or just accept that each region uses its own
    # independent 255-color space.  For PGS playback, each object's pixel
    # indices reference the SAME palette.  We need a unified palette.
    #
    # Practical approach: since subtitle regions use very few colors (typically
    # <20 each), we merge both palettes.  First region keeps indices 1–N,
    # second region gets indices N+1–M.  We remap second region's indices.

    pal0 = region_data[0][1]  # 256 entries from region 0
    pal1 = region_data[1][1]  # 256 entries from region 1
    idx1_raw = region_data[1][0]  # numpy array of indices for region 1

    # Collect non-transparent palette indices from each region (numpy C-level)
    u0 = np.unique(region_data[0][0])
    used0 = set(u0[u0 > 0].tolist())
    u1 = np.unique(idx1_raw)
    used1 = set(u1[u1 > 0].tolist())

    n_used0 = len(used0)
    n_used1 = len(used1)

    if n_used0 + n_used1 <= 255:
        # Both palettes fit — remap region 1 indices to avoid collision
        # Region 0: indices 1..max0 keep their values
        # Region 1: indices shifted by max0
        max0 = max(used0) if used0 else 0
        remap = np.zeros(256, dtype=np.uint8)
        for old_idx in used1:
            remap[old_idx] = old_idx + max0
        # Build merged palette: index 0=transparent, 1..max0 from pal0, max0+1.. from pal1
        merged_palette = [(16, 128, 128, 0)]  # index 0
        for i in range(1, 256):
            if i <= max0:
                merged_palette.append(pal0[i])
            elif i <= max0 + n_used1:
                # Map: merged index i → pal1 original index
                # Find which used1 index maps to i
                merged_palette.append((16, 128, 128, 0))  # placeholder
            else:
                merged_palette.append((16, 128, 128, 0))
        # Fill in region 1 palette entries at their remapped positions
        for old_idx in sorted(used1):
            new_idx = int(remap[old_idx])
            if new_idx < 256:
                merged_palette[new_idx] = pal1[old_idx]

        # Remap region 1's RLE indices
        idx1_remapped = remap[idx1_raw]
        rle_list[1] = _encode_rle(idx1_remapped,
                                   region_data[1][2], region_data[1][3])
    else:
        # Rare: too many colors for a single palette.  Fall back to region 0's
        # palette for both (region 1 will have slight color shifts).  This is
        # extremely unlikely for subtitle text.
        merged_palette = pal0

    # Emit palette entries
    pal_entries = []
    for i, (y_val, cb_val, cr_val, a) in enumerate(merged_palette):
        if a > 0 or i == 0:
            pal_entries.append((i, y_val, cr_val, cb_val, a))
    pds_data = _make_pds(0, 0, pal_entries)

    # ODS for each object
    all_ods = []
    for obj_id in range(num_objects):
        _, _, wr, hr, _, _ = region_data[obj_id]
        all_ods.extend(
            _build_ods_segments(obj_id, 0, wr, hr, rle_list[obj_id], pts)
        )

    segments = [
        _make_segment(_SEG_PCS, pts, pcs_data),
        _make_segment(_SEG_WDS, pts, wds_data),
        _make_segment(_SEG_PDS, pts, pds_data),
        *all_ods,
        _make_segment(_SEG_END, pts, b''),
    ]
    if _detail:
        _ts1 = _time.monotonic()
        total_pixels = sum(rd[2] * rd[3] for rd in region_data)
        dims_str = " + ".join(f"{rd[2]}x{rd[3]}" for rd in region_data)
        print(
            f"[ENCODE {_idx}] 2obj "
            f"quantize={(_tq1-_tq0)*1000:.0f}ms "
            f"rle={(_tr1-_tr0)*1000:.0f}ms "
            f"segments={(_ts1-_ts0)*1000:.0f}ms "
            f"total={(_ts1-_t0)*1000:.0f}ms "
            f"bitmaps={dims_str} "
            f"pixels={total_pixels}"
        )
    return segments


def _build_clear_segments(ds: DisplaySet, comp_number: int,
                          pts_override: int | None = None) -> list[bytes]:
    """Build segments for a "clear" display set (removes bitmap from screen).

    Parameters
    ----------
    pts_override : int | None
        If provided, use this 90 kHz PTS instead of ``ds.end_ms * 90``.
        Used by write_sup() to prevent PTS collision with the next show set.
    """
    pts = pts_override if pts_override is not None else int(ds.end_ms * 90)

    # PCS — epoch start, no objects (clears screen).
    # Must be EPOCH_START (0x80) so the player can seek to this point
    # and correctly clear without depending on prior state.
    pcs_data = _make_pcs(
        ds.canvas_width, ds.canvas_height,
        comp_number, _COMP_EPOCH_START,
        palette_update=False, palette_id=0,
        objects=[],
    )

    # WDS — minimal 1×1 window.  A zero-area window (0×0) can confuse
    # ffmpeg's SUP demuxer during mux even though mpv's native decoder
    # tolerates it when loading external .sup files.
    wds_data = _make_wds([(0, 0, 0, 1, 1)])

    # END
    end_data = b''

    return [
        _make_segment(_SEG_PCS, pts, pcs_data),
        _make_segment(_SEG_WDS, pts, wds_data),
        _make_segment(_SEG_END, pts, end_data),
    ]


# ── Epoch management ─────────────────────────────────────────────────
#
# PGS composition states allow incremental updates within an "epoch":
#   Epoch Start (0x80)       — fully self-contained, seek-safe
#   Acquisition Point (0x40) — full reference for seeking mid-epoch
#   Normal (0x00)            — incremental, only changed objects re-encoded
#
# When only one of two objects changes between abutting events, a Normal
# display set redefines only the changed object — the other persists on
# screen without flickering.

@dataclass
class _CachedObject:
    """Cached encoding data for one PGS object within an epoch."""
    object_id: int
    rle_data: bytes
    width: int
    height: int
    x: int
    y: int
    palette_entries: list   # [(idx, Y, Cr, Cb, A), ...]
    content_key: tuple


def _compute_windows(regions, canvas_width, canvas_height):
    """Compute PGS window definitions for 1 or 2 regions.

    1 region: single window covering the object bounds.
    2 regions: generous fixed windows — top 45% and bottom 25% of canvas.
    """
    if len(regions) == 1:
        img, x, y = regions[0]
        w, h = img.size
        return [(0, x, y, w, h)]
    # 2 regions: fixed generous windows
    top_h = int(canvas_height * 0.45)
    bot_y = int(canvas_height * 0.75)
    bot_h = canvas_height - bot_y
    return [
        (0, 0, 0, canvas_width, top_h),
        (1, 0, bot_y, canvas_width, bot_h),
    ]


def _check_windows_fit(regions, windows):
    """Check if every region's bitmap fits within its assigned window."""
    for i, (img, rx, ry) in enumerate(regions):
        if i >= len(windows):
            return False
        _, wx, wy, ww, wh = windows[i]
        rw, rh = img.size
        if rx < wx or ry < wy or rx + rw > wx + ww or ry + rh > wy + wh:
            return False
    return True


def _quantize_for_epoch(regions):
    """Quantize all regions with reserved palette ranges for epoch management.

    1 object: full range 1–255.
    2 objects: object 0 uses 1–127, object 1 uses 128–254.

    Returns (obj_data_list, merged_pal_entries) where:
    - obj_data_list: [(rle_data, w, h, pal_entries), ...] per object
    - merged_pal_entries: [(idx, Y, Cr, Cb, A), ...] for PDS
    """
    num = len(regions)

    if num == 1:
        img = regions[0][0]
        indices, palette = _quantize_image(img, max_colors=255)
        w, h = img.size
        rle_data = _encode_rle(indices, w, h)
        pal_entries = []
        for i, (y_val, cb_val, cr_val, a) in enumerate(palette):
            if a > 0 or i == 0:
                pal_entries.append((i, y_val, cr_val, cb_val, a))
        return [(rle_data, w, h, pal_entries)], pal_entries

    # 2 objects: reserved palette ranges
    all_entries = [(0, 16, 128, 128, 0)]
    obj_data = []

    for obj_idx, (img, x, y) in enumerate(regions):
        indices, palette = _quantize_image(img, max_colors=127)
        w, h = img.size
        offset = obj_idx * 127

        if offset > 0:
            remapped = np.where(
                indices == 0, np.uint8(0),
                (indices.astype(np.uint16) + offset).astype(np.uint8),
            )
        else:
            remapped = indices

        rle_data = _encode_rle(remapped, w, h)

        obj_entries = []
        for old_idx in range(1, 128):
            new_idx = old_idx + offset
            if new_idx >= 255:
                break
            if old_idx < len(palette):
                y_val, cb_val, cr_val, a = palette[old_idx]
                entry = (new_idx, y_val, cr_val, cb_val, a)
                obj_entries.append(entry)
                if a > 0:
                    all_entries.append(entry)

        obj_data.append((rle_data, w, h, obj_entries))

    return obj_data, all_entries


def _quantize_single_object(image, obj_index, num_objects):
    """Quantize a single object's image within its reserved palette range.

    Used for updating individual objects in AP/Normal display sets.
    """
    if num_objects == 1:
        max_c, offset = 255, 0
    else:
        max_c = 127
        offset = obj_index * 127

    indices, palette = _quantize_image(image, max_colors=max_c)
    w, h = image.size

    if offset > 0:
        indices = np.where(
            indices == 0, np.uint8(0),
            (indices.astype(np.uint16) + offset).astype(np.uint8),
        )

    rle_data = _encode_rle(indices, w, h)

    pal_entries = []
    max_old = 128 if num_objects > 1 else 256
    for old_idx in range(1, max_old):
        new_idx = old_idx + offset
        if new_idx >= 255 and num_objects > 1:
            break
        if old_idx < len(palette):
            y_val, cb_val, cr_val, a = palette[old_idx]
            pal_entries.append((new_idx, y_val, cr_val, cb_val, a))

    return rle_data, w, h, pal_entries


def _build_epoch_segments(ds, comp_number, regions, region_keys, epoch_state):
    """Decide composition state and build segments for an epoch-aware display set.

    Returns (segments, new_epoch_state, ds_type_str).
    ds_type_str is one of: 'epoch_start', 'acquisition_point', 'normal', 'skipped'.
    """
    if not regions:
        return [], epoch_state, 'skipped'

    # 1. No prior state or region count changed → Epoch Start
    if epoch_state is None or len(regions) != epoch_state.get('num_objects', 0):
        segs, state = _emit_epoch_start(ds, comp_number, regions, region_keys)
        return segs, state, 'epoch_start'

    # 2. All content keys identical → Skip
    prev_keys = epoch_state.get('content_keys', [])
    changed = []
    for i, key in enumerate(region_keys):
        if i >= len(prev_keys) or key != prev_keys[i]:
            changed.append(i)
    if not changed:
        return [], epoch_state, 'skipped'

    # 3. Windows don't fit or AP interval → Acquisition Point
    ds_in_epoch = epoch_state.get('ds_in_epoch', 0)
    windows = epoch_state.get('windows', [])
    window_fallback = not _check_windows_fit(regions, windows)
    if window_fallback or (ds_in_epoch > 0 and ds_in_epoch % _AP_INTERVAL == 0):
        segs, state = _emit_acquisition_point(
            ds, comp_number, regions, region_keys, changed, epoch_state,
            window_fallback=window_fallback,
        )
        return segs, state, 'acquisition_point'

    # 4. Normal — only changed objects
    segs, state = _emit_normal(ds, comp_number, regions, region_keys, changed, epoch_state)
    return segs, state, 'normal'


def _emit_epoch_start(ds, comp_number, regions, region_keys):
    """Emit a full Epoch Start display set (PCS 0x80 + WDS + PDS + all ODS + END)."""
    pts = int(ds.start_ms * 90)
    cw, ch = ds.canvas_width, ds.canvas_height

    windows = _compute_windows(regions, cw, ch)
    obj_data, merged_pal = _quantize_for_epoch(regions)

    pcs_objects = []
    cached = []
    for i, ((rle, w, h, pal_e), (img, x, y)) in enumerate(zip(obj_data, regions)):
        win_id = windows[i][0]
        pcs_objects.append((i, win_id, x, y, 0))
        cached.append(_CachedObject(
            object_id=i, rle_data=rle, width=w, height=h,
            x=x, y=y, palette_entries=pal_e,
            content_key=region_keys[i] if i < len(region_keys) else (),
        ))

    pcs_data = _make_pcs(cw, ch, comp_number, _COMP_EPOCH_START,
                         palette_update=False, palette_id=0, objects=pcs_objects)
    wds_data = _make_wds(windows)
    pds_data = _make_pds(0, 0, merged_pal)  # version 0: epoch start

    segs = [
        _make_segment(_SEG_PCS, pts, pcs_data),
        _make_segment(_SEG_WDS, pts, wds_data),
        _make_segment(_SEG_PDS, pts, pds_data),
    ]
    for i, (rle, w, h, _) in enumerate(obj_data):
        segs.extend(_build_ods_segments(i, 0, w, h, rle, pts))
    segs.append(_make_segment(_SEG_END, pts, b''))

    state = {
        'num_objects': len(regions),
        'content_keys': list(region_keys),
        'cached_objects': cached,
        'windows': windows,
        'ds_in_epoch': 1,
        'pal_version': 0,
    }
    return segs, state


def _emit_acquisition_point(ds, comp_number, regions, region_keys,
                            changed, epoch_state, window_fallback=False):
    """Emit a full Acquisition Point display set (PCS 0x40 + WDS + PDS + all ODS + END)."""
    pts = int(ds.start_ms * 90)
    cw, ch = ds.canvas_width, ds.canvas_height
    num = len(regions)
    pal_version = epoch_state.get('pal_version', 0) + 1

    windows = _compute_windows(regions, cw, ch)

    if window_fallback:
        for i, (img, x, y) in enumerate(regions):
            if i < len(windows):
                _, wx, wy, ww, wh = windows[i]
                w, h = img.size
                print(f"[EPOCH] AP window fallback: obj{i} bitmap {w}x{h} at ({x},{y}) "
                      f"exceeds window ({wx},{wy},{ww},{wh})")

    cached = list(epoch_state['cached_objects'])
    all_pal = [(0, 16, 128, 128, 0)]

    for i in range(num):
        if i in changed:
            img, x, y = regions[i]
            rle, w, h, pal_e = _quantize_single_object(img, i, num)
            cached[i] = _CachedObject(
                object_id=i, rle_data=rle, width=w, height=h,
                x=x, y=y, palette_entries=pal_e,
                content_key=region_keys[i] if i < len(region_keys) else (),
            )
            all_pal.extend(e for e in pal_e if e[4] > 0)
        else:
            co = cached[i]
            all_pal.extend(e for e in co.palette_entries if e[4] > 0)

    pcs_objects = []
    for i in range(num):
        co = cached[i]
        win_id = windows[i][0]
        pcs_objects.append((i, win_id, co.x, co.y, 0))

    pcs_data = _make_pcs(cw, ch, comp_number, _COMP_ACQUISITION_POINT,
                         palette_update=False, palette_id=0, objects=pcs_objects)
    wds_data = _make_wds(windows)
    pds_data = _make_pds(0, pal_version, all_pal)

    segs = [
        _make_segment(_SEG_PCS, pts, pcs_data),
        _make_segment(_SEG_WDS, pts, wds_data),
        _make_segment(_SEG_PDS, pts, pds_data),
    ]
    for i in range(num):
        co = cached[i]
        segs.extend(_build_ods_segments(i, 0, co.width, co.height, co.rle_data, pts))
    segs.append(_make_segment(_SEG_END, pts, b''))

    state = {
        'num_objects': num,
        'content_keys': list(region_keys),
        'cached_objects': cached,
        'windows': windows,
        'ds_in_epoch': epoch_state['ds_in_epoch'] + 1,
        'pal_version': pal_version,
    }
    return segs, state


def _emit_normal(ds, comp_number, regions, region_keys, changed, epoch_state):
    """Emit a partial Normal display set (PCS 0x00 + PDS + changed ODS only + END).

    No WDS — windows persist from Epoch Start.  PCS lists ALL objects so both
    remain visible.  PDS includes the FULL palette (changed + unchanged) to
    avoid flicker on decoders that treat PDS as a complete palette definition.
    """
    pts = int(ds.start_ms * 90)
    cw, ch = ds.canvas_width, ds.canvas_height
    num = len(regions)

    cached = list(epoch_state['cached_objects'])
    windows = epoch_state['windows']
    pal_version = epoch_state.get('pal_version', 0) + 1

    # Re-quantize changed objects
    for i in changed:
        img, x, y = regions[i]
        rle, w, h, pal_e = _quantize_single_object(img, i, num)
        cached[i] = _CachedObject(
            object_id=i, rle_data=rle, width=w, height=h,
            x=x, y=y, palette_entries=pal_e,
            content_key=region_keys[i] if i < len(region_keys) else (),
        )

    # Full palette: transparent + all objects' entries (changed and unchanged).
    # Sending only the changed range would cause buggy decoders to flash the
    # unchanged object by clearing its palette entries.
    pal_entries = [(0, 16, 128, 128, 0)]
    for i in range(num):
        co = cached[i]
        pal_entries.extend(e for e in co.palette_entries if e[4] > 0)

    # PCS lists ALL objects (changed and unchanged)
    pcs_objects = []
    for i in range(num):
        co = cached[i]
        win_id = windows[i][0] if i < len(windows) else 0
        pcs_objects.append((i, win_id, co.x, co.y, 0))

    pcs_data = _make_pcs(cw, ch, comp_number, _COMP_NORMAL,
                         palette_update=False, palette_id=0, objects=pcs_objects)
    pds_data = _make_pds(0, pal_version, pal_entries)

    segs = [
        _make_segment(_SEG_PCS, pts, pcs_data),
        # No WDS for Normal — windows persist from Epoch Start
        _make_segment(_SEG_PDS, pts, pds_data),
    ]
    for i in changed:
        co = cached[i]
        segs.extend(_build_ods_segments(i, 0, co.width, co.height, co.rle_data, pts))
    segs.append(_make_segment(_SEG_END, pts, b''))

    state = {
        'num_objects': num,
        'content_keys': list(region_keys),
        'cached_objects': cached,
        'windows': windows,
        'ds_in_epoch': epoch_state['ds_in_epoch'] + 1,
        'pal_version': pal_version,
    }
    return segs, state


# ── Public API ───────────────────────────────────────────────────────

class SupWriter:
    """Streaming PGS/SUP writer — writes display sets incrementally.

    Unlike ``write_sup()`` which requires all display sets up front, this class
    accepts display sets one at a time via ``write(ds)`` and flushes each to
    disk immediately.  This bounds memory usage to at most 2 display sets
    (current + pending) regardless of total frame count or resolution.

    PTS monotonicity: the writer buffers the most recently received display set
    and only flushes it when the *next* one arrives (so it can guard the clear
    PTS against the next show PTS).  ``close()`` flushes the final buffered set.

    Usage::

        writer = SupWriter("output.sup", canvas_width=1920, canvas_height=1080)
        for ds in display_sets:
            writer.write(ds)
        writer.close()
    """

    def __init__(self, path: str, canvas_width: int, canvas_height: int):
        self._f = open(path, 'wb')
        self._comp = 0
        self._pending: DisplaySet | None = None
        self._pending_regions: list[tuple] | None = None
        self._pending_content_keys: list[tuple] | None = None
        self._canvas_w = canvas_width
        self._canvas_h = canvas_height
        self._anchor_written = False
        self._epoch_state: dict | None = None
        self.count = 0  # number of visible display sets written
        self.stats = {
            'epoch_start': 0, 'acquisition_point': 0,
            'normal': 0, 'skipped': 0, 'clears': 0,
            'ap_window_fallback': 0,
        }
        _encode_detail_count[0] = 0  # reset per-frame timing counter

    def write(self, ds: DisplaySet, extra_regions: list[tuple] | None = None,
              region_content_keys: list[tuple] | None = None) -> None:
        """Accept a display set (optionally multi-region, optionally epoch-aware).

        Parameters
        ----------
        ds : DisplaySet
            Primary display set providing timing and canvas dimensions.
        extra_regions : list of (PILImage, x, y) | None
            If provided, these 1–2 region tuples are passed to
            ``_build_show_segments`` for multi-object PGS encoding.
            When None, ``ds.image`` is encoded as a single object.
        region_content_keys : list of tuple | None
            Per-region content keys for epoch management.  When provided,
            enables incremental PGS updates (Normal/AP composition states).
            When None, falls back to Epoch Start for every display set.
        """
        # Write PTS=0 anchor on first display set if it starts after 0ms
        if not self._anchor_written:
            self._anchor_written = True
            if ds.start_ms > 0:
                anchor_pcs = _make_pcs(
                    self._canvas_w, self._canvas_h,
                    self._comp, _COMP_EPOCH_START,
                    palette_update=False, palette_id=0,
                    objects=[],
                )
                anchor_wds = _make_wds([(0, 0, 0, 1, 1)])
                for seg in [
                    _make_segment(_SEG_PCS, 0, anchor_pcs),
                    _make_segment(_SEG_WDS, 0, anchor_wds),
                    _make_segment(_SEG_END, 0, b''),
                ]:
                    self._f.write(seg)
                self._comp += 1

        if self._pending is not None:
            self._flush_pending(next_start_ms=ds.start_ms)

        self._pending = ds
        self._pending_regions = extra_regions
        self._pending_content_keys = region_content_keys

    def _flush_pending(self, next_start_ms: int | None = None) -> None:
        """Write show+clear segments for the pending display set."""
        ds = self._pending
        if ds is None:
            return

        if self._pending_content_keys is None:
            # ── Old path: Epoch Start show + Epoch Start clear ──────
            show_segs = _build_show_segments(ds, self._comp,
                                             extra_regions=self._pending_regions)
            _detail_write = self.count < 10
            if _detail_write:
                _tw0 = _time.monotonic()
            for seg in show_segs:
                self._f.write(seg)
            self._comp += 1

            clear_pts = int(ds.end_ms * 90)
            if next_start_ms is not None:
                next_show_pts = int(next_start_ms * 90)
                if clear_pts >= next_show_pts:
                    clear_pts = next_show_pts - 90

            for seg in _build_clear_segments(ds, self._comp,
                                             pts_override=clear_pts):
                self._f.write(seg)
            self._comp += 1
            if _detail_write:
                _tw1 = _time.monotonic()
                print(f"[ENCODE {self.count}] write={(_tw1-_tw0)*1000:.0f}ms")

            self.count += 1
            ds.image = None
            self._pending = None
            self._pending_regions = None
            self._pending_content_keys = None
            return

        # ── Epoch-aware path ────────────────────────────────────────
        regions = self._pending_regions or [(ds.image, ds.x, ds.y)]
        region_keys = self._pending_content_keys
        _ds_n = self.count   # sequential display set number for logging

        # Check window fallback before building segments (for stats)
        old_windows = self._epoch_state.get('windows', []) if self._epoch_state else []
        pre_window_fit = _check_windows_fit(regions, old_windows) if old_windows else True

        segs, new_state, ds_type = _build_epoch_segments(
            ds, self._comp, regions, region_keys, self._epoch_state,
        )

        if segs:
            for seg in segs:
                self._f.write(seg)
            self._comp += 1
            self._epoch_state = new_state
            self.stats[ds_type] += 1
            self.count += 1
            # Track AP window fallback
            if ds_type == 'acquisition_point' and not pre_window_fit:
                self.stats['ap_window_fallback'] += 1

            # Diagnostic logging for first 50 display sets
            if _ds_n < 50:
                _type_tag = {'epoch_start': 'ES', 'acquisition_point': 'AP',
                             'normal': 'Normal', 'skipped': 'Skip'}
                # Determine which objects changed
                prev_keys = (self._epoch_state or {}).get('content_keys', [])
                changed_objs = new_state.get('_changed', [])  # not stored, recompute
                ods_desc = "both" if len(regions) <= 1 else (
                    "all" if ds_type in ('epoch_start', 'acquisition_point') else
                    "top" if any(k != pk for k, pk in
                                zip(region_keys[:1], (self._epoch_state or {}).get('content_keys', region_keys)[:1]))
                    else "bottom"
                )
                print(
                    f"[DS {_ds_n:3d}] type={_type_tag.get(ds_type, ds_type):6s} "
                    f"pts={ds.start_ms}ms objects={len(regions)} "
                    f"content_changed={ods_desc} "
                    f"pal_ver={new_state.get('pal_version', 0)}"
                )
        else:
            self.stats['skipped'] += 1
            # Increment ds_in_epoch even for skipped (tracks AP interval)
            if self._epoch_state is not None:
                self._epoch_state['ds_in_epoch'] += 1
            if _ds_n < 50:
                print(f"[DS {_ds_n:3d}] type=Skip   pts={ds.start_ms}ms "
                      f"content_changed=none")

        # Determine if clear needed
        abutting = (next_start_ms is not None
                    and next_start_ms - ds.end_ms <= 50)

        if not abutting:
            clear_pts = int(ds.end_ms * 90)
            if next_start_ms is not None:
                next_show_pts = int(next_start_ms * 90)
                if clear_pts >= next_show_pts:
                    clear_pts = next_show_pts - 90

            for seg in _build_clear_segments(ds, self._comp,
                                             pts_override=clear_pts):
                self._f.write(seg)
            self._comp += 1
            self._epoch_state = None
            self.stats['clears'] += 1

            if _ds_n < 50:
                gap_to_next = (next_start_ms - ds.end_ms) if next_start_ms else 0
                print(f"[DS {_ds_n:3d}] type=Clear  pts={clear_pts // 90}ms "
                      f"gap_to_next={gap_to_next}ms")
        elif _ds_n < 50:
            print(f"[DS {_ds_n:3d}] abutting → no clear "
                  f"(gap={next_start_ms - ds.end_ms}ms)")

        ds.image = None
        self._pending = None
        self._pending_regions = None
        self._pending_content_keys = None

    def close(self) -> None:
        """Flush the final pending display set and close the file."""
        if self._pending is not None:
            self._flush_pending()
        if any(self.stats.values()):
            s = self.stats
            print(f"[EPOCH STATS] ES={s['epoch_start']} AP={s['acquisition_point']} "
                  f"Normal={s['normal']} Skip={s['skipped']} Clear={s['clears']} "
                  f"AP_fallback={s['ap_window_fallback']}")
        self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def write_sup(display_sets: list[DisplaySet], output_path: str) -> None:
    """Write a list of display sets to a .sup (PGS) file.

    Each DisplaySet produces a "show" display set at start_ms and a "clear"
    display set at end_ms.  Composition numbers auto-increment to satisfy
    PGS decoder expectations.

    PTS monotonicity is enforced: if a clear set's PTS would equal or exceed
    the next show set's PTS (overlapping or abutting events), the clear PTS
    is nudged 1 ms earlier (90 ticks) so that every segment header has a
    strictly increasing timestamp.

    Parameters
    ----------
    display_sets : list[DisplaySet]
        Annotation bitmaps in chronological order.  Each must have a valid
        RGBA PIL Image and canvas-relative position.
    output_path : str
        Path to write the .sup file.
    """
    comp_number = 0

    with open(output_path, 'wb') as f:
        # Anchor the stream at PTS=0 so ffmpeg doesn't rebase timestamps.
        # Without this, ffmpeg subtracts the first PTS when muxing .sup → MKV,
        # shifting all events earlier by the gap between video start and first
        # subtitle — making every PGS bitmap display at the wrong time.
        if display_sets and display_sets[0].start_ms > 0:
            first = display_sets[0]
            anchor_pcs = _make_pcs(
                first.canvas_width, first.canvas_height,
                comp_number, _COMP_EPOCH_START,
                palette_update=False, palette_id=0,
                objects=[],
            )
            anchor_wds = _make_wds([(0, 0, 0, 1, 1)])
            for seg in [
                _make_segment(_SEG_PCS, 0, anchor_pcs),
                _make_segment(_SEG_WDS, 0, anchor_wds),
                _make_segment(_SEG_END, 0, b''),
            ]:
                f.write(seg)
            comp_number += 1

        for i, ds in enumerate(display_sets):
            # Show segments
            for seg in _build_show_segments(ds, comp_number):
                f.write(seg)
            comp_number += 1

            # Clear segments — guard PTS monotonicity against the next show
            clear_pts = int(ds.end_ms * 90)
            if i + 1 < len(display_sets):
                next_show_pts = int(display_sets[i + 1].start_ms * 90)
                if clear_pts >= next_show_pts:
                    clear_pts = next_show_pts - 90  # 1 ms before next show

            for seg in _build_clear_segments(ds, comp_number,
                                             pts_override=clear_pts):
                f.write(seg)
            comp_number += 1
