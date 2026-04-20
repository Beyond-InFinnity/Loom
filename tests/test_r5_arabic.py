"""R5-4 remaining: Arabic (ar) block romanization.

The romanizer is a consonantal-with-heuristics scheme that:
  * Strips tashkil / shadda / sukun / tanwin / superscript alif.
  * Treats alif (ا) as long ā when medial/final, carrier 'a' at word-start.
  * Applies a mater lectionis rule: و and ي are consonantal at word-start
    or after another vowel letter, vocalic (ū / ī) after a consonant.
  * Inserts a default 'a' between consecutive consonants.
  * Handles the definite article ال with sun-letter assimilation
    (14 sun letters → doubled; 14 moon letters → al- unchanged).
  * Hamza carriers (أ إ آ ؤ ئ ء) emit ʾ in learner/din, nothing in loose.

Three phonetic systems:
  * "learner" (default) — hybrid: macrons + emphatic marks + sh/gh/th/dh/kh
  * "din"               — full DIN 31635 (š ġ ṯ ḏ ḫ)
  * "loose"             — ASCII-only, no emphatic marks or ayn

These heuristics produce recognizable output for common Arabic words but
have known limitations without tashkil.  Tests lock in both the successes
(salām, al-qamar, ṣabāḥ, ash-shamas for sun-letter assimilation) and the
known-wrong cases (shukran → Shakarā, bayt → Bīt) so regressions are
visible when we add a tashkil-aware pass.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ---------------------------------------------------------------------------
# Block romanizer — common words (learner default)
# ---------------------------------------------------------------------------

class TestArabicCommonWords:
    """Phrases the learner-default heuristic handles cleanly."""

    def test_salam(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('سلام').lower() == 'salām'

    def test_salam_with_tashkil_matches_without(self):
        """Tashkil stripping — سَلَامٌ and سلام transliterate identically."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('سَلَامٌ').lower() == r('سلام').lower()

    def test_qamar_with_moon_article(self):
        """القمر → al-qamar (moon letter, no assimilation)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('القمر').lower() == 'al-qamar'

    def test_bayt_with_moon_article(self):
        """البيت → al-bayt/al-bīt (moon letter, no extra 'a')."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        # Default mater rule gives long ī not diphthong ay.
        assert r('البيت').lower() == 'al-bīt'

    def test_emphatic_sad(self):
        """صباح → ṣabāḥ (learner keeps emphatic ṣ, ḥ)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('صباح').lower() == 'ṣabāḥ'

    def test_long_vowel_nur(self):
        """نور → nūr (wāw between consonants = long ū mater)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('نور').lower() == 'nūr'

    def test_two_word_phrase_with_maʿ(self):
        """مع السلامة → maʿ as-salāma (ayn-marked, sun-letter assimilation)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('مع السلامة').lower() == 'maʿ as-salāma'


# ---------------------------------------------------------------------------
# Definite article ال — sun-letter assimilation + moon-letter passthrough
# ---------------------------------------------------------------------------

class TestDefiniteArticle:
    def test_moon_letter_qamar(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('القمر').lower() == 'al-qamar'

    def test_moon_letter_bab(self):
        """الباب → al-bāb (moon letter ب)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('الباب').lower() == 'al-bāb'

    def test_sun_letter_shams(self):
        """الشمس → ash-shamas (sun letter ش — ash-shams ideally,
        but the default-'a' between m/s gives the extra 'a')."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('الشمس').lower()
        assert out.startswith('ash-sh')

    def test_sun_letter_assimilation_sin(self):
        """السلام → as-salām (sun letter س assimilates lām)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('السلام').lower() == 'as-salām'

    def test_sun_letter_nun(self):
        """النور → an-nūr (sun letter ن)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('النور').lower() == 'an-nūr'

    def test_sun_letter_ra(self):
        """الرجل → ar-rajal (sun letter ر; rajul is the correct reading
        but without tashkil the default-'a' gives rajal)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('الرجل').lower()
        assert out.startswith('ar-r')


# ---------------------------------------------------------------------------
# Phonetic system overrides: learner vs din vs loose
# ---------------------------------------------------------------------------

