# app/processing.py
import functools
import os
import re
import subprocess
import streamlit as st
import pysubs2
import tempfile
from .styles import get_lang_config
from .romanize import build_annotation_html, _strip_inline_furigana, _strip_reverse_furigana

# Matches ASS vector-path drawing commands (\p1, \p2, etc.)
# Events containing these are graphical shapes, never subtitle text.
_VEC_PATH_RE = re.compile(r'\\p\d')

# Smart default role patterns for detect_ass_styles().
# Styles whose names match _PRESERVE_PATTERNS default to "preserve" — passed
# through with original styling (signs, typesetting, OP/ED karaoke lyrics).
# OP/ED/song styles preserve their animation tags in .ass output; animation
# tags are auto-stripped for PGS (static bitmap) output.
_PRESERVE_PATTERNS = re.compile(
    r'sign|screen|title|card|caption|typeset|logo|insert'
    r'|song|lyric|karaoke|kfx|opening|ending'
    r'|\bop\b|op_|_op|\bed\b|ed_|_ed',
    re.IGNORECASE,
)
# No styles currently default to exclude — 0-event styles still get "exclude".
_EXCLUDE_PATTERNS = re.compile(
    r'(?!)',  # never matches
    re.IGNORECASE,
)

# Fixed ASS PlayRes reference — all font sizes, margins, and coordinates in the
# generated .ass file are in this coordinate space.  The ASS renderer scales them
# to the actual video resolution at playback.  Must match _REF_H in preview.py
# so that the preview is WYSIWYG.
_PLAY_RES_X = 1920
_PLAY_RES_Y = 1080


