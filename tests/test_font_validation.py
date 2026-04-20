"""R6b-fonts: font availability + glyph-coverage validation tests.

Two layers:
  * Pure-Python logic tests — internal helpers (_chars_not_in_cmap,
    _coverage_sample_for, _normalize_family) are synthetic and
    deterministic.
  * System-dependent integration tests — require fc-match (Linux) and
    specific fonts.  Auto-skipped when the backend isn't available.

The system tests use fonts that are very common on a Noto-bearing Linux
dev box:
  * Noto Sans CJK JP — comprehensive CJK coverage (TTC collection).
  * Liberation Sans / DejaVu Sans — the fontconfig fallbacks for
    Arial and missing fonts respectively; neither covers CJK.
"""

import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Skip the whole "integration" section when fc-match isn't reachable.
_FC_MATCH_OK = shutil.which("fc-match") is not None

integration = pytest.mark.skipif(
    not _FC_MATCH_OK, reason="fc-match not available — Linux-only backend"
)


# ---------------------------------------------------------------------------
# Pure-Python logic
# ---------------------------------------------------------------------------

class TestCoverageSampleLookup:
    def test_primary_subtag_matches(self):
        from loom_core.fonts import _coverage_sample_for
        sample = _coverage_sample_for('ja')
        assert sample is not None and 'あ' in sample

    def test_hyphenated_code_prefers_specific(self):
        """zh-Hans → Simplified-specific sample; zh-Hant → Traditional."""
        from loom_core.fonts import _coverage_sample_for
        hans = _coverage_sample_for('zh-Hans')
        hant = _coverage_sample_for('zh-Hant')
        assert hans is not None and hant is not None
        assert '国' in hans              # Simplified discriminator
        assert '國' in hant              # Traditional discriminator
        assert hans != hant

    def test_unknown_primary_returns_none(self):
        from loom_core.fonts import _coverage_sample_for
        assert _coverage_sample_for('xyzq') is None

    def test_empty_returns_none(self):
        from loom_core.fonts import _coverage_sample_for
        assert _coverage_sample_for('') is None
        assert _coverage_sample_for(None) is None


class TestCharsNotInCmap:
    def test_all_present(self):
        from loom_core.fonts import _chars_not_in_cmap
        cmap = frozenset([ord('a'), ord('b'), ord('c')])
        assert _chars_not_in_cmap(cmap, "abc") == []

    def test_some_missing(self):
        from loom_core.fonts import _chars_not_in_cmap
        cmap = frozenset([ord('a')])
        assert _chars_not_in_cmap(cmap, "abcd") == ['b', 'c', 'd']

    def test_dedupes_by_first_occurrence(self):
        from loom_core.fonts import _chars_not_in_cmap
        cmap = frozenset([ord('a')])
        # 'b' appears three times — missing list must contain it once.
        assert _chars_not_in_cmap(cmap, "bbbbabbb") == ['b']


class TestNormalizeFamily:
    def test_case_insensitive(self):
        from loom_core.fonts import _normalize_family
        assert _normalize_family("NOTO SANS") == _normalize_family("noto sans")

    def test_whitespace_collapsed(self):
        from loom_core.fonts import _normalize_family
        assert (_normalize_family("Noto  Sans") ==
                _normalize_family("noto sans"))

    def test_none_becomes_empty(self):
        from loom_core.fonts import _normalize_family
        assert _normalize_family(None) == ""


class TestSamplesAreRegistered:
    """Every language with a romanizer should have a coverage sample.
    Prevents silent coverage gaps when new languages are added to the
    romanization pipeline."""

    def test_all_romanization_langs_have_samples(self):
        from loom_core.styles import _ROMANIZATION_META
        from loom_core.fonts import _LANG_COVERAGE_SAMPLES, _coverage_sample_for
        missing = [lang for lang in _ROMANIZATION_META
                   if _coverage_sample_for(lang) is None]
        assert not missing, (
            f"No coverage sample registered for: {missing!r}.  Add an "
            f"entry to _LANG_COVERAGE_SAMPLES in loom_core/fonts.py."
        )


# ---------------------------------------------------------------------------
# Integration — requires fc-match
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def noto_cjk_jp_available():
    """True when Noto Sans CJK JP is actually installed (not just
    aliased).  We check by asking fc-match and comparing the returned
    family name."""
    if not _FC_MATCH_OK:
        return False
    result = subprocess.run(
        ["fc-match", "Noto Sans CJK JP", "-f", "%{family[0]}"],
        capture_output=True, text=True, timeout=5,
    )
    return "noto sans cjk" in result.stdout.lower()


