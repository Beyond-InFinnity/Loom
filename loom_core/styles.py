# app/styles.py
from .romanize import get_romanizer, get_annotation_func, get_japanese_pipeline, _apply_thai_word_boundaries

FONT_LIST = [
    # Latin + Cyrillic (broad script coverage)
    "Noto Sans", "Georgia", "Times New Roman", "Verdana",
    "Arial", "Arial Black",
    # CJK
    "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR",
    "Noto Sans CJK TC", "Noto Sans CJK HK",
    # Non-CJK scripts
    "Noto Sans Thai",
    "Noto Naskh Arabic", "Amiri",
    "Noto Sans Hebrew",
    "Noto Nastaliq Urdu",
    "Noto Sans Devanagari", "Noto Sans Bengali",
    "Noto Sans Tamil", "Noto Sans Telugu",
    "Noto Sans Gujarati", "Noto Sans Gurmukhi",
    "Be Vietnam Pro",
]

# Fonts with confirmed CJK (kanji/kana/hanzi) glyph coverage.
# Used for the Annotation style picker — a font without CJK coverage will
# render furigana/pinyin as boxes.  Must be a subset of FONT_LIST so that the
# ASS renderer can find the font by name.
CJK_FONT_LIST = [
    "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR",
    "Noto Sans CJK TC", "Noto Sans CJK HK",
]

# ISO 639-2 (3-letter) and common alias codes → canonical BCP-47.
# MKV/ffprobe metadata typically uses 3-letter codes; we only key romanization
# + annotation off 2-letter primaries, so anything not in this map silently
# falls off the pipeline. Be liberal here.
_ISO639_ALIAS = {
    # CJK — note chs/cht preserve script variant
    "jpn": "ja", "jp": "ja",
    "kor": "ko", "kr": "ko",
    "zho": "zh", "chi": "zh", "cmn": "zh",
    "chs": "zh-Hans", "cht": "zh-Hant",
    # Cantonese stays as-is (yue is already BCP-47)
    # Cyrillic
    "rus": "ru",
    "ukr": "uk", "ua": "uk",
    "bel": "be", "by": "be",
    "srp": "sr", "bul": "bg", "mkd": "mk", "mon": "mn",
    # Thai
    "tha": "th",
    # Indic (R5 — not implemented yet, but normalize for forward-compat)
    "hin": "hi", "ben": "bn", "tam": "ta", "tel": "te",
    "guj": "gu", "pan": "pa",
    # RTL / experimental
    "ara": "ar", "fas": "fa", "per": "fa", "urd": "ur",
    "heb": "he", "yid": "yi",
    # Vietnamese (Latin, so no romanization, but the font default matters)
    "vie": "vi",
}

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
    "he": ("Hebrew transliteration",        "moderate"),
    "ar": ("Arabic transliteration",        "moderate"),
    "fa": ("Romanization (experimental)",   "low"),
    "ur": ("Romanization (experimental)",   "low"),
}

# Right-to-left primary subtags
_RTL_CODES = frozenset({"ar", "fa", "ur", "he", "yi"})

# Per-script default fonts (must be entries in FONT_LIST).
# Covers every language with a romanization implementation plus the R5
# pending ones so the font routing is correct the day the pipelines land.
_SCRIPT_FONTS = {
    # CJK
    "ja": "Noto Sans CJK JP",
    "ko": "Noto Sans CJK KR",
    # Cyrillic — Noto Sans has full Cyrillic coverage and pairs well with
    # Latin tracks, avoiding a jarring style shift between Bottom/Top.
    "ru": "Noto Sans", "uk": "Noto Sans", "be": "Noto Sans",
    "sr": "Noto Sans", "bg": "Noto Sans", "mk": "Noto Sans",
    "mn": "Noto Sans",
    # Thai
    "th": "Noto Sans Thai",
    # Indic (R5 — not implemented yet)
    "hi": "Noto Sans Devanagari",
    "bn": "Noto Sans Bengali",
    "ta": "Noto Sans Tamil",
    "te": "Noto Sans Telugu",
    "gu": "Noto Sans Gujarati",
    "pa": "Noto Sans Gurmukhi",
    # RTL / experimental
    "ar": "Noto Naskh Arabic",
    "fa": "Noto Naskh Arabic",
    "ur": "Noto Nastaliq Urdu",
    "he": "Noto Sans Hebrew",
    "yi": "Noto Sans Hebrew",
    # Vietnamese uses Latin w/ diacritics — Be Vietnam Pro is purpose-built.
    "vi": "Be Vietnam Pro",
}

