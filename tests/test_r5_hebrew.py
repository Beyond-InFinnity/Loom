"""R5-4 phase (a): Modern Hebrew block romanization.

The romanizer is a consonantal-with-heuristics scheme that:
  * Strips nikud / cantillation before processing.
  * Applies a mater lectionis rule: ו and י are consonantal
    word-initially or after another vowel-letter, and vocalic
    (o / i respectively) after a consonant.
  * Inserts a default 'a' between consecutive consonants.
  * Uses soft/spirantized defaults for begadkefat (ב=v, כ=kh, פ=f).

These heuristics produce recognizable output for the most common
Modern Hebrew words but have known limitations without nikud.  The
tests capture both the successes (shalom, olam, toda) and the
known-wrong cases (baruch → varokh, bayit → vit) so regressions are
visible if/when we add a nikud-aware pass.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ---------------------------------------------------------------------------
# Block romanizer — correct cases
# ---------------------------------------------------------------------------

class TestHebrewCommonWords:
    """Words the heuristic handles correctly end-to-end."""

    def test_shalom(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('שלום').lower() == 'shalom'

    def test_shalom_with_nikud_matches_without(self):
        """Nikud stripping — שָׁלוֹם and שלום transliterate identically."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('שָׁלוֹם').lower() == r('שלום').lower()

    def test_olam(self):
        """עולם → olam.  ע is silent; ו after silent ע classifies
        as vowel because prev_kind is 'cons' (silent but still cons)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('עולם').lower() == 'olam'

    def test_toda(self):
        """תודה → todah (the trailing ה voices as 'h'; colloquial
        'toda' would drop it but 'todah' is the formal transliteration)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('תודה').lower() == 'todah'

    def test_two_word_phrase(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('שלום עולם').lower() == 'shalom olam'


class TestHebrewSilentLetters:
    """א and ע render as empty string (silent)."""

    def test_alef_initial(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('אני').lower() == 'ani'

    def test_ayin_initial(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('עין').lower().startswith('i'), (
            "ע is silent; יn after silent ע reads as 'in'"
        )


class TestHebrewFinalForms:
    """Final-form letters (ם ן ף ץ ך) share their base form's
    transliteration — the final forms are graphical, not phonemic."""

    def test_final_mem(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # שלום ends in final mem ם → 'm'
        assert r('שלום').lower().endswith('m')

    def test_final_nun(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # עין ends in final nun ן → 'n'
        assert r('עין').lower().endswith('n')

    def test_final_tzadi(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert 'tz' in r('קפץ').lower()

    def test_final_pe(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # Final pe ף soft default
        assert 'f' in r('סוף').lower()

    def test_final_kaf(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # Final kaf ך → kh (soft default)
        assert 'kh' in r('לך').lower()


class TestHebrewNikudStripping:
    """Combining marks (nikud U+05B0-U+05BC etc. + cantillation) are
    stripped before transliteration — they don't affect output."""

    def test_hirik_dot_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # בִ (b with hirik) should transliterate same as ב alone.
        assert r('בִ').lower() == r('ב').lower()

    def test_shin_dot_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        # שׁ (shin with right dot) = ש + 'sh' base.
        assert r('שׁ').lower() == r('ש').lower()


class TestHebrewMixedText:
    def test_latin_passthrough(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('Hello שלום world!')
        assert 'Hello' in out
        assert 'shalom' in out.lower()
        assert 'world' in out

    def test_punctuation_preserved(self):
        """Polish converts any CJK punct but ASCII question marks
        and periods in Hebrew text survive."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert '?' in r('מה שלומך?')
        assert '.' in r('תודה רבה.')


class TestHebrewPolishIntegration:
    """Hebrew flows through _polish_romaji(capitalize=True)."""

    def test_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('שלום')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()

    def test_post_period_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('שלום. שלום')
        idx = out.find('.')
        tail = out[idx + 1:].lstrip()
        assert tail and tail[0].isupper()


class TestHebrewEdgeCases:
    def test_empty(self):
        from loom_core.romanize import get_romanizer
        assert get_romanizer('he')('') == ''

    def test_ass_tags_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('{\\an8}שלום')
        assert '{' not in out and '\\an8' not in out
        assert 'shalom' in out.lower()

    def test_whitespace_only(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        assert r('   ').strip() == ''


class TestHebrewKnownLimitations:
    """Documents the cases where the no-nikud heuristic produces
    recognizably-wrong output.  These tests LOCK IN the current
    behavior — if we add a nikud-aware / dictionary pass later, these
    tests will fail and remind us to update the limitation docs."""

    def test_baruch_hard_b_becomes_soft_v(self):
        """ברוך should be 'baruch' but the soft default gives 'varokh'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('ברוך').lower()
        assert 'varokh' == out, (
            f"Known limitation: no-nikud Hebrew defaults ב to soft 'v'. "
            f"Got {out!r}; if this changed, update the docstring comment "
            f"and the known-limitation notes in CLAUDE.md."
        )

    def test_chaverim_e_becomes_a(self):
        """חברים should be 'chaverim' but default-vowel 'a' gives 'chavarim'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('he')
        out = r('חברים').lower()
        assert 'chavarim' == out


# ---------------------------------------------------------------------------
# Script detection
# ---------------------------------------------------------------------------


class TestHebrewScriptDetection:
    def test_dominant_hebrew(self):
        from loom_core.language import _dominant_script
        assert _dominant_script('שלום עולם') == 'Hebrew'

    def test_detect_language_hebrew(self):
        from loom_core.language import detect_language_from_text
        assert detect_language_from_text('שלום, איך אתה?') == 'he'

    def test_majority_latin_not_misdetected(self):
        """A line with mostly English + one Hebrew word should NOT
        resolve to Hebrew — the dominant-script rule requires >40%."""
        from loom_core.language import _dominant_script
        assert _dominant_script(
            'This English line has one שלום word in it'
        ) != 'Hebrew'


# ---------------------------------------------------------------------------
# Language config
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# R5-4 phase (b) — RTL rendering plumbing (no full Playwright rasterize here,
# that's covered by the visual-verification script — this locks in the
# structural contract of the generated HTML).
# ---------------------------------------------------------------------------


class TestIsRtlText:
    def test_hebrew_true(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text("שלום עולם") is True

    def test_arabic_true(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text("مرحبا بالعالم") is True

    def test_english_false(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text("Hello world") is False

    def test_mixed_dominant_hebrew(self):
        """Line is mostly Hebrew with a couple of English loanwords →
        still RTL at the paragraph level."""
        from loom_core.language import is_rtl_text
        assert is_rtl_text("אני גר ב Tel Aviv כל חיי") is True

    def test_mixed_dominant_english(self):
        """A few Hebrew chars inside an English sentence → not dominant."""
        from loom_core.language import is_rtl_text
        assert is_rtl_text("The word שלום means peace") is False

    def test_empty(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text("") is False

    def test_whitespace_and_punct_ignored(self):
        """Non-letter characters don't affect the dominance calculation."""
        from loom_core.language import is_rtl_text
        assert is_rtl_text("   שלום.   ") is True


class TestPgsRasterizeRtlPlumbing:
    """Structural tests of the generated HTML template.  Actual pixel
    verification happens via the ad-hoc Playwright script — these just
    lock in that the flag lands in the template."""

    def _styles(self):
        import pysubs2
        return {
            'Bottom':    {'fontname': 'Noto Sans', 'fontsize': 48, 'marginv': 40,
                          'bold': False, 'italic': False,
                          'primarycolor': pysubs2.Color(255,255,255,0),
                          'outlinecolor': pysubs2.Color(0,0,0,0),
                          'outline': 3.0, 'outline_none': False,
                          'shadow_none': True, 'glow_none': True},
            'Top':       {'fontname': 'Noto Sans Hebrew', 'fontsize': 52, 'marginv': 90,
                          'bold': False, 'italic': False,
                          'primarycolor': pysubs2.Color(255,255,0,0),
                          'outlinecolor': pysubs2.Color(0,0,0,0),
                          'outline': 2.5, 'outline_none': False,
                          'shadow_none': True, 'glow_none': True},
            'Romanized': {'fontname': 'Noto Sans', 'fontsize': 30, 'marginv': 10,
                          'bold': False, 'italic': False,
                          'primarycolor': pysubs2.Color(200,200,200,0),
                          'outlinecolor': pysubs2.Color(0,0,0,0),
                          'outline': 1.5, 'outline_none': False,
                          'shadow_none': True, 'glow_none': True},
            'Annotation': {'fontname': 'Noto Sans', 'fontsize': 22,
                           'bold': False, 'italic': False,
                           'primarycolor': pysubs2.Color(255,255,255,0),
                           'outlinecolor': pysubs2.Color(0,0,0,0),
                           'outline': 1.0, 'outline_none': True,
                           'shadow_none': True, 'glow_none': True},
        }

    def test_top_rtl_sets_attr(self):
        from loom_core.rasterize.pgs import _build_fullframe_html
        html = _build_fullframe_html(self._styles(), 1920, 1080, 1.0, top_rtl=True)
        assert 'id="top" class="layer" dir="rtl"' in html
        assert 'id="bottom" class="layer" dir="rtl"' not in html

    def test_bottom_rtl_sets_attr(self):
        from loom_core.rasterize.pgs import _build_fullframe_html
        html = _build_fullframe_html(self._styles(), 1920, 1080, 1.0, bottom_rtl=True)
        assert 'id="bottom" class="layer" dir="rtl"' in html
        assert 'id="top" class="layer" dir="rtl"' not in html

    def test_no_rtl_by_default(self):
        from loom_core.rasterize.pgs import _build_fullframe_html
        html = _build_fullframe_html(self._styles(), 1920, 1080, 1.0)
        assert 'dir="rtl"' not in html

    def test_romanized_never_rtl(self):
        """Romanized is always Latin-script — no exposed flag, never gets
        dir="rtl", even when both other layers are RTL."""
        from loom_core.rasterize.pgs import _build_fullframe_html
        html = _build_fullframe_html(self._styles(), 1920, 1080, 1.0,
                                      top_rtl=True, bottom_rtl=True)
        assert 'id="romaji" class="layer" dir="rtl"' not in html

    def test_unicode_bidi_isolate_always_present(self):
        """Every .layer gets unicode-bidi: isolate regardless of rtl flags
        — prevents directionality leaking between layers."""
        from loom_core.rasterize.pgs import _build_fullframe_html
        html = _build_fullframe_html(self._styles(), 1920, 1080, 1.0)
        assert 'unicode-bidi: isolate' in html


class TestPreviewRtlPlumbing:
    """generate_unified_preview threads rtl flags into per-layer divs."""

    def _min_styles(self):
        import pysubs2
        def _layer(marginv, size):
            return {
                'enabled': True, 'fontname': 'Noto Sans',
                'fontsize': size, 'marginv': marginv,
                'bold': False, 'italic': False,
                'primarycolor': pysubs2.Color(255,255,255,0),
                'outlinecolor': pysubs2.Color(0,0,0,0),
                'backcolor': pysubs2.Color(0,0,0,255),
                'outline': 2.0, 'outline_none': False,
                'shadow_none': True, 'back_none': True, 'glow_none': True,
            }
        return {
            'Bottom':     _layer(40, 48),
            'Top':        _layer(90, 52),
            'Romanized':  _layer(10, 30),
            'Annotation': {**_layer(0, 22), 'enabled': False},
            'vertical_offset': 0, 'romanized_gap': 0, 'annotation_gap': 2,
        }

    def test_explicit_top_rtl_wins_over_content(self):
        """When a caller passes top_rtl=True explicitly, the output
        reflects that even if the text looks LTR."""
        from loom_core.subs.preview import generate_unified_preview
        html = generate_unified_preview(
            styles=self._min_styles(),
            native_text="Hello",
            target_text="ENGLISH",  # no RTL chars
            pinyin_text="",
            top_rtl=True,
        )
        # There's a div for Top with dir="rtl" somewhere in the overlay
        # HTML — substring check is sufficient.
        assert 'dir="rtl"' in html

    def test_inferred_from_hebrew_content(self):
        """No explicit flag → content heuristic picks up Hebrew."""
        from loom_core.subs.preview import generate_unified_preview
        html = generate_unified_preview(
            styles=self._min_styles(),
            native_text="Hello",
            target_text="שלום עולם",
            pinyin_text="Shalom olam",
        )
        assert 'dir="rtl"' in html

    def test_no_rtl_for_all_ltr(self):
        from loom_core.subs.preview import generate_unified_preview
        html = generate_unified_preview(
            styles=self._min_styles(),
            native_text="Hello",
            target_text="Bonjour",
            pinyin_text="",
        )
        assert 'dir="rtl"' not in html

    def test_unicode_bidi_isolate_on_every_overlay(self):
        from loom_core.subs.preview import generate_unified_preview
        html = generate_unified_preview(
            styles=self._min_styles(),
            native_text="a",
            target_text="b",
            pinyin_text="c",
        )
        # At least 3 occurrences — one per enabled layer (Bottom/Top/Romanized).
        assert html.count('unicode-bidi:isolate') >= 3


class TestHebrewLangConfig:
    def test_hebrew_config(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('he')
        assert cfg['romanize_func'] is not None
        assert cfg['has_phonetic_layer'] is True
        # R5-4 phase (a) is block-only — annotation comes later.
        assert cfg['annotation_func'] is None
        assert cfg['romanization_name'] == 'Hebrew transliteration'
        assert cfg['romanization_confidence'] == 'moderate'
        assert cfg['default_font'] == 'Noto Sans Hebrew'
        # Hebrew is RTL — flagged for future renderer work (phase b).
        assert cfg['rtl'] is True
        assert cfg['supports_ass_annotation'] is False
        assert cfg['annotation_system_name'] == 'Transliteration'
