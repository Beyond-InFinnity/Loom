# app/preview.py
import base64
import os
import pysubs2


def _load_subs(source):
    """Load subtitles from either a file path (str) or a Streamlit file object."""
    if isinstance(source, str):
        return pysubs2.load(source)
    source.seek(0)
    return pysubs2.SSAFile.from_string(source.getvalue().decode("utf-8"))


def get_preview_lines(native_file, target_file):
    """
    Finds two corresponding subtitle lines from the middle of two files based on time overlap.
    Accepts either file path strings or Streamlit uploaded file objects.
    """
    if not native_file or not target_file:
        return None

    try:
        native_subs = _load_subs(native_file)
        target_subs = _load_subs(target_file)

        if not native_subs or not target_subs:
            return None

        anchor_line = target_subs[len(target_subs) // 2]
        corresponding_line = None
        for line in native_subs:
            if line.start < anchor_line.end and line.end > anchor_line.start:
                corresponding_line = line
                break
        
        if corresponding_line is None:
            corresponding_line = native_subs[len(native_subs) // 2]

        return {
            "native": corresponding_line.text.replace(r"\N", " "),
            "target": anchor_line.text.replace(r"\N", " ")
        }
    except Exception as e:
        print(f"Error getting preview lines: {e}")
        return None

def generate_unified_preview(styles, native_text, target_text, pinyin_text,
                             background_image_path=None):
    """Generates HTML/CSS for a unified preview of all text tracks.

    Layout: an outer flex container fills the iframe and centers an inner 16:9
    div.  The inner div is constrained by max-width/max-height so it always
    fits within the iframe regardless of how wide Streamlit makes the content
    area.  Subtitle divs are positioned absolutely inside the inner div, so
    percentage positions (bottom:5%, top:10%) are relative to the video area —
    not the iframe — even when the image is letterboxed or pillarboxed.

    When background_image_path is provided, the video frame is shown as the
    background.  Falls back to a dark background when no frame is available.
    """
    if background_image_path and os.path.exists(background_image_path):
        with open(background_image_path, "rb") as img_f:
            b64 = base64.b64encode(img_f.read()).decode()
        frame_bg = (
            f"background-image:url('data:image/jpeg;base64,{b64}');"
            "background-size:100% 100%;background-position:center;"
            "background-repeat:no-repeat;"
        )
    else:
        frame_bg = "background-color:#111;"

    # Outer container: fills iframe, black surround, centers the video area
    html = (
        '<div style="width:100%;height:100%;display:flex;'
        'align-items:center;justify-content:center;background:black;'
        'margin:0;padding:0;overflow:hidden;">'
    )
    # Inner container: 16:9 video area, constrained to fit within the iframe.
    # Subtitle positions are relative to this div.
    html += (
        f'<div style="position:relative;aspect-ratio:16/9;'
        f'max-width:100%;max-height:100%;{frame_bg}">'
    )

    texts = {"Bottom": native_text, "Top": target_text, "Romanized": pinyin_text}
    positions = {"Bottom": "bottom:5%;", "Top": "top:10%;", "Romanized": "top:3%;"}

    for name, config in styles.items():
        if not config.get('enabled', True):
            continue

        text_content = texts.get(name, "")
        if not text_content:
            continue

        pc, oc, bc = config['primarycolor'], config['outlinecolor'], config['backcolor']
        shadow = 0.0 if config.get('shadow_none', True) else config['shadow']
        outline = 0.0 if config.get('outline_none', True) else config['outline']

        # Build text-shadow parts, filtering out empties to avoid trailing commas
        shadow_parts = []
        if shadow > 0:
            shadow_parts.append(f"{shadow}px {shadow}px 3px rgba(0,0,0,0.8)")
        if not config.get('outline_none', True) and outline > 0:
            oc_rgba = f"rgba({oc.r},{oc.g},{oc.b},{(255-oc.a)/255.0})"
            shadow_parts.extend(
                f"{x}px {y}px {outline}px {oc_rgba}"
                for x in [-1, 0, 1] for y in [-1, 0, 1]
                if x != 0 or y != 0
            )
        text_shadow_css = f"text-shadow:{', '.join(shadow_parts)};" if shadow_parts else ""

        back_alpha = (255 - bc.a) / 255.0 if not config.get('back_none', True) else 0

        style_str = (
            f"position:absolute;width:100%;text-align:center;"
            f"{positions.get(name, 'top:50%;')}"
            f"font-family:'{config['fontname']}';font-size:{config['fontsize']}px;"
            f"font-weight:{'bold' if config['bold'] else 'normal'};"
            f"font-style:{'italic' if config['italic'] else 'normal'};"
            f"color:rgba({pc.r},{pc.g},{pc.b},{(255-pc.a)/255.0});"
            f"background-color:rgba({bc.r},{bc.g},{bc.b},{back_alpha});"
            f"padding:5px 10px;box-sizing:border-box;{text_shadow_css}"
        )
        html += f'<div style="{style_str}">{text_content}</div>'

    html += '</div></div>'
    return html
