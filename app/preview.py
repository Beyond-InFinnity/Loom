# app/preview.py
import base64
import os
import re
import pysubs2
from .romanize import build_annotation_html
from .sub_utils import load_subs

# Fixed reference height — must match _PLAY_RES_Y in processing.py.
_REF_H = 1080
# Preview iframe height (passed to st.components.v1.html).
_PREVIEW_H = 600
# Scale factor from PlayRes coordinates to preview CSS pixels.
_FONT_SCALE = _PREVIEW_H / _REF_H  # ≈0.556

# --- Tag regexes for preserved-event preview rendering ---
_POS_RE = re.compile(r'\\pos\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)')
_AN_RE = re.compile(r'\\an(\d)')
_FN_RE = re.compile(r'\\fn([^\\}]+)')
_FS_RE = re.compile(r'\\fs([\d.]+)')
_C_RE = re.compile(r'\\(?:1?c)&H([0-9A-Fa-f]{2,6})&')
_3C_RE = re.compile(r'\\3c&H([0-9A-Fa-f]{2,6})&')
_BORD_RE = re.compile(r'\\bord([\d.]+)')
_OVERRIDE_RE = re.compile(r'\{[^}]*\}')
_VEC_PATH_RE = re.compile(r'\\p\d')

_ALIGN_CSS = {
    1: ("left", "bottom"),   2: ("center", "bottom"),  3: ("right", "bottom"),
    4: ("left", "center"),   5: ("center", "center"),  6: ("right", "center"),
    7: ("left", "top"),      8: ("center", "top"),      9: ("right", "top"),
}


def _load_subs(source):
    """Load subtitles — delegates to shared cached loader."""
    return load_subs(source)


def _clean_text(text):
    """Strip ASS override tags and normalize line breaks for display.

    Removes {override blocks} like {\\an8}, {\\i1}, {\\fs20\\c&H...}, then
    converts ASS/SRT line-break sequences to spaces.
    """
    text = re.sub(r'\{[^}]*\}', '', text)
    text = text.replace(r'\N', ' ').replace(r'\n', ' ').replace('\n', ' ')
    return text.strip()


def _ass_bgr_to_css(bgr_hex):
    """Convert ASS ``&HBBGGRR&`` hex (without the ``&H`` prefix) to CSS ``rgb()``."""
    bgr_hex = bgr_hex.zfill(6)
    b, g, r = int(bgr_hex[0:2], 16), int(bgr_hex[2:4], 16), int(bgr_hex[4:6], 16)
    return f"rgb({r},{g},{b})"


def _ass_color_obj_to_css(color):
    """Convert a pysubs2.Color to CSS ``rgba()``."""
    if color is None:
        return "white"
    return f"rgba({color.r},{color.g},{color.b},{(255 - color.a) / 255.0})"


