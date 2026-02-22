# app/ocr.py
"""PGS (Presentation Graphic Stream) OCR module.

Parses .sup files extracted from MKV containers, preprocesses subtitle
bitmap images, and runs Tesseract OCR to produce .srt text output.
"""

import os
import struct
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import pytesseract

# ── BCP-47 → Tesseract language code mapping ────────────────────────────
_TESS_LANG = {
    'ja': 'jpn', 'en': 'eng', 'zh': 'chi_tra', 'zh-hans': 'chi_sim',
    'zh-hant': 'chi_tra', 'zh-cn': 'chi_sim', 'zh-tw': 'chi_tra',
    'yue': 'chi_tra', 'de': 'deu', 'fr': 'fra',
    'es': 'spa', 'it': 'ita', 'pt': 'por', 'ru': 'rus', 'ko': 'kor',
    'th': 'tha', 'ar': 'ara', 'nl': 'nld', 'sv': 'swe', 'da': 'dan',
    'no': 'nor', 'fi': 'fin', 'pl': 'pol', 'cs': 'ces', 'hu': 'hun',
    'ro': 'ron', 'el': 'ell', 'he': 'heb', 'hi': 'hin', 'uk': 'ukr',
    'vi': 'vie',
}

# Also accept 3-letter ISO 639-2 codes that ffprobe metadata provides
_ISO639_TO_TESS = {
    'jpn': 'jpn', 'eng': 'eng', 'chi': 'chi_tra', 'zho': 'chi_tra',
    'deu': 'deu', 'fra': 'fra', 'spa': 'spa', 'ita': 'ita',
    'por': 'por', 'rus': 'rus', 'kor': 'kor', 'tha': 'tha',
    'ara': 'ara', 'nld': 'nld', 'swe': 'swe', 'dan': 'dan',
    'nor': 'nor', 'fin': 'fin', 'pol': 'pol', 'ces': 'ces',
    'hun': 'hun', 'ron': 'ron', 'ell': 'ell', 'heb': 'heb',
    'hin': 'hin', 'ukr': 'ukr', 'vie': 'vie',
}


def _resolve_tess_lang(lang_code: str) -> str:
    """BCP-47 or ISO 639-2 → Tesseract lang code.

    Falls back to exact match, then base tag, then 'eng'.
    """
    if not lang_code:
        return 'eng'
    lc = lang_code.lower().strip()
    # Direct BCP-47 match
    if lc in _TESS_LANG:
        return _TESS_LANG[lc]
    # ISO 639-2 match (ffprobe metadata)
    if lc in _ISO639_TO_TESS:
        return _ISO639_TO_TESS[lc]
    # Base tag (e.g. "zh-cn" → "zh")
    base = lc.split('-')[0].split('_')[0]
    if base in _TESS_LANG:
        return _TESS_LANG[base]
    if base in _ISO639_TO_TESS:
        return _ISO639_TO_TESS[base]
    return 'eng'


def _check_tess_lang(tess_lang: str) -> None:
    """Verify tessdata is installed. Raise RuntimeError with install hint if not."""
    try:
        available = pytesseract.get_languages()
    except pytesseract.pytesseract.TesseractNotFoundError:
        raise RuntimeError(
            "Tesseract OCR is not installed.\n"
            "Install: sudo apt install tesseract-ocr"
        )
    if tess_lang not in available:
        raise RuntimeError(
            f"Tesseract language pack '{tess_lang}' is not installed.\n"
            f"Install: sudo apt install tesseract-ocr-{tess_lang}\n"
            f"Available packs: {', '.join(sorted(available))}"
        )


# ── SUP binary parser ───────────────────────────────────────────────────
# PGS segment types
_SEG_PCS = 0x16  # Presentation Composition Segment
_SEG_WDS = 0x17  # Window Definition Segment
_SEG_PDS = 0x14  # Palette Definition Segment
_SEG_ODS = 0x15  # Object Definition Segment
_SEG_END = 0x80  # End of Display Set Segment

_PG_MAGIC = b'PG'


