# srt_stitcher_app.py
import logging
import sys
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format="%(name)s %(levelname)s: %(message)s")

import streamlit as st
import os
import tempfile
import atexit

from app.state import initialize_state
from app.mkv_handler import scan_and_extract_tracks, extract_screenshot, merge_subs_to_mkv, get_video_metadata, extract_pgs_stream, _build_track_title
from app.rasterize import is_playwright_available
from app.ui import render_mkv_path_input, render_hybrid_selector, render_ocr_buttons, render_path_input
from app.styles import get_lang_config, FONT_LIST, CJK_FONT_LIST
from app.language import detect_language
from app.preview import get_lines_at_timestamp, generate_unified_preview
from app.processing import generate_ass_file, generate_pgs_file, build_output_filename, detect_ass_styles
from app.romanize import get_hiragana, detect_preexisting_furigana, build_annotation_html
from app.color_presets import build_preset_selectbox_options, get_preset_styles, preset_swatch_colors, PRESETS
from app.sub_utils import compute_subtitle_offset, load_subs_cached
import pysubs2


def _hex_to_ass_color(hex_str):
    """Convert #RRGGBB hex string to pysubs2.Color (opaque)."""
    r, g, b = int(hex_str[1:3], 16), int(hex_str[3:5], 16), int(hex_str[5:7], 16)
    return pysubs2.Color(r, g, b, 0)


def _ass_color_to_hex(color):
    """Convert pysubs2.Color to #RRGGBB hex string."""
    return f"#{color.r:02x}{color.g:02x}{color.b:02x}"


def _fmt_ts(s):
    """Format seconds as HH:MM:SS.00"""
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}.00"


def _parse_time_input(text, max_seconds):
    """Parse flexible time input to integer seconds, clamped to [0, max_seconds].

    Formats:
        3         → 3 minutes (180s)
        3.5       → 3.5 minutes (210s)
        3:56      → 3 min 56 sec (236s)
        1:22:33   → 1h 22m 33s (4953s)
        1:22:3344 → 1h 22m 33.44s (4953s)
        00:05:30.00 → 5m 30s (330s)
    Returns None on parse failure.
    """
    text = text.strip()
    if not text:
        return None
    try:
        parts = text.split(":")
        if len(parts) == 1:
            # Bare number = minutes
            return max(0, min(round(float(parts[0]) * 60), max_seconds))
        elif len(parts) == 2:
            # M:SS
            m = float(parts[0])
            s = float(parts[1])
            return max(0, min(round(m * 60 + s), max_seconds))
        elif len(parts) == 3:
            # H:MM:SS or H:MM:SS.ff or H:MM:SSFF
            h = float(parts[0])
            m = float(parts[1])
            sec_part = parts[2]
            if "." in sec_part:
                s = float(sec_part)
            elif len(sec_part) > 2:
                # e.g. "3344" → 33.44
                s = float(sec_part[:2] + "." + sec_part[2:])
            else:
                s = float(sec_part)
            return max(0, min(round(h * 3600 + m * 60 + s), max_seconds))
        else:
            return None
    except (ValueError, IndexError):
        return None


def _detect_styles_if_ass(sub_path, info_key):
    """Detect multi-style ASS files and initialize style mappings.

    Only runs for .ass/.ssa files. Tracks the previous path to avoid
    re-detection on every Streamlit rerun.
    """
    prev_key = f"_prev_{info_key}_path"
    mapping_key = info_key.replace("_style_info", "_style_mapping")

    if not sub_path or not isinstance(sub_path, str):
        st.session_state[info_key] = None
        st.session_state[mapping_key] = None
        return

    # Skip re-detection if path hasn't changed
    if st.session_state.get(prev_key) == sub_path:
        return

    st.session_state[prev_key] = sub_path

    ext = os.path.splitext(sub_path)[1].lower()
    if ext not in ('.ass', '.ssa'):
        st.session_state[info_key] = None
        st.session_state[mapping_key] = None
        return

    style_info = detect_ass_styles(sub_path)
    st.session_state[info_key] = style_info

    if style_info:
        # Initialize mapping from smart defaults
        st.session_state[mapping_key] = {
            name: info["role"] for name, info in style_info.items()
        }
    else:
        st.session_state[mapping_key] = None


def _render_style_mapping_ui(source_key):
    """Render the style mapping UI for a subtitle source.

    Shows an expander with per-style role selectors when multi-style
    ASS is detected. Updates session_state mapping in real time.
    """
    info_key = f"{source_key}_style_info"
    mapping_key = f"{source_key}_style_mapping"

    style_info = st.session_state.get(info_key)
    if not style_info:
        return

    mapping = st.session_state.get(mapping_key, {})
    n = len(style_info)
    label = "native" if source_key == "native" else "target"

    with st.expander(f"Style mapping — {label} ({n} styles)", expanded=True):
        _ROLE_OPTIONS = ["Dialogue", "Preserve", "Exclude"]
        _ROLE_MAP = {"Dialogue": "dialogue", "Preserve": "preserve", "Exclude": "exclude"}
        _ROLE_REVERSE = {"dialogue": "Dialogue", "preserve": "Preserve", "exclude": "Exclude"}

        # Sort by event count descending
        sorted_styles = sorted(
            style_info.items(),
            key=lambda x: x[1]["event_count"],
            reverse=True,
        )

        any_has_animation = False
        for style_name, info in sorted_styles:
            has_anim = info.get("has_animation", False)
            if has_anim:
                any_has_animation = True
            anim_marker = " \u26a0\ufe0f" if has_anim else ""

            s_col1, s_col2 = st.columns([3, 2])
            with s_col1:
                sample = info["sample_text"][:40]
                if sample:
                    st.markdown(
                        f"**{style_name}** ({info['event_count']} events){anim_marker} — _{sample}_"
                    )
                else:
                    st.markdown(f"**{style_name}** ({info['event_count']} events){anim_marker}")
            with s_col2:
                current_role = mapping.get(style_name, info["role"])
                current_display = _ROLE_REVERSE.get(current_role, "Dialogue")
                idx = _ROLE_OPTIONS.index(current_display) if current_display in _ROLE_OPTIONS else 0

                selected = st.selectbox(
                    f"Role",
                    _ROLE_OPTIONS,
                    index=idx,
                    key=f"style_role_{source_key}_{style_name}",
                    label_visibility="collapsed",
                )
                mapping[style_name] = _ROLE_MAP[selected]

        if any_has_animation:
            st.caption(
                "\u26a0\ufe0f Contains animation/karaoke effects. "
                "Animations render in .ass output but appear static in PGS."
            )

        st.session_state[mapping_key] = mapping


# --- Initial Setup ---
st.set_page_config(page_title="SRTStitcher Pro", layout="wide")
initialize_state()

# --- Drain pending offset values (set by auto-alignment Apply) ---
# Must run before st.number_input widgets bind to these keys.
for _pending_key, _target_key in (
    ("_pending_bottom_offset_sec", "bottom_offset_sec"),
    ("_pending_top_offset_sec", "top_offset_sec"),
):
    _pv = st.session_state.get(_pending_key)
    if _pv is not None:
        st.session_state[_target_key] = _pv
        st.session_state[f"_prev_{_target_key}"] = _pv
        st.session_state[_pending_key] = None

# --- Temporary Directory Management ---
# This ensures we have a consistent temp folder for the session
if "temp_dir_obj" not in st.session_state:
    st.session_state.temp_dir_obj = tempfile.TemporaryDirectory()
    st.session_state.temp_dir = st.session_state.temp_dir_obj.name
    atexit.register(st.session_state.temp_dir_obj.cleanup)

