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
from dataclasses import dataclass
from typing import TYPE_CHECKING

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

def _encode_rle(indices: list[int], width: int, height: int) -> bytes:
    """RLE-encode a flat list of palette indices into PGS bitmap data.

    This is the inverse of _decode_rle() in ocr.py.  The encoding uses:

    - ``color_byte`` (nonzero)                  → 1 pixel of that color
    - ``0x00 0x00``                             → end of line
    - ``0x00 0b00NNNNNN``          (N 1–63)       → N transparent pixels
    - ``0x00 0b01NNNNNN_NNNNNNNN`` (N 64–16383)  → extended transparent run
    - ``0x00 0b10NNNNNN CC``       (N 1–63)       → N pixels of color CC
    - ``0x00 0b11NNNNNN_NNNNNNNN CC``              → extended color run
    """
    out = bytearray()

    for row in range(height):
        row_start = row * width
        col = 0
        while col < width:
            color = indices[row_start + col]
            # Count the run length
            run = 1
            while col + run < width and indices[row_start + col + run] == color:
                run += 1
                if run >= 16383:
                    break

            if color == 0:
                # Transparent run
                if run < 64:
                    # Short transparent: 0x00 0b00NNNNNN
                    out.append(0x00)
                    out.append(run & 0x3F)
                else:
                    # Extended transparent: 0x00 0b01NNNNNN_NNNNNNNN
                    out.append(0x00)
                    out.append(0x40 | ((run >> 8) & 0x3F))
                    out.append(run & 0xFF)
            else:
                if run == 1:
                    # Single pixel: just the color byte
                    out.append(color)
                elif run < 64:
                    # Short color run: 0x00 0b10NNNNNN CC
                    out.append(0x00)
                    out.append(0x80 | (run & 0x3F))
                    out.append(color)
                else:
                    # Extended color run: 0x00 0b11NNNNNN_NNNNNNNN CC
                    out.append(0x00)
                    out.append(0xC0 | ((run >> 8) & 0x3F))
                    out.append(run & 0xFF)
                    out.append(color)

            col += run

        # End of line
        out.append(0x00)
        out.append(0x00)

    return bytes(out)


# ── Palette quantization ─────────────────────────────────────────────

def _quantize_image(image: "PILImage") -> tuple[list[int], list[tuple[int, int, int, int]]]:
    """Quantize an RGBA image to at most 255 colors + transparent.

    Returns
    -------
    indices : list[int]
        Flat list of palette indices (0 = fully transparent, 1–255 = colors).
    palette : list[(Y, Cb, Cr, Alpha)]
        256-entry palette in PGS format.  Index 0 is always (16, 128, 128, 0)
        representing fully transparent.
    """
    from PIL import Image as PILImageModule

    img = image.convert('RGBA')
    w, h = img.size

    # Separate alpha: build a mask of fully transparent pixels
    pixels = list(img.getdata())

    # Collect non-transparent pixels and quantize their colors
    # We need to preserve alpha variation for anti-aliased edges
    # Strategy: quantize the full RGBA image, then map index 0 to transparent
    quantized = img.quantize(colors=255, method=2, dither=0)
    q_palette_flat = quantized.getpalette(rawmode='RGBA')
    if q_palette_flat is None:
        # Fallback: get RGB palette and assume full opacity
        q_palette_rgb = quantized.getpalette()
        if q_palette_rgb is None:
            q_palette_flat = [0, 0, 0, 0] * 256
        else:
            q_palette_flat = []
            for i in range(0, len(q_palette_rgb), 3):
                q_palette_flat.extend([q_palette_rgb[i], q_palette_rgb[i+1],
                                       q_palette_rgb[i+2], 255])

    # Build (R, G, B, A) tuples from the flat palette
    q_colors = []
    for i in range(0, min(len(q_palette_flat), 256 * 4), 4):
        q_colors.append((q_palette_flat[i], q_palette_flat[i+1],
                         q_palette_flat[i+2], q_palette_flat[i+3]))

    # Get quantized pixel indices
    q_data = list(quantized.getdata())

    # Build the PGS palette.  Index 0 = fully transparent.
    # Shift all quantized indices by +1 to reserve index 0.
    pgs_palette = [(16, 128, 128, 0)]  # index 0: transparent (Y=16, Cb=Cr=128, A=0)

    for rgba in q_colors:
        r, g, b, a = rgba
        y, cb, cr = _rgb_to_ycbcr(r, g, b)
        pgs_palette.append((y, cb, cr, a))

    # Pad to 256 entries
    while len(pgs_palette) < 256:
        pgs_palette.append((16, 128, 128, 0))

    # Map pixel indices: transparent source pixels → 0, others → shifted index
    indices = []
    for i, px in enumerate(pixels):
        if px[3] == 0:  # fully transparent
            indices.append(0)
        else:
            indices.append(q_data[i] + 1)  # shift by 1

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


