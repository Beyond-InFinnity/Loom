# app/language.py
import unicodedata
import pysubs2
import langcodes
from langdetect import detect, DetectorFactory
from langdetect.lang_detect_exception import LangDetectException

# Make langdetect deterministic across runs
DetectorFactory.seed = 0

# Cantonese-specific characters that do not appear in standard Mandarin text.
# Presence of 2+ distinct markers in a text sample strongly indicates Cantonese.
_CANTONESE_MARKERS = frozenset('係喺囉咁嘅咗啩咋喎')


def _detect_cantonese(text_sample: str) -> bool:
    """Return True if *text_sample* contains 2+ distinct Cantonese-specific markers."""
    found = {c for c in text_sample if c in _CANTONESE_MARKERS}
    return len(found) >= 2


def _dominant_script(text):
    """
    Analyze Unicode script blocks to determine the dominant writing system.
    Returns one of: 'CJK', 'Hangul', 'Hiragana_Katakana', 'Latin', or None
    if no single script dominates.

    This is used as a pre-check before statistical language detection,
    because langdetect is unreliable at distinguishing CJK scripts
    (it frequently misidentifies Traditional Chinese as Korean).
    """
    counts = {"CJK": 0, "Hangul": 0, "Kana": 0, "Latin": 0, "Other": 0}

    for char in text:
        if char.isspace():
            continue
        name = unicodedata.name(char, "")
        if "CJK" in name or "KANGXI" in name:
            counts["CJK"] += 1
        elif "HANGUL" in name:
            counts["Hangul"] += 1
        elif "HIRAGANA" in name or "KATAKANA" in name:
            counts["Kana"] += 1
        elif "LATIN" in name:
            counts["Latin"] += 1
        else:
            counts["Other"] += 1

    total = sum(counts.values())
    if total == 0:
        return None

    # Find the dominant script (>40% of non-space characters)
    for script, count in counts.items():
        if count / total > 0.4:
            if script == "Kana":
                return "Hiragana_Katakana"
            if script == "Other":
                return None
            return script

    return None


def _refine_cjk_detection(raw_code, text, metadata_lang=None, track_title=None):
    """
    When the dominant script is CJK ideographs, langdetect's result is
    unreliable — it can't distinguish Chinese from Korean using Han
    characters alone.

    Strategy:
    - Count Kana and Hangul as a proportion of non-Latin, non-space characters.
    - If either exceeds a significance threshold (5%), classify accordingly.
      A lower proportion indicates incidental usage — e.g., katakana names in
      Chinese anime subs, or English loanwords left untranslated in Mandarin.
    - If the text is purely CJK ideographs, it's Chinese. Use MKV metadata to
      disambiguate the variant (Traditional vs Simplified, Mandarin vs Cantonese)
      since this is impossible from text content alone.
    - Track title containing "canto"/"cantonese" is treated as a Cantonese signal.
    - For Traditional Chinese results, run Cantonese discriminator on text content.
    """
    # Count script proportions among non-Latin, non-space characters.
    # Latin characters are excluded because many CJK subtitle tracks contain
    # untranslated English loanwords, names, or technical terms — these
    # shouldn't dilute the ratio between CJK/Kana/Hangul.
    kana_count = 0
    hangul_count = 0
    non_latin_total = 0

    for char in text:
        if char.isspace():
            continue
        name = unicodedata.name(char, "")
        if "LATIN" in name:
            continue
        non_latin_total += 1
        if "HIRAGANA" in name or "KATAKANA" in name:
            kana_count += 1
        elif "HANGUL" in name:
            hangul_count += 1

    # Significance threshold: the secondary script must represent >5% of
    # non-Latin characters to be considered the actual language, not just
    # incidental loanwords or character names.
    SIGNIFICANCE_THRESHOLD = 0.05
    kana_ratio = kana_count / non_latin_total if non_latin_total else 0
    hangul_ratio = hangul_count / non_latin_total if non_latin_total else 0

    if kana_ratio > SIGNIFICANCE_THRESHOLD:
        return "ja"
    if hangul_ratio > SIGNIFICANCE_THRESHOLD:
        return "ko"

    # Pure CJK ideographs — this is Chinese, not Korean.

    # Track title check: "CantoCaptions", "Cantonese", etc. → definitive Cantonese.
    # "CHT" / "Traditional" / "Taiwan" → Traditional Mandarin.
    # "CHS" / "Simplified" → Simplified Mandarin.
    if track_title:
        title_lower = track_title.lower()
        if "canto" in title_lower:
            return "yue"
        if "cht" in title_lower or "traditional" in title_lower or "taiwan" in title_lower:
            # Run Cantonese discriminator — a track titled "Traditional" with
            # Cantonese vernacular is still Cantonese.
            if _detect_cantonese(text):
                return "yue"
            return "zh-Hant"
        if "chs" in title_lower or "simplified" in title_lower:
            return "zh-Hans"

    # Use metadata to disambiguate variant if available.
    resolved_code = None
    if metadata_lang:
        meta_lower = metadata_lang.lower()
        # Common MKV metadata codes for Chinese variants.
        # Checked longest-key-first so "zh-hans" matches before "zh".
        chinese_meta_map = {
            "zh-hans": "zh-Hans", "zh-hant": "zh-Hant",
            "zh-tw": "zh-Hant", "zh-hk": "zh-HK", "zh-cn": "zh-Hans",
            "yue": "yue",  # Cantonese
            "cmn": "zh",   # Mandarin
            "chs": "zh-Hans", "cht": "zh-Hant",
            "zho": "zh", "chi": "zh", "zh": "zh",
        }
        # Exact match first, then prefix match (longest key first).
        if meta_lower in chinese_meta_map:
            resolved_code = chinese_meta_map[meta_lower]
        else:
            for key, code in sorted(chinese_meta_map.items(), key=lambda x: -len(x[0])):
                if meta_lower.startswith(key):
                    resolved_code = code
                    break

    if resolved_code is None:
        # No useful metadata. Check if langdetect at least got Chinese.
        if raw_code and raw_code.startswith("zh"):
            resolved_code = raw_code
        else:
            # langdetect got it wrong (e.g., said 'ko' for Chinese text).
            # Default to zh-Hant since Traditional Chinese is more common in
            # subtitle files that lack metadata (fansubs, anime, etc.)
            resolved_code = "zh-Hant"

    # Direct Cantonese metadata → return immediately, no discriminator needed.
    if resolved_code == "yue":
        return "yue"

    # Simplified Chinese → no Cantonese ambiguity, return directly.
    if resolved_code in ("zh-Hans", "zh-CN", "zh"):
        # "zh" without further qualification defaults to Simplified
        if resolved_code == "zh":
            return "zh-Hans"
        return resolved_code

    # Traditional Chinese variants (zh-Hant, zh-TW, zh-HK) — run Cantonese
    # discriminator on text content.  zh-HK is especially likely to be Cantonese.
    if _detect_cantonese(text):
        return "yue"

    return resolved_code


