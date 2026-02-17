# app/state.py
import streamlit as st
import tempfile
import os

def initialize_state():
    """Initializes all necessary session state variables."""
    if 'styles' not in st.session_state:
        st.session_state.native_lang = "Native"
        st.session_state.target_lang = "Target"
        st.session_state.romanization_lang = "Romanized"
        st.session_state.target_lang_code = None
        st.session_state.styles = {}

    # --- State for MKV Workflow ---
    if 'mkv_path' not in st.session_state:
        st.session_state.mkv_path = None
    if 'mkv_tracks' not in st.session_state:
        st.session_state.mkv_tracks = []
    if 'temp_dir' not in st.session_state:
        # Create a temporary directory for this session
        st.session_state.temp_dir = tempfile.mkdtemp()
    
    if 'native_sub_path' not in st.session_state:
        st.session_state.native_sub_path = None
    if 'target_sub_path' not in st.session_state:
        st.session_state.target_sub_path = None

    if 'mkv_duration' not in st.session_state:
        st.session_state.mkv_duration = 0
    if 'screenshot_path' not in st.session_state:
        st.session_state.screenshot_path = None

    if 'mkv_path_input' not in st.session_state:
        st.session_state.mkv_path_input = ""
