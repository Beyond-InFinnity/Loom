"""Font availability + glyph-coverage validation.

Two independent questions this module answers:

  1. **Availability** — does fontconfig resolve the requested family to an
     exact match (or silently fall back to something else)?  On Linux,
     ``fc-match`` always returns *some* font — never fails — so the real
     "available" signal is whether the returned family matches what we
     asked for (case-insensitive).

  2. **Glyph coverage** — does the resolved font actually contain glyphs
     for the characters we plan to render?  A font like Liberation Sans
     will happily be selected by fontconfig but render Japanese as
     tofu boxes because its cmap has no hiragana/kanji.

The validator handles both.  It is a read-only analysis — never modifies
the user's font choice — and is safe to call from anywhere (pure Python
after the lazy fontTools import; fc-match is a subprocess call).

Cross-platform note: the fc-match backend is Linux-only.  On macOS /
Windows the module returns a "could not verify" result with a
suitable warning so callers can decide whether to block or proceed.
3c bundling will revisit the cross-platform story (likely shipping a
fontTools-only backend that scans a bundled font directory).
"""

from __future__ import annotations

import functools
import subprocess
from dataclasses import dataclass, field

# Maximum number of missing characters to report.  Useful for diagnostics
# without producing a thousand-char warning when someone picks an
# English-only font for a Korean subtitle track.
_MAX_REPORTED_MISSING = 8


# ---------------------------------------------------------------------------
# Per-language representative characters.  A font "covers" a language when
# its cmap includes every character in the relevant set.
#
# Design choices:
#   * The sets are deliberately small — 3 to 6 chars each — so the cost of
#     a full check is negligible.  They cover the minimum feature surface
#     that distinguishes the script: a consonant, a vowel/matra, a
#     diacritic, and any uniquely-shaped feature (Traditional vs
#     Simplified differentiator, nukta, pulli, etc.).
#   * Traditional + Simplified Chinese share Han ideographs but differ on
#     specific chars: 國 (TC) vs 国 (SC).  A font that has 国 but not
#     國 covers Simplified-only; we include one discriminator per variant.
#   * CJK Korean + Japanese share Han ideographs, but Korean text depends
#     on the Hangul block — 한 / 가 are the strongest coverage signal.
# ---------------------------------------------------------------------------

_LANG_COVERAGE_SAMPLES: dict[str, frozenset[str]] = {
    # Latin-script baselines (most fonts pass these trivially)
    "en": frozenset("Aa0,."),
    "vi": frozenset("ăâđêôơư"),      # Vietnamese-specific diacritics

    # CJK
    "ja": frozenset("あアー語"),        # hiragana, katakana, chōon, kanji
    "ko": frozenset("한국가"),          # Hangul syllable blocks
    "zh-hans": frozenset("国你好"),     # Simplified discriminator: 国
    "zh-hant": frozenset("國學"),       # Traditional discriminator: 國
    "zh": frozenset("你好"),            # Bare zh = shared chars only
    "yue": frozenset("國你好"),         # Cantonese uses Traditional

    # Cyrillic
    "ru": frozenset("АаЯя"),
    "uk": frozenset("єіїґ"),           # Ukrainian-unique chars
    "be": frozenset("ўіӯ"),            # Belarusian-unique
    "sr": frozenset("љњђћџј"),         # Serbian-unique
    "bg": frozenset("АаЯя"),           # Bulgarian = baseline Cyrillic
    "mk": frozenset("ѓќѕ"),            # Macedonian-unique
    "mn": frozenset("ӨөҮү"),           # Mongolian Cyrillic-unique

    # Thai
    "th": frozenset("กลืัำ"),         # consonants + matras + tones

    # Indic
    "hi": frozenset("नमस्ेी"),          # Devanagari: consonant + virama + matra
    "bn": frozenset("নমস্েী"),          # Bengali
    "ta": frozenset("வணக்ம"),          # Tamil (pulli ் as virama)
    "te": frozenset("నమస్ెీ"),          # Telugu
    "gu": frozenset("નમસ્ેી"),          # Gujarati
    "pa": frozenset("ਸਤ੍ੀ"),             # Gurmukhi

    # RTL scripts (R5-4 + Hebrew pilot)
    "ar": frozenset("السلامعلي"),       # Arabic core
    "fa": frozenset("پچژگ"),           # Farsi adds 4 chars to Arabic
    "ur": frozenset("ٹڈڑںے"),          # Urdu-specific additions
    "he": frozenset("אבשלםןץ"),         # Hebrew incl. final forms
    "yi": frozenset("אבײאָ"),           # Yiddish incl. digraph yod-yod
}


