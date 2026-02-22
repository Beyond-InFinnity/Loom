# app/romanize.py
"""
Romanization factory for SRTStitcher.

Public API
----------
get_romanizer(lang_code) -> callable | None
    Returns a (str) -> str function that converts subtitle text to a phonetic
    Roman-script representation, or None if romanization is not available for
    the given language.

get_annotation_func(lang_code) -> callable | None
    Returns a (str) -> list[(str, str|None)] function that produces
    character/token-aligned annotation span data.  Each tuple is
    (original_chars, reading).  reading is non-None only for tokens that
    need annotation (kanji in Japanese, hanzi in Chinese).
    Returns None for languages without character-aligned annotations.

build_annotation_html(spans) -> str
    Converts a spans list from get_annotation_func into <ruby> HTML for the
    composite preview.  Browser-native ruby layout handles centering.

get_hiragana(lang_code, text) -> str
    Debug/probe helper: returns hiragana readings for Japanese text.

detect_preexisting_furigana(source) -> (bool, str)
    Heuristic scan for pre-positioned ASS furigana in a subtitle track.

_extract_inline_furigana(text) -> dict[str, str]
    Extracts author-annotated kanji→hiragana pairs: 奴(やつ) → {"奴": "やつ"}.

Implementation status
---------------------
Chunk R1 — scaffold only.  All codes return None.                            ✅
Chunk R2 — Chinese (pypinyin, tone-marked pinyin)                            ✅
Chunk R3 — Japanese (pykakasi, token-aligned Hepburn romaji)                 ✅
Chunk R3-hotfix — inline furigana stripping (奴(やつ) doubled romanization)  ✅
Chunk R3b — Japanese furigana layer (get_furigana_func, build_furigana_html) ✅
Chunk R3c — resolved-kana romaji pipeline + kana→romaji lookup table         ✅
Chunk R4 — Korean (korean-romanizer), Russian/Cyrillic (cyrtranslit), Thai (pythainlp)
Chunk R5 — Indic scripts (indic-transliteration), Arabic/Persian/Urdu (experimental)

Character-aligned \pos() generation (R2b)
-----------------------------------------
Chinese pinyin: per-character \pos() via _make_annotation_events() in
processing.py.  Japanese furigana: token-aligned \pos() via the same function.
Both use get_annotation_func() → span pairs → _make_annotation_events().

Furigana data path (R3b) — THREE-TIER SOURCING
-----------------------------------------------
Priority order for the hiragana reading of each kanji token:
  1. Author inline annotation — _extract_inline_furigana() extracts kanji(hiragana)
     pairs from the raw source text.  Ground-truth: the author's annotated
     reading is correct for that specific line, especially for unusual readings
     and character names where pykakasi errs most often.
  2. Pre-existing ASS \pos() furigana — detect_preexisting_furigana() detects
     whole-track inline furigana; when found the caller disables the Furigana
     style slot to avoid double annotation (per-event extraction deferred).
  3. pykakasi item["hira"] — generated fallback for unannotated kanji tokens.
"""

import re

# Matches ASS override tag blocks: {...}
# Stripped before romanization so tags don't pollute the phonetic output.
_ASS_TAG_RE = re.compile(r'\{[^}]*\}')

# Matches HTML-style tags: <font ...>, </font>, <b>, </i>, etc.
# Some SRT files (e.g. Three Body Problem Amazon release) wrap every line in
# <font face="Serif" size="18">...</font>.  Without stripping, "font", "Serif",
# "size" get fed to romanizers as text.
_HTML_TAG_RE = re.compile(r'<[^>]+>')

# Kana-only pattern used by detect_preexisting_furigana.
# Matches strings composed entirely of hiragana, katakana, prolonged sound
# mark, and common kana punctuation — i.e. phonetic-only text with no kanji.
_KANA_ONLY_RE = re.compile(r'^[\u3040-\u30ff\u30fc\uff65\uff9e\uff9f\s]+$')

# ASS \pos() tag pattern — used to identify absolutely-positioned events.
_POS_TAG_RE = re.compile(r'\\pos\(')

