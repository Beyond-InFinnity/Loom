# app/preview.py
import base64
import os
import re
import pysubs2


def _load_subs(source):
    """Load subtitles from either a file path (str) or a Streamlit file object."""
    if isinstance(source, str):
        return pysubs2.load(source)
    source.seek(0)
    return pysubs2.SSAFile.from_string(source.getvalue().decode("utf-8"))


def _clean_text(text):
    """Strip ASS override tags and normalize line breaks for display.

    Removes {override blocks} like {\\an8}, {\\i1}, {\\fs20\\c&H...}, then
    converts ASS/SRT line-break sequences to spaces.
    """
    text = re.sub(r'\{[^}]*\}', '', text)
    text = text.replace(r'\N', ' ').replace(r'\n', ' ').replace('\n', ' ')
    return text.strip()


def get_lines_at_timestamp(native_file, target_file, timestamp_seconds):
    """Return the active subtitle text for each track at the given timestamp.

    Scans each subtitle file independently for the first event whose time range
    covers timestamp_seconds (event.start <= ts_ms <= event.end). pysubs2
    stores all times in milliseconds, so the input seconds value is converted.

    Returns an empty string for a track when no event is active at that moment
    (a dialogue gap). This is correct behaviour — it accurately reflects what
    the video shows and is useful feedback to the user.

    Args:
        native_file: Path string to the native subtitle file.
        target_file: Path string to the target subtitle file.
        timestamp_seconds: Timestamp in seconds (int or float).

    Returns:
        dict with keys "native" and "target", each a clean display string.
    """
    result = {"native": "", "target": ""}
    if not native_file or not target_file:
        return result

    ts_ms = int(timestamp_seconds * 1000)

    try:
        for event in _load_subs(native_file):
            if event.start <= ts_ms <= event.end:
                result["native"] = _clean_text(event.text)
                break
    except Exception as e:
        print(f"Error looking up native subtitle at {timestamp_seconds}s: {e}")

    try:
        for event in _load_subs(target_file):
            if event.start <= ts_ms <= event.end:
                result["target"] = _clean_text(event.text)
                break
    except Exception as e:
        print(f"Error looking up target subtitle at {timestamp_seconds}s: {e}")

    return result

def generate_unified_preview(styles, native_text, target_text, pinyin_text,
                             resolution=(1920, 1080),
                             background_image_path=None):
    """Generates a full HTML document for a unified preview of all text tracks.

    Returns a complete <!DOCTYPE html> document so that height: 100% cascades
    correctly from the iframe root — without this, percentage heights on divs
    are undefined and the video frame div expands to its natural image size,
    overflowing the iframe and pushing bottom-positioned subtitles off-screen.

    The inner video-frame div uses:
        width: min(100%, calc(100vh * W / H))
        height: auto; aspect-ratio: W / H
    This picks whichever is the binding constraint (full container width vs.
    the width that would fill the viewport height at the given ratio) and
    derives height from it, guaranteeing the frame always fits in the 600px
    iframe without overflow. Subtitle percentage positions are relative to
    this div, so they scale correctly with the displayed frame.
    """
    b64_image_src = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="
    if background_image_path and os.path.exists(background_image_path):
        with open(background_image_path, "rb") as img_f:
            b64 = base64.b64encode(img_f.read()).decode()
        b64_image_src = f"data:image/jpeg;base64,{b64}"

    subtitle_overlays_html = []
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
        subtitle_overlays_html.append(f'<div style="{style_str}">{text_content}</div>')
    overlay_html_string = ''.join(subtitle_overlays_html)

    w, h = resolution

    return f'''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  html, body {{
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background-color: #0e1117;
  }}
  .outer {{
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    width: 100%;
    background-color: #0e1117;
    overflow: hidden;
  }}
  .video-frame {{
    position: relative;
    /* Width = the smaller of: full container width, or the width that fills
       the viewport height at the video's aspect ratio. Height is then derived
       from width via aspect-ratio, so the frame always fits without overflow. */
    width: min(100%, calc(100vh * {w} / {h}));
    height: auto;
    aspect-ratio: {w} / {h};
    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    background-color: #000;
  }}
  .video-frame img {{
    display: block;
    width: 100%;
    height: 100%;
  }}
</style>
</head>
<body>
  <div class="outer">
    <div class="video-frame">
      <img src="{b64_image_src}" alt="">
      {overlay_html_string}
    </div>
  </div>
</body>
</html>'''