def _decode_rle(data: bytes, width: int, height: int) -> list[int]:
    """Decode PGS RLE-compressed bitmap data into a flat list of palette indices."""
    pixels = []
    total = width * height
    i = 0
    n = len(data)

    while i < n and len(pixels) < total:
        byte = data[i]
        i += 1

        if byte != 0x00:
            # Single pixel of color `byte`
            pixels.append(byte)
        else:
            # Escape sequence
            if i >= n:
                break
            flag = data[i]
            i += 1

            if flag == 0x00:
                # End of line — pad to next line boundary
                line_pos = len(pixels) % width
                if line_pos != 0:
                    pixels.extend([0] * (width - line_pos))
            elif flag < 0x40:
                # Short run of color 0, length = flag (1-63)
                pixels.extend([0] * flag)
            elif flag < 0x80:
                # Long run of color 0, length from 2 bytes
                if i >= n:
                    break
                length = ((flag & 0x3F) << 8) | data[i]
                i += 1
                pixels.extend([0] * length)
            elif flag < 0xC0:
                # Short run of color CC
                if i >= n:
                    break
                length = flag & 0x3F
                color = data[i]
                i += 1
                pixels.extend([color] * length)
            else:
                # Long run of color CC
                if i + 1 >= n:
                    break
                length = ((flag & 0x3F) << 8) | data[i]
                color = data[i + 1]
                i += 2
                pixels.extend([color] * length)

    return pixels[:total]


def _ycbcr_to_rgb(y, cb, cr):
    """Convert YCbCr to RGB (BT.601)."""
    r = max(0, min(255, int(y + 1.402 * (cr - 128))))
    g = max(0, min(255, int(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128))))
    b = max(0, min(255, int(y + 1.772 * (cb - 128))))
    return (r, g, b)