# Matches speaker label parentheticals in romaji output with surrounding whitespace.
# Captures: optional leading space + paren + optional space + content + optional space
# + paren + optional trailing space.  Both full-width （） and half-width () supported.
# Used to clean up "（ arumin ） sono nichi" → "（Arumin）sono nichi".
_SPEAKER_LABEL_RE = re.compile(r'\s*([（(])\s*(\S+?)\s*([）)])\s*')

# Matches plain-text inline furigana: CJK character(s) immediately followed by
# a hiragana-only reading in parentheses, e.g. 奴(やつ) or 支配（しはい）.
#
# Safety properties that make the false-positive rate effectively zero:
#   • Requires at least one CJK unified ideograph ([\u4e00-\u9fff\u3400-\u4dbf])
#     IMMEDIATELY before the opening paren — no whitespace allowed.  This rules
#     out speaker labels like （アルミン） which are not glued to a kanji.
#   • Requires hiragana-only ([ぁ-ん]+) inside the parens — rules out:
#       - （笑）   laugh marker — kanji, not hiragana
#       - （注）   editorial note — kanji, not hiragana
#       - （アルミン） character name — katakana, not hiragana
#   • Hiragana-only content inside parens that is glued to kanji is a reserved
#     typographic pattern in Japanese; it has no other usage in subtitle text.
#
# Known gap: katakana furigana (重力(グラビティ)) won't match — the pattern
# requires hiragana.  Rare in subtitle content; deferred to R5.
#
# Group 1 = kanji compound, Group 2 = hiragana reading.
INLINE_FURIGANA_RE = re.compile(
    r'([\u4e00-\u9fff\u3400-\u4dbf]+)[（(]([ぁ-ん]+)[）)]'
)


def _strip_inline_furigana(text: str) -> str:
    """Remove plain-text inline furigana annotations, keeping only the kanji.

    Converts ``奴(やつ)らに支配(しはい)された`` →
              ``奴らに支配された``

    This is a required preprocessing step for the Japanese romanizer: without
    it pykakasi romanizes both the kanji *and* the parenthetical hiragana
    reading, producing doubled output (e.g. "yatsu yatsu" instead of "yatsu").

    Only hiragana-inside-parens-glued-to-kanji matches are affected.
    Speaker labels like （アルミン） and laugh markers like （笑） are not touched.
    """
    return INLINE_FURIGANA_RE.sub(r'\1', text)


def _extract_inline_furigana(text: str) -> dict:
    """Extract author-annotated kanji→hiragana reading pairs from *text*.

    Returns a dict mapping each kanji compound to its annotated reading::

        "奴(やつ)らに支配(しはい)されていた"
        → {"奴": "やつ", "支配": "しはい"}

    This is the R3b data source for the furigana layer.  Author-annotated
    readings are the highest-confidence source — the author knew the correct
    reading for that specific line, including unusual and context-dependent
    readings where pykakasi is most likely to err.

    The function is intentionally stateless and cheap (a single regex scan).
    R3b should call it fresh on each source line rather than caching results,
    keeping the romanizer's single responsibility clean.

    Returns an empty dict when no inline annotations are present.
    """
    return dict(INLINE_FURIGANA_RE.findall(text))


def _clean_speaker_labels(romaji: str) -> str:
    """Remove whitespace around speaker label parentheticals and capitalize.

    Romaji assembly joins every token with spaces, which produces
    ``（ arumin ） sono nichi`` for input ``（アルミン）その日``.
    This post-processing step collapses to ``（Arumin）sono nichi``.

    Only runs on romaji output — never on the Japanese text layer.
    """
    def _repl(m):
        open_p, name, close_p = m.group(1), m.group(2), m.group(3)
        return f'{open_p}{name.capitalize()}{close_p}'
    return _SPEAKER_LABEL_RE.sub(_repl, romaji)


# Matches the reverse furigana convention: hiragana followed by (kanji) as a
# meaning-clarification annotation, e.g. とりかご(鳥籠).  The {2,} minimum
# avoids matching single-kanji markers like （注） and （笑）.
REVERSE_FURIGANA_RE = re.compile(
    r'[（(][\u4e00-\u9fff\u3400-\u4dbf]{2,}[）)]'
)


