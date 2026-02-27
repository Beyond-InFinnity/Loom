# app/styles.py
from .romanize import get_romanizer, get_annotation_func, get_japanese_pipeline, _apply_thai_word_boundaries

FONT_LIST = [
    "Arial", "Arial Black", "Verdana", "Georgia", "Times New Roman",
    "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR",
    "Noto Sans CJK TC", "Noto Sans CJK HK",
]

# Fonts with confirmed CJK (kanji/kana/hanzi) glyph coverage.
# Used for the Annotation style picker — a font without CJK coverage will
# render furigana/pinyin as boxes.  Must be a subset of FONT_LIST so that the
# ASS renderer can find the font by name.
CJK_FONT_LIST = [
    "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR",
    "Noto Sans CJK TC", "Noto Sans CJK HK",
]

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

# Primary BCP-47 subtag → (human-readable romanization name, confidence level)
# Confidence levels match the table in CLAUDE.md's Romanization Architecture
# section: very_high / high / good / moderate / low / none
_ROMANIZATION_META = {
    "zh": ("Pinyin",                        "very_high"),
    "yue": ("Jyutping",                     "high"),
    "ja": ("Romaji / Furigana",             "good"),
    "ko": ("Revised Romanization",          "high"),
    "ru": ("Latin transliteration",         "high"),
    "uk": ("Latin transliteration",         "high"),
    "bg": ("Latin transliteration",         "high"),
    "sr": ("Latin transliteration",         "high"),
    "mk": ("Latin transliteration",         "high"),
    "be": ("Latin transliteration",         "high"),
    "mn": ("Latin transliteration",         "high"),
    "th": ("Paiboon+ (with tones)",         "good"),
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
    "ja": "Noto Sans CJK JP",
    "ko": "Noto Sans CJK KR",
}


def _font_for_script(lang_code: str) -> str:
    """Return the best default font for *lang_code* from FONT_LIST."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary in _SCRIPT_FONTS:
        return _SCRIPT_FONTS[primary]
    # Cantonese uses Traditional Chinese characters
    if primary == "yue":
        return "Noto Sans CJK HK"
    if primary == "zh" or (lang_code or "").lower().startswith("zh"):
        lc = (lang_code or "").lower()
        if lc in ("zh-hant", "zh-tw"):
            return "Noto Sans CJK TC"
        if lc == "zh-hk":
            return "Noto Sans CJK HK"
        return "Noto Sans CJK SC"
    return "Arial"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _chinese_variant(lang_code: str) -> str | None:
    """Classify a Chinese lang_code into a canonical variant string.

    Returns one of "zh-Hans", "zh-Hant", "yue", or None for non-Chinese.
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary == "yue":
        return "yue"
    if primary != "zh":
        return None
    lc = (lang_code or "").lower()
    if lc in ("zh-hant", "zh-tw", "zh-hk"):
        return "zh-Hant"
    # zh, zh-hans, zh-cn, and bare "zh" default to Simplified
    return "zh-Hans"


def _annotation_system_name(lang_code: str, phonetic_system: str = None) -> str:
    """Return the human-readable annotation system name for UI labels.

    Drives dynamic labels: "Furigana Style", "Pinyin Style", "Zhuyin Style",
    "Jyutping Style", etc.  Returns "Annotation" as generic fallback.
    """
    if phonetic_system:
        _SYS_NAMES = {
            "pinyin": "Pinyin", "zhuyin": "Zhuyin", "jyutping": "Jyutping",
            "rtgs": "RTGS", "paiboon": "Paiboon+", "ipa": "IPA",
        }
        return _SYS_NAMES.get(phonetic_system.lower(), "Annotation")

    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary == "ja":
        return "Furigana"
    if primary == "yue":
        return "Jyutping"
    if primary == "zh":
        lc = (lang_code or "").lower()
        if lc in ("zh-hant", "zh-tw"):
            return "Zhuyin"
        return "Pinyin"
    if primary == "ko":
        return "Romanization"
    if primary in ("ru", "uk", "be", "sr", "bg", "mk", "mn"):
        return "Transliteration"
    if primary == "th":
        return "Romanization"
    return "Annotation"


