# app/processing.py
import re
import streamlit as st
import pysubs2
import tempfile
from .styles import get_lang_config

# Matches ASS vector-path drawing commands (\p1, \p2, etc.)
# Events containing these are graphical shapes, never subtitle text.
_VEC_PATH_RE = re.compile(r'\\p\d')


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
      - Layer N (highest) — the actual readable dialogue lines
      - Layers 0…N-1   — karaoke glow/shadow compositing, syllable-highlight
                          clips, OP/ED romaji, chapter-marker drawings, etc.

    Convention: the highest-numbered layer is the main dialogue layer.  All
    lower layers are compositing/effects layers for karaoke or title sequences
    and are excluded.  Single-layer files (plain SRT, simple ASS) are returned
    in full.

    Vector-path drawing events (\\p1, \\p2 …) are always excluded — they are
    graphical shapes, never subtitle text.
    """
    layers = {e.layer for e in subs}
    main_layer = max(layers) if layers else 0
    is_multilayer = len(layers) > 1

    for event in subs:
        # Always skip vector-path drawings.
        if _VEC_PATH_RE.search(event.text):
            continue
        # For multi-layer ASS, discard all compositing/effects layers.
        if is_multilayer and event.layer < main_layer:
            continue
        yield event


def generate_ass_file(native_file, target_file, styles, target_lang_code):
    """
    Generates the final .ass file from subtitle sources and current styles.
    Accepts either file path strings or Streamlit uploaded file objects.
    """
    try:
        native_subs = _load_subs(native_file)
        target_subs = _load_subs(target_file)

        stitched_subs = pysubs2.SSAFile()

        for name, config in styles.items():
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

            stitched_subs.styles[name] = style

        # Add events — always copy so the source SSAFile is not mutated.
        if styles['Bottom']['enabled']:
            for line in _iter_dialogue_events(native_subs):
                new_line = line.copy()
                new_line.style = "Bottom"
                stitched_subs.events.append(new_line)

        romanize_func = get_lang_config(target_lang_code)["romanize_func"]
        for line in _iter_dialogue_events(target_subs):
            if styles['Top']['enabled']:
                h_line = line.copy()
                h_line.style = "Top"
                stitched_subs.events.append(h_line)

            if styles['Romanized']['enabled'] and romanize_func:
                romanized_text = romanize_func(line.text)
                r_line = line.copy()
                r_line.text = romanized_text
                r_line.style = "Romanized"
                stitched_subs.events.append(r_line)

        # Save to a temporary file for download
        with tempfile.NamedTemporaryFile(delete=False, suffix=".ass", mode="w", encoding="utf-8-sig") as f:
            stitched_subs.save(f.name)
            return f.name

    except Exception as e:
        st.error(f"An error occurred during generation: {e}")
        return None