def _strip_reverse_furigana(text: str) -> str:
    """Remove (kanji) meaning-clarification annotations entirely.

    Converts ``とりかご(鳥籠)`` → ``とりかご``

    The reverse convention puts hiragana first and kanji in parens as a
    decorative meaning hint — the opposite of standard inline furigana.
    The parenthetical kanji is redundant in a resolved-kana pipeline and
    should be dropped rather than romanized.
    """
    return REVERSE_FURIGANA_RE.sub('', text)


def _apply_macrons(romaji: str) -> str:
    """Replace doubled-vowel sequences with macron characters.

    Standard modified Hepburn: ou→ō, oo→ō, uu→ū, aa→ā, ii→ī, ee→ē.
    The ei sequence is intentionally NOT collapsed — strict Hepburn treats
    えい as "ei" (e.g. 先生 → sensei, not sensē).
    """
    r = romaji
    r = r.replace('ou', 'ō').replace('oo', 'ō')
    r = r.replace('uu', 'ū')
    r = r.replace('aa', 'ā')
    r = r.replace('ii', 'ī')
    r = r.replace('ee', 'ē')
    return r


def _collapse_long_vowels(romaji: str) -> str:
    """Remove doubled-vowel length — ou→o, oo→o, uu→u, aa→a, ii→i, ee→e."""
    r = romaji
    r = r.replace('ou', 'o').replace('oo', 'o')
    r = r.replace('uu', 'u')
    r = r.replace('aa', 'a')
    r = r.replace('ii', 'i')
    r = r.replace('ee', 'e')
    return r


# ---------------------------------------------------------------------------
# Kana → Romaji lookup table (R3c)
# ---------------------------------------------------------------------------
# Hiragana-only table.  Katakana input is normalized to hiragana before lookup
# (Unicode offset 0x60), except for katakana-only loanword combinations which
# have their own entries.  Digraphs (2-char) must be checked before single
# chars in the greedy scan.

_KANA_TABLE = {
    # --- Digraphs (2-char) — checked first in greedy scan ---
    # K-row
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
    # S-row
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
    # T-row
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
    # N-row
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
    # H-row
    'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    # M-row
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
    # R-row
    'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    # Voiced K (G-row)
    'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    # Voiced S (Z/J-row)
    'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
    # Voiced T (D-row) — rare, same sound as じゃ etc.
    'ぢゃ': 'ja', 'ぢゅ': 'ju', 'ぢょ': 'jo',
    # Voiced H (B-row)
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
    # Semi-voiced H (P-row)
    'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',

    # --- Katakana-only loanword digraphs (not normalized to hiragana) ---
    'ヴァ': 'va', 'ヴィ': 'vi', 'ヴェ': 've', 'ヴォ': 'vo',
    'ファ': 'fa', 'フィ': 'fi', 'フェ': 'fe', 'フォ': 'fo',
    'ティ': 'ti', 'ディ': 'di', 'トゥ': 'tu', 'ドゥ': 'du',
    'ウィ': 'wi', 'ウェ': 'we', 'ウォ': 'wo',
    'ツァ': 'tsa', 'ツィ': 'tsi', 'ツェ': 'tse', 'ツォ': 'tso',
    'シェ': 'she', 'チェ': 'che', 'ジェ': 'je',

    # --- Single hiragana ---
    # Vowels
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    # K-row
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    # S-row
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    # T-row
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    # N-row
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    # H-row
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    # M-row
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    # Y-row
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    # R-row
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    # W-row
    'わ': 'wa', 'ゐ': 'wi', 'ゑ': 'we', 'を': 'wo',
    # Voiced K (G-row)
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    # Voiced S (Z-row)
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    # Voiced T (D-row)
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    # Voiced H (B-row)
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    # Semi-voiced H (P-row)
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    # Small vowels (rare, used in loanword katakana combos)
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
    # Small ya/yu/yo (used in digraphs, but also standalone in some contexts)
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo',

    # --- Katakana singles not covered by normalization ---
    'ヴ': 'vu',
}

