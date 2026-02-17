# srt_stitcher_app.py
import streamlit as st
import os
import tempfile
import atexit

from app.state import initialize_state
from app.mkv_handler import scan_and_extract_tracks, extract_screenshot, merge_subs_to_mkv, get_duration
from app.ui import render_mkv_path_input, render_hybrid_selector
from app.styles import LANG_CONFIG, FONT_LIST
from app.language import detect_language
from app.preview import get_preview_lines, generate_unified_preview
from app.processing import generate_ass_file


# --- Initial Setup ---
st.set_page_config(page_title="SRTStitcher Pro", layout="wide")
initialize_state()

# --- Temporary Directory Management ---
# This ensures we have a consistent temp folder for the session
if "temp_dir_obj" not in st.session_state:
    st.session_state.temp_dir_obj = tempfile.TemporaryDirectory()
    st.session_state.temp_dir = st.session_state.temp_dir_obj.name
    atexit.register(st.session_state.temp_dir_obj.cleanup)

# --- Main App ---
st.title("🎬 SRTStitcher Pro")
st.write("---")

workflow_mode = st.radio(
    "Choose Workflow Mode:",
    ("Simple Upload (Legacy)", "MKV Workflow (Local File)"),
    key="workflow_mode"
)

if workflow_mode == "Simple Upload (Legacy)":
    st.warning("This mode is for smaller files and will use st.file_uploader.")
    # Placeholder for old file uploader logic
    st.info("Simple Upload (Legacy) mode will be implemented here in a later phase.")