@functools.lru_cache(maxsize=16)
def _resolve_font_path(fontname: str):
    """Resolve font family name to file path via fontconfig (fc-match)."""
    try:
        result = subprocess.run(
            ['fc-match', fontname, '-f', '%{file}'],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


@functools.lru_cache(maxsize=16)
def _load_measurement_font(fontname: str, fontsize: int):
    """Load a Pillow ImageFont for text width measurement.

    Returns None on failure (missing font, Pillow not installed, etc.).
    The caller falls back to _char_display_width() approximations.
    """
    try:
        from PIL import ImageFont
    except ImportError:
        return None
    path = _resolve_font_path(fontname)
    if not path:
        return None
    try:
        return ImageFont.truetype(path, fontsize)
    except Exception:
        return None


def _char_display_width(char: str) -> float:
    """Return the relative display width of *char* in a CJK-capable font.

    Full-width characters (CJK ideographs, hiragana, katakana, full-width
    punctuation) return 1.0 — they occupy one full em-square.  Half-width
    characters (ASCII, numerals, common punctuation) return 0.5.  ASCII space
    returns 0.25 — it is significantly narrower than half-width in both CJK
    and Latin fonts (~0.25em in most subtitle fonts).

    This is a fallback approximation used when Pillow font measurement is
    unavailable.  When a Pillow ImageFont is loaded, _make_annotation_events()
    uses font.getlength() for pixel-accurate positioning instead.
    """
    cp = ord(char)
    # ASCII space — narrow in both CJK and Latin fonts (~0.25em)
    if cp == 0x0020:
        return 0.25
    # Full-width CJK/kana ranges
    if (0x4e00 <= cp <= 0x9fff or   # CJK unified ideographs
            0x3400 <= cp <= 0x4dbf or   # CJK extension A
            0x3040 <= cp <= 0x309f or   # Hiragana
            0x30a0 <= cp <= 0x30ff or   # Katakana
            0x3100 <= cp <= 0x312f or   # Bopomofo (Zhuyin)
            0xff01 <= cp <= 0xff60 or   # Full-width ASCII variants
            0x3000 <= cp <= 0x303f):    # CJK symbols and punctuation
        return 1.0
    # Additional full-width characters common in CJK subtitle text
    if cp in (0x2014, 0x2015, 0x2026):  # em dash, horizontal bar, ellipsis
        return 1.0
    if 0x2E80 <= cp <= 0x2EFF:  # CJK radicals supplement
        return 1.0
    if 0xFE30 <= cp <= 0xFE4F:  # CJK compatibility forms
        return 1.0
    return 0.5


def _make_annotation_events(line, spans, annotation_cfg, top_marginv,
                            top_fontsize, screen_width, font=None):
    """Generate one positioned ASS event per annotated token in *spans*.

    Language-agnostic: works for Japanese furigana (kanji→hiragana), Chinese
    pinyin (hanzi→pinyin), or any annotation system that produces (original,
    reading) span pairs via get_annotation_func().

    Each event carries ``\\an8\\pos(x, y)`` tags placing the reading directly
    above the corresponding token in the main-text line.

    Parameters
    ----------
    line : pysubs2.SSAEvent
        The source dialogue event (provides start/end times).  Copied — not
        mutated.
    spans : list[(str, str|None)]
        Output of get_annotation_func()(line.text).  (orig, reading) pairs;
        only pairs with a non-None reading produce events.
    annotation_cfg : dict
        The "Annotation" style config dict from st.session_state.styles.  Used
        for fontsize — the Y position is derived from this value.
    top_marginv : int
        Live value of styles["Top"]["marginv"] at generation time.  Annotation
        Y is computed as ``max(0, top_marginv - annotation_fontsize - 2)`` so
        that the annotation sits 2 video-pixels above the main text's top edge.
    top_fontsize : int
        Live value of styles["Top"]["fontsize"].  Used for X-offset calculation
        when *font* is None (fallback mode): each full-width character occupies
        top_fontsize pixels horizontally.
    screen_width : int
        Video width in pixels (from mkv_resolution).  The main text is
        ``\\an8``-centered at screen_width/2; annotation X positions are
        relative to this center.
    font : PIL.ImageFont.FreeTypeFont | None
        When provided, ``font.getlength()`` is used for pixel-accurate glyph
        measurement — eliminates drift from approximated character widths.
        Loaded via ``_load_measurement_font()`` using the Top layer's font.
        Falls back to ``_char_display_width()`` approximations when None.

    X calculation
    -------------
    **With font (primary):** ``font.getlength(stripped[:N])`` measures actual
    pixel advance up to character N.  Total text width and per-token positions
    are measured directly — no approximation error.

    **Without font (fallback):** For ``\\an8`` (top-center) text, the left
    edge of the text block is::

        text_left_x = screen_width/2 - total_display_width/2

    where ``total_display_width = sum(_char_display_width(c) * top_fontsize
    for c in stripped_text)``.
    """
    ann_fontsize = annotation_cfg.get('fontsize', 12)
    ann_gap = annotation_cfg.get('annotation_gap', 2)
    ann_y = max(0, top_marginv - ann_fontsize - ann_gap)

    # Reconstruct stripped text from span origs — same character sequence that
    # the tokeniser produced, so display-width sums are consistent.
    stripped = ''.join(orig for orig, _ in spans)

    # Compute text left edge — Pillow font measurement or fallback.
    if font:
        total_px = font.getlength(stripped)
        text_left_x = screen_width / 2 - total_px / 2
    else:
        total_display_w = sum(_char_display_width(c) for c in stripped)
        text_left_x = screen_width / 2 - (total_display_w * top_fontsize) / 2

    events = []
    char_idx = 0

    for orig, reading in spans:
        if not orig:
            continue
        next_idx = char_idx + len(orig)

        if reading:
            if font:
                token_left = font.getlength(stripped[:char_idx]) if char_idx > 0 else 0.0
                token_right = font.getlength(stripped[:next_idx])
                orig_px = token_right - token_left
            else:
                token_left = sum(_char_display_width(c) for c in stripped[:char_idx]) * top_fontsize
                orig_px = sum(_char_display_width(c) for c in orig) * top_fontsize

            ann_x = text_left_x + token_left + orig_px / 2

            ann_event = line.copy()
            ann_event.text = f'{{\\an8\\pos({ann_x:.0f},{ann_y})}}{reading}'
            ann_event.style = "Annotation"
            events.append(ann_event)

        char_idx = next_idx

    return events


def _load_subs(source):
    """Load subtitles from either a file path (str) or a Streamlit file object."""
    if isinstance(source, str):
        return pysubs2.load(source)
    source.seek(0)
    return pysubs2.SSAFile.from_string(source.getvalue().decode("utf-8"))


def _get_source_playres(subs):
    """Return (PlayResX, PlayResY) from an SSAFile, defaulting per ASS spec.

    The ASS spec default is (384, 288) when PlayRes tags are absent.
    """
    try:
        x = int(subs.info.get('PlayResX', 0))
    except (ValueError, TypeError):
        x = 0
    try:
        y = int(subs.info.get('PlayResY', 0))
    except (ValueError, TypeError):
        y = 0
    return (x or 384, y or 288)


def detect_ass_styles(source):
    """Detect named styles and their event counts in an ASS/SSA file.

    Parameters
    ----------
    source : str or file object
        Path to an .ass/.ssa file, or a Streamlit uploaded file object.

    Returns
    -------
    dict | None
        ``None`` for SRT files (no named styles) or files with <= 1 style.
        Otherwise a dict keyed by style name::

            {style_name: {
                "event_count": int,
                "style": SSAStyle,
                "role": "dialogue" | "preserve" | "exclude",
                "sample_text": str,
                "has_animation": bool,
            }}

    The ``role`` field is a smart default (priority order — first match wins):

    1. Names matching ``_PRESERVE_PATTERNS`` -> ``"preserve"`` (final)
    2. Names matching ``_EXCLUDE_PATTERNS`` -> ``"exclude"`` (final)
    3. Names literally "Dialogue" or "Default" -> ``"dialogue"``
    4. Styles with 0 events -> ``"exclude"``
    5. Among remaining styles, most events -> ``"dialogue"``
    6. Everything else -> ``"dialogue"``
    """
    try:
        subs = _load_subs(source)
    except Exception:
        return None

    # SRT files have at most one style ("Default")
    if len(subs.styles) <= 1:
        return None

    # Detect animation/karaoke tags in event text per style.
    _anim_detect_re = re.compile(
        r'\\(?:k[fo]?\d|K\d|t\(|move\(|fad(?:e)?\()',
    )

    # Count events per style, collect sample text, and detect animation tags
    style_counts = {}
    style_samples = {}
    style_has_animation = {}
    for event in subs:
        if event.is_comment:
            continue
        if _VEC_PATH_RE.search(event.text):
            continue
        name = event.style
        style_counts[name] = style_counts.get(name, 0) + 1
        if name not in style_samples:
            cleaned = re.sub(r'\{[^}]*\}', '', event.text)
            cleaned = cleaned.replace(r'\N', ' ').replace(r'\n', ' ').replace('\n', ' ').strip()
            style_samples[name] = cleaned[:80]
        if not style_has_animation.get(name) and _anim_detect_re.search(event.text):
            style_has_animation[name] = True

    if not style_counts and not subs.styles:
        return None

    # Find most-events style — but only among styles NOT claimed by pattern
    # rules.  Pattern match is final: if a name matches _PRESERVE_PATTERNS or
    # _EXCLUDE_PATTERNS, it keeps that role regardless of event count.
    _DIALOGUE_NAME_RE = re.compile(r'^(?:dialogue|default)$', re.IGNORECASE)

    # First pass: assign pattern-based roles (immutable)
    pattern_assigned = set()
    result = {}
    for style_name, style_obj in subs.styles.items():
        count = style_counts.get(style_name, 0)

        if count == 0:
            role = "exclude"
            pattern_assigned.add(style_name)
        elif _PRESERVE_PATTERNS.search(style_name):
            role = "preserve"
            pattern_assigned.add(style_name)
        elif _EXCLUDE_PATTERNS.search(style_name):
            role = "exclude"
            pattern_assigned.add(style_name)
        elif _DIALOGUE_NAME_RE.match(style_name):
            role = "dialogue"
            pattern_assigned.add(style_name)
        else:
            role = None  # deferred to second pass

        result[style_name] = {
            "event_count": count,
            "style": style_obj,
            "role": role,
            "sample_text": style_samples.get(style_name, ""),
            "has_animation": style_has_animation.get(style_name, False),
        }

    # Second pass: among unassigned styles, the one with the most events
    # gets "dialogue"; everything else also gets "dialogue".
    unassigned = {
        name for name, info in result.items() if info["role"] is None
    }
    if unassigned:
        max_unassigned = max(
            unassigned,
            key=lambda n: style_counts.get(n, 0),
        )
        for name in unassigned:
            result[name]["role"] = "dialogue"

    # Only return if there are multiple styles
    if len(result) <= 1:
        return None

    return result


def _iter_preserved_events(subs, style_mapping):
    """Yield ``(event, style_obj)`` tuples for events mapped to ``"preserve"``.

    Skips comment events and vector-path drawing events.
    """
    if not style_mapping:
        return

    preserve_styles = frozenset(
        name for name, role in style_mapping.items() if role == "preserve"
    )
    if not preserve_styles:
        return

    for event in subs:
        if event.is_comment:
            continue
        if _VEC_PATH_RE.search(event.text):
            continue
        if event.style in preserve_styles:
            style_obj = subs.styles.get(event.style)
            yield (event, style_obj)


def _dedup_preserved_for_pgs(events_and_styles):
    """Deduplicate overlapping karaoke layer events for PGS rendering.

    Complex fansub karaoke uses multiple ASS layers at the same timestamp to
    composite effects (shadow, main text, animation sweep, decorations).
    After stripping animation tags for PGS, all layers render fully visible
    simultaneously — producing garbled overlapping text.

    Groups events by style + time overlap + text content.  When a group spans
    multiple ASS layers, only the **lowest non-drawing layer** is kept (the
    static base text).  Higher-layer events (animation/sweep/highlight) are
    discarded since they only make sense with ``\\K``/``\\t``/``\\clip``.

    Parameters
    ----------
    events_and_styles : list[(SSAEvent, SSAStyle)]
        Preserved events from ``_iter_preserved_events()``.

    Returns
    -------
    list[(SSAEvent, SSAStyle)]
        Deduplicated list — safe for PGS rendering without overlaps.
    """
    if not events_and_styles:
        return []

    # Strip tags to get plain display text for content comparison
    def _plain(text):
        return _OVERRIDE_BLOCK_RE.sub('', text).replace(r'\N', ' ').replace(r'\n', ' ').strip()

    # Group events by style name.  Within each style, find clusters of
    # time-overlapping events whose plain text is the same or a substring.
    from collections import defaultdict
    by_style = defaultdict(list)
    for event, style_obj in events_and_styles:
        by_style[event.style].append((event, style_obj))

    kept = []
    for style_name, group in by_style.items():
        # Sort by start time, then by layer
        group.sort(key=lambda es: (es[0].start, es[0].layer))

        # Build clusters of overlapping events with related text content
        clusters = []  # list of lists of (event, style_obj)
        for event, style_obj in group:
            plain = _plain(event.text)
            merged = False
            for cluster in clusters:
                # Check if this event overlaps with any event in the cluster
                # and has related text content
                for c_event, _ in cluster:
                    c_plain = _plain(c_event.text)
                    time_overlap = (
                        max(0, min(event.end, c_event.end)
                             - max(event.start, c_event.start))
                    )
                    if time_overlap <= 0:
                        continue
                    # Text is the same, or one is a substring of the other
                    if (plain == c_plain
                            or plain in c_plain
                            or c_plain in plain):
                        cluster.append((event, style_obj))
                        merged = True
                        break
                if merged:
                    break
            if not merged:
                clusters.append([(event, style_obj)])

        # For each cluster, keep only events on the lowest layer
        for cluster in clusters:
            if len(cluster) <= 1:
                kept.extend(cluster)
                continue
            layers = {ev.layer for ev, _ in cluster}
            if len(layers) <= 1:
                # All on same layer — no dedup needed
                kept.extend(cluster)
                continue
            min_layer = min(layers)
            for event, style_obj in cluster:
                if event.layer == min_layer:
                    kept.append((event, style_obj))

    return kept


# --- PlayRes scaling helpers for preserved events ---

_POS_TAG_RE = re.compile(r'\\pos\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)')
_FS_TAG_RE = re.compile(r'\\fs([\d.]+)')


def _scale_pos_tag(text, sx, sy):
    """Scale ``\\pos(x,y)`` coordinates in ASS event text.

    Parameters
    ----------
    sx, sy : float
        Scale factors for X and Y coordinates.
    """
    def _replace_pos(m):
        x = float(m.group(1)) * sx
        y = float(m.group(2)) * sy
        return f'\\pos({x:.0f},{y:.0f})'
    return _POS_TAG_RE.sub(_replace_pos, text)


def _scale_preserved_event(event, source_res, output_res):
    """Return a copy of *event* with coordinates/sizes scaled from source to output PlayRes.

    No-op when ``source_res == output_res``.
    """
    if source_res == output_res:
        return event.copy()

    sx = output_res[0] / source_res[0]
    sy = output_res[1] / source_res[1]

    new_event = event.copy()
    # Scale \pos() in text
    new_event.text = _scale_pos_tag(new_event.text, sx, sy)
    # Scale inline \fs overrides
    def _replace_fs(m):
        fs = float(m.group(1)) * sy
        return f'\\fs{fs:.0f}'
    new_event.text = _FS_TAG_RE.sub(_replace_fs, new_event.text)
    # Scale event margins
    new_event.marginv = int(new_event.marginv * sy)
    new_event.marginl = int(new_event.marginl * sx)
    new_event.marginr = int(new_event.marginr * sx)
    return new_event


def _iter_dialogue_events(subs, style_mapping=None):
    """Yield only the main dialogue events from an SSAFile.

    Multi-layer fansub ASS files (e.g. Furretar's AoT releases) pack several
    rendering layers into a single track:
      - One layer contains the actual readable dialogue lines (most events)
      - Other layers contain karaoke glow/shadow compositing, syllable-highlight
        clips, OP/ED romaji, chapter-marker drawings, etc. (few events each)

    Heuristic: the layer with the **most non-drawing events** is the main
    dialogue layer.  All other layers are compositing/effects layers and are
    excluded.  Single-layer files (plain SRT, simple ASS) are returned in full.

    Vector-path drawing events (\\p1, \\p2 …) are always excluded — they are
    graphical shapes, never subtitle text.

    Parameters
    ----------
    subs : pysubs2.SSAFile
        Parsed subtitle file.
    style_mapping : dict | None
        When provided, only events whose ``.style`` maps to ``"dialogue"``
        are considered.  The layer heuristic is then applied within those
        events (handles compositing layers within dialogue styles).
        When ``None``, existing behavior is preserved — all styles eligible.
    """
    # Pre-filter by style mapping if provided
    dialogue_styles = None
    if style_mapping:
        dialogue_styles = frozenset(
            name for name, role in style_mapping.items() if role == "dialogue"
        )

    # Count non-drawing events per layer to find the main dialogue layer.
    layer_counts = {}
    for event in subs:
        if _VEC_PATH_RE.search(event.text):
            continue
        if dialogue_styles is not None and event.style not in dialogue_styles:
            continue
        layer_counts[event.layer] = layer_counts.get(event.layer, 0) + 1

    if not layer_counts:
        return

    is_multilayer = len(layer_counts) > 1
    main_layer = max(layer_counts, key=layer_counts.get) if is_multilayer else next(iter(layer_counts))

    for event in subs:
        if _VEC_PATH_RE.search(event.text):
            continue
        if dialogue_styles is not None and event.style not in dialogue_styles:
            continue
        if is_multilayer and event.layer != main_layer:
            continue
        yield event


# --- ASS-to-CSS translation for preserved events in PGS rendering ---

_ASS_ALIGN_CSS = {
    1: ("left", "bottom"),   2: ("center", "bottom"),  3: ("right", "bottom"),
    4: ("left", "center"),   5: ("center", "center"),  6: ("right", "center"),
    7: ("left", "top"),      8: ("center", "top"),      9: ("right", "top"),
}

_AN_TAG_RE = re.compile(r'\\an(\d)')
_FN_TAG_RE = re.compile(r'\\fn([^\\}]+)')
_C_TAG_RE = re.compile(r'\\(?:1?c)&H([0-9A-Fa-f]{2,6})&')
_3C_TAG_RE = re.compile(r'\\3c&H([0-9A-Fa-f]{2,6})&')
_BORD_TAG_RE = re.compile(r'\\bord([\d.]+)')
_OVERRIDE_BLOCK_RE = re.compile(r'\{[^}]*\}')

# Animation/timing tags to strip from preserved events in PGS output.
# These tags produce motion/timing effects that cannot render as static bitmaps.
# Visual styling tags (\fn, \fs, \c, \3c, \bord, \shad, \pos, \an, etc.) are kept.
_ANIMATION_TAG_RE = re.compile(
    r'\\(?:k[fo]?\d*|K\d*|t\([^)]*\)|move\([^)]*\)|fad(?:e)?\([^)]*\)|i?clip\([^)]*\)|org\([^)]*\))',
)


def _strip_animation_tags(text):
    """Remove animation/timing ASS tags from override blocks, keeping visual tags.

    Strips: ``\\k``, ``\\kf``, ``\\ko``, ``\\K``, ``\\t()``, ``\\move()``,
    ``\\fad()``, ``\\fade()``, ``\\clip()``, ``\\iclip()``, ``\\org()``.

    Keeps: ``\\fn``, ``\\fs``, ``\\c``, ``\\3c``, ``\\bord``, ``\\shad``,
    ``\\pos``, ``\\an``, ``\\i``, ``\\b``, ``\\frz``, ``\\fscx``, ``\\fscy``, etc.

    Empty override blocks ``{}`` are cleaned up after stripping.
    """
    result = _ANIMATION_TAG_RE.sub('', text)
    # Clean up empty override blocks left after stripping
    result = re.sub(r'\{\s*\}', '', result)
    return result


def _ass_bgr_to_css(bgr_hex):
    """Convert ASS ``&HBBGGRR&`` hex (without the ``&H`` prefix) to CSS ``rgb(R,G,B)``."""
    bgr_hex = bgr_hex.zfill(6)
    b = int(bgr_hex[0:2], 16)
    g = int(bgr_hex[2:4], 16)
    r = int(bgr_hex[4:6], 16)
    return f"rgb({r},{g},{b})"


def _ass_color_to_css(color):
    """Convert a pysubs2.Color to CSS ``rgba(R,G,B,A)``."""
    if color is None:
        return "white"
    opacity = (255 - color.a) / 255.0
    return f"rgba({color.r},{color.g},{color.b},{opacity})"


def _preserved_event_to_html(event, style, source_res, canvas_res, scale):
    """Convert a preserved ASS event + style to an absolutely-positioned HTML div.

    Translates a subset of ASS override tags to CSS for PGS bitmap rendering:
    ``\\pos``, ``\\an``, ``\\fn``, ``\\fs``, ``\\c``/``\\1c``, ``\\3c``, ``\\bord``.

    Exotic tags (``\\t``, ``\\clip``, ``\\move``, ``\\fad``, ``\\k``) are stripped
    — events render as static text in PGS, which is correct behavior.

    Parameters
    ----------
    event : pysubs2.SSAEvent
        The dialogue event.
    style : pysubs2.SSAStyle
        The source ASS style object.
    source_res : (int, int)
        Source file's (PlayResX, PlayResY).
    canvas_res : (int, int)
        Target PGS canvas (width, height).
    scale : float
        Output scale factor (canvas_height / 1080).
    """
    if style is None:
        return ""

    # Strip animation/timing tags before processing — PGS renders static bitmaps.
    # Visual styling tags (\fn, \fs, \c, \pos, etc.) are preserved for CSS translation.
    text = _strip_animation_tags(event.text)
    sx = canvas_res[0] / source_res[0]
    sy = canvas_res[1] / source_res[1]

    # Extract first override block for tag parsing
    first_block = ""
    block_match = _OVERRIDE_BLOCK_RE.search(text)
    if block_match:
        first_block = block_match.group(0)

    # Parse override tags (inline overrides take precedence over style defaults)
    pos_match = _POS_TAG_RE.search(first_block)
    an_match = _AN_TAG_RE.search(first_block)
    fn_match = _FN_TAG_RE.search(first_block)
    fs_match = _FS_TAG_RE.search(first_block)
    c_match = _C_TAG_RE.search(first_block)
    c3_match = _3C_TAG_RE.search(first_block)
    bord_match = _BORD_TAG_RE.search(first_block)

    # Alignment
    alignment = int(an_match.group(1)) if an_match else (style.alignment if style else 2)
    h_align, v_align = _ASS_ALIGN_CSS.get(alignment, ("center", "bottom"))

    # Font
    fontname = fn_match.group(1).strip() if fn_match else (style.fontname if style else "Arial")
    fontsize = float(fs_match.group(1)) * sy if fs_match else (style.fontsize * sy if style else 24 * sy)

    # Colors
    if c_match:
        color_css = _ass_bgr_to_css(c_match.group(1))
    else:
        color_css = _ass_color_to_css(style.primarycolor) if style else "white"

    # Outline → text-shadow (8-direction grid)
    outline_width = float(bord_match.group(1)) * sy if bord_match else (style.outline * sy if style else 0)
    if c3_match:
        outline_color_css = _ass_bgr_to_css(c3_match.group(1))
    else:
        outline_color_css = _ass_color_to_css(style.outlinecolor) if style else "rgb(0,0,0)"

    shadow_parts = []
    if outline_width > 0:
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx != 0 or dy != 0:
                    shadow_parts.append(
                        f"{dx}px {dy}px {outline_width:.1f}px {outline_color_css}"
                    )
    text_shadow_css = f"text-shadow:{','.join(shadow_parts)};" if shadow_parts else ""

    # Strip all override blocks from display text, convert \N to <br>
    display_text = _OVERRIDE_BLOCK_RE.sub('', text)
    display_text = display_text.replace(r'\N', '<br>').replace(r'\n', '<br>').replace('\n', '<br>')

    # Build CSS positioning
    css_parts = [
        f"position:absolute;",
        f"font-family:'{fontname}','Noto Sans CJK JP',sans-serif;",
        f"font-size:{fontsize:.1f}px;",
        f"color:{color_css};",
        f"{text_shadow_css}",
        f"white-space:pre-wrap;",
    ]

    if style:
        if style.bold:
            css_parts.append("font-weight:bold;")
        if style.italic:
            css_parts.append("font-style:italic;")

    if pos_match:
        # Absolute position — scale from source to canvas coordinates
        px = float(pos_match.group(1)) * sx
        py = float(pos_match.group(2)) * sy

        # Anchor based on alignment
        transform_parts = []
        if h_align == "center":
            css_parts.append(f"left:{px:.1f}px;")
            transform_parts.append("translateX(-50%)")
        elif h_align == "right":
            css_parts.append(f"right:{canvas_res[0] - px:.1f}px;")
        else:  # left
            css_parts.append(f"left:{px:.1f}px;")

        if v_align == "center":
            css_parts.append(f"top:{py:.1f}px;")
            transform_parts.append("translateY(-50%)")
        elif v_align == "bottom":
            css_parts.append(f"bottom:{canvas_res[1] - py:.1f}px;")
        else:  # top
            css_parts.append(f"top:{py:.1f}px;")

        if transform_parts:
            css_parts.append(f"transform:{' '.join(transform_parts)};")
    else:
        # Margin-based positioning from style alignment
        marginv = (event.marginv or (style.marginv if style else 0)) * sy
        marginl = (event.marginl or (style.marginl if style else 0)) * sx
        marginr = (event.marginr or (style.marginr if style else 0)) * sx

        css_parts.append(f"text-align:{h_align};")
        css_parts.append(f"padding-left:{marginl:.1f}px;padding-right:{marginr:.1f}px;")
        css_parts.append("width:100%;box-sizing:border-box;")

        if v_align == "bottom":
            css_parts.append(f"bottom:{marginv:.1f}px;")
        elif v_align == "top":
            css_parts.append(f"top:{marginv:.1f}px;")
        else:  # center
            css_parts.append("top:50%;transform:translateY(-50%);")

    style_str = ''.join(css_parts)
    return f'<div style="{style_str}">{display_text}</div>'


def _make_opencc_converter(chinese_variant, script_display):
    """Return an OpenCC converter for the requested script display, or None.

    Parameters
    ----------
    chinese_variant : str | None
        Source variant: "zh-Hans", "zh-Hant", "yue", or None.
    script_display : str | None
        Target display: "Original", "Traditional (Taiwan)", "Simplified", or None.

    Returns None when no conversion is needed (same script or non-Chinese).
    """
    if not chinese_variant or not script_display or script_display == "Original":
        return None

    _OPENCC_CONFIGS = {
        ("zh-Hans", "Traditional (Taiwan)"): "s2tw",
        ("zh-Hant", "Simplified"):           "t2s",
        ("yue",     "Simplified"):           "t2s",
    }
    config = _OPENCC_CONFIGS.get((chinese_variant, script_display))
    if not config:
        return None

    from opencc import OpenCC  # lazy import
    return OpenCC(config)


def generate_ass_file(native_file, target_file, styles, target_lang_code,
                      resolution=(1920, 1080), output_playres=None,
                      progress_callback=None, include_annotations=True,
                      native_style_mapping=None, target_style_mapping=None):
    """
    Generates a complete 4-layer .ass file from subtitle sources and styles.

    Always produces all enabled layers: Bottom, Top, Romanized, and
    Annotation (as \\pos() events).  PGS rasterization is handled
    separately by ``generate_pgs_file()``.

    Parameters
    ----------
    native_file, target_file : str or file object
        Paths or Streamlit uploaded file objects for the two subtitle tracks.
    styles : dict
        Live style config from st.session_state.styles.
    target_lang_code : str
        BCP 47 language code for the target track.
    resolution : (int, int)
        Video (width, height) in pixels from mkv_resolution.
    output_playres : (int, int) | None
        Target PlayRes for the .ass file (width, height).  Defaults to
        (1920, 1080).
    progress_callback : callable | None
        Optional ``callback(phase, completed, total)`` for UI progress.
    include_annotations : bool
        When True (default), emit ``\\pos()`` Annotation events and keep the
        Annotation style.  When False, skip annotation generation and remove
        the Annotation style — producing a 3-layer .ass file.  PGS is
        recommended for annotations (pixel-perfect ruby rendering).
    native_style_mapping : dict | None
        Style role mapping for native subtitle (from ``detect_ass_styles``).
        Maps style names to ``"dialogue"``/``"preserve"``/``"exclude"``.
    target_style_mapping : dict | None
        Style role mapping for target subtitle.

    Returns
    -------
    str | None
        Path to the generated .ass file, or None on error.
    """
    try:
        native_subs = _load_subs(native_file)
        target_subs = _load_subs(target_file)

        stitched_subs = pysubs2.SSAFile()
        _out_res = output_playres or (_PLAY_RES_X, _PLAY_RES_Y)
        stitched_subs.info['PlayResX'] = _out_res[0]
        stitched_subs.info['PlayResY'] = _out_res[1]
        stitched_subs.info['WrapStyle'] = '2'
        _scale = _out_res[1] / _PLAY_RES_Y

        for name, config in styles.items():
            if not isinstance(config, dict):
                continue
            if not config.get('enabled', True):
                continue

            style = pysubs2.SSAStyle()
            for key, value in config.items():
                if hasattr(style, key):
                    if key in ['bold', 'italic']:
                        setattr(style, key, -1 if value else 0)
                    else:
                        setattr(style, key, value)

            if config.get('back_none', False): style.backcolor = pysubs2.Color(style.backcolor.r, style.backcolor.g, style.backcolor.b, 255)
            if config.get('outline_none', False): style.outline = 0.0
            if config.get('shadow_none', False): style.shadow = 0.0

            if not config.get('glow_none', True):
                glow_hex = config.get('glow_color_hex', '#ffff00')
                gr = int(glow_hex[1:3], 16)
                gg = int(glow_hex[3:5], 16)
                gb = int(glow_hex[5:7], 16)
                if config.get('outline_none', False):
                    style.outline = config.get('glow_radius', 5) / 3.0
                    style.outlinecolor = pysubs2.Color(gr, gg, gb, 0)

            stitched_subs.styles[name] = style

        glow_configs = {}
        for name, config in styles.items():
            if isinstance(config, dict) and not config.get('glow_none', True):
                glow_configs[name] = max(1, config.get('glow_radius', 5) // 3)

        vertical_offset = styles.get('vertical_offset', 0)
        romanized_gap = styles.get('romanized_gap', 0)
        if vertical_offset:
            if 'Top' in stitched_subs.styles:
                stitched_subs.styles['Top'].marginv += vertical_offset
            if 'Romanized' in stitched_subs.styles:
                stitched_subs.styles['Romanized'].marginv += vertical_offset
        if romanized_gap and 'Romanized' in stitched_subs.styles:
            stitched_subs.styles['Romanized'].marginv -= romanized_gap

        if _scale != 1.0:
            for style in stitched_subs.styles.values():
                style.fontsize *= _scale
                style.marginv = int(style.marginv * _scale)
                style.marginl = int(style.marginl * _scale)
                style.marginr = int(style.marginr * _scale)
                style.outline *= _scale
                style.shadow *= _scale

        # Add events — always copy so the source SSAFile is not mutated.
        if styles['Bottom']['enabled']:
            for line in _iter_dialogue_events(native_subs, style_mapping=native_style_mapping):
                new_line = line.copy()
                new_line.style = "Bottom"
                if "Bottom" in glow_configs:
                    new_line.text = f'{{\\blur{glow_configs["Bottom"]}}}{new_line.text}'
                stitched_subs.events.append(new_line)

        phonetic_system = styles.get('Annotation', {}).get('phonetic_system')
        lang_cfg = get_lang_config(target_lang_code, phonetic_system=phonetic_system)
        romanize_func = lang_cfg["romanize_func"]
        annotation_func = lang_cfg["annotation_func"]

        opencc_converter = _make_opencc_converter(
            lang_cfg.get("chinese_variant"),
            styles.get("script_display"),
        )

        resolve_spans_func = lang_cfg.get("resolve_spans_func")
        spans_to_romaji_func = lang_cfg.get("spans_to_romaji_func")
        long_vowel_mode = styles.get('Romanized', {}).get('long_vowel_mode', 'macrons')

        top_marginv = int((styles['Top']['marginv'] + vertical_offset) * _scale)
        top_fontsize = styles['Top']['fontsize'] * _scale
        screen_width = _out_res[0]

        annotation_cfg = dict(styles.get('Annotation', {}))
        annotation_cfg['annotation_gap'] = styles.get('annotation_gap', 2) * _scale
        if _scale != 1.0:
            annotation_cfg['fontsize'] = annotation_cfg.get('fontsize', 12) * _scale

        _top_fontname = styles['Top'].get('fontname', 'Arial')

        word_boundary_func = lang_cfg.get('word_boundary_func')

        romaji_enabled = styles['Romanized']['enabled'] and romanize_func
        annotation_enabled = (
            include_annotations
            and annotation_func is not None
            and styles.get('Annotation', {}).get('enabled', False)
            and lang_cfg.get('supports_ass_annotation', True)
        )
        use_pipeline = resolve_spans_func is not None and spans_to_romaji_func is not None

        # Remove Annotation style from output when annotations are disabled —
        # produces a clean 3-layer .ass file with no orphan style definition.
        if not annotation_enabled:
            stitched_subs.styles.pop('Annotation', None)

        # Load Pillow measurement font for \pos() annotation positioning.
        if annotation_enabled:
            _ann_font = _load_measurement_font(_top_fontname, int(round(top_fontsize)))
        else:
            _ann_font = None

        for line in _iter_dialogue_events(target_subs, style_mapping=target_style_mapping):
            display_text = (opencc_converter.convert(line.text)
                            if opencc_converter else line.text)

            # Strip inline furigana annotations from the display text so the
            # Top track shows clean text: 奴(やつ)らに → 奴らに.
            # Only applies when the resolved-kana pipeline is active (Japanese).
            if use_pipeline:
                display_text = _strip_reverse_furigana(
                    _strip_inline_furigana(display_text)
                )

            if styles['Top']['enabled']:
                h_line = line.copy()
                # Apply word boundary markers (Thai: thin spaces between tokens)
                # to the Top line only — display_text stays clean for romanization.
                top_text = word_boundary_func(display_text) if word_boundary_func else display_text
                h_line.text = top_text
                h_line.style = "Top"
                if "Top" in glow_configs:
                    h_line.text = f'{{\\blur{glow_configs["Top"]}}}{h_line.text}'
                stitched_subs.events.append(h_line)

            spans = None
            if use_pipeline and (romaji_enabled or annotation_enabled):
                spans = resolve_spans_func(display_text)

            if romaji_enabled:
                if use_pipeline and spans is not None:
                    romanized_text = spans_to_romaji_func(spans, long_vowel_mode)
                else:
                    romanized_text = romanize_func(display_text)
                r_line = line.copy()
                r_line.text = romanized_text
                r_line.style = "Romanized"
                if "Romanized" in glow_configs:
                    r_line.text = f'{{\\blur{glow_configs["Romanized"]}}}{r_line.text}'
                stitched_subs.events.append(r_line)

            if annotation_enabled:
                text_lines = display_text.split(r'\N')
                line_height = int(top_fontsize * 1.2)

                for line_idx, text_line in enumerate(text_lines):
                    text_line = text_line.strip()
                    if not text_line:
                        continue
                    if use_pipeline:
                        line_spans = resolve_spans_func(text_line)
                    else:
                        line_spans = annotation_func(text_line)

                    ann_events = _make_annotation_events(
                        line, line_spans,
                        annotation_cfg,
                        top_marginv + line_idx * line_height,
                        top_fontsize,
                        screen_width,
                        font=_ann_font,
                    )
                    if "Annotation" in glow_configs:
                        blur_val = glow_configs["Annotation"]
                        for ev in ann_events:
                            ev.text = f'{{\\blur{blur_val}}}' + ev.text
                    stitched_subs.events.extend(ann_events)

        # --- Append preserved events (signs/typesetting/titles) ---
        # Preserved styles are copied with prefixed names to avoid conflicts
        # with the output styles (Bottom/Top/Romanized/Annotation).
        _preserve_sources = [
            (native_subs, native_style_mapping, "SRC_N_"),
            (target_subs, target_style_mapping, "SRC_T_"),
        ]
        for src_subs, src_mapping, prefix in _preserve_sources:
            if not src_mapping:
                continue
            has_preserve = any(
                role == "preserve" for role in src_mapping.values()
            )
            if not has_preserve:
                continue

            source_res = _get_source_playres(src_subs)
            for event, style_obj in _iter_preserved_events(src_subs, src_mapping):
                if style_obj is None:
                    continue
                prefixed_name = prefix + event.style
                # Copy style definition (once per unique style name)
                if prefixed_name not in stitched_subs.styles:
                    new_style = style_obj.copy()
                    # Scale style attrs from source PlayRes to output PlayRes
                    if source_res != _out_res:
                        sy = _out_res[1] / source_res[1]
                        sx = _out_res[0] / source_res[0]
                        new_style.fontsize *= sy
                        new_style.marginv = int(new_style.marginv * sy)
                        new_style.marginl = int(new_style.marginl * sx)
                        new_style.marginr = int(new_style.marginr * sx)
                        new_style.outline *= sy
                        new_style.shadow *= sy
                    stitched_subs.styles[prefixed_name] = new_style

                new_event = _scale_preserved_event(event, source_res, _out_res)
                new_event.style = prefixed_name
                stitched_subs.events.append(new_event)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".ass", mode="w", encoding="utf-8-sig") as f:
            stitched_subs.save(f.name)
            ass_path = f.name

        return ass_path

    except Exception as e:
        st.error(f"An error occurred during generation: {e}")
        return None


def generate_pgs_file(native_file, target_file, styles, target_lang_code,
                      resolution=(1920, 1080), output_resolution=None,
                      progress_callback=None,
                      native_style_mapping=None, target_style_mapping=None):
    """
    Generates a PGS .sup file with all enabled subtitle layers as bitmaps.

    Renders full-frame composites (Bottom, Top with ruby annotations,
    Romanized) via Playwright headless Chromium, then encodes them as PGS
    bitmap subtitles.

    Parameters
    ----------
    native_file, target_file : str or file object
        Paths or Streamlit uploaded file objects for the two subtitle tracks.
    styles : dict
        Live style config from st.session_state.styles.
    target_lang_code : str
        BCP 47 language code for the target track.
    resolution : (int, int)
        Source video (width, height) in pixels.
    output_resolution : (int, int) | None
        Target PGS canvas size.  Defaults to (1920, 1080).
    progress_callback : callable | None
        Optional ``callback(completed, total)`` for UI progress.

    Returns
    -------
    str | None
        Path to the generated .sup file, or None on error.
    """
    from .rasterize import PGSFrameEvent, rasterize_pgs_to_file

    try:
        native_subs = _load_subs(native_file)
        target_subs = _load_subs(target_file)

        out_res = output_resolution or (_PLAY_RES_X, _PLAY_RES_Y)
        _scale = out_res[1] / _PLAY_RES_Y

        phonetic_system = styles.get('Annotation', {}).get('phonetic_system')
        lang_cfg = get_lang_config(target_lang_code, phonetic_system=phonetic_system)
        romanize_func = lang_cfg["romanize_func"]
        annotation_func = lang_cfg["annotation_func"]

        opencc_converter = _make_opencc_converter(
            lang_cfg.get("chinese_variant"),
            styles.get("script_display"),
        )

        resolve_spans_func = lang_cfg.get("resolve_spans_func")
        spans_to_romaji_func = lang_cfg.get("spans_to_romaji_func")
        long_vowel_mode = styles.get('Romanized', {}).get('long_vowel_mode', 'macrons')

        word_boundary_func = lang_cfg.get('word_boundary_func')

        romaji_enabled = styles['Romanized']['enabled'] and romanize_func
        annotation_enabled = (
            annotation_func is not None
            and styles.get('Annotation', {}).get('enabled', False)
        )
        use_pipeline = resolve_spans_func is not None and spans_to_romaji_func is not None
        bottom_enabled = styles['Bottom']['enabled']
        ann_render_mode = lang_cfg.get('annotation_render_mode', 'ruby')

        # --- Collect native events for temporal pairing ---
        native_events = []
        if bottom_enabled:
            for line in _iter_dialogue_events(native_subs, style_mapping=native_style_mapping):
                text = re.sub(r'\{[^}]*\}', '', line.text)
                text = text.replace(r'\N', '\\N').replace(r'\n', '\\N').replace('\n', '\\N')
                native_events.append((line.start, line.end, text.strip()))

        # --- Build PGSFrameEvents from target events ---
        pgs_events = []

        for line in _iter_dialogue_events(target_subs, style_mapping=target_style_mapping):
            display_text = (opencc_converter.convert(line.text)
                            if opencc_converter else line.text)

            if use_pipeline:
                display_text = _strip_reverse_furigana(
                    _strip_inline_furigana(display_text)
                )

            # Top text: ruby HTML or plain text
            if annotation_enabled:
                spans = None
                if use_pipeline:
                    spans = resolve_spans_func(display_text)
                else:
                    spans = annotation_func(display_text)
                top_html = build_annotation_html(spans, mode=ann_render_mode) or display_text
            else:
                # Apply word boundary markers (Thai: thin spaces) to plain Top text.
                top_html = word_boundary_func(display_text) if word_boundary_func else display_text
                spans = None

            # Romanized text
            romaji_text = None
            if romaji_enabled:
                if use_pipeline:
                    if spans is None:
                        spans = resolve_spans_func(display_text)
                    romaji_text = spans_to_romaji_func(spans, long_vowel_mode)
                else:
                    romaji_text = romanize_func(display_text)

            # Pair with native event by maximum temporal overlap
            bottom_text = None
            if bottom_enabled and native_events:
                best_overlap = 0
                for n_start, n_end, n_text in native_events:
                    overlap = max(0, min(line.end, n_end) - max(line.start, n_start))
                    if overlap > best_overlap:
                        best_overlap = overlap
                        bottom_text = n_text

            pgs_events.append(PGSFrameEvent(
                start_ms=line.start,
                end_ms=line.end,
                bottom_text=bottom_text,
                top_html=top_html,
                romaji_text=romaji_text,
            ))

        if not pgs_events:
            return None

        # --- Collect preserved events and assign to overlapping PGS frames ---
        _preserved_htmls = []  # list of (start_ms, end_ms, html_str)
        _pgs_preserve_sources = [
            (native_subs, native_style_mapping),
            (target_subs, target_style_mapping),
        ]
        for src_subs, src_mapping in _pgs_preserve_sources:
            if not src_mapping:
                continue
            has_preserve = any(
                role == "preserve" for role in src_mapping.values()
            )
            if not has_preserve:
                continue
            source_res = _get_source_playres(src_subs)
            # Collect then deduplicate overlapping karaoke layer events.
            # Without dedup, layered karaoke composites (shadow + main + sweep)
            # render as garbled overlapping text after animation tag stripping.
            raw_preserved = [
                (ev, st) for ev, st in _iter_preserved_events(src_subs, src_mapping)
                if st is not None
            ]
            deduped = _dedup_preserved_for_pgs(raw_preserved)
            for event, style_obj in deduped:
                html = _preserved_event_to_html(
                    event, style_obj, source_res, out_res, _scale,
                )
                if html:
                    _preserved_htmls.append((event.start, event.end, html))

        # Assign overlapping preserved HTML to each PGS frame event
        if _preserved_htmls:
            for pgs_ev in pgs_events:
                overlapping = []
                for p_start, p_end, p_html in _preserved_htmls:
                    overlap = max(0, min(pgs_ev.end_ms, p_end) - max(pgs_ev.start_ms, p_start))
                    if overlap > 0:
                        overlapping.append(p_html)
                if overlapping:
                    pgs_ev.preserved_html = ''.join(overlapping)

        # Rasterize frames in batches and write .sup incrementally (memory-bounded)
        sup_fd = tempfile.NamedTemporaryFile(delete=False, suffix=".sup")
        sup_path = sup_fd.name
        sup_fd.close()

        count = rasterize_pgs_to_file(
            pgs_events,
            styles=styles,
            canvas_width=out_res[0],
            canvas_height=out_res[1],
            output_path=sup_path,
            scale=_scale,
            progress_callback=progress_callback,
            annotation_render_mode=ann_render_mode,
        )

        if count == 0:
            os.unlink(sup_path)
            return None

        return sup_path

    except Exception as e:
        st.error(f"An error occurred during PGS generation: {e}")
        return None


def build_output_filename(media_title=None, year=None, native_lang=None,
                          target_lang=None, annotation_system=None,
                          romanization_system=None, ext="ass"):
    """Build a structured output filename.

    Pattern: {media_title}.{year}.{native_lang}.{target_lang}[.{annotation}][.{romanization}].{ext}

    Parameters
    ----------
    media_title : str | None
        Media title from MKV metadata or filename.  Sanitized: spaces to dots,
        special chars stripped.
    year : str | None
        Release year from MKV metadata.
    native_lang : str | None
        Native language code (e.g. "en").
    target_lang : str | None
        Target language code (e.g. "ja").
    annotation_system : str | None
        Annotation system name (e.g. "furigana", "pinyin").
    romanization_system : str | None
        Romanization system name (e.g. "hepburn", "pinyin").
    ext : str
        File extension without dot (default "ass").

    Returns
    -------
    str
        Sanitized filename.
    """
    parts = []

    if media_title:
        # Sanitize: spaces/underscores → dots, strip non-alphanumeric (keep dots)
        sanitized = re.sub(r'[\s_]+', '.', media_title.strip())
        sanitized = re.sub(r'[^\w.\-]', '', sanitized)
        sanitized = re.sub(r'\.{2,}', '.', sanitized)
        parts.append(sanitized)

    if year:
        parts.append(str(year))

    if native_lang:
        parts.append(native_lang.lower())

    if target_lang:
        parts.append(target_lang.lower())

    if annotation_system:
        clean_ann = re.sub(r'[^\w\-]', '', annotation_system).lower()
        if clean_ann:
            parts.append(clean_ann)

    if romanization_system:
        # Take first part before "/" to avoid redundancy with annotation_system
        # e.g. "Romaji / Furigana" → "romaji"
        clean_rom = romanization_system.split('/')[0].strip()
        clean_rom = re.sub(r'[^\w\-]', '', clean_rom).lower()
        if clean_rom:
            parts.append(clean_rom)

    if not parts:
        parts.append("stitched_subs")

    return '.'.join(parts) + '.' + ext
