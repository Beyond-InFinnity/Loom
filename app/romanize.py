# app/romanize.py
"""
Romanization factory for SRTStitcher.

Public API
----------
get_romanizer(lang_code) -> callable | None
    Returns a (str) -> str function that converts subtitle text to a phonetic
    Roman-script representation, or None if romanization is not available for
    the given language.

get_hiragana(lang_code, text) -> str
    Debug/probe helper: returns hiragana readings for Japanese text, empty
    string for other languages.  Creates its own pykakasi instance — fine for
    the debug probe but should share the romanizer closure's instance if ever
    called on the hot path.

detect_preexisting_furigana(source) -> (bool, str)
    Heuristic scan of a pysubs2 SSAFile (or path string) for inline furigana
    annotations already present in the subtitle track.

Implementation status
---------------------
Chunk R1 — scaffold only.  All codes return None.
Chunk R2 — Chinese (pypinyin, tone-marked pinyin) ✅
Chunk R3 — Japanese (pykakasi, token-aligned Hepburn romaji) ✅
Chunk R4 — Korean (korean-romanizer), Russian/Cyrillic (cyrtranslit), Thai (pythainlp)
Chunk R5 — Indic scripts (indic-transliteration), Arabic/Persian/Urdu (experimental)

Character-aligned \pos() generation (R2b)
-----------------------------------------
The current romanizer returns a flat space-joined string, which maps directly
to the existing single-event Romanized layer in processing.py and the preview.
True per-character \pos() positioning (one pinyin syllable hovering above each
hanzi) requires processing.py to emit N ASS events per source line with
calculated X offsets, and preview.py to render per-span HTML.  That scope
belongs in a dedicated R2b pass once basic pinyin display is confirmed working.

Furigana data path (R3b)
------------------------
_make_japanese_romanizer() emits flat Hepburn romaji (item["hepburn"]).
Each pykakasi token also carries item["hira"] — the hiragana reading — which
is the raw material for a future character-aligned furigana layer (R3b).
get_hiragana() exposes this data path for inspection in the debug probe.
"""

import re

# Matches ASS override tag blocks: {...}
# Stripped before romanization so tags don't pollute the phonetic output.
_ASS_TAG_RE = re.compile(r'\{[^}]*\}')

# Kana-only pattern used by detect_preexisting_furigana.
# Matches strings composed entirely of hiragana, katakana, prolonged sound
# mark, and common kana punctuation — i.e. phonetic-only text with no kanji.
_KANA_ONLY_RE = re.compile(r'^[\u3040-\u30ff\u30fc\uff65\uff9e\uff9f\s]+$')

# ASS \pos() tag pattern — used to identify absolutely-positioned events.
_POS_TAG_RE = re.compile(r'\\pos\(')


def _strip_ass(text: str) -> str:
    """Remove ASS override tags and line-break markers from *text*."""
    clean = _ASS_TAG_RE.sub('', text)
    # \N = hard line break, \n = soft line break in ASS
    clean = clean.replace(r'\N', ' ').replace(r'\n', ' ')
    return clean


def _make_pinyin_romanizer():
    """Return a Chinese pinyin romanizer built on pypinyin.

    Imported lazily so users who never select a Chinese track are not affected
    by a missing pypinyin installation.

    Behaviour
    ---------
    * ASS override tags and line-break markers are stripped before processing.
    * pypinyin.pinyin() is called with Style.TONE (tone marks, e.g. "nǐ hǎo")
      and errors='default', which passes non-CJK characters (punctuation,
      numerals, Latin letters) through unchanged rather than crashing or
      silently dropping them.
    * The list-of-lists result is flattened and joined with spaces.
    * Empty input returns an empty string.

    This produces output like:
        "你好，世界"  →  "nǐ hǎo ， shì jiè"
        "（艾連）那天"  →  "（ ài lián ） nà tiān"
    """
    from pypinyin import pinyin as _pinyin, Style  # lazy import

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        syllables = [item[0] for item in _pinyin(clean, style=Style.TONE, errors='default')]
        return ' '.join(syllables)

    return romanize


def _make_japanese_romanizer():
    """Return a Japanese Hepburn romaji romanizer built on pykakasi.

    Imported lazily so users who never select a Japanese track are not affected
    by a missing pykakasi installation.

    Behaviour
    ---------
    * ASS override tags and line-break markers are stripped before processing.
    * pykakasi.kakasi().convert() tokenises the text into morpheme-level tokens.
      Each token is a dict with keys: 'orig', 'hira', 'hepburn', 'passport',
      'kunrei'.
    * 'hepburn' is preferred; 'orig' is the fallback for tokens pykakasi cannot
      romanize (e.g. punctuation, numerals, Latin passthrough).
    * Tokens are joined with spaces, producing output like:
          "今日は"  →  "kyou ha"
          "アニメ"  →  "anime"
          "Attack on Titan"  →  "Attack on Titan"
    * Furigana data path (R3b): item["hira"] contains the hiragana reading for
      each token — this is the raw material for a character-aligned furigana
      layer.  Not used here; see get_hiragana() for the debug-probe accessor.
    * Empty input returns an empty string.

    Note: pykakasi tokenises at the word/morpheme level, not per-character.
    One romaji token may correspond to several kanji.  Per-character \pos()
    alignment is deferred to R3b.
    """
    import pykakasi  # lazy import

    kks = pykakasi.kakasi()  # single instance captured by the closure

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        tokens = kks.convert(clean)
        # item["hepburn"] is the Hepburn romanization; fall back to orig
        # for punctuation/numerals/Latin passthrough that pykakasi returns as-is.
        parts = [item.get('hepburn') or item.get('orig', '') for item in tokens]
        return ' '.join(p for p in parts if p)

    return romanize