def _preserved_event_to_preview_html(event, style, source_res):
    """Convert a preserved ASS event to a percentage-positioned preview HTML div.

    Unlike ``_preserved_event_to_html()`` in ``processing.py`` which targets a
    fixed-pixel PGS canvas, this function uses **percentage-based positioning**
    so the output scales correctly in the responsive preview iframe.

    Font sizes are scaled from the source PlayRes coordinate space to the
    preview's pixel space using ``_PREVIEW_H / source_PlayResY``.

    Parameters
    ----------
    event : pysubs2.SSAEvent
    style : pysubs2.SSAStyle
    source_res : (int, int)
        Source file's (PlayResX, PlayResY).
    """
    if style is None:
        return ""

    text = event.text
    src_x, src_y = source_res
    # Scale factor: source PlayRes → preview CSS pixels.
    fs_scale = _PREVIEW_H / src_y

    # Parse first override block
    first_block = ""
    bm = _OVERRIDE_RE.search(text)
    if bm:
        first_block = bm.group(0)

    pos_m = _POS_RE.search(first_block)
    an_m = _AN_RE.search(first_block)
    fn_m = _FN_RE.search(first_block)
    fs_m = _FS_RE.search(first_block)
    c_m = _C_RE.search(first_block)
    c3_m = _3C_RE.search(first_block)
    bord_m = _BORD_RE.search(first_block)

    alignment = int(an_m.group(1)) if an_m else (style.alignment if style else 2)
    h_align, v_align = _ALIGN_CSS.get(alignment, ("center", "bottom"))

    fontname = fn_m.group(1).strip() if fn_m else (style.fontname if style else "Arial")
    fontsize = float(fs_m.group(1)) * fs_scale if fs_m else style.fontsize * fs_scale

    color_css = _ass_bgr_to_css(c_m.group(1)) if c_m else _ass_color_obj_to_css(style.primarycolor)

    # Outline → text-shadow
    outline_w = float(bord_m.group(1)) * fs_scale if bord_m else (style.outline * fs_scale if style else 0)
    outline_css = _ass_bgr_to_css(c3_m.group(1)) if c3_m else _ass_color_obj_to_css(style.outlinecolor)

    shadow_parts = []
    if outline_w > 0:
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx != 0 or dy != 0:
                    shadow_parts.append(f"{dx}px {dy}px {outline_w:.1f}px {outline_css}")
    ts_css = f"text-shadow:{','.join(shadow_parts)};" if shadow_parts else ""

    # Strip overrides, convert \N
    display = _OVERRIDE_RE.sub('', text)
    display = display.replace(r'\N', '<br>').replace(r'\n', '<br>').replace('\n', '<br>')

    css = [
        "position:absolute;",
        f"font-family:'{fontname}','Noto Sans CJK JP',sans-serif;",
        f"font-size:{fontsize:.1f}px;",
        f"color:{color_css};",
        ts_css,
        "white-space:pre-wrap;",
    ]
    if style and style.bold:
        css.append("font-weight:bold;")
    if style and style.italic:
        css.append("font-style:italic;")

    if pos_m:
        # Percentage position — scales with any preview frame size.
        left_pct = float(pos_m.group(1)) / src_x * 100
        top_pct = float(pos_m.group(2)) / src_y * 100

        transform = []
        if h_align == "center":
            css.append(f"left:{left_pct:.2f}%;")
            transform.append("translateX(-50%)")
        elif h_align == "right":
            css.append(f"right:{100 - left_pct:.2f}%;")
        else:
            css.append(f"left:{left_pct:.2f}%;")

        if v_align == "center":
            css.append(f"top:{top_pct:.2f}%;")
            transform.append("translateY(-50%)")
        elif v_align == "bottom":
            css.append(f"bottom:{100 - top_pct:.2f}%;")
        else:
            css.append(f"top:{top_pct:.2f}%;")

        if transform:
            css.append(f"transform:{' '.join(transform)};")
    else:
        marginv_pct = ((event.marginv or style.marginv) / src_y * 100) if style else 0
        css.append(f"text-align:{h_align};width:100%;box-sizing:border-box;")
        css.append("padding-left:10px;padding-right:10px;")
        if v_align == "bottom":
            css.append(f"bottom:{marginv_pct:.2f}%;")
        elif v_align == "top":
            css.append(f"top:{marginv_pct:.2f}%;")
        else:
            css.append("top:50%;transform:translateY(-50%);")

    return f'<div style="{"".join(css)}">{display}</div>'


def _get_playres(subs):
    """Return (PlayResX, PlayResY), defaulting per ASS spec."""
    try:
        x = int(subs.info.get('PlayResX', 0))
    except (ValueError, TypeError):
        x = 0
    try:
        y = int(subs.info.get('PlayResY', 0))
    except (ValueError, TypeError):
        y = 0
    return (x or 384, y or 288)


def _collect_preserved_html(subs, style_mapping, ts_ms):
    """Return a list of preview HTML divs for preserved events active at *ts_ms*.

    Each "preserve"-mapped event whose time range covers ts_ms is converted to
    a percentage-positioned HTML div via ``_preserved_event_to_preview_html()``.
    """
    if not style_mapping:
        return []

    preserve_styles = frozenset(
        name for name, role in style_mapping.items() if role == "preserve"
    )
    if not preserve_styles:
        return []

    source_res = _get_playres(subs)
    divs = []
    for event in subs:
        if event.is_comment:
            continue
        if _VEC_PATH_RE.search(event.text):
            continue
        if event.style not in preserve_styles:
            continue
        if event.start <= ts_ms <= event.end:
            style_obj = subs.styles.get(event.style)
            if style_obj:
                divs.append(
                    _preserved_event_to_preview_html(event, style_obj, source_res)
                )
    return divs


