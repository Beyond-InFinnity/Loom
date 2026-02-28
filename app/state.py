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
    if 'mkv_scan_complete' not in st.session_state:
        st.session_state.mkv_scan_complete = False
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

    # --- Style mapping for multi-style ASS files ---
    if 'native_style_info' not in st.session_state:
        st.session_state.native_style_info = None
    if 'target_style_info' not in st.session_state:
        st.session_state.target_style_info = None
    if 'native_style_mapping' not in st.session_state:
        st.session_state.native_style_mapping = None
    if 'target_style_mapping' not in st.session_state:
        st.session_state.target_style_mapping = None

    # --- Timing offsets ---
    if 'bottom_offset_sec' not in st.session_state:
        st.session_state.bottom_offset_sec = 0.0
    if 'top_offset_sec' not in st.session_state:
        st.session_state.top_offset_sec = 0.0
    if 'timing_offsets_linked' not in st.session_state:
        st.session_state.timing_offsets_linked = False
    if '_prev_bottom_offset' not in st.session_state:
        st.session_state._prev_bottom_offset = 0.0
    if '_prev_top_offset' not in st.session_state:
        st.session_state._prev_top_offset = 0.0

    # --- Pending offset values (deferred writes for auto-alignment Apply) ---
    if '_pending_top_offset_sec' not in st.session_state:
        st.session_state._pending_top_offset_sec = None
    if '_pending_bottom_offset_sec' not in st.session_state:
        st.session_state._pending_bottom_offset_sec = None

    # --- Auto-alignment from reference ---
    if '_ref_align_path' not in st.session_state:
        st.session_state._ref_align_path = ""
    if '_ref_align_tracks' not in st.session_state:
        st.session_state._ref_align_tracks = None
    if '_ref_align_scanned_path' not in st.session_state:
        st.session_state._ref_align_scanned_path = None
    if '_ref_align_offset' not in st.session_state:
        st.session_state._ref_align_offset = None
    if '_ref_align_warning' not in st.session_state:
        st.session_state._ref_align_warning = None

    # --- Color preset system (R6b) ---
    if 'active_color_preset' not in st.session_state:
        st.session_state.active_color_preset = ""