def get_hiragana(lang_code: str, text: str) -> str:
    """Return space-joined hiragana readings for *text* if *lang_code* is Japanese.

    This is a debug/probe helper that exposes the furigana data path
    (item["hira"] from pykakasi tokens) without touching the Romanized layer.

    NOTE: This function creates its own pykakasi instance on every call.
    That is acceptable for the debug probe (called once per UI rerun on a
    single line of text), but it must NOT be used in the hot path
    (e.g. inside generate_ass_file()).  If furigana generation ever moves into
    the hot path, share the single kakasi instance from _make_japanese_romanizer().

    Returns an empty string for non-Japanese lang_codes or empty text.
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary != "ja" or not text:
        return ''
    import pykakasi  # lazy import
    kks = pykakasi.kakasi()
    tokens = kks.convert(_strip_ass(text))
    parts = [item.get('hira') or item.get('orig', '') for item in tokens]
    return ' '.join(p for p in parts if p)


def detect_preexisting_furigana(source) -> tuple:
    """Heuristic: detect whether *source* already contains inline furigana.

    Parameters
    ----------
    source : str | pysubs2.SSAFile
        Either an absolute path to a subtitle file (.ass/.srt/…) or an already-
        loaded pysubs2 SSAFile object.

    Returns
    -------
    (found: bool, detail: str)
        found  — True if inline furigana annotations were detected.
        detail — Human-readable description of what was found, or "none" if not.

    Detection heuristic
    -------------------
    Scans up to the first 50 dialogue events.  For each event that contains a
    \\pos() tag, we check whether the stripped text is kana-only.  If two or
    more such events share a timestamp with a non-kana event at the same start
    time, the track almost certainly uses pre-positioned furigana in the ASS
    fansub style.

    This heuristic has false-positive rate near zero on real subtitle tracks
    because: (a) \\pos() is rare outside fansub effect layers, and (b) kana-only
    \\pos()-tagged events co-occurring with kanji events at the same timestamp is
    a very specific signature.  False negatives are possible for unusually
    formatted tracks.
    """
    import pysubs2

    if isinstance(source, str):
        try:
            subs = pysubs2.load(source)
        except Exception:
            return (False, "could not load file")
    else:
        subs = source

    events = [e for e in subs if e.type == 'Dialogue'][:50]

    # Build a map: start_time -> list of stripped texts
    from collections import defaultdict
    by_start: dict = defaultdict(list)
    pos_kana_starts = set()

    for event in events:
        stripped = _strip_ass(event.text).strip()
        by_start[event.start].append(stripped)
        if _POS_TAG_RE.search(event.text) and _KANA_ONLY_RE.match(stripped):
            pos_kana_starts.add(event.start)

    # Check if any \pos()+kana-only event shares a timestamp with a non-kana event
    for start in pos_kana_starts:
        siblings = by_start[start]
        has_non_kana = any(not _KANA_ONLY_RE.match(s) for s in siblings if s)
        if has_non_kana:
            return (True, f"\\pos()+kana furigana pattern detected at {len(pos_kana_starts)} timestamp(s)")

    return (False, "none")


def get_romanizer(lang_code: str):
    """Return a romanization callable for *lang_code*, or None.

    The returned callable has the signature::

        romanize(text: str) -> str

    It accepts a raw subtitle line (may contain ASS override tags) and returns
    a plain-text phonetic string suitable for display as the Romanized layer.

    Returns None for:
    - Roman-script languages that need no phonetic annotation (en, de, fr, …)
    - Languages whose romanization library has not yet been wired in
    - Unknown or empty language codes

    Args:
        lang_code: BCP 47 language tag, e.g. ``"ja"``, ``"zh-cn"``, ``"ko"``.
                   Unknown codes are handled gracefully — no exception is raised.
    """
    # Normalise: lower-case, extract primary subtag
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]

    # Chunk R2 — Chinese pinyin (pypinyin) ─────────────────────────── ✅
    if primary == "zh":
        return _make_pinyin_romanizer()

    # Chunk R3 — Japanese Hepburn romaji (pykakasi) ───────────────── ✅
    if primary == "ja":
        return _make_japanese_romanizer()

    # Chunk R4 — Korean, Russian/Cyrillic, Thai ───────────────────── TODO
    # Chunk R5 — Indic scripts, Arabic/Persian/Urdu ───────────────── TODO

    return None