def get_lines_at_timestamp(native_file, target_file, timestamp_seconds,
                           native_style_mapping=None, target_style_mapping=None):
    """Return the active subtitle text for each track at the given timestamp.

    Scans each subtitle file independently for the first event whose time range
    covers timestamp_seconds (event.start <= ts_ms <= event.end). pysubs2
    stores all times in milliseconds, so the input seconds value is converted.

    When a style_mapping is provided, only events whose ``.style`` maps to
    ``"dialogue"`` are considered for the ``"native"``/``"target"`` text keys.
    Events from Preserve styles are collected separately and returned as
    pre-rendered HTML in the ``"preserved_html"`` key.  Exclude styles are
    dropped entirely.

    Returns an empty string for a track when no event is active at that moment
    (a dialogue gap). This is correct behaviour — it accurately reflects what
    the video shows and is useful feedback to the user.

    Args:
        native_file: Path to user's language subtitle file (Bottom layer).
        target_file: Path to foreign/media language subtitle file (Top layer).
        timestamp_seconds: Timestamp in seconds (int or float).
        native_style_mapping: Style role mapping dict or None.
        target_style_mapping: Style role mapping dict or None.

    Returns:
        dict with keys ``"native"``, ``"target"`` (clean display strings),
        and ``"preserved_html"`` (positioned HTML divs for overlay, may be
        empty string).
    """
    result = {"native": "", "target": "", "preserved_html": ""}
    if not native_file or not target_file:
        return result

    ts_ms = int(timestamp_seconds * 1000)

    # Build dialogue-only style sets when mappings are provided
    native_dialogue = None
    if native_style_mapping:
        native_dialogue = frozenset(
            name for name, role in native_style_mapping.items() if role == "dialogue"
        )
    target_dialogue = None
    if target_style_mapping:
        target_dialogue = frozenset(
            name for name, role in target_style_mapping.items() if role == "dialogue"
        )

    # --- Dialogue text ---
    native_subs = None
    try:
        native_subs = _load_subs(native_file)
        for event in native_subs:
            if native_dialogue is not None and event.style not in native_dialogue:
                continue
            if event.start <= ts_ms <= event.end:
                result["native"] = _clean_text(event.text)
                break
    except Exception as e:
        print(f"Error looking up native subtitle at {timestamp_seconds}s: {e}")

    target_subs = None
    try:
        target_subs = _load_subs(target_file)
        for event in target_subs:
            if target_dialogue is not None and event.style not in target_dialogue:
                continue
            if event.start <= ts_ms <= event.end:
                result["target"] = _clean_text(event.text)
                break
    except Exception as e:
        print(f"Error looking up target subtitle at {timestamp_seconds}s: {e}")

    # --- Preserved events → positioned preview HTML ---
    preserved_divs = []
    if native_subs and native_style_mapping:
        preserved_divs.extend(
            _collect_preserved_html(native_subs, native_style_mapping, ts_ms)
        )
    if target_subs and target_style_mapping:
        preserved_divs.extend(
            _collect_preserved_html(target_subs, target_style_mapping, ts_ms)
        )
    if preserved_divs:
        result["preserved_html"] = ''.join(preserved_divs)

    return result