elif workflow_mode == "MKV Workflow (Local File)":
    st.header("1. Load & Scan Local MKV File")
    mkv_path_input_value = render_mkv_path_input()
    st.session_state.mkv_path = mkv_path_input_value # Keep st.session_state.mkv_path updated

    if st.button("Load & Scan MKV", key="scan_mkv_button") and st.session_state.mkv_path:
        if not os.path.exists(st.session_state.mkv_path):
            st.error(f"File not found at: `{st.session_state.mkv_path}`. Please check the path.")
        else:
            with st.spinner(f"Scanning `{os.path.basename(st.session_state.mkv_path)}` for subtitle tracks..."):
                st.session_state.mkv_duration = get_duration(st.session_state.mkv_path)
                st.session_state.mkv_tracks = scan_and_extract_tracks(st.session_state.mkv_path, st.session_state.temp_dir)
                if st.session_state.mkv_tracks:
                    st.success(f"Scan complete. Found {len(st.session_state.mkv_tracks)} text-based subtitle tracks.")
                else:
                    st.warning("No text-based subtitle tracks (SRT, ASS) found in the MKV.")

    # --- 2. Subtitle Source Selection ---
    if st.session_state.mkv_path and st.session_state.mkv_tracks:
        st.header("2. Select Subtitle Sources")
        
        col1, col2 = st.columns(2)
        with col1:
            st.session_state.native_sub_path = render_hybrid_selector(
                "Native Subtitle Source",
                st.session_state.mkv_tracks,
                key="native"
            )
        with col2:
            st.session_state.target_sub_path = render_hybrid_selector(
                "Target Subtitle Source",
                st.session_state.mkv_tracks,
                key="target"
            )

    # --- 3. Style, Preview & Generate ---
    if st.session_state.native_sub_path and st.session_state.target_sub_path:
        st.write("---")
        st.header("3. Style & Preview")

        # --- Frame grab (top of section so user gets a frame first) ---
        if st.session_state.mkv_path and os.path.exists(st.session_state.mkv_path):
            duration = st.session_state.get("mkv_duration", 0) or 1
            preview_cols = st.columns([3, 1])
            with preview_cols[0]:
                timestamp = st.slider(
                    "Timestamp (seconds)", min_value=0,
                    max_value=duration, value=min(300, duration),
                    step=1, key="screenshot_ts",
                )
            with preview_cols[1]:
                st.write("<br>", unsafe_allow_html=True)
                grab_frame = st.button("Grab Frame", key="grab_frame_btn")

            if grab_frame:
                with st.spinner("Extracting frame..."):
                    screenshot_path = extract_screenshot(
                        st.session_state.mkv_path, timestamp,
                        st.session_state.temp_dir,
                    )
                    if screenshot_path and os.path.exists(screenshot_path):
                        st.session_state.screenshot_path = screenshot_path
                    else:
                        st.warning("Could not extract frame at this timestamp.")

        # --- Detect target language for romanization ---
        target_lang_code = detect_language(st.session_state.target_sub_path)
        st.session_state.target_lang_code = target_lang_code
        lang_config = LANG_CONFIG.get(target_lang_code, {})
        romanize_func = lang_config.get("romanize_function")
        romanization_name = lang_config.get("romanization_name", "N/A")

        st.caption(f"Detected target language: **{target_lang_code}** — Romanization: {romanization_name}")

        # --- Build default styles if not already set ---
        if not st.session_state.styles:
            import pysubs2
            st.session_state.styles = {
                "Bottom": {
                    "enabled": True, "fontname": "Arial", "fontsize": 20,
                    "bold": False, "italic": False,
                    "primarycolor": pysubs2.Color(255, 255, 255, 0),
                    "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                    "backcolor": pysubs2.Color(0, 0, 0, 128),
                    "outline": 2.0, "shadow": 0.0,
                    "back_none": True, "outline_none": False, "shadow_none": True,
                },
                "Top": {
                    "enabled": True, "fontname": "Arial", "fontsize": 18,
                    "bold": False, "italic": False,
                    "primarycolor": pysubs2.Color(255, 255, 0, 0),
                    "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                    "backcolor": pysubs2.Color(0, 0, 0, 128),
                    "outline": 2.0, "shadow": 0.0,
                    "back_none": True, "outline_none": False, "shadow_none": True,
                },
                "Romanized": {
                    "enabled": romanize_func is not None, "fontname": "Arial", "fontsize": 14,
                    "bold": False, "italic": True,
                    "primarycolor": pysubs2.Color(200, 200, 200, 0),
                    "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                    "backcolor": pysubs2.Color(0, 0, 0, 128),
                    "outline": 1.0, "shadow": 0.0,
                    "back_none": True, "outline_none": False, "shadow_none": True,
                },
            }

        # --- Style editing per track ---
        for track_name in ["Bottom", "Top", "Romanized"]:
            config = st.session_state.styles[track_name]
            with st.expander(f"{track_name} Track Style", expanded=False):
                config["enabled"] = st.checkbox("Enabled", value=config["enabled"], key=f"{track_name}_enabled")
                if not config["enabled"]:
                    continue
                col_a, col_b, col_c = st.columns(3)
                with col_a:
                    config["fontname"] = st.selectbox("Font", FONT_LIST, index=FONT_LIST.index(config["fontname"]) if config["fontname"] in FONT_LIST else 0, key=f"{track_name}_font")
                    config["fontsize"] = st.slider("Size", 8, 48, config["fontsize"], key=f"{track_name}_size")
                with col_b:
                    config["bold"] = st.checkbox("Bold", value=config["bold"], key=f"{track_name}_bold")
                    config["italic"] = st.checkbox("Italic", value=config["italic"], key=f"{track_name}_italic")
                with col_c:
                    config["outline_none"] = st.checkbox("No Outline", value=config.get("outline_none", True), key=f"{track_name}_no_outline")
                    if not config["outline_none"]:
                        config["outline"] = st.slider("Outline", 0.0, 5.0, config["outline"], key=f"{track_name}_outline")
                    config["shadow_none"] = st.checkbox("No Shadow", value=config.get("shadow_none", True), key=f"{track_name}_no_shadow")

        # --- Composite preview: subtitles rendered over the video frame ---
        st.subheader("Preview")
        preview_lines = get_preview_lines(st.session_state.native_sub_path, st.session_state.target_sub_path)
        if preview_lines:
            native_text = preview_lines["native"]
            target_text = preview_lines["target"]
            pinyin_text = ""
            if romanize_func and st.session_state.styles["Romanized"]["enabled"]:
                pinyin_text = romanize_func(target_text)
            bg_path = st.session_state.get("screenshot_path")
            preview_html = generate_unified_preview(
                st.session_state.styles, native_text, target_text, pinyin_text,
                background_image_path=bg_path,
            )
            st.components.v1.html(preview_html, height=550)
        else:
            st.info("Could not generate preview lines from the selected subtitles.")

        # --- Generate ---
        st.write("---")
        st.subheader("Generate")

        output_name = st.text_input("Output filename", value="stitched_subs.ass", key="output_name")

        if st.button("Generate .ass File", key="generate_ass_btn"):
            with st.spinner("Generating stitched subtitle file..."):
                ass_path = generate_ass_file(
                    st.session_state.native_sub_path,
                    st.session_state.target_sub_path,
                    st.session_state.styles,
                    target_lang_code,
                )
            if ass_path:
                st.session_state.generated_ass_path = ass_path
                st.success("Subtitle file generated.")

        # --- Download & Remux ---
        if st.session_state.get("generated_ass_path") and os.path.exists(st.session_state.get("generated_ass_path", "")):
            with open(st.session_state.generated_ass_path, "rb") as f:
                st.download_button("Download .ass", data=f, file_name=output_name, mime="text/plain")

            if st.session_state.mkv_path and os.path.exists(st.session_state.mkv_path):
                st.write("---")
                st.subheader("Remux into MKV")
                mkv_base = os.path.splitext(os.path.basename(st.session_state.mkv_path))[0]
                output_mkv_name = st.text_input("Output MKV filename", value=f"{mkv_base}_stitched.mkv", key="output_mkv_name")
                output_mkv_path = os.path.join(os.path.dirname(st.session_state.mkv_path), output_mkv_name)

                if st.button("Mux Subtitles into MKV", key="remux_btn"):
                    with st.spinner("Muxing subtitle track into MKV (no re-encoding)..."):
                        result = merge_subs_to_mkv(st.session_state.mkv_path, st.session_state.generated_ass_path, output_mkv_path)
                    if result:
                        st.success(f"Done! Output saved to `{output_mkv_path}`")
                    else:
                        st.error("Muxing failed. Check the console for ffmpeg errors.")

    elif st.session_state.mkv_path:
        if st.session_state.mkv_tracks:
            st.info("Please select both a native and target subtitle source to continue.")
        else:
            st.info("No subtitle tracks found or selected. Please ensure your MKV has embedded text subtitles or upload custom files.")
    else:
        st.info("Begin by entering the path to a local MKV file and clicking 'Load & Scan MKV'.")