def _sample_text(subs, sample_size):
    """Extract a text sample from the middle of a subtitle file."""
    if not subs:
        return None

    total_lines = len(subs)
    mid_point = total_lines // 2
    start_index = max(0, mid_point - (sample_size // 2))
    end_index = min(total_lines, start_index + sample_size)

    if start_index >= end_index:
        return None

    text_sample = " ".join(
        line.text.replace("\\N", " ") for line in subs[start_index:end_index]
    )

    return text_sample if text_sample.strip() else None


def detect_language(file_path, sample_size=50, metadata_lang=None, track_title=None):
    """
    Detects language from a subtitle file on disk. Uses a two-stage approach:
    1. Unicode script analysis to identify the writing system
    2. langdetect for statistical detection within that script family

    For CJK text, script analysis overrides langdetect when it misidentifies
    the language (e.g., calling Traditional Chinese "Korean"). MKV metadata
    is used as a disambiguation hint for Chinese variants, not as the primary
    detection source.

    Args:
        file_path: Absolute path to a subtitle file (.srt, .ass, etc.).
        sample_size: Number of subtitle lines to sample for detection.
        metadata_lang: Optional MKV metadata language tag (e.g., 'chi', 'zh-TW').
                       Used as a hint for variant disambiguation, not trusted blindly.
        track_title: Optional MKV track title string (e.g., 'CantoCaptions').
                     Used to detect Cantonese tracks by title convention.

    Returns:
        A language code string (e.g., 'en', 'ja', 'zh-Hant', 'yue') or None.
    """
    if not file_path:
        return None

    try:
        subs = pysubs2.load(file_path)
        text_sample = _sample_text(subs, sample_size)
        if not text_sample:
            return None

        # Stage 1: Script analysis
        script = _dominant_script(text_sample)

        # Stage 2: Statistical detection
        raw_code = detect(text_sample)

        # Stage 3: Reconcile script analysis with langdetect
        if script == "CJK":
            return _refine_cjk_detection(raw_code, text_sample, metadata_lang, track_title)

        if script == "Hiragana_Katakana":
            return "ja"

        if script == "Hangul":
            return "ko"

        # For Latin and other scripts, langdetect is generally reliable
        return raw_code

    except (LangDetectException, IndexError, Exception) as e:
        print(f"Language detection failed for {file_path}: {e}")
        return None


def code_to_name(code):
    """
    Convert a language code to a full English display name.
    Handles standard ISO 639 codes, BCP 47 tags, and Chinese variants:
      'en' -> 'English'
      'ja' -> 'Japanese'
      'zh-Hant' -> 'Chinese (Traditional)'
      'zh-TW' -> 'Chinese (Taiwan)'
      'zh-HK' -> 'Chinese (Hong Kong)'
      'yue' -> 'Cantonese'

    Returns the original code if resolution fails.
    """
    if not code:
        return "Unknown"
    try:
        return langcodes.Language.get(code).display_name()
    except Exception:
        return code


def detect_language_from_file(file, sample_size=50):
    """
    Detects language from an uploaded Streamlit file object by sampling
    from the middle of the file to avoid credits and branding.

    Args:
        file: The uploaded file object from Streamlit.
        sample_size: The number of subtitle lines to use for detection.

    Returns:
        The detected language code (e.g., 'en', 'zh-Hant') or None.
    """
    if not file:
        return None

    try:
        file.seek(0)
        subs = pysubs2.SSAFile.from_string(file.getvalue().decode("utf-8"))
        text_sample = _sample_text(subs, sample_size)
        if not text_sample:
            return None

        script = _dominant_script(text_sample)
        raw_code = detect(text_sample)

        if script == "CJK":
            return _refine_cjk_detection(raw_code, text_sample)
        if script == "Hiragana_Katakana":
            return "ja"
        if script == "Hangul":
            return "ko"

        return raw_code

    except (LangDetectException, IndexError, Exception) as e:
        print(f"Language detection failed: {e}")
        return None
