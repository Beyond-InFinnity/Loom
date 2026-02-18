# app/styles.py
from .romanize import get_romanizer

FONT_LIST = [
    "Arial", "Arial Black", "Verdana", "Georgia", "Times New Roman",
    "Noto Sans", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR",
]

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

# Primary BCP-47 subtag → (human-readable romanization name, confidence level)
# Confidence levels match the table in CLAUDE.md's Romanization Architecture
# section: very_high / high / good / moderate / low / none
_ROMANIZATION_META = {
    "zh": ("Pinyin",                        "very_high"),
    "ja": ("Romaji / Furigana",             "good"),
    "ko": ("Revised Romanization",          "high"),
    "ru": ("Latin transliteration",         "high"),
    "uk": ("Latin transliteration",         "high"),
    "bg": ("Latin transliteration",         "high"),
    "sr": ("Latin transliteration",         "high"),
    "mk": ("Latin transliteration",         "high"),
    "th": ("Royal Institute Romanization",  "good"),
    "hi": ("IAST",                          "moderate"),
    "bn": ("IAST",                          "moderate"),
    "ta": ("IAST",                          "moderate"),
    "te": ("IAST",                          "moderate"),
    "gu": ("IAST",                          "moderate"),
    "pa": ("IAST",                          "moderate"),
    "ar": ("Romanization (experimental)",   "low"),
    "fa": ("Romanization (experimental)",   "low"),
    "ur": ("Romanization (experimental)",   "low"),
}

# Right-to-left primary subtags
_RTL_CODES = frozenset({"ar", "fa", "ur", "he", "yi"})

# Per-script default fonts (must be entries in FONT_LIST)
_SCRIPT_FONTS = {
    "ja": "Noto Sans JP",
    "ko": "Noto Sans KR",
}


def _font_for_script(lang_code: str) -> str:
    """Return the best default font for *lang_code* from FONT_LIST."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary in _SCRIPT_FONTS:
        return _SCRIPT_FONTS[primary]
    if primary == "zh" or (lang_code or "").lower().startswith("zh"):
        return "Noto Sans SC"
    return "Arial"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_lang_config(lang_code: str) -> dict:
    """Return a style/romanization config dict for *lang_code*.

    Always returns a complete dict — unknown or empty codes get safe defaults
    rather than raising or returning None.

    Keys
    ----
    romanize_func : callable | None
        (str) -> str romanization function, or None if unavailable.
        See ``app/romanize.py`` for implementation status per language.
    has_phonetic_layer : bool
        True when a romanize_func is available.
    romanization_name : str
        Human-readable name shown in the UI (e.g. "Pinyin", "N/A").
    romanization_confidence : str
        One of: very_high / high / good / moderate / low / none.
    default_font : str
        Sensible default font for the script (entry from FONT_LIST).
    rtl : bool
        True for right-to-left scripts (Arabic, Persian, Urdu, Hebrew …).
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]

    romanizer = get_romanizer(lang_code)
    rom_name, confidence = _ROMANIZATION_META.get(primary, ("N/A", "none"))

    return {
        "romanize_func":            romanizer,
        "has_phonetic_layer":       romanizer is not None,
        "romanization_name":        rom_name,
        "romanization_confidence":  confidence,
        "default_font":             _font_for_script(lang_code),
        "rtl":                      primary in _RTL_CODES,
    }
