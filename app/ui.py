# app/ui.py
import streamlit as st
import pysubs2
from .styles import FONT_LIST

def hex_to_rgb(h): return tuple(int(h.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))
def rgb_to_hex(rgb): return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"

def render_styling_dashboard(track_keys, romanization_possible):
    """Renders the entire styling dashboard with its tabs and controls."""
    tab_names = [f"Bottom ({st.session_state.native_lang})", f"Top ({st.session_state.target_lang})", st.session_state.romanization_lang]
    tabs = st.tabs(tab_names)

    for i, tab in enumerate(tabs):
        track_name = track_keys[i]
        s = st.session_state.styles[track_name]

        with tab:
            # Enable/disable checkbox for Top and Romanized tracks
            if track_name != "Bottom":
                disable_toggle = (track_name == "Romanized" and not romanization_possible)
                s['enabled'] = st.checkbox("Enable this track", value=s['enabled'], key=f"enabled_{track_name}", disabled=disable_toggle)
            
            # Only show controls if the track is enabled
            if s['enabled']:
                _render_track_controls(track_name, s)

def _render_track_controls(track_name, s):
    """Renders the set of style controls for a single track."""
    st.markdown("##### Character")
    char_col1, char_col2 = st.columns(2)
    font_index = FONT_LIST.index(s['fontname']) if s['fontname'] in FONT_LIST else 0
    s['fontname'] = char_col1.selectbox("Font Name", FONT_LIST, index=font_index, key=f"font_{track_name}")
    s['bold'] = char_col1.checkbox("Bold", s['bold'], key=f"bold_{track_name}")
    s['fontsize'] = char_col2.slider("Font Size", 10, 150, s['fontsize'], key=f"size_{track_name}")
    s['italic'] = char_col2.checkbox("Italic", s['italic'], key=f"italic_{track_name}")

    st.markdown("---")
    st.markdown("##### Color & Windowing")
    st.write("Primary Color")
    pc_col1, pc_col2 = st.columns([1, 2])
    pc_hex = pc_col1.color_picker("Text Color", rgb_to_hex((s['primarycolor'].r, s['primarycolor'].g, s['primarycolor'].b)), key=f"pc_hex_{track_name}")
    pc_opacity = pc_col2.slider("Text Opacity (%)", 0, 100, round((255 - s['primarycolor'].a) / 2.55), key=f"pc_alpha_{track_name}")
    s['primarycolor'] = pysubs2.Color(*hex_to_rgb(pc_hex), 255 - int(pc_opacity * 2.55))

    st.write("Background Box")
    s['back_none'] = st.checkbox("None", s['back_none'], key=f"back_none_{track_name}")
    bc_col1, bc_col2 = st.columns([1, 2])
    bc_hex = bc_col1.color_picker("Box Color", rgb_to_hex((s['backcolor'].r, s['backcolor'].g, s['backcolor'].b)), key=f"bc_hex_{track_name}", disabled=s['back_none'])
    bc_opacity = bc_col2.slider("Box Opacity (%)", 0, 100, round((255 - s['backcolor'].a) / 2.55), key=f"bc_alpha_{track_name}", disabled=s['back_none'])
    s['backcolor'] = pysubs2.Color(*hex_to_rgb(bc_hex), 255 - int(bc_opacity * 2.55))

    st.markdown("---")
    st.markdown("##### Edge Features")
    st.write("Outline")
    s['outline_none'] = st.checkbox("None", s['outline_none'], key=f"outline_none_{track_name}")
    oc_col1, oc_col2 = st.columns([1, 2])
    oc_hex = oc_col1.color_picker("Outline Color", rgb_to_hex((s['outlinecolor'].r, s['outlinecolor'].g, s['outlinecolor'].b)), key=f"oc_hex_{track_name}", disabled=s['outline_none'])
    oc_opacity = oc_col2.slider("Outline Opacity (%)", 0, 100, round((255 - s['outlinecolor'].a) / 2.55), key=f"oc_alpha_{track_name}", disabled=s['outline_none'])
    s['outlinecolor'] = pysubs2.Color(*hex_to_rgb(oc_hex), 255 - int(oc_opacity * 2.55))
    s['outline'] = st.slider("Outline Width", 0.0, 10.0, s['outline'], 0.5, key=f"outline_{track_name}", disabled=s['outline_none'])

    st.write("Shadow")
    s['shadow_none'] = st.checkbox("None", s['shadow_none'], key=f"shadow_none_{track_name}")
    s['shadow'] = st.slider("Shadow Distance", 0.0, 10.0, s['shadow'], 0.5, key=f"shadow_{track_name}", disabled=s['shadow_none'])