# Kana that trigger n' apostrophe disambiguation after ん/ン.
# If ん is followed by a vowel kana or y-kana, an apostrophe separates them
# to prevent ambiguity: しんあい → shin'ai (not shinai).
_N_APOSTROPHE_TRIGGERS = frozenset(
    'あいうえおやゆよアイウエオヤユヨ'
    'ぁぃぅぇぉァィゥェォ'
)


def _normalize_kata_char(ch: str) -> str:
    """Convert a single katakana character to its hiragana equivalent.

    Preserves chōon (ー), katakana-only characters (ヴ), and non-katakana
    characters as-is.  Only standard katakana ァ(U+30A1)–ヶ(U+30F6) are
    converted.
    """
    cp = ord(ch)
    if 0x30A1 <= cp <= 0x30F6:   # Katakana ァ–ヶ
        return chr(cp - 0x60)
    return ch


def _kana_to_romaji(kana_string: str, long_vowel_mode: str = "macrons") -> str:
    """Convert a kana string to romaji using a deterministic lookup table.

    Handles all standard hiragana/katakana, digraphs, gemination (っ/ッ),
    chōon (ー), and moraic nasal disambiguation (ん before vowels → n').

    Parameters
    ----------
    kana_string : str
        Pure kana string (may contain non-kana passthrough chars like
        punctuation, spaces, Latin).
    long_vowel_mode : str
        One of "macrons" (ō, ū, etc.), "doubled" (ou, uu — no change),
        or "unmarked" (o, u — collapsed).
    """
    parts: list[str] = []
    n = len(kana_string)
    i = 0

    while i < n:
        ch = kana_string[i]

        # --- Gemination: っ/ッ doubles the following consonant ---
        if ch in ('っ', 'ッ'):
            # Peek ahead to find the leading consonant of the next kana
            if i + 1 < n:
                # Try 2-char digraph first (e.g. っちゃ → tcha)
                nxt = kana_string[i + 1]
                nxt_h = _normalize_kata_char(nxt)
                rom = None
                if i + 2 < n:
                    pair = _normalize_kata_char(kana_string[i + 1]) + _normalize_kata_char(kana_string[i + 2])
                    # Also check raw katakana pairs for loanword combos
                    raw_pair = kana_string[i + 1:i + 3]
                    rom = _KANA_TABLE.get(pair) or _KANA_TABLE.get(raw_pair)
                if rom is None:
                    rom = _KANA_TABLE.get(nxt_h) or _KANA_TABLE.get(nxt)
                if rom and rom[0].isalpha() and rom[0] not in 'aeiou':
                    parts.append(rom[0])  # double the consonant
                else:
                    parts.append('t')     # standalone っ at end or before vowel
            else:
                parts.append('t')         # っ at end of string
            i += 1
            continue

        # --- Chōon: ー extends the preceding vowel ---
        if ch == 'ー':
            if parts:
                # Find the last vowel in the accumulated romaji
                for c in reversed(parts[-1]):
                    if c in 'aeiouāīūēō':
                        # Append the base vowel (strip macron if already applied)
                        base = {'ā': 'a', 'ī': 'i', 'ū': 'u', 'ē': 'e', 'ō': 'o'}.get(c, c)
                        parts.append(base)
                        break
            i += 1
            continue

        # --- Moraic nasal: ん/ン with apostrophe disambiguation ---
        if ch in ('ん', 'ン'):
            parts.append('n')
            if i + 1 < n and kana_string[i + 1] in _N_APOSTROPHE_TRIGGERS:
                parts.append("'")
            i += 1
            continue

        # --- Greedy 2-char digraph lookup ---
        if i + 1 < n:
            # Try normalized (hiragana) pair first, then raw katakana pair
            pair_h = _normalize_kata_char(ch) + _normalize_kata_char(kana_string[i + 1])
            raw_pair = ch + kana_string[i + 1]
            rom = _KANA_TABLE.get(pair_h) or _KANA_TABLE.get(raw_pair)
            if rom is not None:
                parts.append(rom)
                i += 2
                continue

        # --- Single char lookup ---
        ch_h = _normalize_kata_char(ch)
        rom = _KANA_TABLE.get(ch_h) or _KANA_TABLE.get(ch)
        if rom is not None:
            parts.append(rom)
            i += 1
            continue

        # --- Passthrough (punctuation, spaces, Latin, etc.) ---
        parts.append(ch)
        i += 1

    raw = ''.join(parts)

    # Apply long vowel mode post-processing
    if long_vowel_mode == "macrons":
        return _apply_macrons(raw)
    elif long_vowel_mode == "unmarked":
        return _collapse_long_vowels(raw)
    # "doubled" — return raw (ou, oo, etc. preserved as-is)
    return raw