def generate_unified_preview(styles, native_text, target_text, pinyin_text,
                             resolution=(1920, 1080),
                             background_image_path=None,
                             annotation_spans=None,
                             preview_mode="ass",
                             annotation_render_mode="ruby",
                             preserved_html=""):
    """Generates a full HTML document for a unified preview of all text tracks.

    Returns a complete <!DOCTYPE html> document so that height: 100% cascades
    correctly from the iframe root.

    The inner video-frame div uses:
        width: min(100%, calc(100vh * W / H))
        height: auto; aspect-ratio: W / H

    Parameters
    ----------
    annotation_spans : list[(str, str|None)] | None
        If provided (target language with annotation enabled), the Top div
        renders the text with <ruby> markup using build_annotation_html().
        The browser's native ruby layout centers each reading above its base
        character/token.  When None, target_text is used as plain text.
    preview_mode : str
        "ass" (default) — simulates .ass output layout with separate annotation
        positioning. "pgs" — renders annotation as native <ruby><rt> inline
        with Top text, matching the full-frame PGS rasterizer output.
    preserved_html : str
        Pre-rendered HTML divs for preserved (sign/title) events.  Positioned
        absolutely within the video-frame div using percentage coordinates.
        Generated by ``get_lines_at_timestamp()`` from preserved-mapped styles.

    Positions
    ---------
    All subtitle positions are computed from live style marginv values and the
    video resolution — not hardcoded percentages.  marginv is in video pixels;
    dividing by the video height converts to a CSS percentage of the frame div.
    This means any style-expander change to marginv ripples through the preview
    on the next rerun.
    """
    b64_image_src = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="
    if background_image_path and os.path.exists(background_image_path):
        with open(background_image_path, "rb") as img_f:
            b64 = base64.b64encode(img_f.read()).decode()
        b64_image_src = f"data:image/jpeg;base64,{b64}"

    w, h = resolution

    # Positions derived from live style marginv values.
    # Use a fixed reference height (1080) for the percentage calculation so the
    # preview layout is independent of the source video resolution.  Font sizes
    # are in absolute CSS pixels — margins must produce the same effective pixel
    # offsets regardless of video resolution.  Without a fixed reference, a 4K
    # video (h=2160) halves percentage-based margins while font sizes stay fixed,
    # causing text layers to overlap.
    # vertical_offset shifts the entire top stack as a unit (R6a).
    # romanized_gap adds extra space between Romanized and Target layers.
    # _REF_H, _PREVIEW_H, _FONT_SCALE are module-level constants.
    v_offset = styles.get('vertical_offset', 0)
    rom_gap = styles.get('romanized_gap', 0)
    ann_gap = styles.get('annotation_gap', 2)
    positions = {
        "Bottom":    f"bottom:{styles['Bottom']['marginv'] / _REF_H * 100:.2f}%;",
        "Top":       f"top:{(styles['Top']['marginv'] + v_offset) / _REF_H * 100:.2f}%;",
        "Romanized": f"top:{(styles['Romanized']['marginv'] + v_offset - rom_gap) / _REF_H * 100:.2f}%;",
    }

    # When annotation spans are available, render the Top slot as ruby HTML.
    # In PGS mode, always use ruby HTML (annotation inline with Top).
    # In ASS mode, ruby HTML previews the annotation overlay.
    if preview_mode == "pgs" and annotation_spans:
        top_content = build_annotation_html(annotation_spans, mode=annotation_render_mode)
    elif annotation_spans:
        top_content = build_annotation_html(annotation_spans, mode=annotation_render_mode)
    else:
        top_content = target_text
    texts = {"Bottom": native_text, "Top": top_content, "Romanized": pinyin_text}

    subtitle_overlays_html = []

    for name, config in styles.items():
        if not isinstance(config, dict):
            continue
        if not config.get('enabled', True):
            continue

        text_content = texts.get(name, "")
        if not text_content:
            continue

        pc, oc, bc = config['primarycolor'], config['outlinecolor'], config['backcolor']
        shadow = 0.0 if config.get('shadow_none', True) else config['shadow']
        outline = 0.0 if config.get('outline_none', True) else config['outline']

        # Scale shadow/outline/glow from PlayRes to preview pixels.
        p_shadow = shadow * _FONT_SCALE
        p_outline = outline * _FONT_SCALE

        shadow_parts = []
        if p_shadow > 0:
            shadow_parts.append(f"{p_shadow:.1f}px {p_shadow:.1f}px 3px rgba({oc.r},{oc.g},{oc.b},0.8)")
        if not config.get('outline_none', True) and p_outline > 0:
            oc_rgba = f"rgba({oc.r},{oc.g},{oc.b},{(255-oc.a)/255.0})"
            shadow_parts.extend(
                f"{x}px {y}px {p_outline:.1f}px {oc_rgba}"
                for x in [-1, 0, 1] for y in [-1, 0, 1]
                if x != 0 or y != 0
            )
        if not config.get('glow_none', True):
            glow_r = config.get('glow_radius', 5) * _FONT_SCALE
            glow_hex = config.get('glow_color_hex', '#ffff00')
            gr = int(glow_hex[1:3], 16)
            gg = int(glow_hex[3:5], 16)
            gb = int(glow_hex[5:7], 16)
            shadow_parts.append(f"0 0 {glow_r:.1f}px rgba({gr},{gg},{gb},0.9)")
            shadow_parts.append(f"0 0 {glow_r * 2:.1f}px rgba({gr},{gg},{gb},0.5)")
        text_shadow_css = f"text-shadow:{', '.join(shadow_parts)};" if shadow_parts else ""

        back_alpha = (255 - bc.a) / 255.0 if not config.get('back_none', True) else 0

        # Scale font size from PlayRes coordinates to preview pixels.
        preview_fontsize = config['fontsize'] * _FONT_SCALE

        style_str = (
            f"position:absolute;width:100%;text-align:center;"
            f"{positions.get(name, 'top:50%;')}"
            f"font-family:'{config['fontname']}';font-size:{preview_fontsize:.1f}px;"
            f"font-weight:{'bold' if config['bold'] else 'normal'};"
            f"font-style:{'italic' if config['italic'] else 'normal'};"
            f"color:rgba({pc.r},{pc.g},{pc.b},{(255-pc.a)/255.0});"
            f"background-color:rgba({bc.r},{bc.g},{bc.b},{back_alpha});"
            f"padding:5px 10px;box-sizing:border-box;{text_shadow_css}"
        )
        subtitle_overlays_html.append(f'<div style="{style_str}">{text_content}</div>')
    overlay_html_string = ''.join(subtitle_overlays_html)

    # Compute annotation (ruby <rt>) styling from Annotation config.
    ann_cfg = styles.get('Annotation', {})
    ann_rt_extra_css = ""
    if isinstance(ann_cfg, dict) and ann_cfg.get('enabled', False):
        ann_pc = ann_cfg.get('primarycolor', pysubs2.Color(255, 255, 255, 0))
        ann_opacity = (255 - ann_pc.a) / 255.0
        ann_color_css = f"rgba({ann_pc.r},{ann_pc.g},{ann_pc.b},{ann_opacity})"
        top_fontsize = styles.get('Top', {}).get('fontsize', 24)
        ann_fontsize_ratio = ann_cfg.get('fontsize', 12) / top_fontsize if top_fontsize else 0.5

        # Build text-shadow for <rt> elements (outline/shadow/glow)
        ann_shadow_parts = []
        if not ann_cfg.get('outline_none', True):
            p_outline = ann_cfg.get('outline', 1.0) * _FONT_SCALE
            oc = ann_cfg.get('outlinecolor')
            if oc:
                oc_rgba = f"rgba({oc.r},{oc.g},{oc.b},{(255-oc.a)/255.0})"
            else:
                oc_rgba = "rgba(0,0,0,1)"
            ann_shadow_parts.extend(
                f"{x}px {y}px {p_outline:.1f}px {oc_rgba}"
                for x in [-1, 0, 1] for y in [-1, 0, 1]
                if x != 0 or y != 0
            )
        if not ann_cfg.get('shadow_none', True):
            p_shadow = ann_cfg.get('shadow', 1.5) * _FONT_SCALE
            oc = ann_cfg.get('outlinecolor')
            s_rgba = f"rgba({oc.r},{oc.g},{oc.b},0.8)" if oc else "rgba(0,0,0,0.8)"
            ann_shadow_parts.append(f"{p_shadow:.1f}px {p_shadow:.1f}px 3px {s_rgba}")
        if not ann_cfg.get('glow_none', True):
            glow_r = ann_cfg.get('glow_radius', 5) * _FONT_SCALE
            glow_hex = ann_cfg.get('glow_color_hex', '#ffff00')
            gr = int(glow_hex[1:3], 16)
            gg = int(glow_hex[3:5], 16)
            gb = int(glow_hex[5:7], 16)
            ann_shadow_parts.append(f"0 0 {glow_r:.1f}px rgba({gr},{gg},{gb},0.9)")
            ann_shadow_parts.append(f"0 0 {glow_r * 2:.1f}px rgba({gr},{gg},{gb},0.5)")
        if ann_shadow_parts:
            ann_rt_extra_css = f"text-shadow: {', '.join(ann_shadow_parts)};"
    else:
        ann_color_css = "inherit"
        ann_fontsize_ratio = 0.5

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
  /* Ruby text for annotation preview (furigana/pinyin/zhuyin/jyutping).
     Font-size ratio and color are driven by the Annotation style config. */
  ruby rt {{
    font-size: {ann_fontsize_ratio}em;
    text-align: center;
    color: {ann_color_css};
    transform: translateY(-{ann_gap * _FONT_SCALE:.1f}px);
    {ann_rt_extra_css}
  }}
  /* Interlinear annotation mode: inline-block two-row containers */
  .ilb {{
    display: inline-block;
    text-align: center;
    vertical-align: bottom;
    line-height: 1.1;
  }}
  .ilb-r {{
    display: block;
    font-size: {ann_fontsize_ratio}em;
    color: {ann_color_css};
    transform: translateY(-{ann_gap * _FONT_SCALE:.1f}px);
    {ann_rt_extra_css}
  }}
  .ilb-b {{
    display: block;
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
      {preserved_html}
    </div>
  </div>
</body>
</html>'''
