# app/state.py
import streamlit as st

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
    # NOTE: temp_dir is intentionally NOT created here.
    # srt_stitcher_app.py owns temp dir creation via tempfile.TemporaryDirectory()
    # so that cleanup is managed and the dir path is registered via atexit.
    if 'temp_dir' not in st.session_state:
        st.session_state.temp_dir = None
    
    if 'native_sub_path' not in st.session_state:
        st.session_state.native_sub_path = None
    if 'target_sub_path' not in st.session_state:
        st.session_state.target_sub_path = None

    if 'mkv_duration' not in st.session_state:
        st.session_state.mkv_duration = 0
    if 'screenshot_path' not in st.session_state:
        st.session_state.screenshot_path = None
    if 'last_extracted_ts' not in st.session_state:
        st.session_state.last_extracted_ts = None

    if 'mkv_path_input' not in st.session_state:
        st.session_state.mkv_path_input = ""
    if 'mkv_resolution' not in st.session_state:
        st.session_state.mkv_resolution = (1920, 1080)