def get_lang_config(lang_code: str, phonetic_system: str = None) -> dict:
    """Return a style/romanization config dict for *lang_code*.

    Always returns a complete dict — unknown or empty codes get safe defaults
    rather than raising or returning None.

    Parameters
    ----------
    lang_code : str
        BCP 47 language tag (e.g. "ja", "zh-Hant", "yue").
    phonetic_system : str | None
        Override the auto-detected phonetic annotation system.  One of
        "pinyin", "zhuyin", "jyutping", or None (auto-detect).

    Keys
    ----
    romanize_func : callable | None
        (str) -> str romanization function, or None if unavailable.
    annotation_func : callable | None
        Character/token-aligned annotation span producer.
    annotation_system_name : str
        Human-readable name for the annotation system ("Pinyin", "Zhuyin",
        "Furigana", "Jyutping", etc.).  Drives dynamic UI labels.
    resolve_spans_func : callable | None
        Japanese-only: shared resolve_spans from the pipeline.
    spans_to_romaji_func : callable | None
        Japanese-only: shared spans-to-romaji converter.
    has_phonetic_layer : bool
        True when a romanize_func is available.
    romanization_name : str
        Human-readable name shown in the UI (e.g. "Pinyin", "N/A").
    romanization_confidence : str
        One of: very_high / high / good / moderate / low / none.
    default_font : str
        Sensible default font for the script (entry from FONT_LIST).
    rtl : bool
        True for right-to-left scripts.
    chinese_variant : str | None
        One of "zh-Hans", "zh-Hant", "yue", or None for non-Chinese.
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]

    # Thai default phonetic system is Paiboon+ (tone diacritics for learners).
    if primary == 'th' and not phonetic_system:
        phonetic_system = 'paiboon'

    rom_name, confidence = _ROMANIZATION_META.get(primary, ("N/A", "none"))

    # Override romanization name/confidence for Thai based on phonetic system.
    _THAI_PHONETIC_META = {
        'rtgs': ('RTGS (no tones)', 'good'),
        'paiboon': ('Paiboon+ (with tones)', 'good'),
        'ipa': ('IPA', 'good'),
    }
    if primary == 'th' and phonetic_system in _THAI_PHONETIC_META:
        rom_name, confidence = _THAI_PHONETIC_META[phonetic_system]

    # For Japanese: create one shared pipeline — single MeCab tagger instance
    # serves both the annotation (resolve_spans) and romaji (spans_to_romaji)
    # consumers.  For all other languages: independent functions, no pipeline.
    resolve_spans_func = None
    spans_to_romaji_func = None

    if primary == "ja":
        resolve_spans, spans_to_romaji = get_japanese_pipeline()
        resolve_spans_func = resolve_spans
        spans_to_romaji_func = spans_to_romaji
        annotation_func = resolve_spans

        # Standalone romanizer wrapper — uses default macrons mode.
        # Optimized call sites (processing.py) should use resolve_spans_func +
        # spans_to_romaji_func directly to pass the user's long_vowel_mode.
        def _ja_romanize(text: str) -> str:
            if not text:
                return ''
            return spans_to_romaji(resolve_spans(text))
        romanizer = _ja_romanize
    else:
        romanizer = get_romanizer(lang_code, phonetic_system=phonetic_system)
        annotation_func = get_annotation_func(lang_code, system=phonetic_system)

    ann_sys_name = _annotation_system_name(lang_code, phonetic_system)
    variant = _chinese_variant(lang_code)

    # CJK scripts support \pos() ASS annotation (character-width math is reliable).
    # Alphabetic scripts (Korean, Cyrillic, Thai) use PGS-only annotation.
    _CJK_ANN_LANGS = frozenset({"ja", "zh", "yue"})
    supports_ass = primary in _CJK_ANN_LANGS

    # CJK scripts get larger annotation ratio (0.5); alphabetic scripts get 0.4
    # because romanized words are often longer than their originals.
    ann_font_ratio = 0.5 if primary in _CJK_ANN_LANGS else 0.4

    # Annotation default: off for Cantonese (block romanization sufficient)
    # and Thai (every word would be annotated, replicating the romaji line
    # with more visual noise — block romanization line is sufficient).
    _ANN_DEFAULT_OFF = frozenset({'yue', 'th'})
    ann_default_enabled = primary not in _ANN_DEFAULT_OFF

    # Word boundary function: Thai only (no natural word spaces in Thai script).
    # Inserts U+2009 THIN SPACE between tokens for learner readability.
    word_boundary_func = _apply_thai_word_boundaries if primary == 'th' else None

    return {
        "romanize_func":            romanizer,
        "annotation_func":          annotation_func,
        "annotation_system_name":   ann_sys_name,
        "annotation_render_mode":   "ruby",
        "annotation_font_ratio":    ann_font_ratio,
        "supports_ass_annotation":  supports_ass,
        "annotation_default_enabled": ann_default_enabled,
        "word_boundary_func":       word_boundary_func,
        "resolve_spans_func":       resolve_spans_func,
        "spans_to_romaji_func":     spans_to_romaji_func,
        "has_phonetic_layer":       romanizer is not None,
        "romanization_name":        rom_name,
        "romanization_confidence":  confidence,
        "default_font":             _font_for_script(lang_code),
        "rtl":                      primary in _RTL_CODES,
        "chinese_variant":          variant,
    }