# ── Display set assembly ─────────────────────────────────────────────

def _build_show_segments(ds: DisplaySet, comp_number: int) -> list[bytes]:
    """Build all segments for a "show" display set (makes bitmap visible)."""
    pts = int(ds.start_ms * 90)

    # Quantize image
    indices, palette = _quantize_image(ds.image)
    w, h = ds.image.size

    # RLE encode
    rle_data = _encode_rle(indices, w, h)

    # PCS — epoch start, one object at (x, y)
    pcs_data = _make_pcs(
        ds.canvas_width, ds.canvas_height,
        comp_number, _COMP_EPOCH_START,
        palette_update=False, palette_id=0,
        objects=[(0, 0, ds.x, ds.y, 0)],
    )

    # WDS — one window matching the object
    wds_data = _make_wds([(0, ds.x, ds.y, w, h)])

    # PDS — full palette (only emit non-transparent entries to save space)
    pal_entries = []
    for i, (y_val, cb_val, cr_val, alpha) in enumerate(palette):
        if alpha > 0 or i == 0:
            pal_entries.append((i, y_val, cr_val, cb_val, alpha))
    pds_data = _make_pds(0, 0, pal_entries)

    # ODS — fragmented if RLE data exceeds 65535-byte segment limit
    ods_segments = _build_ods_segments(0, 0, w, h, rle_data, pts)

    # END
    end_data = b''

    return [
        _make_segment(_SEG_PCS, pts, pcs_data),
        _make_segment(_SEG_WDS, pts, wds_data),
        _make_segment(_SEG_PDS, pts, pds_data),
        *ods_segments,
        _make_segment(_SEG_END, pts, end_data),
    ]


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
        self._canvas_w = canvas_width
        self._canvas_h = canvas_height
        self._anchor_written = False
        self.count = 0  # number of display sets written

    def write(self, ds: DisplaySet) -> None:
        """Accept a display set.  The *previous* pending set is flushed to disk."""
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

    def _flush_pending(self, next_start_ms: int | None = None) -> None:
        """Write show+clear segments for the pending display set."""
        ds = self._pending
        if ds is None:
            return

        # Show segments
        for seg in _build_show_segments(ds, self._comp):
            self._f.write(seg)
        self._comp += 1

        # Clear segments — guard PTS monotonicity against next show
        clear_pts = int(ds.end_ms * 90)
        if next_start_ms is not None:
            next_show_pts = int(next_start_ms * 90)
            if clear_pts >= next_show_pts:
                clear_pts = next_show_pts - 90  # 1 ms before next show

        for seg in _build_clear_segments(ds, self._comp,
                                         pts_override=clear_pts):
            self._f.write(seg)
        self._comp += 1

        self.count += 1
        ds.image = None  # release PIL image after writing
        self._pending = None

    def close(self) -> None:
        """Flush the final pending display set and close the file."""
        if self._pending is not None:
            self._flush_pending()
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
