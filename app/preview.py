# app/preview.py
import pysubs2

def get_preview_lines(native_file, target_file):
    """
    Finds two corresponding subtitle lines from the middle of two files based on time overlap.
    """
    if not native_file or not target_file:
        return None

    try:
        native_file.seek(0)
        target_file.seek(0)
        native_subs = pysubs2.SSAFile.from_string(native_file.getvalue().decode("utf-8"))
        target_subs = pysubs2.SSAFile.from_string(target_file.getvalue().decode("utf-8"))

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

def generate_unified_preview(styles, native_text, target_text, pinyin_text):
    """Generates HTML/CSS for a unified preview of all three text tracks."""
    html = '<div style="background-color:black; aspect-ratio:16/9; position:relative; width:100%;">'
    texts = {"Bottom": native_text, "Top": target_text, "Romanized": pinyin_text}
    positions = {"Bottom": "bottom: 5%;", "Top": "top: 10%;", "Romanized": "top: 5%;"}

    for name, config in styles.items():
        if not config.get('enabled', True):
            continue
        
        pc, oc, bc = config['primarycolor'], config['outlinecolor'], config['backcolor']
        shadow = 0.0 if config.get('shadow_none', True) else config['shadow']
        outline = 0.0 if config.get('outline_none', True) else config['outline']
        
        shadow_css = f"{shadow}px {shadow}px 3px rgba(0,0,0,0.8)"
        outline_css = ", ".join([f"{x}px {y}px {outline}px rgba({oc.r},{oc.g},{oc.b},{(255-oc.a)/255.0})" for x in [-1,0,1] for y in [-1,0,1] if x!=0 or y!=0]) if not config.get('outline_none',True) else ""
        
        style_str = (
            f"position:absolute; width:100%; text-align:center; {positions.get(name, 'top: 50%;')}"
            f"font-family:'{config['fontname']}'; font-size:{config['fontsize']}px;"
            f"font-weight:{'bold' if config['bold'] else 'normal'}; font-style:{'italic' if config['italic'] else 'normal'};"
            f"color:rgba({pc.r},{pc.g},{pc.b},{(255-pc.a)/255.0});"
            f"background-color:rgba({bc.r},{bc.g},{bc.b},{(255-bc.a)/255.0 if not config.get('back_none', True) else 0});"
            f"padding: 5px 10px; box-sizing: border-box; text-shadow: {shadow_css}, {outline_css};"
        )
        html += f'<div style="{style_str}">{texts.get(name, "")}</div>'
    html += "</div>"
    return html
