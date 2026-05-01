"""R6b-fonts: font availability + glyph-coverage validation tests.

The validator is backed by :class:`loom_core.fonts.FontScanner`, a
fontTools-only directory walker.  Tests run on Linux, macOS, and
Windows identically — the synthetic font fixtures (see
``conftest.py::synthetic_font_dir``) provide a controlled set of TTFs
with known family names and cmaps, so each test can verify scanner +
validator behavior without depending on what's installed system-wide.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ---------------------------------------------------------------------------
# Pure-Python logic (no scanner needed)
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
        from loom_core.fonts import _coverage_sample_for
        missing = [lang for lang in _ROMANIZATION_META
                   if _coverage_sample_for(lang) is None]
        assert not missing, (
            f"No coverage sample registered for: {missing!r}.  Add an "
            f"entry to _LANG_COVERAGE_SAMPLES in loom_core/fonts.py."
        )


# ---------------------------------------------------------------------------
# FontScanner — directory walking, family-name resolution, weight pref
# ---------------------------------------------------------------------------

class TestFontScanner:
    def test_indexes_synthetic_fonts(self, synthetic_scanner):
        families = synthetic_scanner.families()
        # Display names — lowercase comparison via the lookup, but the
        # display list should contain the literal family names.
        assert 'TestLatin' in families
        assert 'TestHebrew' in families
        assert 'TestCJK' in families

    def test_resolve_returns_path_and_index(self, synthetic_scanner):
        face = synthetic_scanner.resolve('TestLatin')
        assert face is not None
        path, index = face
        assert path.endswith('.ttf')
        assert index == 0

    def test_resolve_is_case_insensitive(self, synthetic_scanner):
        a = synthetic_scanner.resolve('TestLatin')
        b = synthetic_scanner.resolve('testlatin')
        c = synthetic_scanner.resolve('TESTLATIN')
        assert a == b == c
        assert a is not None

    def test_resolve_collapses_whitespace(self, synthetic_scanner):
        # No internal whitespace in TestLatin, but extra outer whitespace
        # should still resolve.
        assert synthetic_scanner.resolve('  TestLatin  ') is not None

    def test_resolve_returns_none_for_unknown(self, synthetic_scanner):
        assert synthetic_scanner.resolve('NoSuchFontXYZ') is None

    def test_prefers_regular_over_bold(self, synthetic_scanner):
        """The fixture has both TestLatin-Regular and TestLatin-Bold;
        resolve() must pick the Regular weight."""
        face = synthetic_scanner.resolve('TestLatin')
        assert face is not None
        assert 'Regular' in face[0]

    def test_cmap_for_returns_codepoints(self, synthetic_scanner):
        face = synthetic_scanner.resolve('TestLatin')
        cmap = synthetic_scanner.cmap_for(face)
        assert cmap is not None
        assert ord('A') in cmap
        assert ord('語') not in cmap   # Latin font, no CJK

    def test_display_family_returns_canonical_name(self, synthetic_scanner):
        # Lookup case-insensitive but canonical name comes from the font.
        assert synthetic_scanner.display_family('testlatin') == 'TestLatin'

    def test_skips_nonexistent_directories(self):
        """Constructing a scanner with paths that don't exist should
        not raise — just exclude them from the indexed set."""
        from loom_core.fonts import FontScanner
        s = FontScanner(['/nonexistent/path/zzz', '/also/missing'])
        assert s.directories() == []
        assert s.families() == []
        assert s.resolve('TestLatin') is None

    def test_invalidate_forces_rebuild(self, synthetic_scanner):
        # Trigger initial build, then invalidate, then rebuild.
        before = synthetic_scanner.families()
        synthetic_scanner.invalidate()
        after = synthetic_scanner.families()
        assert before == after

    def test_handles_ttc_when_present(self):
        """If the dev system has Noto Sans CJK installed as a TTC, the
        scanner should index it.  Skipped when no TTC is present."""
        from pathlib import Path
        from loom_core.fonts import FontScanner
        candidates = [
            Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
            Path('/Library/Fonts/NotoSansCJK-Regular.ttc'),
        ]
        ttc = next((p for p in candidates if p.exists()), None)
        if ttc is None:
            pytest.skip("no Noto CJK TTC present on this system")
        s = FontScanner([ttc.parent])
        # TTC contains multiple faces — at minimum JP/KR/SC/TC subfaces.
        face = s.resolve('Noto Sans CJK JP')
        assert face is not None
        assert face[0] == str(ttc)


# ---------------------------------------------------------------------------
# validate_font — public API, scanner-backed
# ---------------------------------------------------------------------------

class TestValidateFont:
    def test_empty_font_name_warns(self, synthetic_scanner):
        from loom_core.fonts import validate_font
        v = validate_font("", scanner=synthetic_scanner)
        assert v.warnings
        assert v.resolved_path is None

    def test_unknown_font_marks_fallback(self, synthetic_scanner):
        """Unknown family → not in scanned dir → is_fallback flag set,
        warning describes the situation.  This is the silent-substitution
        signal in the new backend."""
        from loom_core.fonts import validate_font
        v = validate_font("TotallyFakeFontNameZZZ", scanner=synthetic_scanner)
        assert v.is_fallback is True
        assert v.resolved_path is None
        assert any("not found" in w.lower() for w in v.warnings)

    def test_known_font_no_lang_no_text(self, synthetic_scanner):
        """Font found, but no coverage check requested → coverage_ok
        stays None."""
        from loom_core.fonts import validate_font
        v = validate_font("TestLatin", scanner=synthetic_scanner)
        assert v.resolved_path is not None
        assert v.is_fallback is False
        assert v.coverage_ok is None
        assert v.missing_chars == []

    def test_text_overrides_lang_sample(self, synthetic_scanner):
        """When text is provided, only its chars are checked — lang_code
        is ignored.  Latin font + Latin text passes regardless of lang."""
        from loom_core.fonts import validate_font
        v = validate_font("TestLatin", lang_code="ja", text="hello",
                          scanner=synthetic_scanner)
        assert v.coverage_ok is True
        assert v.missing_chars == []


class TestCoverageDetection:
    def test_cjk_font_covers_japanese(self, synthetic_scanner):
        from loom_core.fonts import validate_font
        v = validate_font("TestCJK", lang_code="ja", scanner=synthetic_scanner)
        assert v.coverage_ok is True
        assert v.is_fallback is False
        assert v.missing_chars == []

    def test_cjk_font_covers_korean(self, synthetic_scanner):
        from loom_core.fonts import validate_font
        v = validate_font("TestCJK", lang_code="ko", scanner=synthetic_scanner)
        assert v.coverage_ok is True

    def test_cjk_font_covers_traditional_chinese(self, synthetic_scanner):
        """The fixture's TestCJK includes 國 + 學 — the zh-Hant
        discriminator chars."""
        from loom_core.fonts import validate_font
        v = validate_font("TestCJK", lang_code="zh-Hant",
                          scanner=synthetic_scanner)
        assert v.coverage_ok is True

    def test_latin_font_fails_cjk_coverage(self, synthetic_scanner):
        """TestLatin has no CJK glyphs — coverage check must flag it
        and list specific missing CJK chars."""
        from loom_core.fonts import validate_font
        v = validate_font("TestLatin", lang_code="ja",
                          scanner=synthetic_scanner)
        assert v.is_fallback is False
        assert v.coverage_ok is False
        missing_set = set(v.missing_chars)
        # Sample chars come from _LANG_COVERAGE_SAMPLES["ja"].
        assert 'あ' in missing_set or '語' in missing_set

    def test_latin_font_fails_hebrew_coverage(self, synthetic_scanner):
        from loom_core.fonts import validate_font
        v = validate_font("TestLatin", lang_code="he",
                          scanner=synthetic_scanner)
        assert v.coverage_ok is False
        # Hebrew letter aleph (U+05D0) should be among the missing.
        assert any(0x05D0 <= ord(c) <= 0x05EA for c in v.missing_chars)

    def test_hebrew_font_covers_hebrew(self, synthetic_scanner):
        from loom_core.fonts import validate_font
        v = validate_font("TestHebrew", lang_code="he",
                          scanner=synthetic_scanner)
        assert v.coverage_ok is True
        assert v.missing_chars == []

    def test_missing_chars_capped(self, synthetic_scanner):
        """The missing_chars list is capped — if a font is completely
        unsuited, we get a representative sample, not a thousand-char
        dump."""
        from loom_core.fonts import validate_font, _MAX_REPORTED_MISSING
        # Long stretch of Tamil through a Latin-only font.
        text = "வணக்கம் உலகம். நீங்கள் எப்படி இருக்கிறீர்கள்? வா ச க ல ண ல"
        v = validate_font("TestLatin", text=text, scanner=synthetic_scanner)
        assert v.coverage_ok is False
        assert len(v.missing_chars) <= _MAX_REPORTED_MISSING


# ---------------------------------------------------------------------------
# Default-scanner module state
# ---------------------------------------------------------------------------

class TestDefaultScanner:
    def test_set_default_scanner_swaps_in_fixture(self, synthetic_scanner):
        """After set_default_scanner(), validate_font() with no
        explicit scanner uses the swap-in.  Critical for production
        wiring later — the Tauri shell will call set_default_scanner
        with the bundled-resources directory at startup."""
        from loom_core.fonts import (
            set_default_scanner, get_default_scanner, validate_font,
        )
        original = get_default_scanner()
        try:
            set_default_scanner(synthetic_scanner)
            v = validate_font("TestLatin")
            assert v.resolved_path is not None
            v2 = validate_font("TotallyMadeUp")
            assert v2.is_fallback is True
        finally:
            set_default_scanner(original)

    def test_set_default_scanner_none_resets(self):
        """Passing None clears the cached default; next call rebuilds."""
        from loom_core.fonts import (
            set_default_scanner, get_default_scanner, FontScanner,
        )
        set_default_scanner(None)
        s = get_default_scanner()
        assert isinstance(s, FontScanner)
