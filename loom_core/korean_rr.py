"""Korean Revised Romanization — standalone implementation.

MIT License. No dependency on GPL-licensed korean-romanizer.

Implements the official Revised Romanization of Korean (국어의 로마자 표기법)
as specified by the South Korean Ministry of Culture and Tourism (2000).

Algorithm:
  1. Decompose each Hangul syllable block (U+AC00–U+D7A3) into
     initial (choseong), medial (jungseong), final (jongseong) jamo.
  2. Apply pronunciation rules: final consonant simplification,
     liaison (연음), ㅎ-aspiration, double-consonant splitting.
  3. Map resulting jamo to Latin letters per the RR standard.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Unicode Hangul decomposition constants
# ---------------------------------------------------------------------------
_HANGUL_BASE = 0xAC00
_INITIAL_COUNT = 19
_MEDIAL_COUNT = 21
_FINAL_COUNT = 28   # includes "no final" = index 0
_INITIAL_OFFSET = _MEDIAL_COUNT * _FINAL_COUNT  # 588
_MEDIAL_OFFSET = _FINAL_COUNT                   # 28

# Choseong jamo (U+1100–U+1112)
_INITIALS = [chr(c) for c in range(0x1100, 0x1113)]

# Jungseong as compatibility jamo for medial lookup
_MEDIALS = [
    'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ',
    'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
]

# Jongseong jamo (U+11A8–U+11C2), index 0 = no final
_FINALS: list[str | None] = [None] + [chr(c) for c in range(0x11A8, 0x11C3)]

# Compatibility consonants (ㄱ–ㅎ) mapped to initial jamo index
_COMPAT_CONSONANTS = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
]

# Map compatibility final consonants to jongseong jamo
_COMPAT_TO_FINAL = {
    'ㄱ': '\u11A8', 'ㄲ': '\u11A9', 'ㄴ': '\u11AB', 'ㄷ': '\u11AE',
    'ㄹ': '\u11AF', 'ㅁ': '\u11B7', 'ㅂ': '\u11B8', 'ㅅ': '\u11BA',
    'ㅆ': '\u11BB', 'ㅇ': '\u11BC', 'ㅈ': '\u11BD', 'ㅊ': '\u11BE',
    'ㅋ': '\u11BF', 'ㅌ': '\u11C0', 'ㅍ': '\u11C1', 'ㅎ': '\u11C2',
}

# ---------------------------------------------------------------------------
# Revised Romanization mapping tables
# ---------------------------------------------------------------------------

_VOWEL = {
    'ㅏ': 'a',   'ㅐ': 'ae',  'ㅑ': 'ya',  'ㅒ': 'yae',
    'ㅓ': 'eo',  'ㅔ': 'e',   'ㅕ': 'yeo', 'ㅖ': 'ye',
    'ㅗ': 'o',   'ㅘ': 'wa',  'ㅙ': 'wae', 'ㅚ': 'oe',
    'ㅛ': 'yo',  'ㅜ': 'u',   'ㅝ': 'wo',  'ㅞ': 'we',
    'ㅟ': 'wi',  'ㅠ': 'yu',  'ㅡ': 'eu',  'ㅢ': 'ui',
    'ㅣ': 'i',
}

# Onset (choseong) romanization
_ONSET = {
    '\u1100': 'g',   '\u1101': 'kk',  '\u1102': 'n',   '\u1103': 'd',
    '\u1104': 'tt',  '\u1105': 'r',   '\u1106': 'm',   '\u1107': 'b',
    '\u1108': 'pp',  '\u1109': 's',   '\u110A': 'ss',  '\u110B': '',
    '\u110C': 'j',   '\u110D': 'jj',  '\u110E': 'ch',  '\u110F': 'k',
    '\u1110': 't',   '\u1111': 'p',   '\u1112': 'h',
}

# Coda (jongseong) romanization — only the 7 representative sounds
_CODA = {
    '\u11A8': 'k',   '\u11AB': 'n',   '\u11AE': 't',   '\u11AF': 'l',
    '\u11B7': 'm',   '\u11B8': 'p',   '\u11BC': 'ng',
    None: '',
}

# Compatibility onset (for bare jamo like ㄱ, ㄴ outside syllable blocks)
_COMPAT_ONSET = {
    comp: _ONSET[_INITIALS[i]]
    for i, comp in enumerate(_COMPAT_CONSONANTS)
}

# ---------------------------------------------------------------------------
# Double (compound) final consonants
# ---------------------------------------------------------------------------
_DOUBLE_FINAL = {
    '\u11AA': ('\u11A8', '\u11BA'),  # ㄳ → ㄱ, ㅅ
    '\u11AC': ('\u11AB', '\u11BD'),  # ㄵ → ㄴ, ㅈ
    '\u11AD': ('\u11AB', '\u11C2'),  # ㄶ → ㄴ, ㅎ
    '\u11B0': ('\u11AF', '\u11A8'),  # ㄺ → ㄹ, ㄱ
    '\u11B1': ('\u11AF', '\u11B7'),  # ㄻ → ㄹ, ㅁ
    '\u11B2': ('\u11AF', '\u11B8'),  # ㄼ → ㄹ, ㅂ
    '\u11B3': ('\u11AF', '\u11BB'),  # ㄽ → ㄹ, ㅅ
    '\u11B4': ('\u11AF', '\u11C0'),  # ㄾ → ㄹ, ㅌ
    '\u11B5': ('\u11AF', '\u11C1'),  # ㄿ → ㄹ, ㅍ
    '\u11B6': ('\u11AF', '\u11C2'),  # ㅀ → ㄹ, ㅎ
    '\u11B9': ('\u11B8', '\u11BA'),  # ㅄ → ㅂ, ㅅ
}

# Map jongseong → choseong for liaison
_FINAL_TO_INITIAL: dict[str, str] = {}
for _i, _compat in enumerate(_COMPAT_CONSONANTS):
    if _compat in _COMPAT_TO_FINAL:
        _final_jamo = _COMPAT_TO_FINAL[_compat]
        _FINAL_TO_INITIAL[_final_jamo] = _INITIALS[_i]

_NULL_ONSET = '\u110B'  # ㅇ as initial = silent

# ㅎ-family finals
_H_FINALS = {
    '\u11C2': None,      # ㅎ → nothing
    '\u11AD': '\u11AB',  # ㄶ → ㄴ
    '\u11B6': '\u11AF',  # ㅀ → ㄹ
}

# Aspiration: ㅎ + {ㄱ,ㄷ,ㅈ,ㅅ} → aspirated/tense
_H_ASPIRATION = {
    '\u1100': '\u110F',  # ㄱ → ㅋ
    '\u1103': '\u1110',  # ㄷ → ㅌ
    '\u110C': '\u110E',  # ㅈ → ㅊ
    '\u1109': '\u110A',  # ㅅ → ㅆ
}


# ---------------------------------------------------------------------------
# Syllable decomposition
# ---------------------------------------------------------------------------

def _is_hangul(char: str) -> bool:
    return 0xAC00 <= ord(char) <= 0xD7A3


def _decompose(char: str) -> tuple[str, str, str | None]:
    """Decompose a Hangul syllable block into (initial, medial, final)."""
    code = ord(char) - _HANGUL_BASE
    ini_idx = code // _INITIAL_OFFSET
    med_idx = (code % _INITIAL_OFFSET) // _MEDIAL_OFFSET
    fin_idx = code % _MEDIAL_OFFSET
    return _INITIALS[ini_idx], _MEDIALS[med_idx], _FINALS[fin_idx]


def _compose(initial: str, medial: str, final: str | None) -> str:
    """Compose jamo back into a Hangul syllable block."""
    ini_idx = _INITIALS.index(initial)
    med_idx = _MEDIALS.index(medial)
    fin_idx = _FINALS.index(final) if final else 0
    return chr(_HANGUL_BASE + ini_idx * _INITIAL_OFFSET + med_idx * _MEDIAL_OFFSET + fin_idx)


# ---------------------------------------------------------------------------
# Pronunciation rules
# ---------------------------------------------------------------------------

class _Syl:
    """Mutable syllable container for pronunciation processing."""
    __slots__ = ('initial', 'medial', 'final', 'is_hangul', 'char')

    def __init__(self, char: str):
        self.char = char
        if _is_hangul(char):
            self.is_hangul = True
            self.initial, self.medial, self.final = _decompose(char)
        else:
            self.is_hangul = False
            self.initial = char
            self.medial = None
            self.final = None

    def to_str(self) -> str:
        if self.is_hangul and self.medial is not None:
            return _compose(self.initial, self.medial, self.final)
        return self.char


def _apply_pronunciation(syllables: list[_Syl]) -> list[_Syl]:
    """Apply Korean pronunciation rules in-place and return the list."""
    for idx, syl in enumerate(syllables):
        if not syl.is_hangul:
            continue

        nxt = syllables[idx + 1] if idx + 1 < len(syllables) else None
        nxt_hangul = nxt and nxt.is_hangul

        has_final = syl.final is not None
        final_before_C = has_final and nxt_hangul and nxt.initial != _NULL_ONSET
        final_before_V = has_final and nxt_hangul and nxt.initial == _NULL_ONSET
        is_last = has_final and nxt is None

        # Rule 1-3: Final consonant simplification (word-final or before consonant)
        if is_last or final_before_C:
            f = syl.final
            if f in ('\u11A9', '\u11BF', '\u11AA', '\u11B0'):  # ㄲ,ㅋ,ㄳ,ㄺ
                syl.final = '\u11A8'  # → ㄱ
            elif f in ('\u11BA', '\u11BB', '\u11BD', '\u11BE', '\u11C0'):  # ㅅ,ㅆ,ㅈ,ㅊ,ㅌ
                syl.final = '\u11AE'  # → ㄷ
            elif f in ('\u11C1', '\u11B9', '\u11B5'):  # ㅍ,ㅄ,ㄿ
                syl.final = '\u11B8'  # → ㅂ
            elif f in ('\u11AC',):  # ㄵ
                syl.final = '\u11AB'  # → ㄴ
            elif f in ('\u11B2', '\u11B3', '\u11B4'):  # ㄼ,ㄽ,ㄾ
                syl.final = '\u11AF'  # → ㄹ
            elif f in ('\u11B1',):  # ㄻ
                syl.final = '\u11B7'  # → ㅁ

        # Rule 4: ㅎ-related pronunciation
        if syl.final in _H_FINALS and nxt_hangul:
            base = _H_FINALS[syl.final]
            if nxt.initial in _H_ASPIRATION:
                syl.final = base
                nxt.initial = _H_ASPIRATION[nxt.initial]
            elif nxt.initial == '\u1102':  # ㄴ
                if syl.final in ('\u11AD', '\u11B6'):  # ㄶ, ㅀ
                    syl.final = base
                else:
                    syl.final = '\u11AB'  # ㅎ → ㄴ
            elif nxt.initial == _NULL_ONSET:
                if syl.final in ('\u11AD', '\u11B6'):
                    syl.final = base
                else:
                    syl.final = None
            elif nxt.initial == '\u1105':  # ㄹ
                if syl.final == '\u11B6':  # ㅀ
                    syl.final = '\u11AF'
            else:
                if syl.final == '\u11C2':  # bare ㅎ
                    syl.final = None
        elif syl.final in _H_FINALS and (is_last or not nxt_hangul):
            syl.final = _H_FINALS[syl.final]

        # Rule 6: Double final + vowel → split (second part becomes next onset)
        if syl.final in _DOUBLE_FINAL and final_before_V:
            first, second = _DOUBLE_FINAL[syl.final]
            syl.final = first
            if second in _FINAL_TO_INITIAL:
                nxt.initial = _FINAL_TO_INITIAL[second]

        # Rule 5: Single final + vowel → liaison
        if nxt_hangul and final_before_V:
            if nxt.initial == _NULL_ONSET and syl.final is not None and syl.final != '\u11BC':
                if syl.final in _FINAL_TO_INITIAL:
                    nxt.initial = _FINAL_TO_INITIAL[syl.final]
                    syl.final = None

    return syllables


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def romanize(text: str) -> str:
    """Romanize Korean text using the Revised Romanization system.

    Handles Hangul syllable blocks, compatibility jamo, and passes
    non-Korean characters through unchanged.
    """
    if not text:
        return ''

    syllables = [_Syl(c) for c in text]
    _apply_pronunciation(syllables)

    pronounced = ''.join(s.to_str() for s in syllables)

    result = []
    for char in pronounced:
        if _is_hangul(char):
            ini, med, fin = _decompose(char)
            result.append(_ONSET.get(ini, '') + _VOWEL.get(med, '') + _CODA.get(fin, ''))
        elif char in _VOWEL:
            result.append(_VOWEL[char])
        elif char in _COMPAT_ONSET:
            result.append(_COMPAT_ONSET[char])
        else:
            result.append(char)

    return ''.join(result)


def romanize_syllable(char: str) -> str:
    """Romanize a single Hangul syllable block (no pronunciation context)."""
    if not _is_hangul(char):
        return char
    ini, med, fin = _decompose(char)
    return _ONSET.get(ini, '') + _VOWEL.get(med, '') + _CODA.get(fin, '')