class TestPhoneticSystems:
    def test_learner_keeps_emphatic_marks(self):
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('learner')
        out = r('صباح').lower()
        assert 'ṣ' in out and 'ḥ' in out

    def test_din_uses_single_char_digraph_alternatives(self):
        """DIN replaces sh→š, kh→ḫ, gh→ġ, th→ṯ, dh→ḏ."""
        from loom_core.romanize import _make_arabic_romanizer
        r_din = _make_arabic_romanizer('din')
        r_learner = _make_arabic_romanizer('learner')
        shin_din = r_din('الشمس').lower()
        shin_learner = r_learner('الشمس').lower()
        assert 'š' in shin_din
        assert 'sh' in shin_learner

    def test_din_ghain(self):
        """غ: learner 'gh', DIN 'ġ'."""
        from loom_core.romanize import _make_arabic_romanizer
        r_din = _make_arabic_romanizer('din')
        r_learner = _make_arabic_romanizer('learner')
        assert 'ġ' in r_din('غنى').lower()
        assert 'gh' in r_learner('غنى').lower()

    def test_din_khain(self):
        """خ: learner 'kh', DIN 'ḫ'."""
        from loom_core.romanize import _make_arabic_romanizer
        r_din = _make_arabic_romanizer('din')
        r_learner = _make_arabic_romanizer('learner')
        out_din = r_din('خير').lower()
        out_learner = r_learner('خير').lower()
        assert 'ḫ' in out_din
        assert 'kh' in out_learner

    def test_loose_strips_emphatic_marks(self):
        """Loose mode: emphatic ṣ ḍ ṭ ẓ ḥ collapse to s d t z h."""
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('loose')
        out = r('صباح').lower()
        assert 'ṣ' not in out
        assert 'ḥ' not in out
        assert 's' in out and 'b' in out and 'h' in out

    def test_loose_drops_ayn(self):
        """Loose mode: ayn emits empty string (conservative for ASCII)."""
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('loose')
        out = r('عربي').lower()
        assert 'ʿ' not in out

    def test_loose_no_macrons(self):
        """Loose mode: long vowels emit as bare a/i/u without macrons."""
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('loose')
        out = r('كتاب').lower()
        assert 'ā' not in out and 'ī' not in out and 'ū' not in out
        assert 'a' in out and 'b' in out

    def test_invalid_phonetic_system_falls_back_to_learner(self):
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('bogus_scheme')
        # Should behave as learner (keeps emphatics).
        assert 'ṣ' in r('صباح').lower()


# ---------------------------------------------------------------------------
# Tashkil stripping + mixed-content passthrough
# ---------------------------------------------------------------------------

