"""Shared pytest fixtures.

The synthetic font fixtures here let the font-validator tests run on
any platform without depending on system-installed fonts.  Each font
is a minimal valid TTF built via :class:`fontTools.fontBuilder.FontBuilder`
with a controlled cmap and family name, so tests can verify scanner
behavior deterministically — no fontconfig, no Linux-only path.
"""

from __future__ import annotations

from pathlib import Path

import pytest


# Codepoint sets used to drive coverage tests.  Kept in module scope so
# tests that build expectations off them stay in sync with the fixtures.
_LATIN_CODEPOINTS: frozenset[int] = frozenset(range(0x20, 0x7F))
# Hebrew letter block + final forms.
_HEBREW_CODEPOINTS: frozenset[int] = frozenset(range(0x05D0, 0x05EB))
# A compact CJK set covering the cmap targets in _LANG_COVERAGE_SAMPLES
# for ja / ko / zh-Hans / zh-Hant.
_CJK_CODEPOINTS: frozenset[int] = frozenset({
    0x3042, 0x30A2, 0x30FC, 0x8A9E,           # ja: あ ア ー 語
    0xD55C, 0xAD6D, 0xAC00,                   # ko: 한 국 가
    0x4F60, 0x597D, 0x56FD,                   # zh: 你 好 国 (Simplified)
    0x570B, 0x5B78,                           # zh-Hant: 國 學
})


def _build_synthetic_ttf(path: Path, family_name: str, style_name: str,
                         codepoints: frozenset[int]) -> None:
    """Write a minimal valid TTF with the requested family + cmap.

    The glyphs are all the same square — visually meaningless, but the
    font is structurally valid (passes ``TTFont.getBestCmap()``,
    ``OS/2.usWeightClass``, name table reads).  Output is ~4 KB per
    font, so a fixture directory of half a dozen fonts is negligible.
    """
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    glyph_order = ['.notdef'] + [f'u{cp:04X}' for cp in sorted(codepoints)]
    cmap = {cp: f'u{cp:04X}' for cp in codepoints}

    fb = FontBuilder(unitsPerEm=1000, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)

    pens: dict[str, object] = {}
    for gn in glyph_order:
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((500, 0))
        pen.lineTo((500, 500))
        pen.lineTo((0, 500))
        pen.closePath()
        pens[gn] = pen.glyph()
    fb.setupGlyf(pens)

    fb.setupHorizontalMetrics({gn: (500, 0) for gn in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({
        'familyName': family_name,
        'styleName': style_name,
        'fullName': f'{family_name} {style_name}',
        'psName': f"{family_name.replace(' ', '')}-{style_name.replace(' ', '')}",
        'uniqueFontIdentifier': f'loom-test-{family_name}-{style_name}',
    })
    # Map common style names to OS/2 weight classes so the scanner's
    # "prefer Regular" tiebreaker has something to work with.
    weight_class = {
        'Regular': 400, 'Bold': 700, 'Light': 300, 'Black': 900,
    }.get(style_name, 400)
    fb.setupOS2(
        sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=200,
        usWinAscent=800, usWinDescent=200,
        usWeightClass=weight_class,
    )
    fb.setupPost()
    fb.save(str(path))


@pytest.fixture(scope="session")
def synthetic_font_dir(tmp_path_factory) -> Path:
    """Directory of synthetic TTFs for font-scanner tests.

    Contents:
      * ``TestLatin-Regular.ttf`` — ASCII printable; family ``TestLatin``.
      * ``TestHebrew-Regular.ttf`` — Hebrew letter block; family
        ``TestHebrew``.
      * ``TestCJK-Regular.ttf`` — small Japanese / Korean / Han set;
        family ``TestCJK``.
      * ``TestLatin-Bold.ttf`` — second weight under family ``TestLatin``,
        used to verify scanner's Regular-weight preference.
    """
    d = tmp_path_factory.mktemp("synthetic_fonts")
    _build_synthetic_ttf(d / "TestLatin-Regular.ttf",
                         "TestLatin", "Regular", _LATIN_CODEPOINTS)
    _build_synthetic_ttf(d / "TestLatin-Bold.ttf",
                         "TestLatin", "Bold", _LATIN_CODEPOINTS)
    _build_synthetic_ttf(d / "TestHebrew-Regular.ttf",
                         "TestHebrew", "Regular", _HEBREW_CODEPOINTS)
    _build_synthetic_ttf(d / "TestCJK-Regular.ttf",
                         "TestCJK", "Regular", _CJK_CODEPOINTS)
    return d


@pytest.fixture
def synthetic_scanner(synthetic_font_dir):
    """Fresh :class:`FontScanner` over the synthetic fixture.

    Function-scoped so individual tests can mutate / invalidate without
    leaking state into others.
    """
    from loom_core.fonts import FontScanner
    return FontScanner([synthetic_font_dir])
