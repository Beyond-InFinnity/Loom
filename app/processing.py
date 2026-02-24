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


def _iter_dialogue_events(subs):
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
    """
    # Count non-drawing events per layer to find the main dialogue layer.
    layer_counts = {}
    for event in subs:
        if _VEC_PATH_RE.search(event.text):
            continue
        layer_counts[event.layer] = layer_counts.get(event.layer, 0) + 1

    if not layer_counts:
        return

    is_multilayer = len(layer_counts) > 1
    main_layer = max(layer_counts, key=layer_counts.get) if is_multilayer else next(iter(layer_counts))

    for event in subs:
        if _VEC_PATH_RE.search(event.text):
            continue
        if is_multilayer and event.layer != main_layer:
            continue
        yield event


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
                      progress_callback=None, include_annotations=True):
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
            for line in _iter_dialogue_events(native_subs):
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

        for line in _iter_dialogue_events(target_subs):
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

        with tempfile.NamedTemporaryFile(delete=False, suffix=".ass", mode="w", encoding="utf-8-sig") as f:
            stitched_subs.save(f.name)
            ass_path = f.name

        return ass_path

    except Exception as e:
        st.error(f"An error occurred during generation: {e}")
        return None


def generate_pgs_file(native_file, target_file, styles, target_lang_code,
                      resolution=(1920, 1080), output_resolution=None,
                      progress_callback=None):
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
    from .rasterize import PGSFrameEvent, rasterize_pgs_frames
    from .sup_writer import write_sup

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
            for line in _iter_dialogue_events(native_subs):
                text = re.sub(r'\{[^}]*\}', '', line.text)
                text = text.replace(r'\N', '\\N').replace(r'\n', '\\N').replace('\n', '\\N')
                native_events.append((line.start, line.end, text.strip()))

        # --- Build PGSFrameEvents from target events ---
        pgs_events = []

        for line in _iter_dialogue_events(target_subs):
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

        # Rasterize all frames
        display_sets = rasterize_pgs_frames(
            pgs_events,
            styles=styles,
            canvas_width=out_res[0],
            canvas_height=out_res[1],
            scale=_scale,
            progress_callback=progress_callback,
            annotation_render_mode=ann_render_mode,
        )

        if not display_sets:
            return None

        sup_fd = tempfile.NamedTemporaryFile(delete=False, suffix=".sup")
        sup_path = sup_fd.name
        sup_fd.close()
        write_sup(display_sets, sup_path)

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