def _parse_sup(sup_path: str) -> list[tuple[int, int, "Image.Image"]]:
    """Parse a .sup (PGS) file into display sets.

    Returns a list of (start_ms, end_ms, PIL.Image) tuples.
    Only non-empty display sets (those with actual bitmap data) are returned.
    """
    with open(sup_path, 'rb') as f:
        data = f.read()

    segments = []
    pos = 0
    n = len(data)

    # Parse all segments
    while pos + 13 <= n:
        magic = data[pos:pos + 2]
        if magic != _PG_MAGIC:
            # Try to resync — scan for next PG marker
            next_pg = data.find(_PG_MAGIC, pos + 1)
            if next_pg == -1:
                break
            pos = next_pg
            continue

        pts = struct.unpack('>I', data[pos + 2:pos + 6])[0]
        # dts = struct.unpack('>I', data[pos + 6:pos + 10])[0]
        seg_type = data[pos + 10]
        seg_size = struct.unpack('>H', data[pos + 11:pos + 13])[0]

        if pos + 13 + seg_size > n:
            break

        payload = data[pos + 13:pos + 13 + seg_size]
        segments.append((pts, seg_type, payload))
        pos += 13 + seg_size

    # Group segments into display sets (PCS marks start of each set)
    display_sets = []
    current_set = None

    for pts, seg_type, payload in segments:
        if seg_type == _SEG_PCS:
            if current_set is not None:
                display_sets.append(current_set)
            current_set = {
                'pts': pts,
                'pcs': payload,
                'palettes': [],
                'objects': [],
            }
        elif current_set is not None:
            if seg_type == _SEG_PDS:
                current_set['palettes'].append(payload)
            elif seg_type == _SEG_ODS:
                current_set['objects'].append(payload)
            # WDS and END are not needed for bitmap extraction

    if current_set is not None:
        display_sets.append(current_set)

    # Convert display sets to images
    results = []
    for ds_idx, ds in enumerate(display_sets):
        pts_ms = ds['pts'] // 90  # 90kHz clock → ms

        # Parse palette
        palette = {}  # index → (R, G, B, A)
        for pal_payload in ds['palettes']:
            if len(pal_payload) < 2:
                continue
            # pal_id = pal_payload[0]
            # pal_version = pal_payload[1]
            entry_pos = 2
            while entry_pos + 5 <= len(pal_payload):
                idx = pal_payload[entry_pos]
                y_val = pal_payload[entry_pos + 1]
                cr_val = pal_payload[entry_pos + 2]
                cb_val = pal_payload[entry_pos + 3]
                alpha = pal_payload[entry_pos + 4]
                r, g, b = _ycbcr_to_rgb(y_val, cb_val, cr_val)
                palette[idx] = (r, g, b, alpha)
                entry_pos += 5

        if not ds['objects']:
            # Empty display set (screen clear) — skip but use as end marker
            continue

        # Parse and composite all objects
        images = []
        for obj_payload in ds['objects']:
            if len(obj_payload) < 7:
                continue
            # obj_id = struct.unpack('>H', obj_payload[0:2])[0]
            # obj_version = obj_payload[2]
            seq_flag = obj_payload[3]

            # First fragment has width/height at offset 7
            if seq_flag & 0x80:  # First-in-sequence
                if len(obj_payload) < 11:
                    continue
                # 3 bytes for data_len at offset 4
                obj_width = struct.unpack('>H', obj_payload[7:9])[0]
                obj_height = struct.unpack('>H', obj_payload[9:11])[0]
                rle_data = obj_payload[11:]
            else:
                # Continuation fragment — append to previous
                # For simplicity, treat as standalone (rare in subtitle PGS)
                continue

            if obj_width == 0 or obj_height == 0:
                continue

            # Decode RLE
            pixel_indices = _decode_rle(rle_data, obj_width, obj_height)

            # Build RGBA image
            img = Image.new('RGBA', (obj_width, obj_height), (0, 0, 0, 0))
            px = img.load()
            for y in range(obj_height):
                for x in range(obj_width):
                    pi = y * obj_width + x
                    if pi < len(pixel_indices):
                        color_idx = pixel_indices[pi]
                        if color_idx in palette:
                            px[x, y] = palette[color_idx]
                        # else: transparent (default)
            images.append(img)

        if not images:
            continue

        # Composite multiple objects onto a single canvas
        if len(images) == 1:
            composite = images[0]
        else:
            # Find bounding box for all objects
            max_w = max(im.width for im in images)
            total_h = sum(im.height for im in images)
            composite = Image.new('RGBA', (max_w, total_h), (0, 0, 0, 0))
            y_offset = 0
            for im in images:
                composite.paste(im, (0, y_offset), im)
                y_offset += im.height

        # Determine end time: use next display set's PTS, or +5000ms default
        end_ms = pts_ms + 5000
        if ds_idx + 1 < len(display_sets):
            next_pts_ms = display_sets[ds_idx + 1]['pts'] // 90
            if next_pts_ms > pts_ms:
                end_ms = next_pts_ms

        results.append((pts_ms, end_ms, composite))

    return results


def _preprocess_for_ocr(img: "Image.Image") -> "Image.Image":
    """Preprocess a PGS subtitle image for Tesseract OCR.

    Input: RGBA PIL Image (colored text on transparent background).
    Output: Grayscale image with dark text on white background, padded.
    """
    # Use alpha channel to create mask (text = opaque)
    if img.mode == 'RGBA':
        alpha = img.split()[3]
    else:
        alpha = img.convert('RGBA').split()[3]

    # Convert to grayscale using the alpha channel
    # Text pixels (high alpha) → dark; background (low alpha) → white
    import numpy as np
    alpha_arr = np.array(alpha, dtype=np.float32)

    # Invert: high alpha (text) → dark, low alpha (bg) → white
    gray_arr = 255 - alpha_arr
    gray_arr = np.clip(gray_arr, 0, 255).astype(np.uint8)
    gray_img = Image.fromarray(gray_arr, mode='L')

    # Add white padding border (~10px) — Tesseract needs whitespace
    pad = 10
    padded = Image.new('L', (gray_img.width + 2 * pad, gray_img.height + 2 * pad), 255)
    padded.paste(gray_img, (pad, pad))

    # Upscale small images — Tesseract works better with larger text
    min_height = 50
    if padded.height < min_height:
        scale = min_height / padded.height
        new_w = int(padded.width * scale)
        new_h = int(padded.height * scale)
        padded = padded.resize((new_w, new_h), Image.LANCZOS)

    return padded


