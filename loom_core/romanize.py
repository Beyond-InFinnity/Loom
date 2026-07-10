# app/romanize.py
"""
Romanization factory for Loom.

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
Chunk R3 — Japanese (MeCab/fugashi, token-aligned Hepburn romaji)            ✅
Chunk R3-hotfix — inline furigana stripping (奴(やつ) doubled romanization)  ✅
Chunk R3b — Japanese furigana layer (get_furigana_func, build_furigana_html) ✅
Chunk R3c — resolved-kana romaji pipeline + kana→romaji lookup table         ✅
Chunk R4 — Korean (korean-romanizer), Russian/Cyrillic (cyrtranslit), Thai (pythainlp)  ✅
  Thai phonetic systems: RTGS (royin), Paiboon+ (tone diacritics), IPA
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
     and character names where MeCab errs most often.
  2. Pre-existing ASS \pos() furigana — detect_preexisting_furigana() detects
     whole-track inline furigana; when found the caller disables the Furigana
     style slot to avoid double annotation (per-event extraction deferred).
  3. MeCab morpheme reading — generated fallback for unannotated kanji tokens.
"""

import functools
import re

# ---------------------------------------------------------------------------
# Engine versions — cache-key discipline (ROMANIZATION_CACHE.md gotcha #1)
# ---------------------------------------------------------------------------
# The API's content-addressed result cache (loom_api/result_cache.py) stamps
# every cached romanization/annotation with the engine version of its primary
# language.  BUMP THE LANGUAGE'S VERSION whenever a change to this module (or
# styles.py's system resolution) alters romanize/annotation OUTPUT for that
# language — e.g. fixing a documented failure mode like ברוך → varokh or
# Pākistān → Pākasatān.  Old cache rows then simply stop matching; no
# invalidation logic exists or is needed.  Refactors that don't change output
# must NOT bump (that would needlessly cold-start the cache).
_ENGINE_VERSION_DEFAULT = 1
ENGINE_VERSIONS: dict[str, int] = {
    # primary lang code -> version; unlisted languages use the default.
    # Bumped when the /annotate `tokens` output format changes so old cache
    # rows (an earlier token shape) can't be served — the version is part of
    # the key.  Shared with romanize (same key fn); those langs recompute once.
    #   v2: tokens added (Phase 0).
    #   v3: JA tokens merged into words + `reading` field on every token
    #       (Phase 2 §1/§2); ZH token tuple gained the same `reading` slot.
    #   v4: JA tokens strip leading/trailing punctuation from the clickable
    #       surface (は… → は), so the token's word/start/length can change.
    #   ko v2: Korean word tokens added (Phase 3, kiwipiepy) — was [] at the
    #       default v1, so old ko cache rows must be invalidated.
    "ja": 4,
    "zh": 3,
    "yue": 3,
    "ko": 2,
}


def engine_version(lang_code: str) -> int:
    """Cache-key version for *lang_code* (primary subtag, case-insensitive)."""
    primary = (lang_code or "").split("-")[0].lower()
    return ENGINE_VERSIONS.get(primary, _ENGINE_VERSION_DEFAULT)


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
# a kana reading in parentheses, e.g. 奴(やつ), 支配（しはい）, or
# 重力(グラビティ) (katakana gloss for a loanword/slang reading).
#
# Safety properties that make the false-positive rate effectively zero:
#   • Requires at least one CJK unified ideograph ([\u4e00-\u9fff\u3400-\u4dbf])
#     IMMEDIATELY before the opening paren — no whitespace allowed.  This rules
#     out speaker labels like （アルミン） which are not glued to a kanji.
#   • Requires kana-only ([ぁ-んァ-ヶー]+) inside the parens — accepts:
#       - hiragana readings:  奴(やつ), 支配(しはい)
#       - katakana readings:  重力(グラビティ), 本気(マジ), 宇宙(スペース)
#       - mixed + chōon:      魔女(まじょー) / 心(ハート) / etc.
#     Rejects:
#       - （笑）   laugh marker — kanji, not kana
#       - （注）   editorial note — kanji, not kana
#   • Kana-only content inside parens that is glued to kanji is a reserved
#     typographic pattern in Japanese; it has no other usage in subtitle text.
#     Authors use katakana specifically to mark loanword / slang / stylized
#     readings where the kanji's standard reading is overridden — preserved
#     as katakana in the annotation layer so the author's intent is visible.
#
# Group 1 = kanji compound, Group 2 = kana reading (hiragana or katakana).
INLINE_FURIGANA_RE = re.compile(
    r'([\u4e00-\u9fff\u3400-\u4dbf]+)[（(]([ぁ-んァ-ヶー]+)[）)]'
)


def _strip_inline_furigana(text: str) -> str:
    """Remove plain-text inline furigana annotations, keeping only the kanji.

    Converts ``奴(やつ)らに支配(しはい)された`` →
              ``奴らに支配された``

    This is a required preprocessing step for the Japanese romanizer: without
    it MeCab romanizes both the kanji *and* the parenthetical hiragana
    reading, producing doubled output (e.g. "yatsu yatsu" instead of "yatsu").

    Only hiragana-inside-parens-glued-to-kanji matches are affected.
    Speaker labels like （アルミン） and laugh markers like （笑） are not touched.
    """
    return INLINE_FURIGANA_RE.sub(r'\1', text)