@dataclass
class FontValidation:
    """Result of validating a font family name.

    Fields
    ------
    font_name : str
        The requested family (echoed back).
    resolved_path : str | None
        Absolute path to the file fontconfig selected, or ``None`` when
        fc-match is unavailable or returned nothing.
    resolved_family : str | None
        The family name of the resolved font — useful for detecting when
        fontconfig silently substituted a different family.
    resolved_index : int
        For TrueType Collections (TTC), the font index inside the file.
        0 when not a collection or unknown.
    is_fallback : bool
        True when ``resolved_family`` doesn't match ``font_name``
        (case-insensitive).  Users often hit this with "Arial" on Linux,
        which fontconfig aliases to Liberation Sans — functionally fine
        for Latin but signals the exact font isn't present.
    coverage_ok : bool | None
        True when every checked character is in the font's cmap, False
        when some are missing, None when no coverage check was performed
        (no lang_code / text given, or backend unavailable).
    missing_chars : list[str]
        Characters that were checked and NOT found in the font's cmap.
        Capped at eight for diagnostic readability.
    warnings : list[str]
        Human-readable messages explaining fallback / missing coverage /
        backend issues.  Empty list when everything is clean.
    """

    font_name: str
    resolved_path: str | None = None
    resolved_family: str | None = None
    resolved_index: int = 0
    is_fallback: bool = False
    coverage_ok: bool | None = None
    missing_chars: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# fc-match backend
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=64)
def _fc_match(font_name: str) -> tuple[str, str, int] | None:
    """Resolve *font_name* via fontconfig.

    Returns ``(file_path, family, index)`` or ``None`` if fc-match is
    unavailable (not installed / non-Linux / process failure).
    """
    try:
        result = subprocess.run(
            ["fc-match", font_name, "-f", "%{file}|%{family[0]}|%{index}"],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    parts = result.stdout.strip().split("|")
    if len(parts) < 2:
        return None
    path, family = parts[0], parts[1]
    try:
        index = int(parts[2]) if len(parts) >= 3 and parts[2] else 0
    except ValueError:
        index = 0
    return path, family, index


# ---------------------------------------------------------------------------
# fontTools cmap check
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=32)
def _font_cmap(path: str, index: int = 0) -> frozenset[int] | None:
    """Return the set of Unicode codepoints the font covers, or None
    when the file can't be parsed.  Cached per (path, index) — opening
    a font file is the slowest step in this module."""
    try:
        from fontTools.ttLib import TTFont  # lazy import
    except ImportError:
        return None
    try:
        tt = TTFont(path, fontNumber=index, lazy=True)
        cmap = tt.getBestCmap()
        tt.close()
    except Exception:
        return None
    if cmap is None:
        return None
    return frozenset(cmap.keys())


def _chars_not_in_cmap(cmap_codepoints: frozenset[int], chars) -> list[str]:
    """Return characters from *chars* whose codepoints are NOT in the
    cmap.  Preserves the order of first appearance in *chars*."""
    missing: list[str] = []
    seen: set[str] = set()
    for ch in chars:
        if ch in seen:
            continue
        seen.add(ch)
        if ord(ch) not in cmap_codepoints:
            missing.append(ch)
    return missing


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _normalize_family(name: str) -> str:
    """Case-insensitive, whitespace-trimmed family name for comparison."""
    return " ".join((name or "").lower().split())


def _primary_subtag(lang_code: str) -> str:
    return (lang_code or "").lower().split("-")[0].split("_")[0]


def _coverage_sample_for(lang_code: str) -> frozenset[str] | None:
    """Look up the representative char sample for *lang_code*.

    Tries the full lowercased code first (so ``zh-Hans`` maps to its
    Simplified-specific set), then falls back to the primary subtag.
    """
    if not lang_code:
        return None
    lc = lang_code.lower()
    if lc in _LANG_COVERAGE_SAMPLES:
        return _LANG_COVERAGE_SAMPLES[lc]
    primary = _primary_subtag(lang_code)
    return _LANG_COVERAGE_SAMPLES.get(primary)


def validate_font(font_name: str, *, lang_code: str | None = None,
                  text: str | None = None) -> FontValidation:
    """Validate that *font_name* is resolvable and covers the required glyphs.

    When *text* is provided, coverage is checked against the unique
    characters of that text.  Otherwise, when *lang_code* is provided,
    the per-language representative sample from ``_LANG_COVERAGE_SAMPLES``
    is used.  With neither, only availability (fc-match resolution) is
    checked — ``coverage_ok`` stays ``None``.

    Never raises — on any backend failure the returned FontValidation
    carries a warning in ``warnings`` so callers can decide what to do.
    """
    v = FontValidation(font_name=font_name)

    if not font_name:
        v.warnings.append("empty font name")
        return v

    resolved = _fc_match(font_name)
    if resolved is None:
        v.warnings.append(
            "fontconfig (fc-match) unavailable — could not verify font "
            "availability or coverage on this system"
        )
        return v

    path, family, index = resolved
    v.resolved_path = path
    v.resolved_family = family
    v.resolved_index = index

    if _normalize_family(family) != _normalize_family(font_name):
        v.is_fallback = True
        v.warnings.append(
            f"requested {font_name!r} but fontconfig resolved to "
            f"{family!r} — exact font not installed"
        )

    # Coverage check — source chars: explicit text > lang sample > nothing.
    chars_to_check: frozenset[str] | None = None
    if text:
        chars_to_check = frozenset(text)
    elif lang_code:
        sample = _coverage_sample_for(lang_code)
        if sample is None:
            v.warnings.append(
                f"no coverage sample available for lang_code {lang_code!r}"
            )
        else:
            chars_to_check = sample

    if chars_to_check is None:
        return v

    cmap = _font_cmap(path, index)
    if cmap is None:
        v.warnings.append(
            f"could not read font cmap from {path!r} — coverage unchecked"
        )
        return v

    missing = _chars_not_in_cmap(cmap, chars_to_check)
    if not missing:
        v.coverage_ok = True
        return v

    v.coverage_ok = False
    v.missing_chars = missing[:_MAX_REPORTED_MISSING]
    truncated = "" if len(missing) <= _MAX_REPORTED_MISSING else (
        f" (+{len(missing) - _MAX_REPORTED_MISSING} more)"
    )
    visible = "".join(v.missing_chars)
    v.warnings.append(
        f"font {family!r} is missing glyphs for: {visible!r}{truncated}"
    )
    return v
