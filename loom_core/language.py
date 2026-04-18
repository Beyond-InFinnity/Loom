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


def _has_cyrillic(text: str) -> bool:
    """Return True if *text* contains any Cyrillic characters."""
    return any('CYRILLIC' in unicodedata.name(c, '') for c in text if not c.isspace())


# Characters unique to specific Cyrillic-script languages.
# Used for pre-detection override before langdetect runs.
_UKRAINIAN_UNIQUE = frozenset('іІїЇєЄґҐ')   # і/ї/є/ґ — not in Russian
_BELARUSIAN_UNIQUE = frozenset('ўЎ')          # ў — not in Russian or Ukrainian


def _detect_by_script_chars(text: str) -> str | None:
    """Pre-detection override for Cyrillic script variants.

    Checks for characters unique to specific languages before falling back
    to statistical detection.  This is necessary because langdetect is
    unreliable at distinguishing Russian, Ukrainian, and Belarusian — they
    share most of the Cyrillic alphabet.

    Returns a BCP-47 code or None if no unique characters are found.
    """
    has_uk = any(c in _UKRAINIAN_UNIQUE for c in text)
    has_be = any(c in _BELARUSIAN_UNIQUE for c in text)

    # ў is exclusive to Belarusian among Slavic languages
    if has_be:
        return 'be'
    # і/ї/є/ґ are exclusive to Ukrainian (not in Russian)
    if has_uk:
        return 'uk'

    return None


def _normalize_metadata_lang(metadata_lang: str) -> str | None:
    """Resolve an MKV/ffprobe metadata language tag to a BCP-47 code.

    Returns a normalized code (e.g. ``'es'`` for ``'spa'``,
    ``'fr'`` for ``'fre'``/``'fra'``) or ``None`` if the tag can't be
    resolved to a well-known language.

    Uses ``langcodes`` for resolution — handles ISO 639-1/2/3 codes,
    BCP-47 tags, and common aliases.  Rejects tags that resolve to
    ``'und'`` (undetermined), unknown codes, or tags whose resolved
    language string is ≥3 chars with no 2-letter equivalent (obscure
    ISO 639-3 codes like ``'cas'`` = Tsimané that are unlikely in
    real MKV metadata).
    """
    if not metadata_lang:
        return None
    try:
        lang = langcodes.Language.get(metadata_lang)
        # Reject if langcodes couldn't parse it into a real language
        if not lang.language:
            return None
        tag = lang.to_tag()
        # Reject 'und' (undetermined) and codes that didn't simplify
        # to a well-known tag (e.g. 'cas'→'cas', 'xxx'→'xxx').
        # MKV/ffprobe metadata uses ISO 639-2 (3-letter) codes which
        # langcodes always resolves to 2-letter BCP-47 for major
        # languages.  If the tag stayed 3+ chars with no subtag
        # separator, it's likely an obscure ISO 639-3 code.
        if tag in ('und', 'mis', 'mul', 'zxx'):
            return None
        if len(tag) >= 3 and '-' not in tag:
            return None
        return tag
    except Exception:
        return None


def _dominant_script(text):
    """
    Analyze Unicode script blocks to determine the dominant writing system.
    Returns one of: 'CJK', 'Hangul', 'Hiragana_Katakana', 'Cyrillic',
    'Thai', 'Latin', or None if no single script dominates.

    This is used as a pre-check before statistical language detection,
    because langdetect is unreliable at distinguishing CJK scripts
    (it frequently misidentifies Traditional Chinese as Korean) and
    Cyrillic scripts (it confuses Russian, Ukrainian, Belarusian).
    """
    counts = {"CJK": 0, "Hangul": 0, "Kana": 0, "Cyrillic": 0,
              "Thai": 0, "Latin": 0, "Other": 0}

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
        elif "CYRILLIC" in name:
            counts["Cyrillic"] += 1
        elif "THAI" in name:
            counts["Thai"] += 1
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


def detect_language_from_text(text_sample, metadata_lang=None, track_title=None):
    """Detect language from a pre-built text sample.

    This is the core detection pipeline used by :func:`detect_language` and
    :func:`detect_languages_by_style`.  It runs script analysis followed by
    statistical detection and script-specific reconciliation.

    Parameters
    ----------
    text_sample : str
        Concatenated subtitle text to analyze.
    metadata_lang : str | None
        Optional MKV metadata language tag hint.
    track_title : str | None
        Optional MKV track title string hint.

    Returns
    -------
    str | None
        A BCP-47 language code, or ``None`` on failure.
    """
    if not text_sample or not text_sample.strip():
        return None

    try:
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

        if script == "Cyrillic":
            char_override = _detect_by_script_chars(text_sample)
            if char_override:
                return char_override
            if raw_code in ('ru', 'sr', 'bg', 'mk', 'uk', 'be', 'mn'):
                return raw_code
            return 'ru'

        if script == "Thai":
            return "th"

        if metadata_lang:
            meta_code = _normalize_metadata_lang(metadata_lang)
            if meta_code and meta_code != raw_code:
                return meta_code

        return raw_code

    except (LangDetectException, IndexError, Exception):
        return None


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

        return detect_language_from_text(text_sample, metadata_lang, track_title)

    except (LangDetectException, IndexError, Exception) as e:
        print(f"Language detection failed for {file_path}: {e}")
        return None


# Matches ASS drawing mode commands (\p1, \p2, etc.) — local to this module
# to avoid importing from sub_utils.
_LANG_DRAWING_RE = __import__('re').compile(r'\\p[1-9]')


def detect_languages_by_style(file_path, style_mapping=None, sample_size=50):
    """Detect language separately per style group in an ASS/SSA file.

    Groups dialogue events by their ``Style`` field, then runs the full
    detection pipeline on each group independently.  This prevents a
    majority language from drowning out a minority language when styles
    encode separate language tracks (e.g. ``Dial_JP`` + ``Dial_CH``).

    Parameters
    ----------
    file_path : str
        Path to an ``.ass`` / ``.ssa`` file.
    style_mapping : dict | None
        ``{style_name: role}`` from the style mapper.  Styles whose role is
        ``"exclude"`` are skipped.  ``None`` means all styles are analyzed.
    sample_size : int
        Maximum events to sample per style (middle-of-track strategy).

    Returns
    -------
    dict[str, str | None]
        ``{style_name: lang_code}`` for each analyzed style.
    """
    try:
        subs = pysubs2.load(file_path)
    except Exception:
        return {}

    # Group non-comment, non-drawing events by style
    style_events = {}
    for ev in subs.events:
        if ev.is_comment:
            continue
        if _LANG_DRAWING_RE.search(ev.text):
            continue
        if style_mapping and style_mapping.get(ev.style) == "exclude":
            continue
        style_events.setdefault(ev.style, []).append(ev)

    result = {}
    for style_name, events in style_events.items():
        # Sample from the middle (same strategy as _sample_text)
        total = len(events)
        mid = total // 2
        start = max(0, mid - sample_size // 2)
        end = min(total, start + sample_size)
        text_sample = " ".join(
            ev.text.replace("\\N", " ") for ev in events[start:end]
        )
        result[style_name] = detect_language_from_text(text_sample)

    return result


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
