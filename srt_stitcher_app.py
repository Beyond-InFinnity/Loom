# srt_stitcher_app.py
import streamlit as st
import os
import tempfile
import atexit

from app.state import initialize_state
from app.mkv_handler import scan_and_extract_tracks, extract_screenshot, merge_subs_to_mkv, get_video_metadata
from app.ui import render_mkv_path_input, render_hybrid_selector
from app.styles import get_lang_config, FONT_LIST
from app.language import detect_language
from app.preview import get_lines_at_timestamp, generate_unified_preview
from app.processing import generate_ass_file
from app.romanize import get_hiragana, detect_preexisting_furigana


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
            st.error(f"File not found at: `{st.session_state.mkv_path}`")
        else:
            with st.spinner(f"Scanning `{os.path.basename(st.session_state.mkv_path)}`..."):
                # --- NEW METADATA LOGIC ---
                metadata = get_video_metadata(st.session_state.mkv_path)
                st.session_state.mkv_duration = metadata['duration']
                st.session_state.mkv_resolution = (metadata['width'], metadata['height'])
                # --------------------------
                
                st.session_state.mkv_tracks = scan_and_extract_tracks(st.session_state.mkv_path, st.session_state.temp_dir)
                if st.session_state.mkv_tracks:
                    st.success(f"Scan complete. Resolution: {metadata['width']}x{metadata['height']}")
                else:
                    st.warning("No text-based subtitle tracks found.")

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

        # --- Frame auto-extract on slider change ---
        if st.session_state.mkv_path and os.path.exists(st.session_state.mkv_path):
            duration = st.session_state.get("mkv_duration", 0) or 1
            timestamp = st.slider(
                "Timestamp (seconds)", min_value=0,
                max_value=duration, value=min(300, duration),
                step=1, key="screenshot_ts",
            )
            # Extract a new frame whenever the slider moves (or on first load).
            # last_extracted_ts tracks the timestamp of the current screenshot_path
            # so we only call ffmpeg when the value actually changed.
            if st.session_state.get("last_extracted_ts") != timestamp:
                with st.spinner("Extracting frame..."):
                    path = extract_screenshot(
                        st.session_state.mkv_path, timestamp,
                        st.session_state.temp_dir,
                    )
                if path and os.path.exists(path):
                    st.session_state.screenshot_path = path
                    st.session_state.last_extracted_ts = timestamp

        # --- Detect target language for romanization ---
        target_lang_code = detect_language(st.session_state.target_sub_path)
        st.session_state.target_lang_code = target_lang_code
        lang_config = get_lang_config(target_lang_code)
        romanize_func = lang_config["romanize_func"]
        romanization_name = lang_config["romanization_name"]

        st.caption(f"Detected target language: **{target_lang_code}** — Romanization: {romanization_name}")

        # --- Pre-existing furigana detection (Japanese tracks only) ---
        if target_lang_code and target_lang_code.lower().split("-")[0] == "ja":
            furigana_found, furigana_detail = detect_preexisting_furigana(st.session_state.target_sub_path)
            if furigana_found:
                st.info(
                    f"ℹ️ **Pre-existing furigana detected** in the Japanese subtitle track "
                    f"({furigana_detail}). The Romanized layer will still be generated as flat "
                    f"Hepburn romaji — character-aligned reuse of existing furigana is planned "
                    f"for R3b."
                )

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
                    "alignment": 2,  # bottom-center
                    "marginv": 20,
                    "back_none": True, "outline_none": False, "shadow_none": True,
                },
                "Top": {
                    "enabled": True, "fontname": "Arial", "fontsize": 18,
                    "bold": False, "italic": False,
                    "primarycolor": pysubs2.Color(255, 255, 0, 0),
                    "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                    "backcolor": pysubs2.Color(0, 0, 0, 128),
                    "outline": 2.0, "shadow": 0.0,
                    "alignment": 8,  # top-center
                    "marginv": 25,
                    "back_none": True, "outline_none": False, "shadow_none": True,
                },
                "Romanized": {
                    "enabled": True, "fontname": "Arial", "fontsize": 14,
                    "bold": False, "italic": True,
                    "primarycolor": pysubs2.Color(200, 200, 200, 0),
                    "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                    "backcolor": pysubs2.Color(0, 0, 0, 128),
                    "outline": 1.0, "shadow": 0.0,
                    "alignment": 8,  # top-center, marginv=5 places it above Top text
                    "marginv": 5,
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
                    config["fontsize"] = st.slider("Size", 8, 150, config["fontsize"], key=f"{track_name}_size")
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
        preview_ts = st.session_state.get("screenshot_ts", 0)
        preview_lines = get_lines_at_timestamp(
            st.session_state.native_sub_path,
            st.session_state.target_sub_path,
            preview_ts,
        )
        native_text = preview_lines["native"]
        target_text = preview_lines["target"]
        pinyin_text = ""
        if romanize_func and target_text and st.session_state.styles["Romanized"]["enabled"]:
            pinyin_text = romanize_func(target_text)
        bg_path = st.session_state.get("screenshot_path")

        # --- 🔍 DIAGNOSTIC PROBE ---
        with st.expander("🔧 Debug: Pipeline Inspection", expanded=False):
            st.write("---")
            st.subheader("🔍 PIPELINE INSPECTION")
            d_col1, d_col2 = st.columns(2)

            with d_col1:
                st.warning("📸 **Video Frame Check**")
                st.write(f"**Path in Variable:** `{bg_path}`")
                if bg_path:
                    exists = os.path.exists(bg_path)
                    st.write(f"**Exists on Disk:** `{exists}`")
                    if exists:
                        st.write(f"**File Size:** `{os.path.getsize(bg_path)} bytes`")
                        with open(bg_path, 'rb') as f:
                            header = f.read(4)
                        st.write(f"**Header Hex:** `{header.hex()}` (FFD8... is JPG)")
                else:
                    st.error("❌ Variable is None/Empty")

                st.warning("📐 **Resolution Check**")
                res = st.session_state.get('mkv_resolution')
                st.write(f"**State Resolution:** `{res}`")

            with d_col2:
                st.warning("📝 **Subtitle Text Check**")
                st.code(f"Native (Bottom): '{native_text}'")
                st.code(f"Target (Top): '{target_text}'")
                st.code(f"Pinyin/Romaji (Romanized): '{pinyin_text}'")
                if target_lang_code and target_lang_code.lower().split("-")[0] == "ja":
                    furigana_text = get_hiragana(target_lang_code, target_text)
                    st.code(f"Furigana (hiragana readings): '{furigana_text}'")

                st.warning("🎨 **Style Visibility Check**")
                st.write(f"Bottom Enabled: `{st.session_state.styles['Bottom']['enabled']}`")
                st.write(f"Top Enabled: `{st.session_state.styles['Top']['enabled']}`")
                st.write(f"Romanized Enabled: `{st.session_state.styles['Romanized']['enabled']}`")
        # --- 🔍 DIAGNOSTIC PROBE END ---

        preview_html = generate_unified_preview(
            st.session_state.styles, native_text, target_text, pinyin_text,
            resolution=st.session_state.get("mkv_resolution", (1920, 1080)),
            background_image_path=bg_path,
        )
        st.components.v1.html(preview_html, height=600, scrolling=False)
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
