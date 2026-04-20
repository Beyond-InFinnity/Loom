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