def _strip_ass(text: str) -> str:
    """Remove ASS override tags, HTML tags, and line-break markers from *text*."""
    clean = _ASS_TAG_RE.sub('', text)
    clean = _HTML_TAG_RE.sub('', clean)
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


def _make_japanese_pipeline():
    """Shared Japanese pipeline — one pykakasi instance, two consumers.

    Returns ``(resolve_spans, spans_to_romaji)`` where:

    resolve_spans(text: str) -> list[(str, str|None)]
        The shared core.  Extracts inline author annotations, strips ASS tags
        and both furigana conventions, runs pykakasi once, and merges readings
        with three-tier priority (inline > pykakasi > passthrough).  This IS
        the furigana function — same object, same output.

    spans_to_romaji(spans: list, long_vowel_mode: str) -> str
        Converts resolved spans to romaji.  Joins readings into a pure kana
        string, then converts via the deterministic _kana_to_romaji() lookup
        table.  No pykakasi dependency — pure deterministic conversion.
        The long_vowel_mode parameter is passed at call time (not baked into
        the closure) so the UI can toggle modes without recreating the pipeline.

    The single pykakasi instance (kks) is captured in the closure and shared
    by resolve_spans.  spans_to_romaji never touches pykakasi — it only
    consumes the output of resolve_spans.

    Imported lazily so users who never select a Japanese track are not affected
    by a missing pykakasi installation.
    """
    import pykakasi  # lazy import

    kks = pykakasi.kakasi()  # single instance captured by closure

    def resolve_spans(text: str) -> list:
        """Resolve text into (original, reading) span pairs.

        Three-tier sourcing:
          1. Author inline annotations (ground-truth, highest confidence)
          2. Pre-existing ASS furigana (handled at track level by caller)
          3. pykakasi item["hira"] (generated fallback)
        """
        if not text:
            return []
        # Tier 1: extract author annotations from the raw text (before stripping).
        inline_map = _extract_inline_furigana(text)
        clean = _strip_reverse_furigana(_strip_inline_furigana(_strip_ass(text)))
        tokens = kks.convert(clean)
        result = []
        for token in tokens:
            orig = token.get('orig', '')
            hira = token.get('hira', '')
            if not orig:
                continue
            has_kanji = any(_is_cjk(c) for c in orig)
            if not has_kanji or not hira or hira == orig:
                result.append((orig, None))
            elif orig in inline_map:
                result.append((orig, inline_map[orig]))   # tier 1: author wins
            else:
                result.append((orig, hira))               # tier 3: pykakasi
        return result

    def spans_to_romaji(spans: list, long_vowel_mode: str = "macrons") -> str:
        """Convert resolved spans to romaji via the kana→romaji lookup table.

        Each span is converted independently, then joined with spaces — same
        word-level separation as the pre-R3c pykakasi romanizer.  This prevents
        false long-vowel merges across token boundaries (e.g. に+行く should
        be "ni iku", not "nīku") and maintains readability.

        Kanji tokens are replaced by their resolved hiragana readings;
        non-kanji tokens (hiragana, katakana, Latin, punctuation) pass through
        as-is.  Each token's kana is converted deterministically by
        _kana_to_romaji().
        """
        if not spans:
            return ''
        romaji_parts = []
        for orig, reading in spans:
            token_kana = reading if reading else orig
            romaji_parts.append(_kana_to_romaji(token_kana, long_vowel_mode))
        raw = ' '.join(p for p in romaji_parts if p.strip())
        return _clean_speaker_labels(raw)

    return resolve_spans, spans_to_romaji


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
    clean = _strip_inline_furigana(_strip_ass(text))
    tokens = kks.convert(clean)
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