# Fallback for Latin-script and unknown languages. Noto Sans renders Latin +
# Cyrillic + Greek + Vietnamese diacritics cleanly — it's our universal
# safe default. Arial is intentionally never returned as a default.
_DEFAULT_FONT = "Noto Sans"


def _normalize_lang_code(lang_code):
    """Normalize ISO 639-2/3 aliases to canonical BCP-47.

    MKV/ffprobe metadata and older subtitle tooling commonly emit 3-letter
    codes (``"jpn"``, ``"tha"``, ``"chi"``) that ``get_lang_config`` and
    friends don't recognize — the primary-subtag extraction keys on
    2-letter BCP-47 codes. Normalizing here is the single fix that makes
    every downstream helper agree.

    Returns the input unchanged when no alias applies (including for
    already-canonical codes like ``"ja"`` or ``"zh-Hans"``).
    """
    if not lang_code:
        return lang_code
    lc = lang_code.lower()
    mapped = _ISO639_ALIAS.get(lc)
    if mapped is not None:
        return mapped
    # Hyphenated compounds (``jpn-JP``, ``chi-hant``) — normalize the primary
    # subtag and preserve the rest.
    if "-" in lc or "_" in lc:
        sep = "-" if "-" in lc else "_"
        head, _, tail = lc.partition(sep)
        head_map = _ISO639_ALIAS.get(head)
        if head_map is not None:
            # If the mapped primary already carries script info (e.g. "zh-Hans"),
            # trust it and drop the tail to avoid "zh-Hans-hant".
            if "-" in head_map:
                return head_map
            return f"{head_map}-{tail}"
    return lang_code


def _font_for_script(lang_code: str) -> str:
    """Return the best default font for *lang_code* from FONT_LIST.

    Never returns ``"Arial"`` — the goal is a default that renders the
    target script correctly and looks intentional. Users who want Arial
    can pick it explicitly from FONT_LIST.
    """
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
    return _DEFAULT_FONT


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
    if primary in ("hi", "bn", "ta", "te", "gu", "pa"):
        return "Transliteration"
    if primary == "he":
        return "Transliteration"
    if primary == "ar":
        return "Transliteration"
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
    # Normalize ISO 639-2 aliases (jpn/kor/tha/chi/cht/...) to BCP-47 once.
    # Downstream helpers (annotation_system_name, chinese_variant,
    # font_for_script) all key on the primary 2-letter subtag.
    lang_code = _normalize_lang_code(lang_code)
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

    # Override romanization name/confidence for Arabic based on phonetic system.
    _ARABIC_PHONETIC_META = {
        'learner': ('Arabic (learner hybrid)', 'moderate'),
        'din':     ('DIN 31635',               'moderate'),
        'loose':   ('Loose phonetic',          'low'),
    }
    if primary == 'ar' and phonetic_system in _ARABIC_PHONETIC_META:
        rom_name, confidence = _ARABIC_PHONETIC_META[phonetic_system]

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

    # Annotation default: off for Thai (every word would be annotated,
    # replicating the romaji line with more visual noise — block romanization
    # line is sufficient).  Cantonese per-character Jyutping is on by default
    # (valuable for learners, unlike Thai where romanization line suffices).
    _ANN_DEFAULT_OFF = frozenset({'th'})
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