def _extract_inline_furigana(text: str) -> dict:
    """Extract author-annotated kanji→kana reading pairs from *text*.

    Returns a dict mapping each kanji compound to its annotated reading::

        "奴(やつ)らに支配(しはい)されていた"
        → {"奴": "やつ", "支配": "しはい"}

        "重力(グラビティ)を操る"
        → {"重力": "グラビティ"}

    Readings may be hiragana (standard furigana) or katakana (loanword /
    slang / stylized glosses such as 重力(グラビティ) or 本気(マジ)).
    Katakana readings are preserved as katakana downstream: the romaji
    pipeline handles both kana via _kana_to_romaji, and the annotation
    layer keeps the author's typographic choice visible to the reader.

    This is the R3b data source for the furigana layer.  Author-annotated
    readings are the highest-confidence source — the author knew the correct
    reading for that specific line, including unusual and context-dependent
    readings where MeCab is most likely to err.

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
                elif rom:
                    parts.append('t')     # before vowel kana (mid-word glottal stop)
                else:
                    parts.append("'")     # before punctuation/non-kana — utterance-final
            else:
                parts.append("'")         # っ at end of string
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


def _is_cjk_punct(char: str) -> bool:
    """Return True if *char* is a CJK or fullwidth punctuation character.

    Covers:
    - U+3000–U+303F  CJK Symbols and Punctuation (。、「」etc.)
    - U+FF00–U+FF0F  Fullwidth digits/symbols prefix (！＂＃)
    - U+FF1A–U+FF20  Fullwidth colon–at (：；＜＝＞？＠)
    - U+FF3B–U+FF40  Fullwidth brackets (［＼］＾＿｀)
    - U+FF5B–U+FF65  Fullwidth braces + halfwidth CJK punct (｛｜｝～｟｠)
    - U+FE30–U+FE4F  CJK Compatibility Forms (︰︱etc.)
    - U+2000–U+206F  General Punctuation (en-dash, em-dash, ellipsis, etc.)
    """
    cp = ord(char)
    return (0x3000 <= cp <= 0x303F or
            0xFF01 <= cp <= 0xFF0F or
            0xFF1A <= cp <= 0xFF20 or
            0xFF3B <= cp <= 0xFF40 or
            0xFF5B <= cp <= 0xFF65 or
            0xFE30 <= cp <= 0xFE4F or
            0x2000 <= cp <= 0x206F)


def _is_cjk_punct_segment(seg: str) -> bool:
    """Return True if *seg* consists entirely of CJK/fullwidth punctuation or whitespace."""
    return all(_is_cjk_punct(c) or c.isspace() for c in seg)


# ---------------------------------------------------------------------------
# Universal romanization polish
# ---------------------------------------------------------------------------
#
# Applied at the tail of every romanization factory.  Romanization output is
# Latin-script, so fullwidth CJK punctuation visually clashes with it — we
# convert to ASCII equivalents.  The space-before-punct artifact comes from
# token-wise space joining (`' '.join(parts)`) in the Chinese / Japanese /
# Cantonese / Thai pipelines, where a punctuation token gets a leading space
# from the join just like any other token.  Capitalization is opt-in per
# language: on for scripts without source case (ja / zh / yue / ko); off for
# Cyrillic (cyrtranslit preserves source case, which is the correct signal
# for continuation vs. sentence-start lines) and Thai (no caps convention).

# Fullwidth CJK punctuation → Latin equivalent.  The middle-dot ・ is common
# in katakana (separates foreign first/last names) and maps to a space rather
# than a dot, since in Latin-script output the separation is the signal.
_CJK_TO_LATIN_PUNCT = {
    '。': '.', '、': ',', '，': ',', '！': '!', '？': '?',
    '；': ';', '：': ':', '（': '(', '）': ')',
    '【': '[', '】': ']', '「': '"', '」': '"',
    '『': '"', '』': '"', '・': ' ',
}
_CJK_PUNCT_TRANSLATE = str.maketrans(_CJK_TO_LATIN_PUNCT)

# One or more whitespace characters followed by a closing-side punctuation
# mark.  Matches the artifact produced by space-joining punctuation tokens
# in the tokenized pipelines (e.g. "hello ." → "hello.").
_SPACE_BEFORE_CLOSE_PUNCT_RE = re.compile(r'\s+([,.!?;:)\]}"])')

# Sentence-ending punctuation + whitespace + any non-space character.  Used
# to uppercase the first alphabetic character of the next sentence.
_SENTENCE_END_RE = re.compile(r'([.!?])(\s+)(\S)')


def _capitalize_first_letter(s: str) -> str:
    """Uppercase the first alphabetic character in *s* in place.

    Leading whitespace and punctuation are preserved.  Returns *s* unchanged
    when it contains no cased characters (e.g. pure Thai script, numerals).
    ``str.upper()`` on a single char handles Unicode (e.g. ``ō`` → ``Ō``).
    """
    for i, c in enumerate(s):
        if c.isalpha():
            return s[:i] + c.upper() + s[i + 1:]
    return s


def _polish_romaji(text: str, *, capitalize: bool = True) -> str:
    """Normalize the final string produced by a romanization factory.

    Three passes, each independently safe and idempotent:

    1. Fullwidth CJK punctuation → ASCII equivalents.
    2. Strip whitespace before closing punctuation (``.,!?;:)]"}``).
    3. When ``capitalize`` is True, uppercase the first alphabetic character
       of the line and the first alphabetic character after any sentence
       terminator (``.!?``).

    Parameters
    ----------
    text : str
        Joined romanization output.  Empty strings pass through unchanged.
    capitalize : bool
        True for scripts without source case (ja, zh, yue, ko).  False for
        Cyrillic (source case is meaningful and preserved by cyrtranslit)
        and Thai (no caps convention).  IPA output is also capitalize=False
        since IPA has no sentence-case tradition.
    """
    if not text:
        return text
    out = text.translate(_CJK_PUNCT_TRANSLATE)
    out = _SPACE_BEFORE_CLOSE_PUNCT_RE.sub(r'\1', out)
    if capitalize:
        out = _capitalize_first_letter(out)
        out = _SENTENCE_END_RE.sub(
            lambda m: m.group(1) + m.group(2) + m.group(3).upper(),
            out,
        )
    return out


def hepburn_from_kana(kana: str) -> tuple[str, str]:
    """Romanize a kana READING string to Hepburn, both long-vowel styles.

    Returns ``(macron, doubled)`` — e.g. とうきょう → ("Tōkyō", "Toukyou"),
    しゅうまつ → ("Shūmatsu", "Shuumatsu").  When the reading has no long vowel
    the two are identical (みた → ("Mita", "Mita")); the caller can collapse the
    redundant second form.  Katakana readings are handled (フリーレン →
    ("Furīren", "Furiiren")).  Blank input → ``("", "")``.

    Reuses the same tested kana→romaji table + polish as the romaji caption
    line, so the vocab card's Hepburn can't drift from the overlay's.
    """
    if not kana or not kana.strip():
        return ("", "")
    return (
        _polish_romaji(_kana_to_romaji(kana, "macrons")),
        _polish_romaji(_kana_to_romaji(kana, "doubled")),
    )


def _make_pinyin_romanizer(variant: str = None):
    """Return a Chinese pinyin romanizer with word-segmented output.

    Uses jieba for word segmentation so that multi-character words are grouped
    (e.g. "nǐhǎo shìjiè" instead of "nǐ hǎo shì jiè").

    Parameters
    ----------
    variant : str | None
        Chinese variant: ``"zh-Hant"`` for Traditional, ``"zh-Hans"`` or None
        for Simplified.  When Traditional, text is converted to Simplified via
        OpenCC for jieba segmentation (jieba's dictionary is Simplified-oriented),
        then word boundaries are mapped back to the original Traditional text
        for pypinyin processing.

    Behaviour
    ---------
    * ASS override tags and line-break markers are stripped before processing.
    * jieba.cut() provides word boundaries.
    * CJK punctuation segments pass through so the Romanized layer preserves
      sentence boundaries; _polish_romaji() converts them to Latin equivalents
      (。 → ., ， → ,, etc.) at the tail.
    * For each CJK word, pypinyin syllables are joined without spaces within
      the word, then words are joined with spaces.
    * Non-CJK segments (Latin, numerals) pass through unchanged.
    """
    from pypinyin import pinyin as _pinyin, Style  # lazy import
    import jieba  # lazy import

    # Suppress jieba's noisy initialization log to stderr
    import logging as _logging
    _logging.getLogger('jieba').setLevel(_logging.WARNING)

    # For Traditional Chinese: convert to Simplified for jieba segmentation
    _t2s = None
    if variant == 'zh-Hant':
        import opencc  # lazy import
        _t2s = opencc.OpenCC('t2s')

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)

        # For Traditional: convert to Simplified for segmentation, then map
        # word boundaries back to original Traditional text for pypinyin.
        if _t2s is not None:
            simplified = _t2s.convert(clean)
            seg_words = list(jieba.cut(simplified))
            # Map segment lengths back to original Traditional characters.
            # Simplified and Traditional have 1:1 character correspondence
            # (OpenCC t2s never changes string length for CJK text).
            words = []
            pos = 0
            for sw in seg_words:
                words.append(clean[pos:pos + len(sw)])
                pos += len(sw)
        else:
            words = list(jieba.cut(clean))

        parts = []
        for word in words:
            if not word.strip():
                continue
            if _is_cjk_punct_segment(word):
                # Preserve punctuation so the polish pass can carry
                # sentence boundaries through to Latin equivalents.
                parts.append(word)
                continue
            # Check if word contains any CJK characters
            if any(_is_cjk(c) for c in word):
                syllables = [s[0] for s in _pinyin(word, style=Style.TONE, errors='default')]
                parts.append(''.join(syllables))
            else:
                parts.append(word.strip())
        return _polish_romaji(' '.join(p for p in parts if p), capitalize=True)

    return romanize


def _make_zhuyin_romanizer(variant: str = None):
    """Return a Chinese Zhuyin (Bopomofo) romanizer with word-segmented output.

    Sibling of ``_make_pinyin_romanizer`` — same pipeline (jieba segmentation
    + optional Trad→Simp mapping), but emits Style.BOPOMOFO so the Romanized
    layer renders with bopomofo glyphs (e.g. "ㄋㄧˇ ㄏㄠˇ ㄕˋ ㄐㄧㄝˋ" for "你好世界").

    Parameters
    ----------
    variant : str | None
        ``"zh-Hant"`` for Traditional, anything else for Simplified.  Default
        for Traditional Mandarin per CLAUDE.md's "Locked Architectural
        Decisions" — Taiwan uses Zhuyin Fuhao (注音符號) as the primary
        phonetic system, so a zh-Hant track gets bopomofo rather than pinyin
        unless the caller explicitly overrides via ``phonetic_system="pinyin"``.

    Output convention
    -----------------
    Syllables within a jieba-segmented word are space-separated rather than
    glued.  Bopomofo syllables render as vertical stacks in CJK fonts; no
    space between two syllables collapses them into one ambiguous stack.
    Spaces between words and within words look identical when rendered, so
    no information loss — readers parse word boundaries from context.

    ``capitalize=False`` because bopomofo has no case.  ``_polish_romaji``
    still runs to convert CJK punctuation (。 → ., ， → ,) and tidy
    whitespace before closing punctuation.
    """
    from pypinyin import pinyin as _pinyin, Style  # lazy import
    import jieba  # lazy import

    import logging as _logging
    _logging.getLogger('jieba').setLevel(_logging.WARNING)

    _t2s = None
    if variant == 'zh-Hant':
        import opencc  # lazy import
        _t2s = opencc.OpenCC('t2s')

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)

        if _t2s is not None:
            simplified = _t2s.convert(clean)
            seg_words = list(jieba.cut(simplified))
            words = []
            pos = 0
            for sw in seg_words:
                words.append(clean[pos:pos + len(sw)])
                pos += len(sw)
        else:
            words = list(jieba.cut(clean))

        parts = []
        for word in words:
            if not word.strip():
                continue
            if _is_cjk_punct_segment(word):
                parts.append(word)
                continue
            if any(_is_cjk(c) for c in word):
                # Space-separate syllables within the word — each bopomofo
                # syllable is a vertical stack, glued syllables become an
                # ambiguous taller stack.
                syllables = [s[0] for s in _pinyin(word, style=Style.BOPOMOFO, errors='default')]
                parts.append(' '.join(syllables))
            else:
                parts.append(word.strip())

        return _polish_romaji(' '.join(p for p in parts if p), capitalize=False)

    return romanize


def _make_japanese_pipeline():
    """Shared Japanese pipeline — one MeCab tagger instance, two consumers.

    Returns ``(resolve_spans, spans_to_romaji)`` where:

    resolve_spans(text: str) -> list[(str, str|None)]
        The shared core.  Extracts inline author annotations, strips ASS tags
        and both furigana conventions, runs MeCab (via fugashi) once, and
        merges readings with three-tier priority (inline > MeCab > passthrough).
        This IS the furigana function — same object, same output.

        Also computes romaji metadata (particle-は indices, verb-chain merge
        mask) stored in the closure and consumed by spans_to_romaji.

    spans_to_romaji(spans: list, long_vowel_mode: str) -> str
        Converts resolved spans to romaji.  Uses merge metadata from the
        paired resolve_spans call to join verb/auxiliary chains and convert
        particle は → wa.  Then converts via the deterministic
        _kana_to_romaji() lookup table.  The long_vowel_mode parameter is
        passed at call time (not baked into the closure) so the UI can toggle
        modes without recreating the pipeline.

    The single fugashi Tagger instance is captured in the closure and shared
    by resolve_spans.  spans_to_romaji never touches MeCab — it only
    consumes the output of resolve_spans.

    Imported lazily so users who never select a Japanese track are not affected
    by a missing fugashi/unidic-lite installation.
    """
    import fugashi  # lazy import

    tagger = fugashi.Tagger()  # single instance captured by closure

    # Closure state: merge metadata populated by resolve_spans, consumed by
    # spans_to_romaji.  Always read before the next resolve_spans overwrites.
    _romaji_meta = {'merge_mask': [], 'particle_ha': set()}

    def _kata_to_hira(text: str) -> str:
        """Convert katakana string to hiragana."""
        return ''.join(_normalize_kata_char(c) for c in text)

    def _is_katakana_token(text: str) -> bool:
        """True if text is entirely katakana (incl. chōon/middle dot)."""
        if not text:
            return False
        has_letter = False
        for c in text:
            cp = ord(c)
            if 0x30A1 <= cp <= 0x30F6:
                has_letter = True
            elif not (0x30A0 <= cp <= 0x30FF):
                return False
        return has_letter

    def _merge_katakana_fragments(tokens: list) -> list:
        """Merge adjacent katakana-only token fragments into single tokens.

        MeCab splits unknown katakana names (e.g. ミカサ → ミカ+サ).
        Re-joining consecutive katakana fragments restores the original name.
        Tokens are 5-tuples: (surface, kana, pos1, pos2, lemma).
        """
        if not tokens:
            return tokens
        merged = []
        i = 0
        while i < len(tokens):
            surface, kana, pos1, pos2, lemma = tokens[i]
            if _is_katakana_token(surface):
                group_s = [surface]
                group_k = [kana if kana else surface]
                j = i + 1
                while j < len(tokens):
                    ns, nk, _, _, _ = tokens[j]
                    if _is_katakana_token(ns):
                        group_s.append(ns)
                        group_k.append(nk if nk else ns)
                        j += 1
                    else:
                        break
                if len(group_s) > 1:
                    merged.append((''.join(group_s), ''.join(group_k), pos1, pos2, lemma))
                else:
                    merged.append(tokens[i])
                i = j
            else:
                merged.append(tokens[i])
                i += 1
        return merged

    def _should_merge_for_romaji(pos1, pos2, next_surface, next_pos1, next_pos2, next_lemma):
        """Whether current token should merge with next in romaji output.

        Merges verb/auxiliary chains into single phonological words so that
        sokuon (っ) gemination, te-form auxiliaries, and tense suffixes
        produce natural romaji (e.g. 'sareteita' not 'sa re te i ta').

        Keeps noun+verb boundaries and subsidiary verb boundaries separate
        for readability (e.g. 'shihai sareteita' not 'shihaisareteita',
        'kaette kita' not 'kaettekita').
        """
        # Rule 1: Auxiliary verb (た, だ, れる, etc.) after verb/aux/adj/suffix
        # or after conjunctive particle (て+た).
        # EXCEPTION: ます/です are sentence-enders — keep separate for readability
        # (e.g. 'kizuku deshō' not 'kizukudeshō', 'torikaesemasendeshita' → split).
        if next_pos1 == '助動詞':
            if next_lemma in ('ます', 'です'):
                return False
            if pos1 in ('動詞', '助動詞', '形容詞', '接尾辞'):
                return True
            if pos1 == '助詞' and pos2 == '接続助詞':
                return True
        # Rule 2: Conjunctive particle て/で ONLY after verb/aux/adj/suffix.
        # Other conjunctive particles (から, ば, etc.) stay separate.
        if next_pos1 == '助詞' and next_pos2 == '接続助詞':
            if next_surface in ('て', 'で'):
                if pos1 in ('動詞', '助動詞', '形容詞', '接尾辞'):
                    return True
        # Rule 3: Progressive いる after conjunctive particle (ている/ていた)
        # Only merge い or いる (progressive aspect marker), NOT き(くる),
        # くれ(くれる), いき(いく), おき(おく) etc.  MeCab sometimes produces
        # いる as a single token (決まっている) and sometimes splits い+た
        # (支配されていた) — handle both forms.
        if next_pos1 == '動詞' and next_pos2 == '非自立可能':
            if pos1 == '助詞' and pos2 == '接続助詞':
                if next_surface in ('い', 'いる'):
                    return True
        # Rule 4: Suffix merges BACKWARD — if next token is a suffix (接尾辞),
        # merge it onto the current token (e.g. 奴+ら → yatsura, 人+たち → hitotachi).
        # Old forward-chaining rule (suffix → verb/aux/particle) was wrong —
        # it caused 君+落ち着いて → "kun'ochitsuite".
        if next_pos1 == '接尾辞':
            return True
        # Rule 5: Supplementary symbol っ (standalone sokuon) merges with
        # whatever precedes it (e.g. 酒臭+っ → sake-shū')
        if next_pos1 == '補助記号' and next_pos2 == '一般':
            return True
        # Rule 6: Contracted nominalizer ん (only ん, not の) after verb chain
        if next_pos1 == '助詞' and next_pos2 == '準体助詞':
            if next_surface == 'ん':
                if pos1 in ('動詞', '助動詞'):
                    return True
        return False

    def resolve_spans(text: str) -> list:
        """Resolve text into (original, reading) span pairs.

        Three-tier sourcing:
          1. Author inline annotations (ground-truth, highest confidence)
          2. Pre-existing ASS furigana (handled at track level by caller)
          3. MeCab morpheme reading (generated fallback)

        Also populates _romaji_meta with merge mask and particle-は indices
        for the paired spans_to_romaji call.
        """
        if not text:
            _romaji_meta['merge_mask'] = []
            _romaji_meta['particle_ha'] = set()
            return []
        # Tier 1: extract author annotations from the raw text (before stripping).
        inline_map = _extract_inline_furigana(text)
        clean = _strip_reverse_furigana(_strip_inline_furigana(_strip_ass(text)))
        words = tagger(clean)

        # Phase 1: Extract structured tokens from MeCab
        # Tokens are 5-tuples: (surface, kana, pos1, pos2, lemma)
        raw_tokens = []
        for word in words:
            surface = word.surface
            if not surface:
                continue
            kana = pos1 = pos2 = lemma = None
            try:
                kana = word.feature.kana
                if kana is None or kana == '*':
                    kana = None
            except (AttributeError, IndexError):
                pass
            try:
                pos1 = word.feature.pos1 or ''
            except (AttributeError, IndexError):
                pos1 = ''
            try:
                pos2 = word.feature.pos2 or ''
            except (AttributeError, IndexError):
                pos2 = ''
            try:
                lemma = word.feature.lemma or ''
            except (AttributeError, IndexError):
                lemma = ''
            # Override: 私 defaults to ワタクシ in UniDic — ワタシ is the
            # modern standard reading used in virtually all anime/media.
            if surface == '私' and kana == 'ワタクシ':
                kana = 'ワタシ'
            raw_tokens.append((surface, kana, pos1, pos2, lemma))

        # Phase 2: Merge adjacent katakana fragments (fixes name splitting)
        tokens = _merge_katakana_fragments(raw_tokens)

        # Phase 3: Build spans + compute romaji metadata
        result = []
        token_meta = []  # per-span (lemma, pos1) for word-level vocab tokens
        particle_ha = set()
        merge_mask = []

        for idx, (surface, kana, pos1, pos2, lemma) in enumerate(tokens):
            has_kanji = any(_is_cjk(c) for c in surface)

            if not has_kanji:
                # Track particle は for romaji wa conversion.
                # Guard against は？ interjection overcorrection: when は is
                # tagged as 助詞 but contextually an interjection (e.g. after
                # closing bracket/paren followed by ？), keep as 'ha'.
                if surface == 'は' and pos1 == '助詞':
                    is_interjection = False
                    # Check if preceded by closing bracket/paren
                    if idx > 0:
                        prev_s = tokens[idx - 1][0]
                        if prev_s and prev_s[-1] in '）)】」』〉》':
                            # Check if followed by ？ or nothing (sentence-final)
                            if idx + 1 < len(tokens):
                                next_s = tokens[idx + 1][0]
                                if next_s and next_s[0] in '？?':
                                    is_interjection = True
                            else:
                                is_interjection = True
                    if not is_interjection:
                        particle_ha.add(len(result))
                result.append((surface, None))
            elif surface in inline_map:
                result.append((surface, inline_map[surface]))   # tier 1: author wins
            else:
                # tier 3: MeCab reading (katakana → hiragana)
                if kana:
                    hira = _kata_to_hira(kana)
                    if hira != surface:
                        result.append((surface, hira))
                    else:
                        result.append((surface, None))
                else:
                    result.append((surface, None))

            # Per-span token metadata (dictionary lemma + POS) — appended once
            # per iteration so it stays 1:1 with `result`. Consumed by
            # build_word_tokens() for the /annotate `tokens` field; stashed in
            # the closure like merge_mask/particle_ha (VOCAB_LOOKUP.md Phase 0).
            token_meta.append((lemma or None, pos1 or ''))

            # Compute merge mask for romaji
            should_merge = False
            if idx + 1 < len(tokens):
                next_surface, _, next_pos1, next_pos2, next_lemma = tokens[idx + 1]
                should_merge = _should_merge_for_romaji(
                    pos1, pos2, next_surface, next_pos1, next_pos2, next_lemma)
            merge_mask.append(should_merge)

        _romaji_meta['merge_mask'] = merge_mask
        _romaji_meta['particle_ha'] = particle_ha
        _romaji_meta['token_meta'] = token_meta
        return result

    def spans_to_romaji(spans: list, long_vowel_mode: str = "macrons") -> str:
        """Convert resolved spans to romaji via the kana→romaji lookup table.

        Uses merge metadata from the paired resolve_spans call to:
        - Convert particle は to わ (→ "wa" instead of "ha")
        - Merge verb/auxiliary chains into single kana strings before
          romanization, so sokuon gemination works across morpheme boundaries
          (e.g. 決まっ+て → きまって → kimatte, not kima'+te)

        Token boundaries still produce spaces between independent words,
        preventing false long-vowel merges (e.g. に+行く → "ni iku" not "nīku").
        """
        if not spans:
            return ''
        merge_mask = _romaji_meta.get('merge_mask', [])
        particle_ha = _romaji_meta.get('particle_ha', set())

        # Build kana tokens, applying particle は → わ
        kana_tokens = []
        for i, (orig, reading) in enumerate(spans):
            if i in particle_ha:
                kana_tokens.append('わ')
            else:
                kana_tokens.append(reading if reading else orig)

        # Merge tokens according to merge mask (verb/auxiliary chains)
        merged = []
        i = 0
        while i < len(kana_tokens):
            group = [kana_tokens[i]]
            while i < len(merge_mask) and merge_mask[i]:
                i += 1
                if i < len(kana_tokens):
                    group.append(kana_tokens[i])
            merged.append(''.join(group))
            i += 1

        # Convert merged kana groups to romaji
        romaji_parts = [_kana_to_romaji(k, long_vowel_mode) for k in merged]
        raw = ' '.join(p for p in romaji_parts if p.strip())
        return _polish_romaji(_clean_speaker_labels(raw), capitalize=True)

    # Expose the per-span token metadata from the LAST resolve_spans call as a
    # function attribute — non-breaking for the (resolve_spans, spans_to_romaji)
    # callers, read by build_word_tokens() right after it calls resolve_spans.
    resolve_spans._loom_ja_meta = lambda: {
        'token_meta': _romaji_meta.get('token_meta', []),     # per-span (lemma, pos1)
        'merge_mask': _romaji_meta.get('merge_mask', []),     # merge span i with i+1?
        'particle_ha': _romaji_meta.get('particle_ha', set()),  # spans where は is pronounced わ
    }

    return resolve_spans, spans_to_romaji


def get_hiragana(lang_code: str, text: str) -> str:
    """Return space-joined hiragana readings for *text* if *lang_code* is Japanese.

    This is a debug/probe helper that exposes the furigana data path
    (MeCab katakana readings converted to hiragana) without touching the
    Romanized layer.

    NOTE: This function creates its own fugashi Tagger on every call.
    That is acceptable for the debug probe (called once per UI rerun on a
    single line of text), but it must NOT be used in the hot path
    (e.g. inside generate_ass_file()).  If furigana generation ever moves into
    the hot path, share the single Tagger instance from _make_japanese_pipeline().

    Returns an empty string for non-Japanese lang_codes or empty text.
    """
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary != "ja" or not text:
        return ''
    import fugashi  # lazy import
    tagger = fugashi.Tagger()
    clean = _strip_inline_furigana(_strip_ass(text))
    words = tagger(clean)
    parts = []
    for word in words:
        kana = None
        try:
            kana = word.feature.kana
            if kana is None or kana == '*':
                kana = None
        except (AttributeError, IndexError):
            pass
        if kana:
            parts.append(''.join(_normalize_kata_char(c) for c in kana))
        else:
            parts.append(word.surface)
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
        return _polish_romaji(' '.join(parts), capitalize=True)

    return romanize


# BCP-47 primary subtags for Cyrillic-script languages supported by cyrtranslit.
# Maps BCP-47 primary subtag → cyrtranslit language code.
_CYRILLIC_LANG_CODES = {
    "ru": "ru",   # Russian
    "uk": "ua",   # Ukrainian (cyrtranslit uses 'ua')
    "be": "by",   # Belarusian (cyrtranslit uses 'by')
    "sr": "sr",   # Serbian
    "bg": "bg",   # Bulgarian
    "mk": "mk",   # Macedonian
    "mn": "mn",   # Mongolian
}


def _make_korean_romanizer():
    """Return a Korean Revised Romanization block romanizer.

    Uses app.korean_rr (standalone MIT implementation).
    """
    from .korean_rr import romanize as _kr_romanize

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        return _polish_romaji(_kr_romanize(clean), capitalize=True)

    return romanize


def _make_korean_annotation_func():
    """Return a Korean per-syllable annotation span producer.

    Each Hangul syllable block (가–힣) gets its own ruby annotation with
    its individual Revised Romanization reading, matching how Mandarin
    gives each 汉字 its own pinyin ruby.

    Non-Hangul characters (punctuation, Latin, numbers, spaces) pass
    through with ``reading=None``.

    Per-syllable romanization uses ``romanize_syllable()`` from
    app.korean_rr on each syllable independently.  This loses some
    inter-syllable phonological rules (liaison 연음, tensification
    경음화, nasalization 비음화), but shows the base reading of each
    character — which is more useful for character-level lookup.  The
    romanization *line* (block text from ``_make_korean_romanizer``)
    uses full-word romanization and captures those rules correctly.
    """
    from .korean_rr import romanize_syllable

    def _is_hangul_syllable(c: str) -> bool:
        return '\uAC00' <= c <= '\uD7AF'

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        for char in clean:
            if _is_hangul_syllable(char):
                rom = romanize_syllable(char)
                spans.append((char, rom if rom else None))
            else:
                spans.append((char, None))
        return spans

    return get_spans


def _make_cyrillic_romanizer(primary: str):
    """Return a Cyrillic→Latin transliteration function for *primary* subtag.

    Uses cyrtranslit with the correct lang code mapping (BCP-47 → cyrtranslit).
    """
    import cyrtranslit

    cyr_code = _CYRILLIC_LANG_CODES[primary]

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        # capitalize=False: cyrtranslit preserves source case.  Respecting
        # the source distinguishes sentence-initial lines from continuation
        # lines — our sentence-start heuristic cannot.
        return _polish_romaji(cyrtranslit.to_latin(clean, cyr_code),
                              capitalize=False)

    return romanize


def _make_cyrillic_annotation_func(primary: str):
    """Return a Cyrillic per-word annotation span producer.

    Words are space-delimited.  Each word containing Cyrillic characters is
    transliterated to Latin via cyrtranslit.  Non-Cyrillic words (Latin,
    numerals, punctuation) pass through with reading=None.
    """
    import cyrtranslit

    cyr_code = _CYRILLIC_LANG_CODES[primary]

    def _has_cyrillic(word: str) -> bool:
        return any('\u0400' <= c <= '\u04FF' for c in word)

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        parts = clean.split(' ')
        for i, word in enumerate(parts):
            if word:
                if _has_cyrillic(word):
                    lat = cyrtranslit.to_latin(word, cyr_code)
                    spans.append((word, lat))
                else:
                    spans.append((word, None))
            if i < len(parts) - 1:
                spans.append((' ', None))
        return spans

    return get_spans


# ---------------------------------------------------------------------------
# R5-2: Indic scripts (Devanagari, Bengali, Tamil, Telugu, Gujarati, Gurmukhi)
# ---------------------------------------------------------------------------
#
# Block-level romanization via aksharamukha.  Aksharamukha is preferred over
# indic-transliteration/sanscript because sanscript gives phonologically
# distorted output for Tamil ("vaṇakkam" → "vaṇaghghaṃ") — it treats the
# Tamil script as a subset of Sanskrit phonology and maps conflated
# consonant sounds to their voiced-aspirate Sanskrit equivalents. Aksharamukha
# produces the conventional transliteration that learners recognize.
#
# IAST is the default target: diacritic-rich (ā, ī, ṇ, ś, ṃ) but
# immediately readable.  ISO 15919 is a supported alternative scholarly
# scheme; we could expose it as a phonetic_system override later.
#
# The Devanagari danda (।) and double danda (॥) — sentence and verse
# terminators — are converted automatically by aksharamukha to "." and "..".

# BCP-47 primary subtag → aksharamukha source-script name.
# Each Indic script maps 1:1 to one BCP-47 language in R5-2's scope;
# multi-language scripts (Devanagari for Sanskrit/Marathi/Nepali) are
# deferred — when added, they'll share this romanizer factory.
_INDIC_SCRIPTS = {
    "hi": "Devanagari",   # Hindi
    "bn": "Bengali",      # Bengali / Bangla
    "ta": "Tamil",
    "te": "Telugu",
    "gu": "Gujarati",
    "pa": "Gurmukhi",     # Punjabi
}


def _make_indic_romanizer(primary: str):
    """Return an Indic-script → IAST block romanizer.

    Uses aksharamukha.transliterate.process() under the hood.  The
    script-name argument is looked up in _INDIC_SCRIPTS.  The tail runs
    through _polish_romaji(capitalize=True) so sentence-initial letters
    are uppercased and fullwidth punctuation (rare in these scripts) is
    normalized.
    """
    from aksharamukha import transliterate as _akt  # lazy import
    source_script = _INDIC_SCRIPTS[primary]

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        out = _akt.process(source_script, "IAST", clean)
        return _polish_romaji(out or '', capitalize=True)

    return romanize


# ---------------------------------------------------------------------------
# R5-3: Brahmic per-akshara annotation (Hindi, Bengali, Tamil, Telugu,
# Gujarati, Punjabi)
# ---------------------------------------------------------------------------
#
# An akshara is the reading unit in Brahmic scripts — a consonant cluster
# (one or more consonants joined by virama) plus an optional attached
# vowel sign (matra) and modifiers (anusvara, visarga, candrabindu, nukta).
# Examples:
#   नमस्ते   (hi)  →  [न, म, स्ते]     (na, ma, ste)
#   क्या     (hi)  →  [क्या]           (kyā — single conjunct akshara)
#   নমস্কার  (bn)  →  [ন, ম, স্কা, র]  (na, ma, skā, ra)
#   வணக்கம்  (ta)  →  [வ, ண, க்க, ம்]  (va, ṇa, kka, m)
#
# Each akshara becomes one ruby span; its IAST reading is produced by
# aksharamukha on that single akshara (not the whole text) so ruby
# placement and reading boundaries line up.
#
# All six Brahmic scripts share the same block layout by offset from
# their block base codepoint:
#     offset 0x01–0x03  signs (anusvara, visarga, candrabindu)  [extender]
#     offset 0x05–0x14  independent vowels                      [starter]
#     offset 0x15–0x39  consonants                              [starter]
#     offset 0x3C       nukta                                   [extender]
#     offset 0x3E–0x4C  vowel signs (matras)                    [extender]
#     offset 0x4D       virama / halant                         [halant]
#     offset 0x51–0x57  accents                                 [extender]
#     offset 0x58–0x5F  additional consonants                   [starter]
#     offset 0x60–0x61  vocalic RR, LL (independent)            [starter]
#     offset 0x62–0x63  vocalic L, LL matras                    [extender]
#
# Script-specific extras (Devanagari OM at 0x0950, extended ranges
# 0x0972–0x097F, Bengali Khanda Ta at 0x09CE etc.) are handled
# conservatively — they either fall into an approximate class via the
# table above (close enough for reading purposes) or flow through as
# 'other' passthrough with no ruby annotation.  Breakdown is
# "degraded, not broken" for edge chars.

from dataclasses import dataclass as _brahmic_dataclass


@_brahmic_dataclass(frozen=True)
class _BrahmicBlock:
    """Metadata for a single Brahmic script block.

    The block base codepoint + a shared offset pattern gives us a
    unified akshara splitter across all six scripts in R5 scope.
    ``name`` is aksharamukha's source-script parameter name.
    """

    name: str
    base: int

    @property
    def virama(self) -> int:
        return self.base + 0x4D


_BRAHMIC_BLOCKS: dict[str, _BrahmicBlock] = {
    "hi": _BrahmicBlock("Devanagari", 0x0900),
    "bn": _BrahmicBlock("Bengali",    0x0980),
    "pa": _BrahmicBlock("Gurmukhi",   0x0A00),
    "gu": _BrahmicBlock("Gujarati",   0x0A80),
    "ta": _BrahmicBlock("Tamil",      0x0B80),
    "te": _BrahmicBlock("Telugu",     0x0C00),
}


def _classify_brahmic(cp: int, block: _BrahmicBlock) -> str:
    """Classify *cp* relative to *block* as 'starter', 'extender',
    'halant', or 'other'.  Uses block-relative offsets so the same
    logic works for all six Brahmic scripts."""
    if cp == block.virama:
        return "halant"
    off = cp - block.base
    if off < 0 or off > 0x7F:
        return "other"
    # Signs: anusvara, visarga, candrabindu
    if 0x01 <= off <= 0x03:
        return "extender"
    # Independent vowels (sparse in some scripts — gaps fall into 'other')
    if 0x05 <= off <= 0x14:
        return "starter"
    # Consonants
    if 0x15 <= off <= 0x39:
        return "starter"
    # Nukta
    if off == 0x3C:
        return "extender"
    # Matras (vowel signs)
    if 0x3E <= off <= 0x4C:
        return "extender"
    # Extended matras — includes Devanagari prishthamatra / awadhi matra.
    # Bengali's 0x09CE (Khanda Ta, offset 0x4E) is a standalone letter
    # form; classifying as extender means it sticks to its neighbor
    # akshara rather than standing alone — acceptable for reading, but
    # a Bengali linguistics-grade tool would want to special-case it.
    if 0x4E <= off <= 0x4F:
        return "extender"
    # OM sign — appears at different offsets per script (Devanagari 0x50,
    # Telugu 0x50, Gujarati 0x50, Tamil 0x50).  Treat as starter so it
    # gets its own annotation span when present.
    if off == 0x50:
        return "starter"
    # Accents: udatta, anudatta, stress, other
    if 0x51 <= off <= 0x57:
        return "extender"
    # Additional consonants (nukta-combined forms)
    if 0x58 <= off <= 0x5F:
        return "starter"
    # Vocalic RR, LL independent vowels
    if 0x60 <= off <= 0x61:
        return "starter"
    # Vocalic matras
    if 0x62 <= off <= 0x63:
        return "extender"
    # 0x64–0x7F: punctuation (danda at 0x64), digits (0x66–0x6F), and
    # script-specific letters (Devanagari extended range 0x72–0x7F).
    # Flow as 'other' — annotation unavailable but block romanization
    # still covers these via aksharamukha's block-level transliteration.
    return "other"


def _split_brahmic_aksharas(text: str, block: _BrahmicBlock) -> list:
    """Split *text* into (segment, is_akshara) spans for the given Brahmic
    *block*.  Aksharas become (akshara_str, True).  Non-Brahmic characters
    (Latin, digit, punctuation, whitespace) and out-of-block Brahmic chars
    become single (char, False) spans for downstream passthrough.
    """
    result: list = []
    current = ""
    prev_was_halant = False

    for ch in text:
        cls = _classify_brahmic(ord(ch), block)
        if cls == "starter":
            if current and prev_was_halant:
                # Conjunct: this starter attaches to the previous akshara
                # via the trailing virama.
                current += ch
                prev_was_halant = False
            else:
                if current:
                    result.append((current, True))
                current = ch
                prev_was_halant = False
        elif cls == "extender":
            if current:
                current += ch
            else:
                # Orphaned combining mark — degenerate text, pass through.
                result.append((ch, False))
            prev_was_halant = False
        elif cls == "halant":
            if current:
                current += ch
                prev_was_halant = True
            else:
                # Orphaned virama — degenerate text, pass through.
                result.append((ch, False))
                prev_was_halant = False
        else:  # 'other'
            if current:
                result.append((current, True))
                current = ""
            result.append((ch, False))
            prev_was_halant = False

    if current:
        result.append((current, True))
    return result


def _make_brahmic_annotation_func(primary: str):
    """Return a per-akshara annotation span producer for the given
    Brahmic-script language (``hi``/``bn``/``ta``/``te``/``gu``/``pa``).

    Each akshara gets its IAST reading produced by aksharamukha on that
    akshara alone.  Non-script characters (Latin loanwords, spaces,
    punctuation, digits) pass through with reading=None.
    """
    from aksharamukha import transliterate as _akt  # lazy import
    block = _BRAHMIC_BLOCKS[primary]

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        segments = _split_brahmic_aksharas(clean, block)
        spans = []
        for segment, is_akshara in segments:
            if is_akshara:
                reading = _akt.process(block.name, "IAST", segment)
                spans.append((segment, reading if reading else None))
            else:
                spans.append((segment, None))
        return spans

    return get_spans


# Backward-compatible alias: existing tests and any external callers import
# _split_devanagari_aksharas by name.  New code should call
# _split_brahmic_aksharas(text, _BRAHMIC_BLOCKS['hi']) directly.
def _split_devanagari_aksharas(text: str) -> list:
    return _split_brahmic_aksharas(text, _BRAHMIC_BLOCKS["hi"])


def _make_devanagari_annotation_func():
    return _make_brahmic_annotation_func("hi")


# ---------------------------------------------------------------------------
# R5-4 phase (a): Modern Hebrew block romanization
# ---------------------------------------------------------------------------
#
# RTL rendering is deferred to phase (b) — this commit ships the
# romanization layer only.  Hebrew is the R5-4 pilot (over Arabic)
# because its rendering story is much simpler: no contextual shaping,
# no cursive joining, well-tested bidi cooperation.
#
# Modern Hebrew subtitle text typically omits nikud (vowel diacritics).
# Without nikud, correct vowels are inferable only from context, which
# this module does not have — so the output is a *reading aid*, not a
# phonetic reference.  Documented tradeoffs:
#
#   * Begadkefat letters (ב כ פ) default to their soft/spirantized form
#     (v / kh / f) because Modern Hebrew subtitle text has no dagesh
#     mark to distinguish hard from soft.  A nikud-aware mode could do
#     better; punted.
#   * Vowel letters ו (vav) and י (yod) are treated as consonants when
#     they appear word-initially or after another vowel-letter, and as
#     vowels (o / i respectively) after a consonant.  This is the
#     simplest mater-lectionis rule that gets common words right
#     (שלום → shalom, עולם → olam, תודה → todah).
#   * A default "a" is inserted between consecutive consonants, since
#     "a" is the most common Modern Hebrew vowel in unpointed text.
#     This is wrong in many cases — "חברים" (chaverim) comes out as
#     "chavarim" — but produces recognizable output for common words.
#   * Silent letters (א ʔ, ע ʿ) map to empty string; a linguist would
#     use ʾ/ʿ but those don't read naturally to anglophone learners.
#   * Cantillation (te'amim) and nikud (U+0591-U+05C7) are stripped
#     before transliteration.  Everything outside the Hebrew block
#     passes through unchanged.

# Hebrew consonantal transliteration table.  Soft/spirantized defaults
# for begadkefat (ב=v, כ=kh, פ=f); silent letters א and ע map to "".
# Final-form letters (ם ן ף ץ ך) share the transliteration of their
# base form (Hebrew's final forms are graphical, not phonemic).
_HEBREW_CONSONANTS = {
    "א": "",    "ב": "v",   "ג": "g",   "ד": "d",   "ה": "h",
    "ז": "z",   "ח": "ch",  "ט": "t",   "כ": "kh",  "ך": "kh",
    "ל": "l",   "מ": "m",   "ם": "m",   "נ": "n",   "ן": "n",
    "ס": "s",   "ע": "",    "פ": "f",   "ף": "f",   "צ": "tz",
    "ץ": "tz",  "ק": "k",   "ר": "r",   "ש": "sh",  "ת": "t",
}

# Nikud (vowel points U+05B0-U+05BC, U+05C1-U+05C2, U+05C7) + cantillation
# marks (te'amim U+0591-U+05AF, U+05BD, U+05BF, U+05C0, U+05C3-U+05C6).
# The range U+0591-U+05C7 covers everything combining in the Hebrew block.
# Modern subtitles rarely carry these; strip before transliteration.
_HEBREW_COMBINING_RE = re.compile(r"[\u0591-\u05C7]")


def _hebrew_classify_letter(ch: str, prev_kind: str) -> tuple[str, str]:
    """Return ``(kind, output)`` for a Hebrew letter.

    ``kind`` is ``'cons'`` for consonants (including silent א / ע),
    ``'vowel'`` for ו / י acting as mater lectionis, or ``'other'`` for
    a character outside the Hebrew consonant set.

    Mater lectionis rule: ו / י are **consonantal** at word-start and
    after another vowel-letter (prev_kind != 'cons'), and **vocalic**
    (o / i) after a consonant.
    """
    if ch == "ו":
        return ("vowel", "o") if prev_kind == "cons" else ("cons", "v")
    if ch == "י":
        return ("vowel", "i") if prev_kind == "cons" else ("cons", "y")
    if ch in _HEBREW_CONSONANTS:
        return ("cons", _HEBREW_CONSONANTS[ch])
    return ("other", ch)


def _hebrew_romanize_word(letters: str) -> str:
    """Romanize a contiguous run of Hebrew letters.

    Applies mater lectionis classification, then a second pass that
    inserts a default 'a' between consecutive consonants (simulating
    Hebrew's most common unpointed vowel).  Operates on pre-stripped
    input — callers must remove nikud and split on non-Hebrew chars.
    """
    if not letters:
        return ""
    tokens: list[tuple[str, str]] = []
    prev_kind = "start"
    for ch in letters:
        kind, val = _hebrew_classify_letter(ch, prev_kind)
        tokens.append((kind, val))
        prev_kind = kind

    out: list[str] = []
    for i, (kind, val) in enumerate(tokens):
        out.append(val)
        if kind == "cons":
            next_kind = tokens[i + 1][0] if i + 1 < len(tokens) else None
            if next_kind == "cons":
                out.append("a")
    return "".join(out)


def _make_hebrew_romanizer():
    """Return a Modern Hebrew block romanizer.

    Segments input into Hebrew-letter runs and non-Hebrew passthrough
    runs; romanizes each Hebrew run with ``_hebrew_romanize_word``.
    Output flows through ``_polish_romaji(capitalize=True)`` for
    sentence-initial caps + punctuation normalization.
    """
    def _is_hebrew_letter(ch: str) -> bool:
        return ch in _HEBREW_CONSONANTS or ch in "וי"

    def romanize(text: str) -> str:
        if not text:
            return ""
        clean = _strip_ass(text)
        clean = _HEBREW_COMBINING_RE.sub("", clean)

        out: list[str] = []
        buf = ""
        for ch in clean:
            if _is_hebrew_letter(ch):
                buf += ch
            else:
                if buf:
                    out.append(_hebrew_romanize_word(buf))
                    buf = ""
                out.append(ch)
        if buf:
            out.append(_hebrew_romanize_word(buf))

        return _polish_romaji("".join(out), capitalize=True)

    return romanize


# ---------------------------------------------------------------------------
# R5-4 remaining: Arabic block romanization (Modern Standard Arabic)
# ---------------------------------------------------------------------------
#
# Design: "learner-academic hybrid" default (phonetic_system="learner"),
# with "din" (full DIN 31635) and "loose" (ASCII-only, no emphatic marks)
# as overrides.  The hybrid keeps the distinctions that matter for
# levelling up from Duolingo (emphatics ṣ ḍ ṭ ẓ ḥ, long vowels ā ī ū,
# ayn/hamza ʿ/ʾ) but uses digraphs for sounds with natural ASCII
# equivalents (sh, gh, th, dh, kh).  DIN uses š ġ ṯ ḏ ḫ for the same.
#
# Like Hebrew, Arabic subtitle text rarely carries tashkil (short vowel
# diacritics), so short vowel values must be guessed.  This module:
#   * Strips tashkil (fatḥa, kasra, ḍamma, shadda, sukūn, tanwīn,
#     superscript alif) before transliteration.
#   * Treats alif (ا) as long ā when medial/final and as "a"-carrier
#     when initial without hamza.
#   * Treats wāw (و) and yāʾ (ي) with a mater-lectionis rule: vocalic
#     (ū / ī) after a consonant, consonantal (w / y) at word-start or
#     after a vowel-letter — same rule that worked for Hebrew's ו / י.
#   * Inserts a default "a" between consecutive consonants.
#   * Handles the definite article ال with sun-letter assimilation:
#     14 sun letters (ت ث د ذ ر ز س ش ص ض ط ظ ل ن) cause lām to
#     assimilate and the following letter to double (الشمس → ash-shams).
#     14 moon letters keep al- unchanged (القمر → al-qamar).
#   * Silent hamza-carrier alif forms (أ إ) contribute their hamza + the
#     implied short vowel; wāw-hamza (ؤ) and yāʾ-hamza (ئ) emit bare ʾ.
#   * Final ة (tāʾ marbūṭa) emits pause-form "a" (not "at") — the
#     connective-form value is context-dependent and rarely needed for
#     subtitle reading aids.
#   * Alif maksūra (ى) emits long ā (same as regular alif in this role).
#
# Known failure modes (locked in tests so a future tashkil-aware or
# dictionary pass shows up as a clean regression signal):
#   * Unvocalized short vowels guessed as 'a' — e.g. "yadhhab" (he goes)
#     comes out as "yadhhab" only by luck; "yaktub" (he writes) comes
#     out as "yaktab" because the default-a heuristic doesn't know the
#     imperfect-prefix ya- pattern.
#   * No sun-letter assimilation for non-definite-article constructions
#     (it's only applied to the prefix ال).
#   * Loose mode drops ayn completely; a stricter reading would use
#     an apostrophe, but apostrophes interact badly with English-side
#     punctuation in mixed text.
#
# Output quality is "recognizable for common words" — same quality bar
# we accepted for Hebrew.  Real-content troubleshooting deferred to the
# browser extension phase (step 5) per the language-stacking feedback.

# Three transliteration tables keyed by phonetic_system.  Each maps an
# Arabic letter to its Roman output.  Missing keys (hamza carriers,
# matres) are handled by the classifier.
_ARABIC_CONSONANTS_LEARNER = {
    "ب": "b",   "ت": "t",   "ث": "th",  "ج": "j",   "ح": "ḥ",
    "خ": "kh",  "د": "d",   "ذ": "dh",  "ر": "r",   "ز": "z",
    "س": "s",   "ش": "sh",  "ص": "ṣ",   "ض": "ḍ",   "ط": "ṭ",
    "ظ": "ẓ",   "ع": "ʿ",   "غ": "gh",  "ف": "f",   "ق": "q",
    "ك": "k",   "ل": "l",   "م": "m",   "ن": "n",   "ه": "h",
    # Hamza-only carriers (no consonant body) emit ʾ.
    "ء": "ʾ",
    # Hamza-over-wāw and hamza-over-yāʾ act as pure hamza seats.
    "ؤ": "ʾ",   "ئ": "ʾ",
    # Final forms and letter variants Arabic shares with Persian/Urdu
    # passthrough context; keep values identical to their base forms.
    "ة": "a",          # tāʾ marbūṭa — pause form (most common in subtitles)
}

_ARABIC_CONSONANTS_DIN = {
    **_ARABIC_CONSONANTS_LEARNER,
    "ث": "ṯ",   "خ": "ḫ",   "ذ": "ḏ",   "ش": "š",   "غ": "ġ",
}

_ARABIC_CONSONANTS_LOOSE = {
    **_ARABIC_CONSONANTS_LEARNER,
    "ح": "h",   "ص": "s",   "ض": "d",   "ط": "t",   "ظ": "z",
    "ع": "",    "ء": "",    "ؤ": "",    "ئ": "",
}

_ARABIC_TABLES = {
    "learner": _ARABIC_CONSONANTS_LEARNER,
    "din":     _ARABIC_CONSONANTS_DIN,
    "loose":   _ARABIC_CONSONANTS_LOOSE,
}

# Long-vowel markers for each phonetic system.  DIN/learner use macrons;
# loose uses bare vowels (matching the "no diacritics" principle).
_ARABIC_LONG_VOWELS = {
    "learner": {"a": "ā", "i": "ī", "u": "ū"},
    "din":     {"a": "ā", "i": "ī", "u": "ū"},
    "loose":   {"a": "a", "i": "i", "u": "u"},
}

# Hamza output by phonetic system.
_ARABIC_HAMZA = {"learner": "ʾ", "din": "ʾ", "loose": ""}

# Sun letters: cause lām of the definite article to assimilate (lām is
# replaced by a copy of the following letter).  These are the 14 letters
# whose points of articulation are close enough to lām that Classical
# Arabic phonotactics collapse them.
_ARABIC_SUN_LETTERS = frozenset("تثدذرزسشصضطظلن")

# Tashkil (short-vowel marks + shadda + sukun + tanwin) + superscript
# alif (U+0670) + alif waṣla (U+0671 carrier treated like alif).
# Covers the main diacritic range; we strip before transliteration.
_ARABIC_COMBINING_RE = re.compile(r"[\u064B-\u065F\u0670]")

# Alif variants that carry a vowel + hamza: hamza-above-alif (أ) is an
# a- or u- initial vowel (defaults to a), hamza-below-alif (إ) is i-.
_ARABIC_HAMZA_ALIF_ABOVE = "أ"   # ʾa- by default
_ARABIC_HAMZA_ALIF_BELOW = "إ"   # ʾi-
_ARABIC_ALIF_MADDA = "آ"         # ʾā (alif with long-vowel carrier)
_ARABIC_ALIF = "ا"
_ARABIC_ALIF_MAKSURA = "ى"       # terminal alif variant — emits long ā
_ARABIC_WAW = "و"
_ARABIC_YA = "ي"
_ARABIC_TA_MARBUTA = "ة"
_ARABIC_LAM = "ل"

# Letters that combine with wāw/yāʾ into a short diphthong rather than a
# long vowel.  We render aw/ay in learner+din, aw/ay in loose too (since
# diphthongs are phonetically distinct from long ū/ī).


def _arabic_is_letter(ch: str, table: dict) -> bool:
    return (ch in table
            or ch in (_ARABIC_ALIF, _ARABIC_ALIF_MAKSURA, _ARABIC_WAW,
                      _ARABIC_YA, _ARABIC_HAMZA_ALIF_ABOVE,
                      _ARABIC_HAMZA_ALIF_BELOW, _ARABIC_ALIF_MADDA))


def _arabic_script_romanize_word(letters: str, *, table: dict,
                                 long_vowels: dict, hamza: str,
                                 default_short: str = "a",
                                 waw_cons: str = "w",
                                 ya_cons: str = "y",
                                 enable_sun_letter: bool = True) -> str:
    """Romanize a contiguous run of Arabic-script letters.

    Shared walker used by both Arabic (`_make_arabic_romanizer`) and
    Persian (`_make_persian_romanizer`).  Parameters let Persian override
    language-specific quirks:

      * ``default_short``: unwritten short vowel (Arabic 'a', Persian 'e').
      * ``waw_cons`` / ``ya_cons``: consonantal values for و / ی (Arabic
        'w'/'y', Persian 'v'/'y').
      * ``enable_sun_letter``: Persian uses the Arabic definite article
        only in Arabic loanwords, but the assimilation is still useful
        for those loans, so both languages default to True.

    Applies the definite-article ال / sun-letter assimilation at
    word-start, then walks letter-by-letter with the mater-lectionis
    rule for wāw/yāʾ and a default short vowel between consecutive
    consonants.
    """
    if not letters:
        return ""

    # --- Definite article ال handling -----------------------------------
    # Unified with the token walker so the default-short-vowel heuristic
    # applies across the article boundary (e.g. الشمس emits tokens 'a'
    # + cons 'sh-sh' + cons 'm' + cons 's', and the post-pass inserts
    # 'a' between each consecutive pair → "ash-shamas").
    tokens: list[tuple[str, str]] = []
    prev_kind: str = "start"
    body_start = 0

    if (enable_sun_letter
            and len(letters) >= 3
            and letters[0] == _ARABIC_ALIF
            and letters[1] == _ARABIC_LAM):
        next_letter = letters[2]
        if next_letter in _ARABIC_SUN_LETTERS:
            # Sun-letter assimilation: drop the lām, double the sun
            # letter (الشمس → ash-shams).
            sun_out = table.get(next_letter, next_letter)
            tokens.append(("vowel", "a"))
            tokens.append(("cons", sun_out + "-" + sun_out))
            prev_kind = "cons"
            body_start = 3
        else:
            # Moon letter: al- stays.  Emit as a single vowel token so
            # the next consonant does NOT get an short vowel inserted
            # before it (the lām of the article carries sukun).
            tokens.append(("vowel", "al-"))
            prev_kind = "vowel"
            body_start = 2

    # --- Main walker ----------------------------------------------------
    for i, ch in enumerate(letters[body_start:]):
        if ch in (_ARABIC_HAMZA_ALIF_ABOVE, _ARABIC_HAMZA_ALIF_BELOW):
            default_v = "i" if ch == _ARABIC_HAMZA_ALIF_BELOW else "a"
            tokens.append(("vowel", hamza + default_v))
            prev_kind = "vowel"
            continue
        if ch == _ARABIC_ALIF_MADDA:
            tokens.append(("long", hamza + long_vowels["a"]))
            prev_kind = "long"
            continue
        if ch == _ARABIC_ALIF:
            if prev_kind == "start":
                tokens.append(("vowel", "a"))
                prev_kind = "vowel"
            else:
                tokens.append(("long", long_vowels["a"]))
                prev_kind = "long"
            continue
        if ch == _ARABIC_ALIF_MAKSURA:
            tokens.append(("long", long_vowels["a"]))
            prev_kind = "long"
            continue
        if ch == _ARABIC_WAW:
            if prev_kind == "start":
                tokens.append(("cons", waw_cons))
                prev_kind = "cons"
            elif prev_kind == "cons":
                tokens.append(("long", long_vowels["u"]))
                prev_kind = "long"
            else:
                tokens.append(("cons", waw_cons))
                prev_kind = "cons"
            continue
        if ch == _ARABIC_YA:
            if prev_kind == "start":
                tokens.append(("cons", ya_cons))
                prev_kind = "cons"
            elif prev_kind == "cons":
                tokens.append(("long", long_vowels["i"]))
                prev_kind = "long"
            else:
                tokens.append(("cons", ya_cons))
                prev_kind = "cons"
            continue
        if ch == _ARABIC_TA_MARBUTA:
            tokens.append(("vowel", "a"))
            prev_kind = "vowel"
            continue
        if ch == "ھ":
            # Urdu heh doachashmee (U+06BE) is an aspiration marker: it
            # combines with the preceding consonant (بھ→bh, ڈھ→ḍh,
            # ٹھ→ṭh).  Safe no-op for Arabic/Persian — the codepoint
            # doesn't appear in those languages' text.
            if tokens and tokens[-1][0] == "cons":
                _, prev_val = tokens[-1]
                tokens[-1] = ("cons", prev_val + "h")
            else:
                tokens.append(("cons", "h"))
                prev_kind = "cons"
            continue
        if ch == "ے":
            # Urdu yeh barree (U+06D2) is a tall-yeh variant used for
            # final /eː/.  Emit as long vowel using the table's 'e' key
            # if present, else fall back to plain 'e'.
            tokens.append(("long", long_vowels.get("e", "e")))
            prev_kind = "long"
            continue
        if ch in table:
            tokens.append(("cons", table[ch]))
            prev_kind = "cons"
            continue
        tokens.append(("other", ch))
        prev_kind = "other"

    # --- Second pass: insert default short vowel between consecutive cons
    out: list[str] = []
    for i, (kind, val) in enumerate(tokens):
        out.append(val)
        if kind == "cons":
            next_kind = tokens[i + 1][0] if i + 1 < len(tokens) else None
            if next_kind == "cons":
                out.append(default_short)

    return "".join(out)


def _make_arabic_romanizer(phonetic_system: str = "learner"):
    """Return an Arabic block romanizer for the given phonetic system.

    Segments input into Arabic-letter runs and non-Arabic passthrough
    runs; romanizes each Arabic run via the shared walker.  Output
    flows through ``_polish_romaji(capitalize=True)``.
    """
    if phonetic_system not in _ARABIC_TABLES:
        phonetic_system = "learner"
    table = _ARABIC_TABLES[phonetic_system]
    long_vowels = _ARABIC_LONG_VOWELS[phonetic_system]
    hamza = _ARABIC_HAMZA[phonetic_system]

    def _is_arabic_letter(ch: str) -> bool:
        return _arabic_is_letter(ch, table)

    def romanize(text: str) -> str:
        if not text:
            return ""
        clean = _strip_ass(text)
        clean = _ARABIC_COMBINING_RE.sub("", clean)

        out: list[str] = []
        buf = ""
        for ch in clean:
            if _is_arabic_letter(ch):
                buf += ch
            else:
                if buf:
                    out.append(_arabic_script_romanize_word(
                        buf, table=table, long_vowels=long_vowels,
                        hamza=hamza, default_short="a",
                        waw_cons="w", ya_cons="y"))
                    buf = ""
                out.append(ch)
        if buf:
            out.append(_arabic_script_romanize_word(
                buf, table=table, long_vowels=long_vowels,
                hamza=hamza, default_short="a",
                waw_cons="w", ya_cons="y"))

        return _polish_romaji("".join(out), capitalize=True)

    return romanize


# ---------------------------------------------------------------------------
# R5-4 remaining: Persian (fa) block romanization
# ---------------------------------------------------------------------------
#
# Persian uses the Arabic script extended with 4 letters (پ چ ژ گ) and
# two codepoint variants (Persian yeh ی U+06CC, Persian keheh ک U+06A9)
# that the Arabic tables don't carry.  Beyond the letter set, the key
# differences from Arabic are:
#
#   * Phonology collapses the Arabic emphatic series.  Persian speakers
#     pronounce ص and س identically (both /s/); ح and ه are both /h/;
#     ث is /s/ not /θ/; ذ is /z/; ط is /t/; ظ is /z/; ض is /z/.
#     In "learner" mode we reflect actual Persian pronunciation and
#     drop the emphatic marks.  In "dmg" (Deutsche Morgenländische
#     Gesellschaft — the scholarly standard) we preserve the marks so
#     Arabic etymology remains visible.
#   * و is typically /v/ or /u/ or /o/ — consonantal /v/ at word-start
#     or after a vowel, /u/~/o/ when serving as mater.  We emit 'v' at
#     start and "ū" after a consonant (long-ū mater).
#   * Persian has no grammatical definite article (ال is present only
#     in Arabic loanwords), but sun-letter assimilation is still applied
#     for those loans to keep output legible.
#   * The default unwritten short vowel in Persian is /e/ more often
#     than /a/, but a statistical preference doesn't outweigh the
#     consistency win of keeping 'a' the default across both Arabic and
#     Persian.  Known-wrong cases are locked in tests; a future
#     dictionary pass can flip them.
#
# Persian's unvocalized-text problem is the same as Arabic's and Hebrew's
# — short vowels, ezāfe (-e / -ye genitive construct), and diphthongs
# must be guessed without tashkil.  Output quality is "recognizable for
# common words"; real-content troubleshooting deferred to step 5.

# Persian-specific extra letters beyond the Arabic set.
_PERSIAN_EXTRA_LEARNER = {
    "پ": "p",
    "چ": "ch",
    "ژ": "zh",
    "گ": "g",
}

_PERSIAN_EXTRA_DMG = {
    "پ": "p",
    "چ": "č",
    "ژ": "ž",
    "گ": "g",
}

# Persian collapses the Arabic emphatic series in actual pronunciation.
# learner mode reflects this; dmg preserves the scholarly marks.
_PERSIAN_COLLAPSE_LEARNER = {
    "ث": "s",   "ح": "h",   "ذ": "z",   "ص": "s",   "ض": "z",
    "ط": "t",   "ظ": "z",   "ع": "",    "ق": "q",   "غ": "gh",
    # ء stays as ʾ for syllable-break hinting (same as Arabic learner);
    # seated hamza-over-wāw / hamza-over-yāʾ emit bare ʾ too.
    "ء": "ʾ",   "ؤ": "ʾ",   "ئ": "ʾ",
}

# Persian "learner" consonant table: Arabic learner base with Persian
# collapses + 4 Persian-extra letters.  Also add Persian codepoint
# variants for yeh/kaf/heh so both Unicode sequences work.
_PERSIAN_CONSONANTS_LEARNER = {
    **_ARABIC_CONSONANTS_LEARNER,
    **_PERSIAN_COLLAPSE_LEARNER,
    **_PERSIAN_EXTRA_LEARNER,
    # Persian keheh ک (U+06A9) — same sound as Arabic kāf ك.
    "ک": "k",
    # Persian he variants U+06C0, U+06C1 — same as ه.
    "ہ": "h",   "ۀ": "h",
}

# Persian "dmg" consonant table: Arabic DIN base with Persian-extra letters.
_PERSIAN_CONSONANTS_DMG = {
    **_ARABIC_CONSONANTS_DIN,
    **_PERSIAN_EXTRA_DMG,
    "ک": "k",
    "ہ": "h",   "ۀ": "h",
}

_PERSIAN_TABLES = {
    "learner": _PERSIAN_CONSONANTS_LEARNER,
    "dmg":     _PERSIAN_CONSONANTS_DMG,
}

_PERSIAN_LONG_VOWELS = {
    "learner": {"a": "ā", "i": "ī", "u": "ū"},
    "dmg":     {"a": "ā", "i": "ī", "u": "ū"},
}

_PERSIAN_HAMZA = {"learner": "ʾ", "dmg": "ʾ"}

# Persian-specific codepoints that must be recognized as letters (so the
# romanizer doesn't split words on them).  Arabic yeh ي and Persian yeh ی
# are visually similar but have different Unicode points; subtitle files
# in the wild mix them freely.
_PERSIAN_LETTER_EXTRAS = frozenset("پچژگکیہۀ")


def _persian_is_letter(ch: str, table: dict) -> bool:
    if _arabic_is_letter(ch, table):
        return True
    return ch in _PERSIAN_LETTER_EXTRAS


# Map Persian yeh (U+06CC) → Arabic yeh (U+064A) before the walker so the
# `ch == _ARABIC_YA` branch handles both forms uniformly.  Same for
# Persian alif maksura variant.
_PERSIAN_NORMALIZE = str.maketrans({
    "ی": _ARABIC_YA,       # Persian yeh → Arabic yeh (for mater rule)
    "ک": "ک",              # leave Persian keheh in place (table has it)
})


def _make_persian_romanizer(phonetic_system: str = "learner"):
    """Return a Persian block romanizer for the given phonetic system.

    Reuses the Arabic shared walker (`_arabic_script_romanize_word`)
    with Persian-specific tables, consonantal /v/ for و, and the same
    default short-vowel 'a' as Arabic.  Persian yeh (U+06CC) is
    normalized to Arabic yeh (U+064A) before the walker so the mater
    rule handles both forms uniformly.
    """
    if phonetic_system not in _PERSIAN_TABLES:
        phonetic_system = "learner"
    table = _PERSIAN_TABLES[phonetic_system]
    long_vowels = _PERSIAN_LONG_VOWELS[phonetic_system]
    hamza = _PERSIAN_HAMZA[phonetic_system]

    def _is_letter(ch: str) -> bool:
        return _persian_is_letter(ch, table)

    def romanize(text: str) -> str:
        if not text:
            return ""
        clean = _strip_ass(text)
        clean = _ARABIC_COMBINING_RE.sub("", clean)
        clean = clean.translate(_PERSIAN_NORMALIZE)

        out: list[str] = []
        buf = ""
        for ch in clean:
            if _is_letter(ch):
                buf += ch
            else:
                if buf:
                    out.append(_arabic_script_romanize_word(
                        buf, table=table, long_vowels=long_vowels,
                        hamza=hamza, default_short="a",
                        waw_cons="v", ya_cons="y"))
                    buf = ""
                out.append(ch)
        if buf:
            out.append(_arabic_script_romanize_word(
                buf, table=table, long_vowels=long_vowels,
                hamza=hamza, default_short="a",
                waw_cons="v", ya_cons="y"))

        return _polish_romaji("".join(out), capitalize=True)

    return romanize


# ---------------------------------------------------------------------------
# R5-4 remaining: Urdu (ur) block romanization
# ---------------------------------------------------------------------------
#
# Urdu uses the Arabic script extended with Persian's 4 letters
# (پ چ ژ گ), the codepoint variants Persian contributes (ی ک),
# and 5 Urdu-specific additions:
#
#   * ٹ (U+0679) Tteh      — retroflex t (ṭ)
#   * ڈ (U+0688) Ddal      — retroflex d (ḍ)
#   * ڑ (U+0691) Rreh      — retroflex r (ṛ)
#   * ں (U+06BA) Noon ghunna — nasalization of preceding vowel
#   * ے (U+06D2) Yeh barree — final long /eː/
#
# Plus the aspiration marker ھ (U+06BE heh doachashmee), which is NOT
# a standalone consonant — it combines with the preceding consonant
# to form aspirated pairs (بھ → bh, ٹھ → ṭh, ڑھ → ṛh, etc.).  The
# shared walker handles ھ by mutating the most recent consonant token;
# handling is wired unconditionally so Arabic/Persian text with a
# stray ھ produces reasonable output too.
#
# Two phonetic systems per the "Duolingo-to-academic hybrid" sign-off:
#
#   * learner (default): Hunterian-lite.  Retroflexes marked with
#     underdots (ṭ ḍ ṛ); aspirates emit as digraphs (bh dh gh kh ph th
#     ṭh ḍh ṛh); Arabic emphatic marks collapse to Persian phonology
#     (ص→s, ح→h, ع→silent); nun ghunnah ں emits as plain "n"; yeh
#     barree ے emits as "e".
#   * ala-lc (ALA-LC, library scholarly): preserves Arabic emphatic
#     marks (ṣ ḍ ṭ ẓ ḥ); nun ghunnah uses combining candrabindu (n̐);
#     yeh barree uses long ē with macron.  Persian's č / ž / š / ġ
#     scholarly digraphs also carry over.
#
# Known limitations (locked in tests) inherit from the Arabic/Persian
# no-tashkil situation: short vowels, ezāfe, and ya/waw mater vs.
# diphthong disambiguation must be guessed.  Aspirate handling is a
# new failure surface: a ھ that appears after a vowel letter (rare
# but legal in Urdu) currently emits as a standalone 'h' rather than
# merging, because there's no preceding consonant token to combine.

# Urdu retroflex set — shared between learner and ala-lc since the
# transliteration convention (underdot) is stable across both.
_URDU_RETROFLEXES = {
    "ٹ": "ṭ",   # U+0679 Tteh
    "ڈ": "ḍ",   # U+0688 Ddal
    "ڑ": "ṛ",   # U+0691 Rreh
}

# Urdu learner table: Persian learner (collapsed emphatics) + retroflexes
# + nun ghunnah as plain 'n'.
_URDU_CONSONANTS_LEARNER = {
    **_PERSIAN_CONSONANTS_LEARNER,
    **_URDU_RETROFLEXES,
    "ں": "n",   # U+06BA noon ghunnah → plain n (learner)
}

# Urdu ala-lc table: Persian dmg base + retroflexes + nun-with-candrabindu.
# The combining candrabindu (U+0310) attaches to the prior vowel; we
# emit "n̐" as a two-codepoint sequence so it renders as nasalized n.
_URDU_CONSONANTS_ALA_LC = {
    **_PERSIAN_CONSONANTS_DMG,
    **_URDU_RETROFLEXES,
    "ں": "n\u0310",
}

_URDU_TABLES = {
    "learner": _URDU_CONSONANTS_LEARNER,
    "ala-lc":  _URDU_CONSONANTS_ALA_LC,
}

# Long vowel table extended with 'e' for yeh barree.  Learner uses
# bare 'e'; ala-lc uses 'ē' with macron to mark length.
_URDU_LONG_VOWELS = {
    "learner": {"a": "ā", "i": "ī", "u": "ū", "e": "e"},
    "ala-lc":  {"a": "ā", "i": "ī", "u": "ū", "e": "ē"},
}

_URDU_HAMZA = {"learner": "ʾ", "ala-lc": "ʾ"}

# Urdu-specific letter set that the classifier must recognize.
# Includes ھ (heh doachashmee) — the walker special-cases it as an
# aspiration marker, but the letter classifier must first admit it
# into the word-buffer so it reaches the walker.
_URDU_LETTER_EXTRAS = frozenset("ٹڈڑںےھ")


def _urdu_is_letter(ch: str, table: dict) -> bool:
    if _persian_is_letter(ch, table):
        return True
    return ch in _URDU_LETTER_EXTRAS


def _make_urdu_romanizer(phonetic_system: str = "learner"):
    """Return an Urdu block romanizer for the given phonetic system.

    Reuses the Arabic/Persian shared walker with Urdu-specific tables.
    Aspiration marker ھ is handled unconditionally by the walker.
    """
    if phonetic_system not in _URDU_TABLES:
        phonetic_system = "learner"
    table = _URDU_TABLES[phonetic_system]
    long_vowels = _URDU_LONG_VOWELS[phonetic_system]
    hamza = _URDU_HAMZA[phonetic_system]

    def _is_letter(ch: str) -> bool:
        return _urdu_is_letter(ch, table)

    def romanize(text: str) -> str:
        if not text:
            return ""
        clean = _strip_ass(text)
        clean = _ARABIC_COMBINING_RE.sub("", clean)
        # Persian-yeh → Arabic-yeh normalization applies to Urdu too.
        clean = clean.translate(_PERSIAN_NORMALIZE)

        out: list[str] = []
        buf = ""
        for ch in clean:
            if _is_letter(ch):
                buf += ch
            else:
                if buf:
                    out.append(_arabic_script_romanize_word(
                        buf, table=table, long_vowels=long_vowels,
                        hamza=hamza, default_short="a",
                        waw_cons="v", ya_cons="y"))
                    buf = ""
                out.append(ch)
        if buf:
            out.append(_arabic_script_romanize_word(
                buf, table=table, long_vowels=long_vowels,
                hamza=hamza, default_short="a",
                waw_cons="v", ya_cons="y"))

        return _polish_romaji("".join(out), capitalize=True)

    return romanize


def _thai_tokenize(text: str) -> list:
    """Hybrid Thai tokenizer: word boundaries + syllable split for compounds.

    Two-pass approach:
      1. ``word_tokenize(engine='newmm')`` for correct word boundaries.
      2. Any token with >6 Thai characters (likely a compound/idiom) is
         further split via ``syllable_tokenize()`` to produce annotation-
         friendly granularity.

    Both ``_make_thai_romanizer()`` and ``_make_thai_annotation_func()`` use
    this function so that block romanization and ruby annotation produce
    consistent word boundaries.
    """
    from pythainlp.tokenize import word_tokenize, syllable_tokenize

    _THAI_CHAR_THRESHOLD = 6
    word_tokens = word_tokenize(text, engine='newmm')
    result = []
    for t in word_tokens:
        thai_chars = sum(1 for c in t if '\u0E01' <= c <= '\u0E5B')
        if thai_chars > _THAI_CHAR_THRESHOLD:
            result.extend(syllable_tokenize(t))
        else:
            result.append(t)
    return result


def _has_thai(token: str) -> bool:
    """Return True if *token* contains any Thai script character."""
    return any('\u0E01' <= c <= '\u0E5B' for c in token)


def _normalize_thai(text: str) -> str:
    """Normalize decomposed Thai forms before tokenization.

    Some subtitle sources use the decomposed sara am sequence
    (nikhahit U+0E4D + sara aa U+0E32) instead of the composed
    sara am (U+0E33).  pythainlp can't handle the decomposed form.
    """
    return text.replace('\u0e4d\u0e32', '\u0e33')


# ---------------------------------------------------------------------------
# Thai Paiboon+ tone diacritics
# ---------------------------------------------------------------------------

# Tone letter → combining diacritic.  Mid tone is unmarked (standard
# linguistic convention — reduces visual clutter on the most common tone).
_THAI_TONE_DIACRITICS = {
    'm': '',          # mid  — unmarked
    'l': '\u0300',    # low  → combining grave accent    (à)
    'f': '\u0302',    # falling → combining circumflex   (â)
    'h': '\u0301',    # high → combining acute accent    (á)
    'r': '\u030C',    # rising → combining caron          (ǎ)
}

# Special-case lookup for tokens that no pythainlp engine handles correctly.
# Keys are Thai tokens; values are pre-computed Paiboon+ romanizations
# (vowel remapping + tone diacritic already applied).
_THAI_SPECIAL_CASES: dict[str, str] = {
    '\u0e01\u0e47': 'k\u0254\u0302',   # ก็ → kɔ̂  (common particle)
}

# RTGS vowel digraphs → Paiboon-style IPA vowels.
# Note: RTGS does not distinguish /o/ from /ɔ/ — both are written "o".
# Only unambiguous mappings are included.
_PAIBOON_VOWEL_SUBS = [
    ('ae', 'ɛ'),     # /ɛ/ — open-mid front unrounded
    ('ue', 'ɯ'),     # /ɯ/ — close back unrounded
]


def _add_tone_diacritic(romanized: str, tone: str) -> str:
    """Place a combining tone diacritic on the first vowel of a romanized syllable.

    Mid tone is left unmarked (standard convention, reduces visual clutter on
    the most frequent Thai tone).
    """
    if not tone or tone not in _THAI_TONE_DIACRITICS:
        return romanized
    diacritic = _THAI_TONE_DIACRITICS[tone]
    if not diacritic:
        return romanized
    for i, c in enumerate(romanized):
        if c.lower() in 'aeiouɛɔɯ':
            return romanized[:i + 1] + diacritic + romanized[i + 1:]
    return romanized


def _paiboon_remap_vowels(rom: str) -> str:
    """Map RTGS vowel digraphs to Paiboon-style IPA vowels."""
    for old, new in _PAIBOON_VOWEL_SUBS:
        rom = rom.replace(old, new)
    return rom


def _compact_thaig2p(raw: str) -> str:
    """Compact pythainlp's ``thaig2p`` transliterate output.

    ``thaig2p`` emits phonemes space-separated and syllables dot-separated
    with IPA tone contour marks, e.g.::

        's a ˧ . w a t̚ ˨˩ . d iː ˧'

    We want a compact, readable form::

        'sa˧.wat̚˨˩.diː˧'

    Loanwords may produce empty tone slots (``'t͡ɕ ɔː  . d ɔː ˧'``) — those
    just drop out cleanly since we strip whitespace per syllable and
    filter empty segments.
    """
    if not raw:
        return raw
    syllables = [''.join(s.split()) for s in raw.split('.')]
    return '.'.join(s for s in syllables if s)


# Probed lazily on first use and cached — both functions below read it
# via the lru_cache. ``thaig2p`` is pythainlp's real Thai→IPA engine
# (neural g2p with tone contours). It needs a one-time ~12MB corpus
# download on first use; if that fails or the engine is otherwise
# unavailable we fall back to ``thai2rom`` (RTGS-ish, no tones — still
# a legible transliteration).
@functools.lru_cache(maxsize=1)
def _detect_thai_ipa_engine() -> tuple[str, str]:
    """Return ``(function_name, engine_name)``: either
    ``('transliterate', 'thaig2p')`` for real IPA, or
    ``('romanize', 'thai2rom')`` as a degraded-but-legible fallback.

    The previous implementation probed ``romanize(engine='ipa')`` which
    accepts the name but silently falls back to the broken ``royin``
    engine — it mangles consonant clusters (ครับ → ``'khnap'`` instead of
    ``'kʰrap̚˦˥'``). This is why Thai IPA output was worthless before.
    """
    try:
        from pythainlp.transliterate import transliterate as _translit
        # Triggers the one-time corpus download on fresh installs.
        out = _translit('\u0e01', engine='thaig2p')
        if out and out.strip():
            return ('transliterate', 'thaig2p')
    except Exception:
        pass
    return ('romanize', 'thai2rom')


def _make_thai_romanizer():
    """Return a Thai Royal Institute romanization function.

    Uses pythainlp with engine="thai2rom" — produces RTGS-compatible output
    with correct consonant clusters (the native ``royin`` engine mangles
    clusters like กล→kn, ปร→pn).  Tokenizes first via ``_thai_tokenize()``,
    romanizes each token, then joins with spaces.
    """
    from pythainlp.transliterate import romanize as _thai_romanize

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        parts = []
        for token in tokens:
            if _has_thai(token):
                parts.append(_thai_romanize(token, engine='thai2rom'))
            elif token.strip():
                parts.append(token)
        return _polish_romaji(' '.join(p for p in parts if p.strip()),
                              capitalize=False)

    return romanize


def _make_thai_annotation_func():
    """Return a Thai per-token annotation span producer.

    Uses ``_thai_tokenize()`` (shared with the block romanizer) to segment
    Thai text, then romanizes each token via ``thai2rom`` engine (RTGS-compatible
    output with correct consonant clusters).
    Non-Thai tokens (Latin, numerals, spaces) pass through with reading=None.
    """
    from pythainlp.transliterate import romanize as _thai_romanize

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        spans = []
        for token in tokens:
            if not token.strip():
                spans.append((token, None))
            elif _has_thai(token):
                rom = _thai_romanize(token, engine='thai2rom')
                spans.append((token, rom if rom else None))
            else:
                spans.append((token, None))
        return spans

    return get_spans


def _make_thai_paiboon_romanizer():
    """Return a Paiboon+-style Thai romanizer with tone diacritics.

    Uses ``thai2rom`` engine as the base (the native ``royin`` engine mangles
    consonant clusters like กล→kn), then layers per-syllable tone information
    on top as combining diacritics on the vowel nucleus.  Mid tone is unmarked.

    Vowel digraphs are remapped to Paiboon equivalents: ae→ɛ, ue→ɯ.
    Syllables within multi-syllabic words are joined with hyphens.
    """
    from pythainlp.transliterate import romanize as _thai_romanize
    from pythainlp.tokenize import syllable_tokenize
    from pythainlp.util import tone_detector

    def _romanize_syllable(syl):
        if syl in _THAI_SPECIAL_CASES:
            return _THAI_SPECIAL_CASES[syl]
        rom = _thai_romanize(syl, engine='thai2rom')
        rom = _paiboon_remap_vowels(rom)
        try:
            tone = tone_detector(syl)
        except (IndexError, Exception):
            import logging
            logging.debug("tone_detector fallback to mid tone for fragment: %r", syl)
            tone = 'm'
        return _add_tone_diacritic(rom, tone)

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        parts = []
        for token in tokens:
            if _has_thai(token):
                # Check whole-token special case before syllable splitting
                if token in _THAI_SPECIAL_CASES:
                    parts.append(_THAI_SPECIAL_CASES[token])
                    continue
                syllables = syllable_tokenize(token)
                syl_parts = [_romanize_syllable(s) for s in syllables if s.strip()]
                if syl_parts:
                    parts.append('-'.join(syl_parts))
            elif token.strip():
                parts.append(token)
        return _polish_romaji(' '.join(p for p in parts if p.strip()),
                              capitalize=False)

    return romanize


def _make_thai_paiboon_annotation_func():
    """Return a Paiboon+ per-token annotation span producer with tone diacritics.

    Uses ``_thai_tokenize()`` (shared with the block romanizer) to segment
    Thai text, then romanizes each token with per-syllable Paiboon+ diacritics.
    """
    from pythainlp.transliterate import romanize as _thai_romanize
    from pythainlp.tokenize import syllable_tokenize
    from pythainlp.util import tone_detector

    def _romanize_token(token):
        if token in _THAI_SPECIAL_CASES:
            return _THAI_SPECIAL_CASES[token]
        syllables = syllable_tokenize(token)
        syl_parts = []
        for s in syllables:
            if not s.strip():
                continue
            if s in _THAI_SPECIAL_CASES:
                syl_parts.append(_THAI_SPECIAL_CASES[s])
                continue
            rom = _thai_romanize(s, engine='thai2rom')
            rom = _paiboon_remap_vowels(rom)
            try:
                tone = tone_detector(s)
            except (IndexError, Exception):
                import logging
                logging.debug("tone_detector fallback to mid tone for fragment: %r", s)
                tone = 'm'
            syl_parts.append(_add_tone_diacritic(rom, tone))
        return '-'.join(syl_parts) if syl_parts else ''

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        spans = []
        for token in tokens:
            if not token.strip():
                spans.append((token, None))
            elif _has_thai(token):
                rom = _romanize_token(token)
                spans.append((token, rom if rom else None))
            else:
                spans.append((token, None))
        return spans

    return get_spans


def _thai_ipa_call(token: str) -> str:
    """Transliterate a single Thai token to compact IPA, using the
    detected best-available engine. Empty/whitespace tokens return ''.
    """
    func_name, engine = _detect_thai_ipa_engine()
    if func_name == 'transliterate':
        from pythainlp.transliterate import transliterate as _translit
        raw = _translit(token, engine=engine)
        return _compact_thaig2p(raw) if raw else ''
    # Fallback: thai2rom via romanize — loses tones but consonants right.
    from pythainlp.transliterate import romanize as _thai_romanize
    return _thai_romanize(token, engine=engine) or ''


def _make_thai_ipa_romanizer():
    """Return a Thai IPA romanizer.

    Uses pythainlp's ``thaig2p`` (neural grapheme-to-phoneme) engine via
    ``transliterate()`` — emits real IPA with tone contour marks
    (˥˦˧˨˩). Falls back to ``thai2rom`` (RTGS-ish, no tones) when
    ``thaig2p`` is unavailable.
    """
    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        parts = []
        for token in tokens:
            if _has_thai(token):
                ipa = _thai_ipa_call(token)
                if ipa:
                    parts.append(ipa)
            elif token.strip():
                parts.append(token)
        return _polish_romaji(' '.join(p for p in parts if p.strip()),
                              capitalize=False)

    return romanize


def _make_thai_ipa_annotation_func():
    """Return a Thai IPA per-token annotation span producer."""
    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        spans = []
        for token in tokens:
            if not token.strip():
                spans.append((token, None))
            elif _has_thai(token):
                ipa = _thai_ipa_call(token)
                spans.append((token, ipa if ipa else None))
            else:
                spans.append((token, None))
        return spans

    return get_spans


def _apply_thai_word_boundaries(text: str) -> str:
    """Insert thin spaces (U+2009) at word boundaries in Thai text.

    Gives learners word segmentation cues without breaking Thai script
    rendering (Thai script shaping is not contextual — spaces don't alter
    glyph forms).  Only inserts thin spaces between consecutive non-whitespace
    tokens; existing whitespace is preserved.
    """
    if not text or not _has_thai(text):
        return text
    clean = _normalize_thai(_strip_ass(text))
    tokens = _thai_tokenize(clean)
    parts = []
    for i, token in enumerate(tokens):
        if i > 0 and token.strip() and parts and parts[-1].strip():
            parts.append('\u2009')
        parts.append(token)
    return ''.join(parts)


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
    get_japanese_pipeline() to share one MeCab tagger instance.

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
        # Auto-detect from variant — same routing as get_romanizer:
        #   zh-HK → Jyutping (HK = Cantonese in practice)
        #   zh-Hant / zh-TW → Zhuyin (Taiwan)
        #   everything else → Pinyin
        lc = (lang_code or "").lower()
        if lc == "zh-hk":
            return _make_jyutping_annotation_func()
        if lc in ("zh-hant", "zh-tw"):
            return _make_zhuyin_annotation_func()
        return _make_chinese_annotation_func()

    # R4 — per-word/per-token annotation for alphabetic scripts
    if primary == "ko":
        return _make_korean_annotation_func()

    if primary in _CYRILLIC_LANG_CODES:
        return _make_cyrillic_annotation_func(primary)

    if primary == "th":
        if system == "paiboon":
            return _make_thai_paiboon_annotation_func()
        if system == "ipa":
            return _make_thai_ipa_annotation_func()
        return _make_thai_annotation_func()  # RTGS default

    # R5-3 — Brahmic per-akshara annotation (shared splitter across
    # the six Indic scripts shipped in R5-2).
    if primary in _BRAHMIC_BLOCKS:
        return _make_brahmic_annotation_func(primary)

    return None


# ---------------------------------------------------------------------------
# Word-level tokens for per-word vocab lookup (VOCAB_LOOKUP.md Phase 0)
# ---------------------------------------------------------------------------
# get_annotation_func() produces per-token (Japanese) / per-character (Chinese)
# annotation SPANS.  build_word_tokens() groups those spans into WORDS — the
# clickable unit for the /define dictionary lookup — carrying the dictionary
# lemma + POS the JA pipeline already computes, the jieba word boundaries the ZH
# romanizer already knows, and (Phase 3) the kiwipiepy morphology the Korean
# analyzer provides.  Japanese, Chinese (all variants) and Korean produce
# tokens; every other language returns [].
#
# A token is a 6-tuple: (word, lemma_or_None, pos_list, reading_or_None,
# span_start, span_length) where spans[span_start : span_start + span_length]
# compose the word.

_t2s_converter = None


def _get_t2s():
    """Lazily-built, cached OpenCC Traditional→Simplified converter (jieba's
    dict is Simplified-oriented).  Cached so per-line token building across a
    batch doesn't reconstruct it each call."""
    global _t2s_converter
    if _t2s_converter is None:
        import opencc  # lazy
        _t2s_converter = opencc.OpenCC('t2s')
    return _t2s_converter


def _jieba_words(clean: str, *, traditional: bool = False) -> list:
    """Word boundaries for `clean` as surface slices of the ORIGINAL text.

    Mirrors the segmentation inside _make_pinyin_romanizer (incl. the
    Traditional→Simplified round-trip that maps boundaries back onto the
    original characters) but kept SEPARATE so the live romanize output is never
    touched.  Concatenation of the returned words == `clean`."""
    if not clean:
        return []
    import jieba  # lazy
    import logging as _logging
    _logging.getLogger('jieba').setLevel(_logging.WARNING)
    if traditional:
        simplified = _get_t2s().convert(clean)
        seg = list(jieba.cut(simplified))
        words = []
        pos = 0
        for sw in seg:
            words.append(clean[pos:pos + len(sw)])
            pos += len(sw)
        return words
    return list(jieba.cut(clean))


def _is_lookupable_word(s: str) -> bool:
    """True for a word worth a dictionary affordance — excludes pure
    punctuation / whitespace runs (which get no clickable token)."""
    return any(c.isalnum() or _is_cjk(c) for c in s)


def _clean_ja_lemma(lemma: "str | None") -> "str | None":
    """UniDic lemmas sometimes carry a '-<disambiguator>' suffix (私 → 私-代名詞)
    that would miss a JMdict headword lookup; strip it (real Japanese lemmas
    contain no ASCII hyphen)."""
    if not lemma:
        return None
    return lemma.split('-', 1)[0] or None


def _japanese_tokens(spans: list, annotation_func) -> list:
    """Group MeCab morpheme spans into WORD tokens (VOCAB_LOOKUP.md Phase 2 §1).

    UniDic over-segments: 食べさせられた → 食べ／させ／られ／た.  Reusing the romaji
    verb-chain merge mask (`_should_merge_for_romaji`) collapses a content word +
    its trailing auxiliaries/inflections into one clickable token whose lemma is
    the HEAD morpheme's dictionary form (→ 食べる, so /define hits).  Particles
    and nouns stay their own tokens (the mask keeps those boundaries).

    Also carries the CONTEXTUAL reading (§2): the concatenated kana of the
    group's morphemes with the topic particle は rendered わ (matching the romaji
    line), so the card shows how the surface is actually pronounced."""
    meta_fn = getattr(annotation_func, "_loom_ja_meta", None)
    meta = meta_fn() if callable(meta_fn) else {}
    token_meta = meta.get('token_meta', [])
    merge_mask = meta.get('merge_mask', [])
    particle_ha = meta.get('particle_ha', set())

    tokens = []
    n = len(spans)
    i = 0
    while i < n:
        # Extend the group while the merge mask says span j joins span j+1.
        j = i
        while j < n - 1 and j < len(merge_mask) and merge_mask[j]:
            j += 1
        # Trim leading/trailing punctuation-only spans so the clickable word is
        # the word itself, not the word plus its trailing ellipsis/quote (は… →
        # は, そうか… → か).  A span is "content" if it holds any alnum/CJK char;
        # a merged 補助記号 like … is not, so it drops out of the surface.
        lo, hi = i, j
        while lo <= hi and not _is_lookupable_word(spans[lo][0]):
            lo += 1
        while hi >= lo and not _is_lookupable_word(spans[hi][0]):
            hi -= 1
        if lo <= hi:
            group = spans[lo:hi + 1]
            word = "".join(s[0] for s in group)
            # Contextual reading: kanji spans carry a kana reading; kana spans
            # read as themselves; particle は → わ.
            reading = "".join(
                "わ" if (lo + off) in particle_ha else (rdg or surf)
                for off, (surf, rdg) in enumerate(group)
            )
            head_lemma, head_pos = token_meta[lo] if lo < len(token_meta) else (None, '')
            lemma = _clean_ja_lemma(head_lemma) or word
            tokens.append((word, lemma, [head_pos] if head_pos else [], reading or None, lo, hi - lo + 1))
        i = j + 1
    return tokens


_TRADITIONAL_LANGS = {"zh-hant", "zh-tw", "zh-hk", "yue", "zh-yue"}


def _chinese_tokens(text: str, spans: list, lang_code: str) -> list:
    """Group per-character Chinese spans into jieba words.  Spans are atomic
    characters over _strip_ass(text), so a jieba word of N chars maps to N
    consecutive spans — exact alignment, no sub-span boundary risk."""
    clean = _strip_ass(text)
    if len(spans) != len(clean):
        return []  # alignment broken (unexpected) — omit tokens, don't mis-map
    traditional = (lang_code or "").lower() in _TRADITIONAL_LANGS
    tokens = []
    offset = 0
    for w in _jieba_words(clean, traditional=traditional):
        n = len(w)
        if n and _is_lookupable_word(w):
            # lemma == word (no inflection); reading None → card uses /define's
            # pinyin.  Token tuple shape matches Japanese (…, reading, start, len).
            tokens.append((w, w, [], None, offset, n))
        offset += n
    return tokens


# Korean word tokenization (VOCAB_LOOKUP.md Phase 3).  Korean annotation spans
# are per-SYLLABLE (like Chinese), so — as with jieba for Chinese — we need a
# real morphological analyzer to group syllables into WORDS and, crucially, to
# recover each word's DICTIONARY FORM (먹었어요 → 먹다) so /define hits the KRDict
# headword.  kiwipiepy is the analyzer: pip-installable (manylinux wheels, no
# system deps → clean on Railway), actively maintained, good quality.
_kiwi = None
_kiwi_failed = False


def _get_kiwi():
    """Lazily-built, cached kiwipiepy Kiwi analyzer.  Returns None (once) if the
    package isn't installed / fails to load — Korean tokens then degrade to []
    exactly like an unsupported language, never raising into the request."""
    global _kiwi, _kiwi_failed
    if _kiwi is not None:
        return _kiwi
    if _kiwi_failed:
        return None
    try:
        from kiwipiepy import Kiwi  # lazy — heavy model load, build once
        _kiwi = Kiwi()
    except Exception:  # noqa: BLE001 — any import/model failure → graceful None
        _kiwi_failed = True
        return None
    return _kiwi


# kiwipiepy (Sejong) tags that ATTACH to the preceding content word rather than
# starting their own: particles (J*), verb/adjective endings (E*), derivational
# suffixes (XS*), and the copula 이다 (VCP — enclitic on its noun).  Everything
# not here and not punctuation is a content HEAD that starts a new word.
_KO_ATTACH_TAGS = frozenset({
    "JKS", "JKC", "JKG", "JKO", "JKB", "JKV", "JKQ", "JX", "JC",  # particles
    "EP", "EF", "EC", "ETN", "ETM",                               # endings
    "XSN", "XSV", "XSA", "XSM",                                   # deriv suffixes
    "VCP",                                                        # copula 이다
})
# Punctuation / symbol tags — break the current word and get no clickable token.
_KO_PUNCT_TAGS = frozenset({"SF", "SP", "SS", "SE", "SO", "SW"})
# Predicate heads whose dictionary form is stem + 다 (kiwipiepy normalizes the
# stem, incl. irregular conjugations: 도왔어요 → 돕 → 돕다; 예뻐요 → 예쁘 → 예쁘다).
_KO_PREDICATE_TAGS = frozenset({"VV", "VA", "VX", "VCN"})
# Derivational suffixes that turn a noun/root into a predicate: 하다/되다 verbs
# (XSV) and 하다 adjectives (XSA).  KRDict lists the DERIVED form (교역 + 하 →
# 교역하다; 깨끗 + 하 → 깨끗하다), so the lemma must reconstruct it, not stop at the
# bare noun/root (깨끗/XR isn't even a standalone headword).
_KO_DERIV_PRED_TAGS = frozenset({"XSV", "XSA"})


def _ko_has_space(sub: str) -> bool:
    """True if a between-morphemes slice contains whitespace (a real word break,
    vs the zero-gap / overlapping spans within one inflected word)."""
    return any(c.isspace() for c in sub)


def _korean_lemma(head_form: str, head_tag: str, deriv_form: str) -> "str | None":
    """Dictionary form (KRDict headword) for a Korean word group.

    - noun/root + 하/되 derivational suffix → head + suffix + 다 (교역 → 교역하다);
    - a bare predicate head → head + 다 (먹다);
    - anything else → the head form as-is (nouns, adverbs, …)."""
    if not head_form:
        return None
    if deriv_form:
        return head_form + deriv_form + "다"
    if head_tag in _KO_PREDICATE_TAGS:
        return head_form + "다"
    return head_form


def _korean_tokens(text: str, spans: list) -> list:
    """Group per-syllable Korean spans into WORD tokens via kiwipiepy.

    Spans are atomic characters over _strip_ass(text) (one per char, exactly
    like Chinese), so a kiwipiepy morpheme's char offset maps straight to a span
    index.  A content-head morpheme (noun / verb / adjective / adverb / …) opens
    a word; trailing particles + endings + suffixes attach to it; a char gap
    (space) or the next content head closes it.  The word's clickable surface is
    the original slice (먹었어요) and its lemma is the head's dictionary form
    (먹다) so /define resolves against the KRDict headword — the Korean analogue
    of the Japanese morpheme→word merge."""
    clean = _strip_ass(text)
    if len(spans) != len(clean):
        return []  # alignment broken (unexpected) — omit tokens, don't mis-map
    kiwi = _get_kiwi()
    if kiwi is None:
        return []

    tokens: list = []
    # cur = [start, end, head_form, head_tag, deriv_form] for the word in
    # progress (deriv_form = the 하/되 suffix that derived a predicate, or "").
    cur: list | None = None

    def flush() -> None:
        nonlocal cur
        if cur is None:
            return
        s, e, head_form, head_tag, deriv_form = cur
        word = clean[s:e]
        if _is_lookupable_word(word):
            lemma = _korean_lemma(head_form, head_tag, deriv_form) or word
            pos = [head_tag] if head_tag else []
            tokens.append((word, lemma, pos, None, s, e - s))
        cur = None

    for m in kiwi.tokenize(clean):
        # kiwipiepy marks irregular vs regular conjugation with a "-I"/"-R"
        # suffix (VA-I, VV-R, …); the base tag is what our tag sets key on.
        base = m.tag.split("-", 1)[0]
        start, end = m.start, m.start + m.len
        if base in _KO_PUNCT_TAGS:
            flush()
            continue
        # An attach morpheme joins the current word UNLESS a space separates
        # them.  The looser "no whitespace between" test (vs exact adjacency) is
        # load-bearing: irregular conjugations contract stem + ending into a
        # shared syllable, so kiwipiepy reports OVERLAPPING char spans for them
        # (즐거워요 → 즐겁 [0,3) + 어요 [2,4)).  Overlap ⇒ same word.
        joins = (
            base in _KO_ATTACH_TAGS
            and cur is not None
            and (start < cur[1] or not _ko_has_space(clean[cur[1]:start]))
        )
        if joins:
            if end > cur[1]:
                cur[1] = end  # extend (max — overlapping spans mustn't shrink it)
            if base in _KO_DERIV_PRED_TAGS and not cur[4]:
                cur[4] = m.form  # 하/되 derived a predicate → reconstruct 다-form
        else:
            flush()
            cur = [start, end, m.form, base, ""]
    flush()
    return tokens


# ---- Generic tokenizer (space-delimited languages via simplemma) ---------- #
#
# The FALLBACK path under the custom morphological analyzers above.  Romance /
# Germanic / Scandinavian / Slavic languages are space-delimited, so tokenizing
# is trivial (word runs by regex); the only real work is LEMMATIZATION so the
# clickable word resolves to its dictionary headword (comieron → comer).  That's
# delegated to simplemma (one lightweight dep, ~50 languages).  This never
# overrides a custom tokenizer — build_word_tokens checks the custom langs FIRST
# and only reaches here for languages with no bespoke path.  Fail-soft: if
# simplemma is absent or errors, the lemma degrades to the surface form.

# A "word": a run of letters (Unicode-aware, no digits/underscore), allowing an
# internal apostrophe or hyphen (e.g. French l'homme, Spanish is unaffected).
_GENERIC_WORD_RE = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*", re.UNICODE)

# Romance languages elide a proclitic before a vowel and join it with an
# apostrophe (fr l'école, d'un, j'ai; it l'ho, l'inglese).  Orthographically the
# apostrophe is a WORD BOUNDARY, so "l'école" is really "l' + école" — but our
# word regex keeps it as one token and the whole thing never hits the dictionary
# (it was the entire top-misses list for fr/it in the quality harness).  We peel
# a LEADING clitic only when it's ≤2 letters: that captures every elided clitic
# (l d j n m t s c qu) while leaving genuine apostrophe-lexemes whole
# (aujourd'hui, quelqu'un, presqu'île — their stems are longer than 2).
_ELISION_PRIMARIES = frozenset({"fr", "it", "ca", "oc"})


def _split_elision(word: str, offset: int, primary: str) -> list:
    """Split leading elided proclitics off *word*; return [(subword, start), …].

    Only peels a clitic of ≤2 letters immediately before an apostrophe, so
    Romance elisions separate but genuine apostrophe-words stay intact.  For
    non-elision languages (or words with no apostrophe) returns [(word, offset)].
    """
    if primary not in _ELISION_PRIMARIES or ("'" not in word and "’" not in word):
        return [(word, offset)]
    parts: list = []
    i, n = 0, len(word)
    while i < n:
        ap = next((j for j in range(i, n) if word[j] in "'’"), -1)
        if ap != -1 and 1 <= ap - i <= 2:
            parts.append((word[i:ap], offset + i))
            i = ap + 1
        else:
            break
    parts.append((word[i:], offset + i))
    return [(w, o) for (w, o) in parts if w]


_simplemma_loaded = None


def _generic_lemma(word: str, lang: str) -> str:
    """simplemma lemma for *word* in *lang*; the surface form if simplemma is
    unavailable / doesn't know the language (fail-soft, never raises)."""
    global _simplemma_loaded
    if _simplemma_loaded is None:
        try:
            import simplemma  # noqa: F401 — probe once
            _simplemma_loaded = True
        except Exception:
            _simplemma_loaded = False
    if not _simplemma_loaded:
        return word
    try:
        import simplemma
        return simplemma.lemmatize(word, lang=lang) or word
    except Exception:
        return word


def _generic_tokens(text: str, lang_code: str) -> list:
    """Word tokens for a space-delimited language: each letter-run is a clickable
    word, its lemma from simplemma so /define hits the dictionary headword.  No
    ruby (Latin/Cyrillic scripts), so reading=None and pos=[] — the card uses the
    dictionary's own reading + POS.  Offsets are char positions over the stripped
    text, consistent with the CJK/Korean token contract."""
    clean = _strip_ass(text)
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    tokens: list = []
    for m in _GENERIC_WORD_RE.finditer(clean):
        for word, start in _split_elision(m.group(), m.start(), primary):
            if not _is_lookupable_word(word):
                continue
            lemma = _generic_lemma(word, primary) or word
            tokens.append((word, lemma, [], None, start, len(word)))
    return tokens


# Custom, per-language tokenizers (morphological analyzers) — ALWAYS preferred;
# build_word_tokens dispatches to them first.  ko needs kiwipiepy at runtime; if
# it's absent, tokens degrade to [] and capabilities still won't expose ko
# because no ko dictionary would be present either.
SUPPORTED_TOKEN_PRIMARIES = frozenset({"ja", "zh", "yue", "ko"})

# Generic simplemma path — enabled PER LANGUAGE, and only after a corpus quality
# check (scripts/dict_quality_check.py) clears the bar.  simplemma supports ~50
# languages; we opt them in deliberately rather than flip them all on at once.
# Whether a language is actually *definable* is still gated on a dictionary
# existing (capabilities intersects this with SELECT DISTINCT lang), so listing a
# language here before its dictionary is ingested is harmless.
GENERIC_TOKEN_PRIMARIES = frozenset(
    {"es", "fr", "de", "it", "pt", "sv", "nl"}
)


def is_token_supported(lang_code: str) -> bool:
    """True if build_word_tokens can produce word tokens for *lang_code* — via a
    custom analyzer OR the generic simplemma path."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    return primary in SUPPORTED_TOKEN_PRIMARIES or primary in GENERIC_TOKEN_PRIMARIES


def build_word_tokens(text: str, lang_code: str, spans: list, annotation_func) -> list:
    """Word-level tokens over the annotation `spans` (VOCAB_LOOKUP.md Phase 0).

    `spans` and `annotation_func` are the ones the caller already computed via
    get_annotation_func()/get_lang_config — reused here so token and span
    boundaries can't diverge (for the CJK/Korean paths).  Custom analyzers are
    tried FIRST; a space-delimited language with no bespoke path falls through to
    the generic simplemma tokenizer.  Returns [] for unsupported languages."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary == "ja":
        return _japanese_tokens(spans, annotation_func)
    if primary in ("zh", "yue"):
        return _chinese_tokens(text, spans, lang_code)
    if primary == "ko":
        return _korean_tokens(text, spans)
    if primary in GENERIC_TOKEN_PRIMARIES:
        return _generic_tokens(text, lang_code)
    return []


def get_japanese_pipeline():
    """Return the shared Japanese pipeline for optimized call sites.

    Returns ``(resolve_spans, spans_to_romaji)`` — see _make_japanese_pipeline()
    for full documentation.  This is the public entry point used by
    get_lang_config() to create one MeCab tagger shared between the
    furigana and romaji consumers.

    Returns ``(None, None)`` for non-Japanese contexts (caller should check).
    """
    return _make_japanese_pipeline()


def build_annotation_html(spans: list, mode: str = 'ruby') -> str:
    """Convert a span list from get_annotation_func() into annotation HTML.

    Parameters
    ----------
    spans : list[(str, str|None)]
        Output of get_annotation_func(text).  Each tuple is (original, reading).
    mode : str
        Rendering strategy:

        - ``"ruby"`` (default): ``<ruby>base<rt>reading</rt></ruby>`` — browser-
          native ruby layout.  Best for CJK (furigana, pinyin) and the default
          for all languages.
        - ``"interlinear"``: inline-block two-row containers with the reading on
          top and base text below.  Better for long alphabetic annotations that
          overflow ruby positioning.
        - ``"inline"``: ``base(reading)`` parenthetical — lightweight, no special
          CSS needed.  Useful as a compact fallback.

    Returns an empty string for an empty span list.
    """
    if not spans:
        return ''

    if mode == 'interlinear':
        parts = []
        for orig, reading in spans:
            if reading:
                parts.append(
                    f'<span class="ilb">'
                    f'<span class="ilb-r">{reading}</span>'
                    f'<span class="ilb-b">{orig}</span>'
                    f'</span>'
                )
            else:
                parts.append(orig)
        return ''.join(parts)

    if mode == 'inline':
        parts = []
        for orig, reading in spans:
            if reading:
                parts.append(f'{orig}({reading})')
            else:
                parts.append(orig)
        return ''.join(parts)

    # Default: ruby mode
    parts = []
    for orig, reading in spans:
        if reading:
            parts.append(f'<ruby>{orig}<rt>{reading}</rt></ruby>')
        else:
            parts.append(orig)
    return ''.join(parts)


def get_romanizer(lang_code: str, phonetic_system: str = None):
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
        phonetic_system: Override for languages with multiple romanization
                         systems.  Thai: ``"rtgs"``, ``"paiboon"``, ``"ipa"``.
    """
    # Normalise: lower-case, extract primary subtag
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]

    # Chunk R2 — Chinese (Pinyin / Zhuyin / Jyutping, jieba-segmented) ✅
    # Variant defaults:
    #   zh-Hant / zh-TW            → Zhuyin (Taiwan convention)
    #   zh-HK                      → Jyutping (HK's spoken language is Cantonese;
    #                                practically every zh-HK-tagged subtitle track
    #                                carries Cantonese — see also language.py's
    #                                Cantonese discriminator that already flags
    #                                zh-HK as suspect-Cantonese)
    #   zh / zh-Hans / zh-CN / etc → Pinyin
    # Explicit phonetic_system ("pinyin" | "zhuyin" | "jyutping") always wins.
    lc = (lang_code or "").lower()
    if primary == "zh":
        sys = (phonetic_system or "").lower() or None
        if sys == "jyutping":
            return _make_jyutping_romanizer()
        if sys == "zhuyin":
            variant = 'zh-Hant' if lc in ('zh-hant', 'zh-tw', 'zh-hk') else 'zh-Hans'
            return _make_zhuyin_romanizer(variant=variant)
        if sys == "pinyin":
            variant = 'zh-Hant' if lc in ('zh-hant', 'zh-tw', 'zh-hk') else 'zh-Hans'
            return _make_pinyin_romanizer(variant=variant)
        # Auto-resolve.
        if lc == "zh-hk":
            return _make_jyutping_romanizer()
        if lc in ('zh-hant', 'zh-tw'):
            return _make_zhuyin_romanizer(variant='zh-Hant')
        return _make_pinyin_romanizer(variant='zh-Hans')

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

    # Chunk R4 — Korean (korean-romanizer, Revised Romanization) ──── ✅
    if primary == "ko":
        return _make_korean_romanizer()

    # Chunk R4 — Cyrillic (cyrtranslit) ───────────────────────────── ✅
    if primary in _CYRILLIC_LANG_CODES:
        return _make_cyrillic_romanizer(primary)

    # Chunk R4 — Thai (pythainlp) ──────────────────────────────────── ✅
    if primary == "th":
        if phonetic_system == "paiboon":
            return _make_thai_paiboon_romanizer()
        if phonetic_system == "ipa":
            return _make_thai_ipa_romanizer()
        return _make_thai_romanizer()  # RTGS default

    # Chunk R5-2 — Indic scripts (aksharamukha → IAST) ────────────── ✅
    if primary in _INDIC_SCRIPTS:
        return _make_indic_romanizer(primary)

    # Chunk R5-4 phase (a) — Modern Hebrew block romanization ──────── ✅
    if primary == "he":
        return _make_hebrew_romanizer()

    # Chunk R5-4 remaining — Arabic (ar) block romanization ────────── ✅
    # Hybrid "learner" default (macrons + emphatic marks, sh/gh/th/dh/kh
    # digraphs); "din" for full DIN 31635; "loose" for ASCII-only.
    if primary == "ar":
        return _make_arabic_romanizer(phonetic_system=phonetic_system or "learner")

    # Chunk R5-4 remaining — Persian (fa) block romanization ───────── ✅
    # "learner" default collapses Arabic emphatics to Persian phonology;
    # "dmg" preserves scholarly marks + uses č / ž for چ ژ.
    if primary == "fa":
        return _make_persian_romanizer(phonetic_system=phonetic_system or "learner")

    # Chunk R5-4 remaining — Urdu (ur) block romanization ──────────── ✅
    # "learner" default: Hunterian-lite — retroflex underdots ṭ ḍ ṛ,
    # digraph aspirates (bh dh gh kh ph th ṭh ḍh ṛh), collapsed
    # emphatics, plain 'n' for nun-ghunnah.
    # "ala-lc": scholarly — preserves emphatics + uses candrabindu for
    # nun-ghunnah (n̐) + macron for yeh-barree (ē).
    if primary == "ur":
        return _make_urdu_romanizer(phonetic_system=phonetic_system or "learner")

    return None