@integration
class TestValidateFontIntegration:
    def test_empty_font_name_warns(self):
        from loom_core.fonts import validate_font
        v = validate_font("")
        assert v.warnings
        assert v.resolved_path is None

    def test_unknown_font_falls_back(self):
        """fc-match never fails — it returns a fallback for unknown names.
        Validator must surface the substitution as a warning."""
        from loom_core.fonts import validate_font
        v = validate_font("TotallyFakeFontNameZZZ")
        assert v.is_fallback is True
        assert v.resolved_family is not None
        assert any("resolved to" in w for w in v.warnings)

    def test_no_coverage_check_without_lang_or_text(self):
        from loom_core.fonts import validate_font
        v = validate_font("Liberation Sans")
        # Font resolves but coverage wasn't checked.
        assert v.resolved_path is not None
        assert v.coverage_ok is None
        assert v.missing_chars == []

    def test_custom_text_overrides_lang_sample(self):
        """Only chars actually in `text` are checked — lang_code is
        ignored when text is provided."""
        from loom_core.fonts import validate_font
        v = validate_font("Liberation Sans", lang_code="ja", text="hello")
        # Latin-only text; Liberation Sans covers it fine.
        assert v.coverage_ok is True
        assert v.missing_chars == []


@integration
class TestCoverageDetection:
    def test_cjk_font_covers_japanese(self, noto_cjk_jp_available):
        if not noto_cjk_jp_available:
            pytest.skip("Noto Sans CJK JP not installed on this system")
        from loom_core.fonts import validate_font
        v = validate_font("Noto Sans CJK JP", lang_code="ja")
        assert v.coverage_ok is True
        assert v.is_fallback is False
        assert v.missing_chars == []

    def test_cjk_font_covers_korean(self, noto_cjk_jp_available):
        if not noto_cjk_jp_available:
            pytest.skip("Noto Sans CJK JP not installed on this system")
        from loom_core.fonts import validate_font
        v = validate_font("Noto Sans CJK JP", lang_code="ko")
        assert v.coverage_ok is True

    def test_cjk_font_covers_traditional_chinese(self, noto_cjk_jp_available):
        """TTC index routing: zh-Hant must hit a face that has 國."""
        if not noto_cjk_jp_available:
            pytest.skip("Noto Sans CJK JP not installed on this system")
        from loom_core.fonts import validate_font
        v = validate_font("Noto Sans CJK JP", lang_code="zh-Hant")
        assert v.coverage_ok is True

    def test_latin_font_fails_cjk_coverage(self):
        """Liberation Sans (fontconfig's Arial alias) has no CJK — coverage
        check must flag it and list missing chars."""
        from loom_core.fonts import validate_font
        v = validate_font("Liberation Sans", lang_code="ja")
        # If the real Liberation Sans IS on this system, coverage_ok is
        # False.  If fontconfig aliased it to something else, is_fallback
        # is True — either way the user should see a warning.
        assert v.coverage_ok is False or v.is_fallback is True
        if v.coverage_ok is False:
            # Specific CJK chars must be among the missing ones.
            missing_set = set(v.missing_chars)
            assert 'あ' in missing_set or '語' in missing_set

    def test_latin_font_fails_devanagari_coverage(self):
        from loom_core.fonts import validate_font
        v = validate_font("Liberation Sans", lang_code="hi")
        assert v.coverage_ok is False or v.is_fallback is True
        if v.coverage_ok is False:
            assert any(ord(c) >= 0x0900 and ord(c) <= 0x097F
                       for c in v.missing_chars), (
                f"Expected Devanagari chars missing, got {v.missing_chars}"
            )

    def test_missing_chars_capped(self):
        """The missing_chars list is capped for diagnostic readability —
        if a font is completely unsuited, we get a representative
        sample, not a thousand-char dump."""
        from loom_core.fonts import validate_font, _MAX_REPORTED_MISSING
        # Ask a Latin font to render a long stretch of Tamil.
        text = "வணக்கம் உலகம். நீங்கள் எப்படி இருக்கிறீர்கள்? வா ச க ல ண ல"
        v = validate_font("Liberation Sans", text=text)
        if v.coverage_ok is False:
            assert len(v.missing_chars) <= _MAX_REPORTED_MISSING
