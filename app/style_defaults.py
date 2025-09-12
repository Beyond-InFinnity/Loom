# app/style_defaults.py

from app.font_presets import get_default_font

style_defaults = {
    "English": {
        "Fontname": get_default_font("English"),
        "Fontsize": 36,
        "PrimaryColour": "&H00FFFFFF",
        "OutlineColour": "&H00000000",
        "BackColour": "&H80000000",
        "BorderStyle": 1,
        "Outline": 2,
        "Shadow": 1,
        "Alignment": 2,
        "MarginV": 50
    },
    "Chinese": {
        "Fontname": get_default_font("Chinese"),
        "Fontsize": 38,
        "PrimaryColour": "&H00FFFFFF",
        "OutlineColour": "&H00222222",
        "BackColour": "&H80000000",
        "BorderStyle": 1,
        "Outline": 2,
        "Shadow": 1,
        "Alignment": 2,
        "MarginV": 55
    },
    "Japanese": {
        "Fontname": get_default_font("Japanese"),
        "Fontsize": 38,
        "PrimaryColour": "&H00FFFFFF",
        "OutlineColour": "&H00222222",
        "BackColour": "&H80000000",
        "BorderStyle": 1,
        "Outline": 2,
        "Shadow": 1,
        "Alignment": 2,
        "MarginV": 55
    },
    "Korean": {
        "Fontname": get_default_font("Korean"),
        "Fontsize": 38,
        "PrimaryColour": "&H00FFFFFF",
        "OutlineColour": "&H00222222",
        "BackColour": "&H80000000",
        "BorderStyle": 1,
        "Outline": 2,
        "Shadow": 1,
        "Alignment": 2,
        "MarginV": 55
    },
    "Arabic": {
        "Fontname": get_default_font("Arabic"),
        "Fontsize": 40,
        "PrimaryColour": "&H00FFFFFF",
        "OutlineColour": "&H00222222",
        "BackColour": "&H80000000",
        "BorderStyle": 1,
        "Outline": 2,
        "Shadow": 1,
        "Alignment": 2,
        "MarginV": 55
    }
    # You can add more overrides per language here
}

def get_style_defaults(language):
    return style_defaults.get(language, style_defaults["English"]).copy()