class TestTashkilAndPassthrough:
    def test_tashkil_stripping_preserves_output(self):
        """Fully vocalized text produces the same output as unvocalized."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('كِتَابٌ').lower() == r('كتاب').lower()

    def test_shadda_stripped(self):
        """Shadda (ّ) is stripped — no gemination in output."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        # مدرّسة → same as مدرسة after shadda stripping
        out1 = r('مدرّسة').lower()
        out2 = r('مدرسة').lower()
        assert out1 == out2

    def test_sukun_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        # يَكْتُبُ → same as يكتب after tashkil stripping
        assert r('يَكْتُبُ').lower() == r('يكتب').lower()

    def test_mixed_english_arabic(self):
        """English chars + Arabic block interleaved — only Arabic romanized."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('Hello سلام').lower()
        assert 'hello' in out.lower()
        assert 'salām' in out

    def test_numbers_and_punct_passthrough(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('123 سلام!')
        assert '123' in out
        assert '!' in out

    def test_empty_string(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('') == ''

    def test_non_arabic_only_passes_through(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('hello world').lower() == 'hello world'


# ---------------------------------------------------------------------------
# Capitalization + polish — _polish_romaji tail
# ---------------------------------------------------------------------------

class TestCapitalization:
    def test_sentence_initial_cap(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('سلام')
        assert out[0].isupper()

    def test_cap_after_period(self):
        """Polish inserts cap after sentence-terminal punctuation."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('سلام. سلام')
        # Both sentences start with capital 'S'.
        idx = out.index('.')
        after = out[idx + 1:].strip()
        assert after[0].isupper()

    def test_punctuation_strip_before_final(self):
        """Polish strips whitespace before punct (. , ! ?)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('سلام .')
        # Trailing "سلام " ending with space, then "." — polish joins to "salām."
        assert 'salām.' in out.lower()


# ---------------------------------------------------------------------------
# Hamza + alif-carrier handling
# ---------------------------------------------------------------------------

class TestHamzaAndCarriers:
    def test_initial_hamza_alif_above(self):
        """أ (U+0623) = ʾa- initial vowel + hamza."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('أنا')
        # Expect "ʾana" or similar; ayn/hamza marks present in learner.
        assert 'ʾ' in out
        assert 'a' in out.lower()
        assert 'n' in out.lower()

    def test_initial_hamza_alif_below(self):
        """إ (U+0625) = ʾi- initial vowel + hamza."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('إسلام')
        assert 'ʾ' in out
        assert 'i' in out.lower()

    def test_alif_madda(self):
        """آ (U+0622) = ʾā — hamza + long ā."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('آمن')
        assert 'ʾ' in out
        assert 'ā' in out.lower()

    def test_standalone_hamza(self):
        """ء (U+0621) — bare hamza letter."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('سماء')
        # Ends with hamza → ʾ preserved in output.
        assert 'ʾ' in out or 'samā' in out.lower()


# ---------------------------------------------------------------------------
# Known limitations — lock-in tests so future improvements show as diffs
# ---------------------------------------------------------------------------

class TestKnownLimitations:
    """These outputs are wrong per standard Arabic pronunciation but are
    produced by the current no-tashkil heuristic.  A future tashkil-aware
    or dictionary-based pass should flip these tests — that is the signal
    we want when the improvement lands."""

    def test_shukran_no_tashkil_gives_shakarā(self):
        """شكرا → shukran expected; without tashkil the default-'a'
        heuristic produces 'Shakarā' (final alif → long ā; initial short
        vowel guessed as 'a' not 'u')."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('شكرا') == 'Shakarā'

    def test_kitab_no_tashkil_gives_katāb(self):
        """كتاب → kitāb expected; default-'a' heuristic gives 'Katāb'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('كتاب') == 'Katāb'

    def test_bayt_mater_default_gives_bīt(self):
        """بيت → bayt expected; the mater rule defaults to long ī over
        diphthong ay when yā is between consonants."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('بيت') == 'Bīt'

    def test_yawm_mater_default_gives_yūm(self):
        """يوم → yawm expected; same mater-over-diphthong failure mode."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('يوم') == 'Yūm'

    def test_allah_shadda_collapse(self):
        """الله → allāh expected; tashkil-stripped form plus our article
        handling gives 'Al-lah' (shadda + long ā not reconstructed)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        assert r('الله') == 'Al-lah'

    def test_alaikum_mater_bug(self):
        """عليكم → ʿalaykum expected; yā in cons-yā-cons → long ī mater
        plus default-'a' between k-m gives 'ʿalīkam'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ar')
        out = r('عليكم').lower()
        assert 'ʿalīkam' in out


# ---------------------------------------------------------------------------
# Language detection + lang_config integration
# ---------------------------------------------------------------------------

class TestArabicLanguageDetection:
    def test_dominant_script_arabic(self):
        from loom_core.language import _dominant_script
        assert _dominant_script('مرحبا بالعالم') == 'Arabic'

    def test_detect_language_returns_ar(self):
        from loom_core.language import detect_language_from_text
        code = detect_language_from_text('مرحبا بالعالم كيف حالك اليوم')
        assert code == 'ar'

    def test_is_rtl_text_detects_arabic(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text('سلام عليكم')
        assert is_rtl_text('مرحبا')

    def test_is_rtl_text_false_for_mixed_latin_heavy(self):
        from loom_core.language import is_rtl_text
        # Predominantly Latin with a single Arabic word.
        assert not is_rtl_text('Hello world, this is mostly English سلام')

    def test_is_rtl_text_true_for_mixed_arabic_heavy(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text('أنا أحب البرمجة جدا hello')


class TestArabicLangConfig:
    def test_lang_config_returns_romanizer(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ar')
        assert cfg['romanize_func'] is not None
        assert cfg['has_phonetic_layer'] is True

    def test_lang_config_rtl_flag(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ar')
        assert cfg['rtl'] is True

    def test_lang_config_default_font_is_naskh(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ar')
        assert 'Arabic' in cfg['default_font']

    def test_lang_config_learner_phonetic_override(self):
        from loom_core.styles import get_lang_config
        cfg_l = get_lang_config('ar', phonetic_system='learner')
        cfg_d = get_lang_config('ar', phonetic_system='din')
        # Different rom_name for each system.
        assert cfg_l['romanization_name'] != cfg_d['romanization_name']

    def test_lang_config_annotation_system_name(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ar')
        assert cfg['annotation_system_name'] == 'Transliteration'

    def test_lang_config_no_ass_annotation(self):
        """Arabic uses the Latin-script romanization line only — no CJK
        \\pos() annotation (shaping + bidi make width math unreliable)."""
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ar')
        assert cfg['supports_ass_annotation'] is False


# ---------------------------------------------------------------------------
# End-to-end: direct aksharamukha alternatives don't regress behavior
# ---------------------------------------------------------------------------

class TestNoAksharamukhaDep:
    def test_romanizer_runs_without_aksharamukha(self):
        """Arabic factory is pure-python (no aksharamukha import path),
        so the romanizer must work even if aksharamukha is unavailable."""
        from loom_core.romanize import _make_arabic_romanizer
        r = _make_arabic_romanizer('learner')
        assert r('سلام').lower() == 'salām'