# --- Main App ---
st.title("🎬 SRTStitcher Pro")
st.write("---")

st.header("1. Load & Scan Video File")
mkv_path_input_value = render_mkv_path_input()
st.session_state.mkv_path = mkv_path_input_value # Keep st.session_state.mkv_path updated

if st.button("Load & Scan Video", key="scan_mkv_button") and st.session_state.mkv_path:
    if not os.path.exists(st.session_state.mkv_path):
        st.error(f"File not found at: `{st.session_state.mkv_path}`")
    else:
        with st.spinner(f"Probing `{os.path.basename(st.session_state.mkv_path)}`..."):
            metadata, probe_data = get_video_metadata(st.session_state.mkv_path)
            st.session_state.mkv_duration = metadata['duration']
            st.session_state.mkv_resolution = (metadata['width'], metadata['height'])
            st.session_state.mkv_metadata = metadata

            # Extract audio stream info for the default-audio selector in remux UI.
            audio_tracks = []
            for s in (probe_data or {}).get('streams', []):
                if s.get('codec_type') == 'audio':
                    tags = s.get('tags', {})
                    audio_tracks.append({
                        'index': s['index'],
                        'codec': s.get('codec_name', '?'),
                        'channels': s.get('channels', '?'),
                        'lang': tags.get('language'),
                        'title': tags.get('title', ''),
                    })
            st.session_state.mkv_audio_tracks = audio_tracks

        with st.spinner(f"Extracting subtitle tracks from `{os.path.basename(st.session_state.mkv_path)}`..."):
            st.session_state.mkv_tracks = scan_and_extract_tracks(
                st.session_state.mkv_path, st.session_state.temp_dir,
                probe_data=probe_data,
            )

        st.session_state.mkv_scan_complete = True

        selectable_count = sum(1 for t in st.session_state.mkv_tracks if t.get('selectable', True))
        if selectable_count:
            st.success(f"Scan complete. {selectable_count} text track(s) found. Resolution: {metadata['width']}x{metadata['height']}")
        else:
            st.warning("No text-based subtitle tracks found. You can upload external subtitle files below.")