def _is_cjk(char: str) -> bool:
    """Return True if *char* is a CJK unified ideograph (kanji / hanzi).

    Covers BMP CJK Unified Ideographs (U+4E00–U+9FFF) and CJK Extension A
    (U+3400–U+4DBF).  Extension B–F (supplementary planes) are excluded —
    they are rarely used in modern Japanese subtitles.
    """
    cp = ord(char)
    return 0x4e00 <= cp <= 0x9fff or 0x3400 <= cp <= 0x4dbf


def _make_chinese_annotation_func():
    """Return a Chinese per-character annotation span producer.

    Each CJK character is paired with its tone-marked pinyin reading.
    Non-CJK characters (punctuation, numerals, Latin) pass through with
    reading=None — they need no annotation.

    pypinyin is imported lazily so users who never select a Chinese track are
    not affected by a missing installation.

    The returned callable has the signature::

        get_spans(text: str) -> list[(str, str | None)]
    """
    from pypinyin import pinyin as _pinyin, Style  # lazy import

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        for char in clean:
            if _is_cjk(char):
                py = _pinyin(char, style=Style.TONE, errors='default')[0][0]
                spans.append((char, py))
            else:
                spans.append((char, None))
        return spans

    return get_spans


def _make_zhuyin_annotation_func():
    """Return a Chinese per-character Zhuyin (Bopomofo) annotation span producer.

    Identical structure to _make_chinese_annotation_func() but uses
    pypinyin's Style.BOPOMOFO output (e.g. ㄋㄧˇ instead of nǐ).
    Default for Traditional Mandarin (zh-Hant / zh-TW) — Taiwan uses
    Zhuyin Fuhao as its primary phonetic system.
    """
    from pypinyin import pinyin as _pinyin, Style  # lazy import

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        for char in clean:
            if _is_cjk(char):
                zy = _pinyin(char, style=Style.BOPOMOFO, errors='default')[0][0]
                spans.append((char, zy))
            else:
                spans.append((char, None))
        return spans

    return get_spans


# Regex to split word-level Jyutping into per-syllable components.
# Jyutping format: lowercase letters followed by a tone number 1-6.
# e.g. "hoeng1gong2jan4" → ["hoeng1", "gong2", "jan4"]
_JP_SYLLABLE_RE = re.compile(r'[a-z]+[1-6]')


def _make_jyutping_annotation_func():
    """Return a Cantonese per-character Jyutping annotation span producer.

    Uses pycantonese's characters_to_jyutping() which returns word-level
    pairs like [('香港人', 'hoeng1gong2jan4')].  The syllable regex splits
    word-level Jyutping into per-character syllables when the syllable count
    matches the character count (1:1).  Falls back to keeping the whole
    word as one unit when the split doesn't match.

    Non-CJK characters pass through with reading=None.
    """
    import pycantonese  # lazy import

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        pairs = pycantonese.characters_to_jyutping(clean)
        for word, jyutping in pairs:
            if jyutping is None:
                # Non-CJK or unrecognized — pass through character by character
                for char in word:
                    spans.append((char, None))
                continue
            # Try to split word-level Jyutping into per-character syllables
            syllables = _JP_SYLLABLE_RE.findall(jyutping)
            if len(syllables) == len(word):
                for char, syl in zip(word, syllables):
                    spans.append((char, syl))
            else:
                # Fallback: keep as one unit (rare — mismatch between char count
                # and syllable count indicates a compound or segmentation edge case)
                spans.append((word, jyutping))
        return spans

    return get_spans


def _make_jyutping_romanizer():
    """Return a Cantonese Jyutping block romanizer for the Romanized layer.

    Similar to _make_pinyin_romanizer() but uses pycantonese.  Produces
    space-separated Jyutping output suitable for display as a single
    Romanized text line.
    """
    import pycantonese  # lazy import

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        pairs = pycantonese.characters_to_jyutping(clean)
        parts = []
        for word, jyutping in pairs:
            if jyutping:
                parts.append(jyutping)
            else:
                parts.append(word)
        return ' '.join(parts)

    return romanize


