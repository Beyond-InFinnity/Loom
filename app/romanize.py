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
    it MeCab romanizes both the kanji *and* the parenthetical hiragana
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

            # Compute merge mask for romaji
            should_merge = False
            if idx + 1 < len(tokens):
                next_surface, _, next_pos1, next_pos2, next_lemma = tokens[idx + 1]
                should_merge = _should_merge_for_romaji(
                    pos1, pos2, next_surface, next_pos1, next_pos2, next_lemma)
            merge_mask.append(should_merge)

        _romaji_meta['merge_mask'] = merge_mask
        _romaji_meta['particle_ha'] = particle_ha
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
        return _clean_speaker_labels(raw)

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
        return ' '.join(parts)

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

    Uses korean-romanizer library.
    """
    from korean_romanizer.romanizer import Romanizer

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _strip_ass(text)
        return Romanizer(clean).romanize()

    return romanize


def _make_korean_annotation_func():
    """Return a Korean per-word annotation span producer.

    Korean is space-delimited — each word is romanized via korean-romanizer
    and paired with its original Hangul.  Spaces pass through with
    reading=None so the rendering pipeline maintains word spacing.
    """
    from korean_romanizer.romanizer import Romanizer

    def _has_hangul(word: str) -> bool:
        return any('\uAC00' <= c <= '\uD7AF' or '\u1100' <= c <= '\u11FF' for c in word)

    def get_spans(text: str) -> list:
        if not text:
            return []
        clean = _strip_ass(text)
        spans = []
        parts = clean.split(' ')
        for i, word in enumerate(parts):
            if word:
                if _has_hangul(word):
                    rom = Romanizer(word).romanize().strip()
                    spans.append((word, rom if rom else None))
                else:
                    spans.append((word, None))
            if i < len(parts) - 1:
                spans.append((' ', None))
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
        return cyrtranslit.to_latin(clean, cyr_code)

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


def _detect_thai_ipa_engine() -> str:
    """Detect the best available IPA-like engine in pythainlp.

    Tries ``'ipa'`` first, then ``'thai2rom'`` (neural, phonetic).
    Falls back to ``'royin'`` if neither is available.
    """
    from pythainlp.transliterate import romanize as _thai_romanize
    for engine in ('ipa', 'thai2rom'):
        try:
            if _thai_romanize('\u0e01', engine=engine):
                return engine
        except Exception:
            continue
    return 'royin'


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
        return ' '.join(p for p in parts if p.strip())

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
        return ' '.join(p for p in parts if p.strip())

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


def _make_thai_ipa_romanizer():
    """Return a Thai IPA romanizer.

    Attempts pythainlp ``'ipa'`` engine; falls back to ``'thai2rom'``
    (neural, phonetic) or ``'royin'`` if neither is available.
    """
    from pythainlp.transliterate import romanize as _thai_romanize
    _engine = _detect_thai_ipa_engine()

    def romanize(text: str) -> str:
        if not text:
            return ''
        clean = _normalize_thai(_strip_ass(text))
        tokens = _thai_tokenize(clean)
        parts = []
        for token in tokens:
            if _has_thai(token):
                parts.append(_thai_romanize(token, engine=_engine))
            elif token.strip():
                parts.append(token)
        return ' '.join(p for p in parts if p.strip())

    return romanize


def _make_thai_ipa_annotation_func():
    """Return a Thai IPA per-token annotation span producer."""
    from pythainlp.transliterate import romanize as _thai_romanize
    _engine = _detect_thai_ipa_engine()

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
                rom = _thai_romanize(token, engine=_engine)
                spans.append((token, rom if rom else None))
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
        # Auto-detect: Traditional Mandarin → Zhuyin, others → Pinyin
        lc = (lang_code or "").lower()
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

    return None


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

    # Chunk R5 — Indic scripts, Arabic/Persian/Urdu ───────────────── TODO

    return None
