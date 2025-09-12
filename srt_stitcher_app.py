# srt_stitcher_app.py

import streamlit as st
import tempfile
import pysrt
import os
from app.lang_detect import detect_language_from_srt, get_lang_display
from app.style_utils import get_style_config
from app.user_settings import save_user_styles, load_user_styles
from app.font_preview import render_font_sample
from app.style_defaults import get_style_defaults

st.set_page_config(page_title="SrtStitcher", layout="centered")
st.title("🎬 SrtStitcher: Dual-Language Subtitle Merger")

st.header("📂 Upload Two Subtitles")
uploaded_files = st.file_uploader("Upload two .srt files", type="srt", accept_multiple_files=True)

if len(uploaded_files) != 2:
    st.warning("Please upload exactly two .srt files.")
    st.stop()

# Ask user for desired resolution
st.header("📐 Select Target Video Resolution")
res_options = {"720p": (1280, 720), "1080p": (1920, 1080), "2160p (4K)": (3840, 2160)}
res_label = st.selectbox("Choose resolution for .ass file positioning:", list(res_options.keys()), index=1)
playresx, playresy = res_options[res_label]

# Assign roles dynamically and detect languages
subs = []
for file in uploaded_files:
    srt_text = file.read().decode("utf-8")
    srt_obj = pysrt.from_string(srt_text)
    lang_code = detect_language_from_srt(srt_obj)
    lang_label = get_lang_display(lang_code)
    custom_label = st.text_input(f"Language label for `{file.name}`", value=lang_label)
    subs.append((custom_label, srt_obj))

# Display customizable styles per language
st.header("🎨 Customize Styles")
style_inputs = {}
positions = ["Top", "Bottom", "Left", "Right"]

for label, _ in subs:
    st.subheader(f"Style for {label}")
    style = get_style_config(label)

    font = st.text_input(f"Font ({label})", value=style["font"], key=f"font_{label}")
    color = st.color_picker(f"Font Color ({label})", value=style["color"], key=f"color_{label}")
    size = st.slider(f"Font Size ({label})", 20, 80, style["size"], key=f"size_{label}")
    position = st.selectbox(f"Position ({label})", positions, index=positions.index(style["position"]), key=f"position_{label}")

    if st.button(f"💾 Save as default for {label}"):
        all_styles = load_user_styles()
        all_styles[label] = {"font": font, "color": color, "size": size, "position": position}
        save_user_styles(all_styles)
        st.success(f"Saved settings for {label}")

    style_inputs[label] = {"font": font, "color": color, "size": size, "position": position}

    # Font preview inline
    preview_path = f"assets/font_previews/{label}_preview.png"
    render_font_sample(font_name=font, text=f"Sample text in {label}", lang=label, size=size, output_path=preview_path)
    st.image(preview_path, caption=f"Preview for {label}", width=480)

# Generate .ass file
if st.button("✨ Generate .ass Subtitle File"):
    def fmt_time(t):
        return f"{t.hours}:{t.minutes:02}:{t.seconds:02}.{int(t.milliseconds/10):02}"

    def rgb_to_ass(hex_color):
        hex_color = hex_color.lstrip("#")
        bgr = hex_color[4:6] + hex_color[2:4] + hex_color[0:2]
        return f"&H00{bgr.upper()}"

    # Build .ass header
    header = f"""[Script Info]
Title: Dual-language subs
ScriptType: v4.00+
PlayResX: {playresx}
PlayResY: {playresy}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
"""

    align_map = {"Bottom": 2, "Top": 8, "Left": 1, "Right": 3}
    events = ""
    styles = ""

    for label in style_inputs:
        s = style_inputs[label]
        styles += f"Style: {label},{s['font']},{s['size']},{rgb_to_ass(s['color'])},&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,{align_map[s['position']]},50,50,50,1\n"

    header += styles + "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"

    # Add dialogue lines
    for i in range(max(len(subs[0][1]), len(subs[1][1]))):
        for label, srt in subs:
            if i < len(srt):
                line = srt[i]
                text = line.text.replace("\n", "\\N")
                events += f"Dialogue: 0,{fmt_time(line.start)},{fmt_time(line.end)},{label},,0,0,0,,{text}\n"

    ass_content = header + events

    with tempfile.NamedTemporaryFile(delete=False, suffix=".ass", mode="w", encoding="utf-8") as f:
        f.write(ass_content)
        temp_path = f.name

    with open(temp_path, "rb") as f:
        st.success("✅ Subtitle file generated!")
        st.download_button("📥 Download .ass file", f, file_name="dual_subs.ass", mime="text/plain")
