# srt_stitcher_app.py
import streamlit as st
import pysubs2
from app.state import initialize_session_state
from app.styles import LANG_CONFIG
from app.language import detect_language_from_file
from app.ui import render_styling_dashboard
from app.processing import generate_ass_file
from app.preview import get_preview_lines, generate_unified_preview

# --- Initial Setup ---
st.set_page_config(page_title="SRTStitcher Pro", layout="wide")
initialize_session_state()

# --- Main App ---
st.title("🎬 SRTStitcher Pro")

st.header("1. Upload Subtitles")
upload_cols = st.columns(2)
native_file = upload_cols[0].file_uploader("Upload Native Language Subtitle (.srt)", type="srt")
target_file = upload_cols[1].file_uploader("Upload Target Language Subtitle (.srt, e.g., German, Chinese)", type="srt")

# --- Language Detection & Manual Override ---
if native_file and st.session_state.native_lang == "Native":
    lang_code = detect_language_from_file(native_file)
    st.session_state.native_lang = LANG_CONFIG.get(lang_code, {}).get("display_name", "Unknown")

if target_file and st.session_state.target_lang == "Target":
    lang_code = detect_language_from_file(target_file)
    st.session_state.target_lang_code = lang_code
    config = LANG_CONFIG.get(lang_code)
    if config:
        st.session_state.target_lang = config["display_name"]
        st.session_state.romanization_lang = config["romanization_name"]
        if config["romanize_function"] is None:
            st.session_state.styles["Romanized"]["enabled"] = False
    else:
        st.session_state.target_lang = "Unsupported"
        st.session_state.romanization_lang = "N/A"

# Manual Override UI (optional, can be added here if needed)

# --- Main Content Layout (Controls & Preview) ---
main_cols = st.columns([0.6, 0.4])

with main_cols[0]:
    st.header(f"3. Customize Styles")
    romanization_possible = LANG_CONFIG.get(st.session_state.target_lang_code, {}).get("romanize_function") is not None
    render_styling_dashboard(["Bottom", "Top", "Romanized"], romanization_possible)

with main_cols[1]:
    st.header("2. Visual Preview")
    if native_file and target_file:
        preview_lines = get_preview_lines(native_file, target_file)
        if preview_lines:
            romanize_func = LANG_CONFIG.get(st.session_state.target_lang_code, {}).get("romanize_function")
            romanized_text = romanize_func(preview_lines["target"]) if romanize_func else ""
            
            st.markdown(generate_unified_preview(
                st.session_state.styles, 
                preview_lines["native"], 
                preview_lines["target"], 
                romanized_text
            ), unsafe_allow_html=True)
        else:
            st.warning("Could not generate preview. Files might be empty or out of sync.")
    else:
        st.info("Upload both subtitle files to see the preview.")

    # --- Generation Button ---
    if native_file and target_file:
        if st.button("✨ Generate Stitched .ass File", type="primary"):
            with st.spinner("Generating file..."):
                temp_file_path = generate_ass_file(native_file, target_file, st.session_state.styles, st.session_state.target_lang_code)
                if temp_file_path:
                    st.success("✅ Subtitle file generated!")
                    with open(temp_file_path, "rb") as f:
                        st.download_button("📥 Download .ass file", f, file_name="stitched_subs.ass")
