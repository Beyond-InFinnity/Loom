# app/processing.py
import streamlit as st
import pysubs2
import tempfile
from .styles import LANG_CONFIG


def _load_subs(source):
    """Load subtitles from either a file path (str) or a Streamlit file object."""
    if isinstance(source, str):
        return pysubs2.load(source)
    source.seek(0)
    return pysubs2.SSAFile.from_string(source.getvalue().decode("utf-8"))


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

        # Add events
        if styles['Bottom']['enabled']:
            for line in native_subs:
                line.style = "Bottom"
                stitched_subs.events.append(line)
        
        romanize_func = LANG_CONFIG.get(target_lang_code, {}).get("romanize_function")
        for line in target_subs:
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
