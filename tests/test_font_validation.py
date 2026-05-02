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


# ---------------------------------------------------------------------------
# 3c bundling: @font-face CSS generation
# ---------------------------------------------------------------------------

class TestCoalesceUnicodeRanges:
    """Coalescing arbitrary codepoint sets into CSS unicode-range syntax."""

    def test_empty_input_returns_empty_string(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        assert _coalesce_unicode_ranges([]) == ''
        assert _coalesce_unicode_ranges(set()) == ''

    def test_single_codepoint_emits_single_token(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        assert _coalesce_unicode_ranges([0x41]) == 'U+41'

    def test_contiguous_codepoints_emit_one_range(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        assert _coalesce_unicode_ranges(range(0x20, 0x7F)) == 'U+20-7E'

    def test_disjoint_blocks_emit_multiple_ranges(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        result = _coalesce_unicode_ranges([0x20, 0x21, 0x40, 0x41, 0x42])
        assert result == 'U+20-21, U+40-42'

    def test_singleton_in_middle(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        # Gap of size 2 — singleton emerges between ranges.
        result = _coalesce_unicode_ranges([0x20, 0x21, 0x23, 0x40, 0x41])
        assert result == 'U+20-21, U+23, U+40-41'

    def test_dedup_and_sort(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        # Out-of-order with dupes — should still emit ascending coalesced.
        result = _coalesce_unicode_ranges([0x42, 0x40, 0x41, 0x42, 0x40])
        assert result == 'U+40-42'

    def test_high_codepoint_uses_uppercase_hex(self):
        from loom_core.fonts import _coalesce_unicode_ranges
        # Astral plane codepoint — exercises >4-hex-digit formatting.
        assert _coalesce_unicode_ranges([0x1F600]) == 'U+1F600'


class TestIterFaces:
    """FontScanner.iter_faces() — face dedup + ordering."""

    def test_yields_each_face_once(self, synthetic_scanner):
        # Synthetic dir has 4 faces: TestLatin Regular+Bold, TestHebrew, TestCJK.
        faces = list(synthetic_scanner.iter_faces())
        assert len(faces) == 4

    def test_dedups_face_under_typographic_family(self, synthetic_scanner):
        # A face exposes both typographic and legacy family names; iter_faces
        # must yield it under exactly one — the typographic / preferred name.
        faces = list(synthetic_scanner.iter_faces())
        seen_paths = [face[0] for _, face in faces]
        assert len(seen_paths) == len(set(seen_paths))

    def test_orders_by_family_then_weight(self, synthetic_scanner):
        # Expected order: TestCJK, TestHebrew, TestLatin Regular, TestLatin Bold.
        faces = list(synthetic_scanner.iter_faces())
        families_in_order = [fam for fam, _ in faces]
        assert families_in_order == [
            'TestCJK', 'TestHebrew', 'TestLatin', 'TestLatin',
        ]
        # The two TestLatin entries: 400 before 700.
        weights = [synthetic_scanner.face_weight(face) for _, face in faces]
        assert weights == [400, 400, 400, 700]


class TestFaceWeight:
    def test_regular_returns_400(self, synthetic_scanner):
        face = synthetic_scanner.resolve('TestLatin')
        assert synthetic_scanner.face_weight(face) == 400

    def test_bold_returns_700(self, synthetic_scanner):
        # Walk faces to find the Bold one — resolve() prefers Regular.
        bold = next(
            face for fam, face in synthetic_scanner.iter_faces()
            if fam == 'TestLatin' and synthetic_scanner.face_weight(face) == 700
        )
        assert synthetic_scanner.face_weight(bold) == 700

    def test_unknown_face_defaults_to_400(self, synthetic_scanner):
        # Face tuple that was never indexed.
        assert synthetic_scanner.face_weight(('/no/such/path.ttf', 0)) == 400


class TestBuildFontFaceCss:
    """End-to-end: scanner → CSS string Chromium can consume."""

    def test_emits_one_block_per_face(self, synthetic_scanner):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # 4 indexed faces → 4 @font-face blocks.
        assert css.count('@font-face') == 4

    def test_each_block_has_required_descriptors(self, synthetic_scanner):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # Each block must have all four descriptors.
        for descriptor in ('font-family:', 'font-weight:',
                           'src:', 'unicode-range:'):
            assert css.count(descriptor) == 4, (
                f"{descriptor!r} appeared {css.count(descriptor)}x; expected 4"
            )

    def test_family_names_match_typographic_family(self, synthetic_scanner):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        assert "font-family: 'TestLatin'" in css
        assert "font-family: 'TestHebrew'" in css
        assert "font-family: 'TestCJK'" in css

    def test_weight_descriptor_distinguishes_regular_vs_bold(
            self, synthetic_scanner):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # 3 Regular faces (Latin, Hebrew, CJK) + 1 Bold (Latin).
        assert css.count('font-weight: 400;') == 3
        assert css.count('font-weight: 700;') == 1

    def test_src_uses_file_url_with_format_hint(
            self, synthetic_scanner, synthetic_font_dir):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # All synthetic fixtures are .ttf → format('truetype').
        assert "format('truetype')" in css
        # File URL points into the fixture dir.  Compare via as_uri() so
        # the expected prefix matches the emitter's normalization on
        # Windows (backslash paths → file:///C:/... with forward slashes).
        expected_prefix = synthetic_font_dir.as_uri() + "/"
        expected_prefix_resolved = synthetic_font_dir.resolve().as_uri() + "/"
        assert expected_prefix in css or expected_prefix_resolved in css

    def test_latin_unicode_range_covers_ascii(self, synthetic_scanner):
        """The Latin synthetic face declares cmap = U+20-7E.  Its
        unicode-range descriptor must coalesce to a single contiguous
        range — confirms the cmap → range pipeline is intact."""
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # Find the TestLatin Regular block (font-weight: 400 immediately
        # after font-family: 'TestLatin').
        latin_block_start = css.find("font-family: 'TestLatin'")
        # Find the next @font-face boundary.
        latin_block_end = css.find('@font-face', latin_block_start + 1)
        if latin_block_end == -1:
            latin_block_end = len(css)
        latin_block = css[latin_block_start:latin_block_end]
        # ASCII printable range is U+20-7E; conftest defines exactly
        # range(0x20, 0x7F).  After coalescing → "U+20-7E".
        assert 'U+20-7E' in latin_block

    def test_hebrew_unicode_range_covers_alefbet(self, synthetic_scanner):
        from loom_core.fonts import build_font_face_css
        css = build_font_face_css(synthetic_scanner)
        # Hebrew letter block is range(0x05D0, 0x05EB) → coalesces to U+5D0-5EA.
        hebrew_idx = css.find("font-family: 'TestHebrew'")
        assert hebrew_idx != -1
        next_block = css.find('@font-face', hebrew_idx + 1)
        if next_block == -1:
            next_block = len(css)
        hebrew_block = css[hebrew_idx:next_block]
        assert 'U+5D0-5EA' in hebrew_block

    def test_empty_scanner_returns_empty_string(self, tmp_path):
        """A scanner pointing at an empty dir yields no @font-face
        blocks.  Caller (the rasterizer template) treats an empty
        result as 'fall through to system fonts' — important so dev
        without LOOM_FONT_DIR set doesn't break the template."""
        from loom_core.fonts import FontScanner, build_font_face_css
        empty_dir = tmp_path / "empty_fonts"
        empty_dir.mkdir()
        scanner = FontScanner([empty_dir])
        assert build_font_face_css(scanner) == ''

    def test_uses_default_scanner_when_none_passed(self, synthetic_scanner):
        from loom_core.fonts import (
            build_font_face_css, set_default_scanner, get_default_scanner,
        )
        original = get_default_scanner()
        try:
            set_default_scanner(synthetic_scanner)
            css = build_font_face_css()  # no scanner arg
            assert "font-family: 'TestLatin'" in css
        finally:
            set_default_scanner(original)