# --- 2. Subtitle Source Selection ---
if st.session_state.mkv_path and st.session_state.get('mkv_scan_complete', False):
    st.header("2. Select Subtitle Sources")

    col1, col2 = st.columns(2)
    with col1:
        st.session_state.native_sub_path = render_hybrid_selector(
            "Native Subtitle Source",
            st.session_state.mkv_tracks,
            key="native"
        )
        _ocr_native = render_ocr_buttons(st.session_state.mkv_tracks, key="native")
    with col2:
        st.session_state.target_sub_path = render_hybrid_selector(
            "Target Subtitle Source",
            st.session_state.mkv_tracks,
            key="target"
        )
        _ocr_target = render_ocr_buttons(st.session_state.mkv_tracks, key="target")

    # --- Multi-style ASS detection + mapping UI ---
    _detect_styles_if_ass(st.session_state.native_sub_path, 'native_style_info')
    _detect_styles_if_ass(st.session_state.target_sub_path, 'target_style_info')

    if st.session_state.get('native_style_info') or st.session_state.get('target_style_info'):
        map_col1, map_col2 = st.columns(2)
        with map_col1:
            _render_style_mapping_ui('native')
        with map_col2:
            _render_style_mapping_ui('target')

    # --- Timing offset controls ---
    with st.expander("Timing Offsets"):
        def _on_bottom_offset_change():
            if st.session_state.timing_offsets_linked:
                delta = st.session_state.bottom_offset_sec - st.session_state._prev_bottom_offset
                st.session_state.top_offset_sec = round(
                    st.session_state.top_offset_sec + delta, 2)
                st.session_state._prev_top_offset = st.session_state.top_offset_sec
            st.session_state._prev_bottom_offset = st.session_state.bottom_offset_sec

        def _on_top_offset_change():
            if st.session_state.timing_offsets_linked:
                delta = st.session_state.top_offset_sec - st.session_state._prev_top_offset
                st.session_state.bottom_offset_sec = round(
                    st.session_state.bottom_offset_sec + delta, 2)
                st.session_state._prev_bottom_offset = st.session_state.bottom_offset_sec
            st.session_state._prev_top_offset = st.session_state.top_offset_sec

        _off_col1, _off_col2, _off_col3 = st.columns([2, 2, 1])
        with _off_col1:
            st.number_input(
                "Bottom (native) offset (sec)",
                key="bottom_offset_sec",
                step=0.01,
                format="%.2f",
                on_change=_on_bottom_offset_change,
            )
        with _off_col2:
            st.number_input(
                "Top (foreign) offset (sec)",
                key="top_offset_sec",
                step=0.01,
                format="%.2f",
                on_change=_on_top_offset_change,
            )
        with _off_col3:
            st.toggle(
                "Link",
                key="timing_offsets_linked",
                help="When linked, changing one offset shifts the other by the same amount.",
            )

        # ── Auto-alignment from reference ────────────────────────────────
        st.divider()
        st.markdown("**Auto-detect offset from reference**")

        _ref_filetypes = [
            ("Video & subtitle files",
             "*.mkv *.mp4 *.avi *.mov *.webm *.ts *.m2ts *.srt *.ass *.ssa *.sub *.vtt"),
            ("All files", "*.*"),
        ]
        render_path_input(
            "Reference file (video or subtitle)",
            "_ref_align_path",
            filetypes=_ref_filetypes,
        )

        _ref_path = st.session_state.get("_ref_align_path", "").strip()
        _SUB_EXTS = {'.srt', '.ass', '.ssa', '.sub', '.vtt'}
        _VID_EXTS = {'.mkv', '.mp4', '.avi', '.mov', '.webm', '.ts', '.m2ts'}
        _ref_subs = None  # Will hold SSAFile for the reference track

        if _ref_path and os.path.isfile(_ref_path):
            _ref_ext = os.path.splitext(_ref_path)[1].lower()

            if _ref_ext in _VID_EXTS:
                # ── Video file: scan for subtitle tracks ──
                if st.session_state.get('_ref_align_scanned_path') != _ref_path:
                    if st.button("Scan Reference Video", key="_ref_scan_btn"):
                        with st.spinner("Scanning reference video..."):
                            _ref_temp = os.path.join(
                                st.session_state.temp_dir, "ref_align")
                            os.makedirs(_ref_temp, exist_ok=True)
                            _, _ref_probe = get_video_metadata(_ref_path)
                            if _ref_probe:
                                _ref_trks = scan_and_extract_tracks(
                                    _ref_path, _ref_temp,
                                    probe_data=_ref_probe)
                                st.session_state._ref_align_tracks = [
                                    t for t in _ref_trks if t.get('selectable')]
                                st.session_state._ref_align_scanned_path = _ref_path
                                st.session_state._ref_align_offset = None
                                st.session_state._ref_align_warning = None
                                st.rerun()
                            else:
                                st.error("Failed to probe reference video.")

                # Show track selectbox if already scanned
                if st.session_state.get('_ref_align_scanned_path') == _ref_path:
                    _ref_tracks = st.session_state.get('_ref_align_tracks') or []
                    if not _ref_tracks:
                        st.warning(
                            "No text subtitle tracks found in reference video.")
                    else:
                        _ref_labels = [t['label'] for t in _ref_tracks]
                        _ref_sel = st.selectbox(
                            "Reference subtitle track",
                            range(len(_ref_labels)),
                            format_func=lambda i: _ref_labels[i],
                            key="_ref_align_track_sel",
                        )
                        _sel_track = _ref_tracks[_ref_sel]
                        if _sel_track.get('path'):
                            _ref_subs = load_subs_cached(_sel_track['path'])

            elif _ref_ext in _SUB_EXTS:
                # ── Subtitle file: load directly ──
                try:
                    _ref_subs = load_subs_cached(_ref_path)
                except Exception as _e:
                    st.error(f"Failed to load subtitle file: {_e}")

            else:
                st.warning(f"Unrecognised file extension: {_ref_ext}")

        # ── Compare + Compute + Apply ──
        if _ref_subs is not None:
            _compare_against = st.selectbox(
                "Compare against",
                ["Bottom (native)", "Top (foreign)"],
                key="_ref_compare_against",
                help="Select which loaded track shares a language with the reference.",
            )

            if st.button("Compute Offset", key="_ref_compute_btn"):
                _cmp_path = (
                    st.session_state.native_sub_path
                    if _compare_against == "Bottom (native)"
                    else st.session_state.target_sub_path
                )
                if not _cmp_path:
                    _which = ("native" if _compare_against == "Bottom (native)"
                              else "target")
                    st.error(f"No {_which} subtitle loaded.")
                else:
                    _cmp_subs = load_subs_cached(_cmp_path)
                    with st.spinner("Computing offset..."):
                        _off_val, _off_warn = compute_subtitle_offset(
                            _ref_subs, _cmp_subs)
                    st.session_state._ref_align_offset = _off_val
                    st.session_state._ref_align_warning = _off_warn
                    st.rerun()

            # ── Display result ──
            _det_warn = st.session_state.get('_ref_align_warning')
            _det_offset = st.session_state.get('_ref_align_offset')

            if _det_warn:
                st.warning(_det_warn)
            elif _det_offset is not None:
                _sign = "+" if _det_offset >= 0 else ""
                if abs(_det_offset) < 0.005:
                    st.success(
                        "Detected offset: **0.00s** — Tracks are already aligned.")
                elif _det_offset > 0:
                    st.info(
                        f"Detected offset: **{_sign}{_det_offset:.2f}s** — "
                        f"The reference source's subtitles start "
                        f"{abs(_det_offset):.2f}s earlier than this video's. "
                        f"Tracks from the reference source need to be shifted "
                        f"{abs(_det_offset):.2f}s later to align."
                    )
                else:
                    st.info(
                        f"Detected offset: **{_det_offset:.2f}s** — "
                        f"The reference source's subtitles start "
                        f"{abs(_det_offset):.2f}s later than this video's. "
                        f"Tracks from the reference source need to be shifted "
                        f"{abs(_det_offset):.2f}s earlier to align."
                    )

                # ── Apply controls ──
                _app_col1, _app_col2 = st.columns([2, 1])
                with _app_col1:
                    _apply_to = st.selectbox(
                        "Apply to",
                        ["Top (foreign)", "Bottom (native)"],
                        key="_ref_apply_to",
                        help=(
                            "You compared the reference against your native "
                            "track, so the offset should typically be applied "
                            "to the foreign track that came from the same "
                            "source as the reference."
                        ),
                    )
                with _app_col2:
                    st.write("<br>", unsafe_allow_html=True)
                    if st.button("Apply", key="_ref_apply_btn"):
                        _new_val = round(_det_offset, 2)
                        if _apply_to == "Bottom (native)":
                            _old = st.session_state.bottom_offset_sec
                            st.session_state._pending_bottom_offset_sec = _new_val
                            if st.session_state.timing_offsets_linked:
                                _delta = _new_val - _old
                                st.session_state._pending_top_offset_sec = round(
                                    st.session_state.top_offset_sec + _delta, 2)
                        else:
                            _old = st.session_state.top_offset_sec
                            st.session_state._pending_top_offset_sec = _new_val
                            if st.session_state.timing_offsets_linked:
                                _delta = _new_val - _old
                                st.session_state._pending_bottom_offset_sec = round(
                                    st.session_state.bottom_offset_sec + _delta, 2)
                        st.rerun()

    # Handle OCR requests for PGS tracks
    _ocr_request = _ocr_native or _ocr_target
    if _ocr_request:
        from app.ocr import ocr_pgs_to_srt
        from app import language as _lang_mod
        track = _ocr_request
        try:
            with st.spinner(f"Extracting PGS stream {track['id']}..."):
                sup_path = extract_pgs_stream(
                    st.session_state.mkv_path, track['id'],
                    st.session_state.temp_dir,
                )

            ocr_lang = track.get('metadata_lang') or 'eng'
            ocr_bar = st.progress(0, text="OCR-ing subtitle images...")

            def _ocr_progress(done, total):
                ocr_bar.progress(done / total, text=f"OCR-ing subtitle images... {done}/{total}")

            srt_path = ocr_pgs_to_srt(
                sup_path, ocr_lang, st.session_state.temp_dir,
                progress_callback=_ocr_progress,
            )
            ocr_bar.empty()

            # Verify OCR produced content
            with open(srt_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
            if not content:
                st.warning(
                    "OCR produced no text. The subtitle images may be too small "
                    "or the Tesseract language pack may be wrong."
                )
            else:
                detected_code = _lang_mod.detect_language(
                    srt_path, metadata_lang=track.get('metadata_lang'),
                    track_title=track.get('track_title'),
                )
                display_name = _lang_mod.code_to_name(detected_code)
                track['path'] = srt_path
                track['lang_code'] = detected_code
                track['selectable'] = True
                track['label'] = f"Stream {track['id']} — {display_name} (OCR extracted)"
                st.success(f"OCR complete — {display_name} track extracted.")
                st.rerun()
        except RuntimeError as e:
            st.error(str(e))
        except Exception as e:
            st.error(f"OCR failed: {e}")

# --- 3. Style, Preview & Generate ---
if st.session_state.native_sub_path and st.session_state.target_sub_path:
    st.write("---")
    st.header("3. Style & Preview")

    # --- Detect foreign/media language for romanization ---
    target_lang_code = detect_language(st.session_state.target_sub_path)
    st.session_state.target_lang_code = target_lang_code

    primary_lang = (target_lang_code or "").lower().split("-")[0].split("_")[0]
    is_japanese = primary_lang == "ja"
    is_chinese = primary_lang in ("zh", "yue")
    is_thai = primary_lang == "th"

    # --- Chinese variant selectors (R2c) ---
    # Phonetic system + script display shown before style expanders so that
    # get_lang_config() receives the override on this rerun.
    phonetic_system = None
    chinese_variant = None
    opencc_converter_preview = None
    if is_chinese:
        from app.styles import _chinese_variant
        chinese_variant = _chinese_variant(target_lang_code)

        st.subheader("Chinese Options")
        ch_col1, ch_col2 = st.columns(2)

        with ch_col1:
            # Phonetic system selector — default depends on variant
            if chinese_variant == "yue":
                _phon_options = ["Jyutping"]
            elif chinese_variant == "zh-Hant":
                _phon_options = ["Zhuyin", "Pinyin"]
            else:  # zh-Hans
                _phon_options = ["Pinyin", "Zhuyin"]
            phonetic_system = st.selectbox(
                "Phonetic Annotation System",
                _phon_options,
                index=0,
                key="phonetic_system_selector",
            ).lower()

        with ch_col2:
            # Script display selector — conversion direction depends on source
            if chinese_variant == "zh-Hans":
                _script_options = ["Original", "Traditional (Taiwan)"]
            else:  # zh-Hant or yue — Traditional source
                _script_options = ["Original", "Simplified"]
            script_display = st.selectbox(
                "Script Display",
                _script_options,
                index=0,
                key="script_display_selector",
            )
            # Store at top level in styles so processing.py can read it
            st.session_state.setdefault("styles", {})
            if isinstance(st.session_state.styles, dict):
                st.session_state.styles["script_display"] = script_display

        # Create opencc converter for preview (reused later)
        if script_display and script_display != "Original" and chinese_variant:
            from app.processing import _make_opencc_converter
            opencc_converter_preview = _make_opencc_converter(chinese_variant, script_display)

    # --- Thai phonetic system selector ---
    if is_thai:
        st.subheader("Thai Options")
        _thai_phon_options = ["Paiboon+", "RTGS", "IPA"]
        _thai_phon_descriptions = {
            "Paiboon+": "Learner standard with tone diacritics (recommended)",
            "RTGS": "Royal Thai General System — no tone information",
            "IPA": "International Phonetic Alphabet",
        }
        _thai_phon_key_map = {"Paiboon+": "paiboon", "RTGS": "rtgs", "IPA": "ipa"}
        phonetic_system = _thai_phon_key_map[st.selectbox(
            "Romanization System",
            _thai_phon_options,
            index=0,
            key="thai_phonetic_system_selector",
            format_func=lambda x: f"{x} — {_thai_phon_descriptions[x]}",
        )]

    lang_config = get_lang_config(target_lang_code, phonetic_system=phonetic_system)
    st.session_state["_lang_config"] = lang_config
    romanize_func = lang_config["romanize_func"]
    annotation_func = lang_config["annotation_func"]
    annotation_system_name = lang_config["annotation_system_name"]
    annotation_render_mode = lang_config.get("annotation_render_mode", "ruby")
    supports_ass_annotation = lang_config.get("supports_ass_annotation", True)
    annotation_default_enabled = lang_config.get("annotation_default_enabled", True)
    spans_to_romaji_func = lang_config.get("spans_to_romaji_func")
    romanization_name = lang_config["romanization_name"]

    has_annotation = annotation_func is not None
    romanization_confidence = lang_config["romanization_confidence"]
    _CONFIDENCE_BADGE = {
        "very_high": "\U0001f7e2 Very High",
        "high":      "\U0001f7e2 High",
        "good":      "\U0001f7e1 Good",
        "moderate":  "\U0001f7e1 Moderate",
        "low":       "\U0001f7e0 Low (opt-in)",
        "none":      "\u26aa None",
    }
    _conf_display = _CONFIDENCE_BADGE.get(romanization_confidence, "")
    st.caption(
        f"Detected target language: **{target_lang_code}** — "
        f"Romanization: {romanization_name} ({_conf_display})"
    )

    # --- Pre-existing furigana detection (Japanese tracks only) ---
    # Must run before style initialization so annotation_preexisting can set
    # the Annotation slot's default enabled state.
    annotation_preexisting = False
    if is_japanese:
        furigana_found, furigana_detail = detect_preexisting_furigana(
            st.session_state.target_sub_path
        )
        annotation_preexisting = furigana_found
        if furigana_found:
            st.info(
                f"ℹ️ **Pre-existing furigana detected** in the Japanese subtitle track "
                f"({furigana_detail}). The generated {annotation_system_name} layer is "
                f"disabled by default to avoid double annotation. You can re-enable it "
                f"in the style expander below if needed."
            )

    # --- Build default styles if not already set ---
    # Check for "Top" key to handle stale sessions that have only scalar keys
    # (e.g. vertical_offset) but lost the track dicts.
    if not st.session_state.styles or "Top" not in st.session_state.styles:
        # Top marginv=45: leaves room for annotation (12px) + 2px gap above
        # the main text line, plus romaji (14px) + gap above that.
        # Layout (top → bottom): romaji@5 | annotation@29 | target_text@45
        #
        # Default annotation font: CJK-capable font matching the target script.
        _default_annotation_font = lang_config["default_font"]
        if _default_annotation_font not in CJK_FONT_LIST:
            _default_annotation_font = "Noto Sans CJK JP"
        # Font sizes and margins are in PlayResY=1080 coordinate space.
        # The ASS renderer scales them to the actual video resolution at
        # playback.  The preview scales them by 600/1080 ≈ 0.556 for the
        # 600px iframe.
        #
        # Layout (top → bottom):
        #   romaji@10 | annotation@68 | target_text@90
        #   ann_y = top_marginv - ann_fontsize - 2 = 90 - 22 - 2 = 66 ≈ 68
        # Default Top font: CJK-capable for CJK targets, serif for others.
        _default_top_font = "Noto Sans CJK JP" if (is_japanese or is_chinese) else "Arial"
        st.session_state.styles = {
            "Bottom": {
                "enabled": True, "fontname": "Georgia", "fontsize": 48,
                "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(255, 255, 255, 0),
                "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128),
                "outline": 3.0, "shadow": 1.5,
                "outline_opacity": 100,
                "alignment": 2,  # bottom-center
                "marginv": 40,
                "back_none": True, "outline_none": False, "shadow_none": True,
                "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
            },
            "Top": {
                "enabled": True, "fontname": _default_top_font, "fontsize": 52,
                "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(255, 255, 255, 0),
                "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128),
                "outline": 2.5, "shadow": 1.5,
                "outline_opacity": 100,
                "alignment": 8,  # top-center
                "marginv": 90,   # room for annotation + romaji above
                "back_none": True, "outline_none": False, "shadow_none": True,
                "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
            },
            "Romanized": {
                "enabled": True, "fontname": "Times New Roman", "fontsize": 30,
                "bold": False, "italic": True,
                "primarycolor": pysubs2.Color(200, 200, 200, 0),
                "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128),
                "outline": 1.5, "shadow": 1.5,
                "outline_opacity": 100,
                "alignment": 8,
                "marginv": 10,
                "back_none": True, "outline_none": False, "shadow_none": True,
                "long_vowel_mode": "macrons",
                "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
            },
            "Annotation": {
                # Disabled by default when pre-existing furigana detected
                # or for Cantonese (Jyutping block romanization is sufficient;
                # per-character annotation is verbose — e.g. "jyut6" per char).
                "enabled": not annotation_preexisting and annotation_default_enabled,
                # Default font must be CJK-capable.
                "fontname": _default_annotation_font,
                "fontsize": 22,
                "bold": False, "italic": False,
                "primarycolor": pysubs2.Color(255, 255, 255, 0),
                "outlinecolor": pysubs2.Color(0, 0, 0, 0),
                "backcolor": pysubs2.Color(0, 0, 0, 128),
                "outline": 1.0, "shadow": 1.5,
                "outline_opacity": 100,
                "alignment": 8,   # overridden per-event by \pos() in ASS output
                "marginv": 10,    # not used directly; ann_y derived from Top marginv
                "back_none": True, "outline_none": False, "shadow_none": True,
                "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
            },
        }

    # --- Guard: migrate old "Furigana" key → "Annotation" (R2b compat) ---
    if "Furigana" in st.session_state.styles and "Annotation" not in st.session_state.styles:
        st.session_state.styles["Annotation"] = st.session_state.styles.pop("Furigana")

    # --- Guard: inject Annotation slot if session predates R3b/R2b ---
    if "Annotation" not in st.session_state.styles and "Top" in st.session_state.styles:
        top_font = st.session_state.styles["Top"]["fontname"]
        default_ann_font = top_font if top_font in CJK_FONT_LIST else "Noto Sans CJK JP"
        st.session_state.styles["Annotation"] = {
            "enabled": not annotation_preexisting and annotation_default_enabled,
            "fontname": default_ann_font,
            "fontsize": 22,
            "bold": False, "italic": False,
            "primarycolor": pysubs2.Color(255, 255, 255, 0),
            "outlinecolor": pysubs2.Color(0, 0, 0, 0),
            "backcolor": pysubs2.Color(0, 0, 0, 128),
            "outline": 1.0, "shadow": 1.5,
            "outline_opacity": 100,
            "alignment": 8, "marginv": 10,
            "back_none": True, "outline_none": False, "shadow_none": True,
            "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
        }

    # --- Guard: inject long_vowel_mode if session predates R3c ---
    if "long_vowel_mode" not in st.session_state.styles.get("Romanized", {}):
        st.session_state.styles.setdefault("Romanized", {})["long_vowel_mode"] = "macrons"

    # --- Guard: reset annotation enabled default when target language changes ---
    # Handles the case where styles were initialized for one language (e.g.
    # Traditional Mandarin with annotation on) and the user switches to
    # another (e.g. Cantonese where annotation should default off).
    _prev_ann_lang = st.session_state.get("_annotation_default_lang")
    if _prev_ann_lang != target_lang_code and "Annotation" in st.session_state.styles:
        _ann_should_enable = not annotation_preexisting and annotation_default_enabled
        st.session_state.styles["Annotation"]["enabled"] = _ann_should_enable
        # Reset the Streamlit widget key so the checkbox reflects the new default
        # (widget keys override the value= parameter once rendered).
        if "Annotation_enabled" in st.session_state:
            st.session_state["Annotation_enabled"] = _ann_should_enable
        st.session_state["_annotation_default_lang"] = target_lang_code

    # --- Guard: store phonetic_system in Annotation config for processing.py ---
    if phonetic_system and "Annotation" in st.session_state.styles:
        st.session_state.styles["Annotation"]["phonetic_system"] = phonetic_system

    # --- Guard: inject vertical_offset for sessions predating R6a ---
    if "vertical_offset" not in st.session_state.styles:
        st.session_state.styles["vertical_offset"] = 0
    if "annotation_gap" not in st.session_state.styles:
        st.session_state.styles["annotation_gap"] = 2
    if "romanized_gap" not in st.session_state.styles:
        st.session_state.styles["romanized_gap"] = 0

    # --- Color preset selector (R6b) ---
    _preset_options = build_preset_selectbox_options(target_lang_code or "")
    _preset_labels = [label for _, label in _preset_options]
    _preset_ids = [pid for pid, _ in _preset_options]

    _current_preset_idx = next(
        (i for i, pid in enumerate(_preset_ids)
         if pid == st.session_state.get("active_color_preset", "")),
        0,
    )

    _chosen_preset_idx = st.selectbox(
        "Color preset",
        range(len(_preset_labels)),
        index=_current_preset_idx,
        format_func=lambda i: _preset_labels[i],
        key="color_preset_select",
        help="Apply a preset color combination to all layers. Manual color "
             "controls below remain active and override individual colors "
             "after applying a preset.",
    )
    _chosen_preset_id = _preset_ids[_chosen_preset_idx]

    # Skip None (group header rows)
    if _chosen_preset_id is not None:
        _prev_preset = st.session_state.get("active_color_preset", "")
        _preset_changed = _chosen_preset_id != _prev_preset
        st.session_state.active_color_preset = _chosen_preset_id

        # Show 4-swatch strip when a real preset is active
        if _chosen_preset_id != "":
            _swatches = preset_swatch_colors(_chosen_preset_id, target_lang_code or "")
            # Push swatch values into widget keys so they update on preset change
            if _preset_changed:
                for _sw_layer, _sw_hex in _swatches:
                    st.session_state[f"_swatch_{_sw_layer}"] = _sw_hex
            _sw_cols = st.columns(len(_swatches))
            for _sw_col, (_sw_layer, _sw_hex) in zip(_sw_cols, _swatches):
                _sw_col.color_picker(_sw_layer, _sw_hex, disabled=True,
                                     label_visibility="visible",
                                     key=f"_swatch_{_sw_layer}")

            # Only merge preset on actual change — otherwise the per-layer
            # widgets' own values (stored under their keys) would be
            # overwritten on every Streamlit rerun.
            if _preset_changed:
                st.session_state.styles = get_preset_styles(
                    _chosen_preset_id, target_lang_code or "",
                    st.session_state.styles,
                )

            # Push preset colors into per-layer widget keys so the
            # color pickers / sliders reflect the new values instead
            # of returning their stale cached state.
            if _preset_changed:
                for _lname in ["Bottom", "Top", "Romanized", "Annotation"]:
                    _lcfg = st.session_state.styles.get(_lname)
                    if not isinstance(_lcfg, dict):
                        continue
                    pc = _lcfg.get("primarycolor")
                    if pc:
                        st.session_state[f"{_lname}_color"] = _ass_color_to_hex(pc)
                    if "opacity" in _lcfg:
                        st.session_state[f"{_lname}_opacity"] = _lcfg["opacity"]
                    oc = _lcfg.get("outlinecolor")
                    if oc:
                        st.session_state[f"{_lname}_outline_color"] = _ass_color_to_hex(oc)
                    if "outline_opacity" in _lcfg:
                        st.session_state[f"{_lname}_outline_opacity"] = _lcfg["outline_opacity"]
                    if "glow_color_hex" in _lcfg:
                        st.session_state[f"{_lname}_glow_color"] = _lcfg["glow_color_hex"]
                    # If preset enables glow, push that into the checkbox key
                    if not _lcfg.get("glow_none", True):
                        st.session_state[f"{_lname}_no_glow"] = False

    # --- Style editing per track ---
    # Annotation expander shown for any language with annotation_func;
    # font picker constrained to CJK_FONT_LIST for the Annotation slot.
    # Dynamic label: "Furigana Style" for Japanese, "Pinyin Style" for
    # Chinese, etc. — driven by annotation_system_name from get_lang_config().
    track_names = ["Bottom", "Top", "Romanized"]
    if has_annotation:
        track_names.append("Annotation")

    for track_name in track_names:
        config = st.session_state.styles[track_name]
        # Dynamic expander label for Annotation slot
        expander_label = (
            f"{annotation_system_name} Style"
            if track_name == "Annotation"
            else f"{track_name} Track Style"
        )
        with st.expander(expander_label, expanded=False):
            config["enabled"] = st.checkbox("Enabled", value=config["enabled"], key=f"{track_name}_enabled")
            if not config["enabled"]:
                continue
            col_a, col_b, col_c = st.columns(3)
            with col_a:
                if track_name == "Annotation":
                    # Constrain to CJK-capable fonts only.
                    ann_font_idx = CJK_FONT_LIST.index(config["fontname"]) if config["fontname"] in CJK_FONT_LIST else 0
                    config["fontname"] = st.selectbox(
                        "Font (CJK-capable only)", CJK_FONT_LIST,
                        index=ann_font_idx, key=f"{track_name}_font"
                    )
                else:
                    config["fontname"] = st.selectbox("Font", FONT_LIST, index=FONT_LIST.index(config["fontname"]) if config["fontname"] in FONT_LIST else 0, key=f"{track_name}_font")
                config["fontsize"] = st.slider("Size", 8, 150, config["fontsize"], key=f"{track_name}_size")
            with col_b:
                config["bold"] = st.checkbox("Bold", value=config["bold"], key=f"{track_name}_bold")
                config["italic"] = st.checkbox("Italic", value=config["italic"], key=f"{track_name}_italic")
                hex_val = st.color_picker(
                    "Text Color", value=_ass_color_to_hex(config["primarycolor"]),
                    key=f"{track_name}_color",
                )
                opacity = st.slider(
                    "Opacity", 0, 100, config.get("opacity", 100),
                    step=5, key=f"{track_name}_opacity",
                )
                config["opacity"] = opacity
                _c = _hex_to_ass_color(hex_val)
                config["primarycolor"] = pysubs2.Color(
                    _c.r, _c.g, _c.b, int((1 - opacity / 100) * 255)
                )
            with col_c:
                config["outline_none"] = st.checkbox("No Outline", value=config.get("outline_none", True), key=f"{track_name}_no_outline")
                if not config["outline_none"]:
                    config["outline"] = st.slider("Outline", 0.0, 5.0, config["outline"], step=0.5, key=f"{track_name}_outline")
                    oc_hex = st.color_picker(
                        "Outline Color",
                        value=_ass_color_to_hex(config["outlinecolor"]),
                        key=f"{track_name}_outline_color",
                    )
                    oc_opacity = st.slider(
                        "Outline Opacity", 0, 100,
                        config.get("outline_opacity", 100),
                        step=5, key=f"{track_name}_outline_opacity",
                    )
                    config["outline_opacity"] = oc_opacity
                    _oc = _hex_to_ass_color(oc_hex)
                    config["outlinecolor"] = pysubs2.Color(
                        _oc.r, _oc.g, _oc.b, int((1 - oc_opacity / 100) * 255)
                    )
                config["shadow_none"] = st.checkbox("No Shadow", value=config.get("shadow_none", True), key=f"{track_name}_no_shadow")
                if not config["shadow_none"]:
                    config["shadow"] = st.slider(
                        "Shadow", 0.0, 5.0, float(config.get("shadow", 1.5)),
                        step=0.5, key=f"{track_name}_shadow",
                    )
                config["glow_none"] = st.checkbox(
                    "No Glow", value=config.get("glow_none", True),
                    key=f"{track_name}_no_glow",
                )
                if not config["glow_none"]:
                    config["glow_radius"] = st.slider(
                        "Glow Radius", 1, 20, config.get("glow_radius", 5),
                        step=1, key=f"{track_name}_glow_radius",
                    )
                    glow_hex = st.color_picker(
                        "Glow Color",
                        value=config.get("glow_color_hex", "#ffff00"),
                        key=f"{track_name}_glow_color",
                    )
                    config["glow_color_hex"] = glow_hex

            # Long vowel mode selector — Japanese Romanized track only
            if track_name == "Romanized" and is_japanese:
                _vowel_modes = ["macrons", "doubled", "unmarked"]
                _vowel_labels = {
                    "macrons": "Macrons (tōkyō, kōhī)",
                    "doubled": "Doubled (toukyou, koohii)",
                    "unmarked": "Unmarked (tokyo, kohi)",
                }
                current_mode = config.get("long_vowel_mode", "macrons")
                config["long_vowel_mode"] = st.radio(
                    "Long Vowel Style",
                    _vowel_modes,
                    index=_vowel_modes.index(current_mode) if current_mode in _vowel_modes else 0,
                    format_func=lambda m: _vowel_labels.get(m, m),
                    key="romaji_vowel_mode",
                )

    # --- Top Stack Position expander (vertical offset + gap controls) ---
    with st.expander("Top Stack Position", expanded=False):
        st.session_state.styles["vertical_offset"] = st.slider(
            "Top Stack Vertical Position (px)", -100, 100,
            st.session_state.styles.get("vertical_offset", 0),
            step=1, key="vertical_offset_slider",
        )
        st.session_state.styles["annotation_gap"] = st.slider(
            "Annotation \u2194 Target gap (px)", -20, 40,
            st.session_state.styles.get("annotation_gap", 2),
            step=1, key="annotation_gap_slider",
            help="Vertical space between the annotation layer and the target script line. "
                 "Positive values push the annotation further above the target text.",
        )
        st.session_state.styles["romanized_gap"] = st.slider(
            "Romanized \u2194 Target gap (px)", -20, 40,
            st.session_state.styles.get("romanized_gap", 0),
            step=1, key="romanized_gap_slider",
            help="Extra vertical space between the romanized line and the target script line. "
                 "Positive values push romanization further above the target text.",
        )

    # --- Preview placeholder (filled after subtitle text is computed below) ---
    _preview_placeholder = st.empty()

    # Preview mode selector
    preview_mode_label = st.selectbox(
        "Preview mode", [".ass", "PGS"], key="preview_mode",
        help="'.ass' shows the text-based .ass layout. 'PGS' shows the full-frame "
             "bitmap layout with inline ruby annotations.",
    )
    _preview_mode = "pgs" if preview_mode_label == "PGS" else "ass"

    # --- Timestamp slider + text input ---
    if st.session_state.mkv_path and os.path.exists(st.session_state.mkv_path):
        duration = st.session_state.get("mkv_duration", 0) or 1

        # Initialize text input on first render
        if "_ts_text_input" not in st.session_state:
            st.session_state["_ts_text_input"] = _fmt_ts(min(300, duration))

        def _on_ts_slider_change():
            """Sync text input when slider moves."""
            st.session_state["_ts_text_input"] = _fmt_ts(st.session_state["screenshot_ts"])

        def _on_ts_text_submit():
            """Parse text input and sync slider."""
            parsed = _parse_time_input(st.session_state["_ts_text_input"], duration)
            if parsed is not None:
                st.session_state["screenshot_ts"] = parsed
                st.session_state["_ts_text_input"] = _fmt_ts(parsed)

        ts_col1, ts_col2 = st.columns([5, 1])
        with ts_col1:
            timestamp = st.select_slider(
                "Timestamp", options=list(range(0, duration + 1)),
                value=min(300, duration),
                format_func=_fmt_ts,
                key="screenshot_ts",
                on_change=_on_ts_slider_change,
            )
        with ts_col2:
            st.text_input(
                "Go to time",
                key="_ts_text_input",
                on_change=_on_ts_text_submit,
                help="e.g. 3 (minutes), 3:56, 1:22:33",
            )

        # Extract a new frame whenever the slider moves (or on first load).
        if st.session_state.get("last_extracted_ts") != timestamp:
            with st.spinner("Extracting frame..."):
                path = extract_screenshot(
                    st.session_state.mkv_path, timestamp,
                    st.session_state.temp_dir,
                )
            if path and os.path.exists(path):
                st.session_state.screenshot_path = path
                st.session_state.last_extracted_ts = timestamp

    preview_ts = st.session_state.get("screenshot_ts", 0)
    preview_lines = get_lines_at_timestamp(
        st.session_state.native_sub_path,
        st.session_state.target_sub_path,
        preview_ts,
        native_style_mapping=st.session_state.get("native_style_mapping"),
        target_style_mapping=st.session_state.get("target_style_mapping"),
        native_offset_ms=int(round(st.session_state.bottom_offset_sec * 1000)),
        target_offset_ms=int(round(st.session_state.top_offset_sec * 1000)),
    )
    native_text = preview_lines["native"]
    target_text = preview_lines["target"]
    _preserved_html = preview_lines.get("preserved_html", "")

    # Apply opencc script conversion to preview text (Chinese only).
    # Must happen before annotation_func and romanize_func calls so that
    # the displayed text, annotation, and romanization are all consistent.
    if opencc_converter_preview and target_text:
        target_text = opencc_converter_preview.convert(target_text)

    # Annotation spans for preview ruby rendering.
    # Computed from live style values — re-evaluated on every rerun so that
    # enabling/disabling the Annotation expander updates the preview instantly.
    annotation_spans = None
    if (has_annotation and annotation_func and target_text
            and st.session_state.styles.get("Annotation", {}).get("enabled", False)):
        annotation_spans = annotation_func(target_text)

    # Romaji preview — uses shared pipeline when available (Japanese),
    # respects the user's long vowel mode selection.  When annotation_spans
    # are already computed, spans_to_romaji_func reuses them (one MeCab tagger
    # call, two consumers).
    pinyin_text = ""
    long_vowel_mode = st.session_state.styles.get("Romanized", {}).get("long_vowel_mode", "macrons")
    if target_text and st.session_state.styles["Romanized"]["enabled"]:
        if spans_to_romaji_func and annotation_spans is not None:
            # Shared pipeline: reuse already-computed spans
            pinyin_text = spans_to_romaji_func(annotation_spans, long_vowel_mode)
        elif spans_to_romaji_func and annotation_func:
            # Pipeline available but annotation disabled — compute spans fresh
            pinyin_text = spans_to_romaji_func(annotation_func(target_text), long_vowel_mode)
        elif romanize_func:
            # Non-pipeline fallback (non-Japanese)
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
            st.code(f"User's Language / Bottom: '{native_text}'")
            st.code(f"Foreign / Media Language / Top: '{target_text}'")
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
        annotation_spans=annotation_spans,
        preview_mode=_preview_mode,
        annotation_render_mode=annotation_render_mode,
        preserved_html=_preserved_html,
    )
    with _preview_placeholder.container():
        st.components.v1.html(preview_html, height=600, scrolling=False)

    # --- Generate ---
    st.write("---")
    st.subheader("Generate")

    # --- Build suggested output filename from metadata ---
    _media_meta = st.session_state.get("mkv_metadata", {})
    _native_lang_code = None
    for t in st.session_state.get("mkv_tracks", []):
        if t.get('path') == st.session_state.get("native_sub_path"):
            _native_lang_code = t.get('lang_code')
            break
    _ann_sys_name_lower = annotation_system_name.lower() if (
        has_annotation and st.session_state.styles.get('Annotation', {}).get('enabled', False)
    ) else None
    _rom_name_lower = romanization_name.lower() if (
        st.session_state.styles.get('Romanized', {}).get('enabled', False) and romanize_func
    ) else None
    _suggested_ass_name = build_output_filename(
        media_title=_media_meta.get('title'),
        year=_media_meta.get('year'),
        native_lang=_native_lang_code,
        target_lang=target_lang_code,
        annotation_system=_ann_sys_name_lower,
        romanization_system=_rom_name_lower,
        ext="ass",
    )

    # Apply any pending extension change (set by Generate button on previous rerun).
    # Must happen BEFORE the text_input widget renders — Streamlit forbids
    # modifying a widget's session_state key after instantiation.
    if "_output_name_next" in st.session_state:
        st.session_state["output_name"] = st.session_state.pop("_output_name_next")

    gen_col1, gen_col2 = st.columns(2)
    with gen_col1:
        output_name = st.text_input("Output filename", value=_suggested_ass_name, key="output_name")
    with gen_col2:
        _PLAYRES_OPTIONS = {
            "1080p (1920×1080) — universal": (1920, 1080),
            "720p (1280×720)": (1280, 720),
            "1440p (2560×1440)": (2560, 1440),
            "2160p (3840×2160)": (3840, 2160),
            "480p (854×480)": (854, 480),
        }
        _source_res = st.session_state.get("mkv_resolution", (1920, 1080))
        _source_label = f"Match source ({_source_res[0]}×{_source_res[1]})"
        _all_options = [_source_label] + list(_PLAYRES_OPTIONS.keys())
        output_res_label = st.selectbox(
            "Output resolution (PlayRes)",
            _all_options,
            index=0,
            key="output_playres_select",
            help="Scales subtitle coordinates to match the target resolution. "
                 "1080p is universal (ASS renderer scales to any video). "
                 "Pick a specific resolution to embed native coordinates.",
        )
        if output_res_label == _source_label:
            output_playres = _source_res
        else:
            output_playres = _PLAYRES_OPTIONS[output_res_label]

    # --- Annotation toggle for .ass output ---
    _ass_ann_help = (
        "Adds \\pos() annotation events to the .ass file. "
        "PGS recommended for annotations — pixel-perfect ruby rendering."
    )
    if not supports_ass_annotation:
        _ass_ann_help = (
            "Not available for this language — \\pos() annotation requires "
            "fixed-width character math (CJK only). Use PGS for annotations."
        )
    _include_ann_in_ass = st.checkbox(
        "Include annotations in .ass",
        value=False,
        key="include_annotations_in_ass",
        disabled=not supports_ass_annotation,
        help=_ass_ann_help,
    )

    # --- Generate .ass ---
    if st.button("Generate .ass File", key="generate_ass_btn"):
        _cur_name = st.session_state.get("output_name", "")
        _base, _ext = os.path.splitext(_cur_name)
        if _ext.lower() != ".ass":
            # First click: switch extension to .ass (applied before widget on next rerun)
            if _ext.lower() in (".sup",):
                st.session_state["_output_name_next"] = _base + ".ass"
            elif _ext:
                st.session_state["_output_name_next"] = _cur_name + ".ass"
            else:
                st.session_state["_output_name_next"] = _cur_name + ".ass"
            st.rerun()

        _gen_status = st.empty()
        _gen_status.text("Generating subtitle events...")

        result = generate_ass_file(
            st.session_state.native_sub_path,
            st.session_state.target_sub_path,
            st.session_state.styles,
            target_lang_code,
            resolution=st.session_state.get("mkv_resolution", (1920, 1080)),
            output_playres=output_playres,
            include_annotations=_include_ann_in_ass,
            native_style_mapping=st.session_state.get("native_style_mapping"),
            target_style_mapping=st.session_state.get("target_style_mapping"),
            lang_config=st.session_state.get("_lang_config"),
            native_offset_ms=int(round(st.session_state.bottom_offset_sec * 1000)),
            target_offset_ms=int(round(st.session_state.top_offset_sec * 1000)),
        )
        _gen_status.empty()

        if result:
            st.session_state.generated_ass_path = result
            _layer_msg = "4 text layers (with annotations)" if _include_ann_in_ass else "3 text layers"
            st.success(f"Subtitle .ass file generated ({_layer_msg}).")

    # --- Generate PGS (.sup) ---
    if is_playwright_available():
        if st.button("Generate PGS (.sup)", key="generate_pgs_btn"):
            _cur_name = st.session_state.get("output_name", "")
            _base, _ext = os.path.splitext(_cur_name)
            if _ext.lower() != ".sup":
                # First click: switch extension to .sup (applied before widget on next rerun)
                if _ext.lower() in (".ass",):
                    st.session_state["_output_name_next"] = _base + ".sup"
                elif _ext:
                    st.session_state["_output_name_next"] = _cur_name + ".sup"
                else:
                    st.session_state["_output_name_next"] = _cur_name + ".sup"
                st.rerun()

            _pgs_status = st.empty()
            _pgs_progress = st.empty()
            _pgs_status.text("Rasterizing subtitle frames...")

            def _pgs_progress_cb(completed, total):
                _pgs_status.text(f"Rasterizing subtitle frames... ({completed}/{total})")
                _pgs_progress.progress(completed / total if total else 0)

            sup_result = generate_pgs_file(
                st.session_state.native_sub_path,
                st.session_state.target_sub_path,
                st.session_state.styles,
                target_lang_code,
                resolution=st.session_state.get("mkv_resolution", (1920, 1080)),
                output_resolution=output_playres,
                progress_callback=_pgs_progress_cb,
                native_style_mapping=st.session_state.get("native_style_mapping"),
                target_style_mapping=st.session_state.get("target_style_mapping"),
                lang_config=st.session_state.get("_lang_config"),
                native_offset_ms=int(round(st.session_state.bottom_offset_sec * 1000)),
                target_offset_ms=int(round(st.session_state.top_offset_sec * 1000)),
            )
            _pgs_status.empty()
            _pgs_progress.empty()

            if sup_result:
                st.session_state.generated_sup_path = sup_result
                st.success("PGS .sup file generated (full-frame bitmap subtitles).")
            else:
                st.error("PGS generation failed.")

    # --- Download & Remux ---
    _has_ass = st.session_state.get("generated_ass_path") and os.path.exists(st.session_state.get("generated_ass_path", ""))
    _has_sup = st.session_state.get("generated_sup_path") and os.path.exists(st.session_state.get("generated_sup_path", ""))

    if _has_ass or _has_sup:
        st.write("---")
        st.subheader("Download")

        dl_col1, dl_col2 = st.columns(2)
        with dl_col1:
            if _has_ass:
                with open(st.session_state.generated_ass_path, "rb") as f:
                    st.download_button(
                        "Download .ass (all text tracks)",
                        data=f, file_name=output_name, mime="text/plain",
                    )
        with dl_col2:
            if _has_sup:
                _sup_name = os.path.splitext(output_name)[0] + ".sup"
                with open(st.session_state.generated_sup_path, "rb") as f:
                    st.download_button(
                        "Download .sup (PGS bitmap)",
                        data=f, file_name=_sup_name,
                        mime="application/octet-stream",
                    )

        st.write("---")
        st.subheader("Remux into MKV")

        # Default remux target to the scanned MKV.  User can switch to any
        # other video file (e.g. a higher-quality encode of the same content).
        _default_remux = st.session_state.get("mkv_path", "")
        if "remux_target_path" not in st.session_state:
            st.session_state["remux_target_path"] = _default_remux
        remux_target = render_path_input(
            "Remux target video file",
            "remux_target_path",
            default_value=_default_remux,
        )

        if remux_target and os.path.exists(remux_target):
            mkv_base = os.path.splitext(os.path.basename(remux_target))[0]
            output_mkv_name = st.text_input("Output filename (.mkv)", value=f"{mkv_base}_stitched.mkv", key="output_mkv_name")
            # Force .mkv extension — MKV is the only output container that supports
            # all track types (ASS, PGS, font attachments, multiple audio tracks).
            if not output_mkv_name.lower().endswith('.mkv'):
                output_mkv_name = os.path.splitext(output_mkv_name)[0] + '.mkv'
            output_mkv_path = os.path.join(os.path.dirname(remux_target), output_mkv_name)

            # Checkboxes for which tracks to include
            mux_col1, mux_col2 = st.columns(2)
            with mux_col1:
                _include_ass = st.checkbox("Include .ass track", value=_has_ass,
                                           disabled=not _has_ass, key="mux_include_ass")
            with mux_col2:
                _include_sup = st.checkbox("Include .sup (PGS) track", value=_has_sup,
                                           disabled=not _has_sup, key="mux_include_sup")

            # Options for stripping existing tracks and audio default
            with st.expander("Advanced mux options"):
                _keep_existing_subs = st.checkbox(
                    "Keep existing subtitle tracks",
                    value=True,
                    key="mux_keep_existing_subs",
                    help="Uncheck to strip all original subtitle tracks from the source. "
                         "Only the new SRTStitcher tracks will be included.",
                )
                _keep_attachments = st.checkbox(
                    "Keep font attachments",
                    value=True,
                    key="mux_keep_attachments",
                    help="Uncheck to strip embedded fonts (TTF/OTF). "
                         "Reduces file size but original ASS tracks may lose their fonts.",
                )

                # --- Default audio track selector ---
                _audio_tracks = st.session_state.get("mkv_audio_tracks", [])
                _selected_audio_idx = None
                if _audio_tracks:
                    from app.language import code_to_name as _audio_code_to_name
                    import langcodes

                    _no_change = "No change (keep source default)"
                    _audio_labels = [_no_change]
                    _auto_select = 0  # default to "No change"

                    for i, at in enumerate(_audio_tracks):
                        lang_display = _audio_code_to_name(at['lang']) if at['lang'] else "Unknown"
                        label = f"Track {i + 1}: {lang_display}"
                        if at['title']:
                            label += f" — {at['title']}"
                        label += f" [{at['codec']}, {at['channels']}ch]"
                        _audio_labels.append(label)

                        # Auto-select: match target language
                        if at['lang'] and target_lang_code and _auto_select == 0:
                            try:
                                source_tag = langcodes.Language.get(at['lang'])
                                target_tag = langcodes.Language.get(target_lang_code)
                                if source_tag.language == target_tag.language:
                                    _auto_select = i + 1  # +1 because index 0 is "No change"
                            except Exception:
                                pass

                    _audio_choice = st.selectbox(
                        "Default audio track",
                        _audio_labels,
                        index=_auto_select,
                        key="mux_default_audio",
                        help="Set the default audio track in the output MKV. "
                             "Audio tracks shown are from the scanned video file. "
                             "If remux target differs, verify the track list.",
                    )
                    if _audio_choice != _no_change:
                        _selected_audio_idx = _audio_labels.index(_audio_choice) - 1

            if st.button("Mux Subtitles into MKV", key="remux_btn"):
                with st.spinner("Muxing subtitle track(s) into MKV (no re-encoding)..."):
                    from app.language import code_to_name as _code_to_name
                    _target_name = _code_to_name(target_lang_code)
                    _native_name = _code_to_name(_native_lang_code) if _native_lang_code else "Unknown"

                    _ass_track_title = _build_track_title(
                        _target_name, _native_name,
                        annotation_name=annotation_system_name if has_annotation else None,
                        romanization_name=romanization_name if romanize_func else None,
                    )
                    _pgs_track_title = _build_track_title(
                        _target_name, _native_name,
                        annotation_name=annotation_system_name if has_annotation else None,
                        romanization_name=romanization_name if romanize_func else None,
                        is_pgs=True,
                    )

                    _mux_ass = st.session_state.generated_ass_path if _include_ass else None
                    _mux_sup = st.session_state.generated_sup_path if _include_sup else None

                    result = merge_subs_to_mkv(
                        remux_target,
                        output_mkv_path,
                        ass_path=_mux_ass,
                        sup_path=_mux_sup,
                        target_lang_code=target_lang_code,
                        track_title=_ass_track_title if _mux_ass else None,
                        pgs_track_title=_pgs_track_title if _mux_sup else None,
                        keep_existing_subs=_keep_existing_subs,
                        keep_attachments=_keep_attachments,
                        default_audio_index=_selected_audio_idx,
                    )
                if result:
                    _tracks = []
                    if _mux_ass:
                        _tracks.append(".ass")
                    if _mux_sup:
                        _tracks.append("PGS .sup")
                    st.success(f"Done! Output saved to `{output_mkv_path}` ({' + '.join(_tracks)})")
                else:
                    st.error("Muxing failed. Check the console for ffmpeg errors.")
        elif remux_target:
            st.error(f"File not found: `{remux_target}`")

elif st.session_state.mkv_path:
    if st.session_state.get('mkv_scan_complete', False):
        st.info("Please select both a native and target subtitle source to continue.")
    else:
        st.info("Click 'Load & Scan Video' to scan for embedded subtitle tracks.")
else:
    st.info("Begin by entering the path to a local video file and clicking 'Load & Scan Video'.")