def _ms_to_srt_time(ms: int) -> str:
    """Convert milliseconds to SRT timestamp format HH:MM:SS,mmm."""
    if ms < 0:
        ms = 0
    hours = ms // 3_600_000
    ms %= 3_600_000
    minutes = ms // 60_000
    ms %= 60_000
    seconds = ms // 1_000
    millis = ms % 1_000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def ocr_pgs_to_srt(sup_path: str, lang_code: str, output_dir: str,
                    progress_callback=None, max_workers=None) -> str:
    """OCR a .sup (PGS) file to .srt.

    Parameters
    ----------
    sup_path : str
        Path to the extracted .sup file.
    lang_code : str
        BCP-47 or ISO 639-2 language code for Tesseract.
    output_dir : str
        Directory to write the output .srt file.
    progress_callback : callable | None
        Optional ``callback(completed, total)`` called after each image is
        OCR'd.  Useful for driving a progress bar in the UI.
    max_workers : int | None
        Number of parallel Tesseract processes.  Defaults to
        ``os.cpu_count()`` (capped at 8 to avoid memory pressure).

    Returns
    -------
    str
        Path to the generated .srt file.

    Raises
    ------
    RuntimeError
        If Tesseract is not installed or the language pack is missing.
    FileNotFoundError
        If the .sup file does not exist.
    ValueError
        If the .sup file is corrupt or contains no subtitle images.
    """
    if not os.path.exists(sup_path):
        raise FileNotFoundError(f"SUP file not found: {sup_path}")

    tess_lang = _resolve_tess_lang(lang_code)
    _check_tess_lang(tess_lang)

    # Tesseract config: PSM 6 = assume uniform block of text
    tess_config = '--psm 6'
    # LSTM engine is better for CJK
    if tess_lang in ('jpn', 'chi_tra', 'chi_sim', 'kor'):
        tess_config += ' --oem 1'

    # Parse SUP file
    display_sets = _parse_sup(sup_path)
    if not display_sets:
        raise ValueError(
            f"No subtitle images found in {os.path.basename(sup_path)}. "
            "The file may be corrupt or empty."
        )

    total = len(display_sets)

    # --- Parallel OCR via thread pool --------------------------------
    # pytesseract spawns a tesseract subprocess per call — the Python
    # thread just waits on I/O, so threading parallelises effectively
    # without GIL contention.
    if max_workers is None:
        max_workers = min(os.cpu_count() or 4, 4)

    def _ocr_one(item):
        idx, start_ms, end_ms, img = item
        processed = _preprocess_for_ocr(img)
        text = pytesseract.image_to_string(
            processed, lang=tess_lang, config=tess_config,
        ).strip()
        return (idx, start_ms, end_ms, text)

    work_items = [
        (i, start_ms, end_ms, img)
        for i, (start_ms, end_ms, img) in enumerate(display_sets)
    ]

    results = [None] * total
    completed = 0

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_ocr_one, item): item[0] for item in work_items}
        for future in _as_completed_iter(futures):
            idx = futures[future]
            results[idx] = future.result()
            completed += 1
            if progress_callback:
                progress_callback(completed, total)

    # Filter to non-empty results, already in original order
    srt_entries = [
        (start_ms, end_ms, text)
        for (_idx, start_ms, end_ms, text) in results
        if text
    ]

    # Write SRT
    base = os.path.splitext(os.path.basename(sup_path))[0]
    srt_path = os.path.join(output_dir, f"{base}_ocr.srt")

    with open(srt_path, 'w', encoding='utf-8') as f:
        for idx, (start_ms, end_ms, text) in enumerate(srt_entries, 1):
            f.write(f"{idx}\n")
            f.write(f"{_ms_to_srt_time(start_ms)} --> {_ms_to_srt_time(end_ms)}\n")
            f.write(f"{text}\n\n")

    return srt_path


def _as_completed_iter(futures):
    """Thin wrapper around concurrent.futures.as_completed."""
    from concurrent.futures import as_completed
    return as_completed(futures)
