# app/state.py
import streamlit as st
import pysubs2
from .styles import LANG_CONFIG

def initialize_session_state():
    """Initializes all necessary session state variables."""
    if 'styles' not in st.session_state:
        st.session_state.native_lang = "Native"
        st.session_state.target_lang = "Target"
        st.session_state.romanization_lang = "Romanized"
        st.session_state.target_lang_code = None

        st.session_state.styles = {
            "Bottom": {
                "fontname": "Georgia", "fontsize": 24, "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(255, 255, 255, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128), "back_none": True,
                "outlinecolor": pysubs2.Color(0, 0, 0, 0), "outline": 2.0, "outline_none": False,
                "shadow": 1.0, "shadow_none": True, "alignment": 2, "enabled": True
            },
            "Top": {
                "fontname": "Noto Sans SC", "fontsize": 36, "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(255, 255, 255, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128), "back_none": True,
                "outlinecolor": pysubs2.Color(0, 0, 0, 0), "outline": 2.0, "outline_none": False,
                "shadow": 1.0, "shadow_none": True, "alignment": 8, "enabled": True
            },
            "Romanized": {
                "fontname": "Times New Roman", "fontsize": 18, "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(229, 229, 229, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128), "back_none": True,
                "outlinecolor": pysubs2.Color(0, 0, 0, 0), "outline": 1.0, "outline_none": False,
                "shadow": 0.5, "shadow_none": True, "alignment": 8, "enabled": True
            }
        }