def get_annotation_func(lang_code: str, system: str = None):
    """Return a character/token-aligned annotation span producer, or None.

    The returned callable has the signature::

        get_spans(text: str) -> list[(str, str | None)]

    Each tuple is (original_text, reading_or_None).  A non-None reading is
    returned only when the token needs annotation:
      - Japanese: kanji tokens get hiragana readings (token-aligned)
      - Chinese (Mandarin): each hanzi gets pinyin or Zhuyin (character-aligned)
      - Chinese (Cantonese): each hanzi gets Jyutping (character-aligned)

    Hiragana, katakana, Latin, punctuation, and non-CJK characters always
    carry None — they need no annotation.

    Parameters
    ----------
    lang_code : str
        BCP 47 language tag.
    system : str | None
        Override the auto-detected phonetic system.  One of "pinyin",
        "zhuyin", "jyutping", or None (auto-detect from lang_code).

    For Japanese, internally creates a shared pipeline via
    _make_japanese_pipeline().  When called alongside get_romanizer() for
    the same lang_code (as in get_lang_config()), prefer
    get_japanese_pipeline() to share one pykakasi instance.

    Returns None for languages without character-aligned annotations.
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]

    # Explicit system override — works for any Chinese variant
    if system == "pinyin":
        return _make_chinese_annotation_func()
    if system == "zhuyin":
        return _make_zhuyin_annotation_func()
    if system == "jyutping":
        return _make_jyutping_annotation_func()

    if primary == "ja":
        resolve_spans, _ = _make_japanese_pipeline()
        return resolve_spans

    if primary == "yue":
        return _make_jyutping_annotation_func()

    if primary == "zh":
        # Auto-detect: Traditional Mandarin → Zhuyin, others → Pinyin
        lc = (lang_code or "").lower()
        if lc in ("zh-hant", "zh-tw"):
            return _make_zhuyin_annotation_func()
        return _make_chinese_annotation_func()

    return None


def get_japanese_pipeline():
    """Return the shared Japanese pipeline for optimized call sites.

    Returns ``(resolve_spans, spans_to_romaji)`` — see _make_japanese_pipeline()
    for full documentation.  This is the public entry point used by
    get_lang_config() to create one pykakasi instance shared between the
    furigana and romaji consumers.

    Returns ``(None, None)`` for non-Japanese contexts (caller should check).
    """
    return _make_japanese_pipeline()


def build_annotation_html(spans: list) -> str:
    """Convert a span list from get_annotation_func() into HTML ruby markup.

    Annotated tokens (reading is not None) are wrapped in::

        <ruby>orig<rt>reading</rt></ruby>

    Passthrough tokens (reading=None) are inserted as plain text.

    The resulting HTML is suitable for direct embedding in a ``<div>`` — the
    browser's native ruby layout handles centering of each ``<rt>`` reading
    over its base characters without any coordinate math.  This is used by the
    composite preview; the .ass output uses ``\\pos()`` stacking instead.

    Language-agnostic: works for Japanese furigana (kanji→hiragana), Chinese
    pinyin (hanzi→pinyin), or any future annotation system that produces
    (original, reading) span pairs.

    Returns an empty string for an empty span list.
    """
    if not spans:
        return ''
    parts = []
    for orig, reading in spans:
        if reading:
            parts.append(f'<ruby>{orig}<rt>{reading}</rt></ruby>')
        else:
            parts.append(orig)
    return ''.join(parts)


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

    # Chunk R2c — Cantonese Jyutping (pycantonese) ────────────────── ✅
    if primary == "yue":
        return _make_jyutping_romanizer()

    # Chunk R3/R3c — Japanese resolved-kana romaji (pipeline) ─────── ✅
    if primary == "ja":
        resolve_spans, spans_to_romaji = _make_japanese_pipeline()
        def _ja_romanize(text: str) -> str:
            if not text:
                return ''
            return spans_to_romaji(resolve_spans(text))
        return _ja_romanize

    # Chunk R4 — Korean, Russian/Cyrillic, Thai ───────────────────── TODO
    # Chunk R5 — Indic scripts, Arabic/Persian/Urdu ───────────────── TODO

    return None
