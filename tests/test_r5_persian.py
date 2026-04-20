"""R5-4 remaining: Persian (fa) block romanization.

Persian shares the Arabic script but uses 4 extra letters (پ چ ژ گ),
two Unicode variants for yeh/kaf (U+06CC, U+06A9), and different
phonology — Arabic emphatics collapse to their non-emphatic equivalents
in Persian pronunciation.

Two phonetic systems:
  * "learner" (default) — Persian-phonology hybrid: emphatic marks
    dropped (ṣ→s, ḥ→h, etc.), digraphs for ش/غ/چ/ژ (sh/gh/ch/zh).
  * "dmg" — Deutsche Morgenländische Gesellschaft scholarly standard:
    emphatic marks preserved (ṣ ḍ ṭ ẓ ḥ), single-char alternatives
    (š ġ ṯ ḏ ḫ č ž).

Known limitations mirror Arabic's: without tashkil / ezāfe markers,
short vowels and long/diphthong disambiguation are guessed.  Locked in
tests so a future dictionary pass shows up as clean diffs.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ---------------------------------------------------------------------------
# Common Persian words — learner default
# ---------------------------------------------------------------------------

class TestPersianCommonWords:
    def test_salam(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('سلام').lower() == 'salām'

    def test_alif_madda(self):
        """آب → ʾāb (glottal stop + long ā)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('آب')
        assert 'ʾ' in out or 'Āb' in out
        assert 'ā' in out.lower()

    def test_chai_with_persian_extra_letter(self):
        """چای → chāy — uses چ (Persian extra letter)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('چای').lower() == 'chāy'

    def test_pers_extra_letter_zh(self):
        """ژ (U+0698) → zh in learner mode."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('ژاله').lower()
        assert out.startswith('zh')

    def test_pers_extra_letter_g(self):
        """گ (U+06AF) → g."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('گربه').lower()
        assert out.startswith('g')

    def test_pers_extra_letter_p(self):
        """پ (U+067E) → p."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('پارسی').lower()
        assert out.startswith('p')


# ---------------------------------------------------------------------------
# Emphatic-collapse contrast: learner drops marks, dmg preserves
# ---------------------------------------------------------------------------

class TestEmphaticCollapse:
    def test_learner_drops_sad_mark(self):
        """ص → s in learner (matches Persian pronunciation)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('صبح')
        assert 'ṣ' not in out
        assert 's' in out.lower()

    def test_dmg_keeps_sad_mark(self):
        """ص → ṣ in dmg (preserves Arabic etymology)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('dmg')
        out = r('صبح').lower()
        assert 'ṣ' in out

    def test_learner_drops_ha_mark(self):
        """ح → h in learner (no distinction from ه)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('حال')
        assert 'ḥ' not in out
        assert 'h' in out.lower()

    def test_dmg_keeps_ha_mark(self):
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('dmg')
        out = r('حال').lower()
        assert 'ḥ' in out

    def test_learner_collapses_thin_to_s(self):
        """ث → s in learner (no /θ/ in Persian)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('ثابت').lower()
        # 's' appears; emphatic 'ṯ' does not.
        assert 'ṯ' not in out
        assert 's' in out

    def test_learner_collapses_dhal_to_z(self):
        """ذ → z in learner (no /ð/ in Persian)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('ذهن').lower()
        assert 'ḏ' not in out
        assert 'z' in out

    def test_learner_drops_ayn(self):
        """ع → (empty) in learner (silent in Persian)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('علی').lower()
        assert 'ʿ' not in out

    def test_dmg_keeps_ayn(self):
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('dmg')
        out = r('علی').lower()
        assert 'ʿ' in out


# ---------------------------------------------------------------------------
# Persian extra letters (پ چ ژ گ) + phonetic-system digraph contrast
# ---------------------------------------------------------------------------

class TestPersianExtraLetters:
    def test_pe_p(self):
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        assert 'p' in r('پدر').lower()

    def test_che_learner_ch(self):
        """چ → 'ch' in learner."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        assert 'ch' in r('چای').lower()

    def test_che_dmg_c_with_caron(self):
        """چ → 'č' in dmg."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('dmg')
        assert 'č' in r('چای').lower()

    def test_zhe_learner_zh(self):
        """ژ → 'zh' in learner."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        assert 'zh' in r('ژانر').lower()

    def test_zhe_dmg_z_with_caron(self):
        """ژ → 'ž' in dmg."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('dmg')
        assert 'ž' in r('ژانر').lower()

    def test_gaf_g(self):
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        assert 'g' in r('گربه').lower()


# ---------------------------------------------------------------------------
# Unicode codepoint variants — Persian yeh (U+06CC) / keheh (U+06A9)
# ---------------------------------------------------------------------------

class TestCodepointVariants:
    def test_persian_yeh_treated_same_as_arabic_yeh(self):
        """ی (U+06CC Persian) and ي (U+064A Arabic) produce identical output."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        persian_yeh = '\u06cc'  # ی
        arabic_yeh = '\u064a'   # ي
        assert r(f'د{persian_yeh}دن') == r(f'د{arabic_yeh}دن')

    def test_persian_keheh_treated_same_as_arabic_kaf(self):
        """ک (U+06A9 Persian) and ك (U+0643 Arabic) produce identical output."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        persian_keheh = '\u06a9'  # ک
        arabic_kaf = '\u0643'     # ك
        assert r(f'{persian_keheh}تاب') == r(f'{arabic_kaf}تاب')

    def test_persian_heh_variant_u06c1(self):
        """ہ (U+06C1) transliterates as 'h' like ه."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('نہ').lower()
        assert 'n' in out and 'h' in out


# ---------------------------------------------------------------------------
# Tashkil stripping + mixed content
# ---------------------------------------------------------------------------

class TestTashkilAndPassthrough:
    def test_tashkil_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('سَلَام').lower() == r('سلام').lower()

    def test_mixed_english_persian(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('Hello سلام').lower()
        assert 'hello' in out
        assert 'salām' in out

    def test_empty_string(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('') == ''

    def test_non_persian_only_passes_through(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('hello world').lower() == 'hello world'

    def test_numbers_and_punct(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('123 سلام!')
        assert '123' in out
        assert '!' in out


# ---------------------------------------------------------------------------
# Capitalization + polish
# ---------------------------------------------------------------------------

class TestCapitalization:
    def test_sentence_initial_cap(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('سلام')
        assert out[0].isupper()

    def test_cap_after_period(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('سلام. سلام')
        idx = out.index('.')
        after = out[idx + 1:].strip()
        assert after[0].isupper()


# ---------------------------------------------------------------------------
# wāw as /v/ (Persian) vs /w/ (Arabic)
# ---------------------------------------------------------------------------

class TestWawAsV:
    def test_word_initial_waw_is_v(self):
        """Word-start و → 'v' in Persian (vs 'w' in Arabic)."""
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('learner')
        out = r('وقت').lower()
        assert 'v' in out
        assert 'w' not in out


# ---------------------------------------------------------------------------
# Invalid phonetic_system falls back
# ---------------------------------------------------------------------------

class TestPhoneticSystemFallback:
    def test_invalid_scheme_falls_back_to_learner(self):
        from loom_core.romanize import _make_persian_romanizer
        r = _make_persian_romanizer('bogus')
        # Learner behavior: emphatic marks absent.
        assert 'ṣ' not in r('صبح')


# ---------------------------------------------------------------------------
# Known limitations — lock in for regression signal
# ---------------------------------------------------------------------------

class TestKnownLimitations:
    """Persian shares Arabic's no-tashkil short-vowel guessing problem.
    These tests document current rough outputs so a future tashkil-aware
    or dictionary-based pass shows up as clean test diffs."""

    def test_mamnun_gets_extra_vowel(self):
        """ممنون → mamnun expected; default-'a' between m-m gives Mamanūn."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('ممنون') == 'Mamanūn'

    def test_iran_misclassifies_ya_as_consonantal(self):
        """ایران → Iran expected; ی after vowel-ā classifies as consonant 'y'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('ایران')
        # Current heuristic produces 'y' between alif and rā (plus default-'a'),
        # e.g. 'Ayarān'.  Lock current rough output.
        assert out == 'Ayarān'

    def test_dust_gets_extra_vowel(self):
        """دوست → dust expected; default-'a' between s-t gives Dūsat."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('دوست') == 'Dūsat'

    def test_final_heh_emits_h(self):
        """گربه → gorbeh expected; final ه emits 'h' not silent schwa 'e'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        out = r('گربه')
        # Final 'h' preserved (pedagogically honest about the written form,
        # even though Persian pronounces it as silent /e/).
        assert out.lower().endswith('h')

    def test_chetori_vowel_guess(self):
        """چطوری → chetori expected; default-'a' + long-ū mater gives Chatūrī."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('fa')
        assert r('چطوری') == 'Chatūrī'


# ---------------------------------------------------------------------------
# Language detection + lang_config
# ---------------------------------------------------------------------------

class TestPersianLanguageDetection:
    def test_dominant_script_arabic_for_persian_text(self):
        """Persian text shares the Arabic script, so _dominant_script
        returns 'Arabic' — langdetect does the fa/ar/ur disambiguation."""
        from loom_core.language import _dominant_script
        assert _dominant_script('سلام دوست من چطور هستی') == 'Arabic'

    def test_is_rtl_text_detects_persian(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text('سلام دوست من')


class TestPersianLangConfig:
    def test_lang_config_returns_romanizer(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('fa')
        assert cfg['romanize_func'] is not None
        assert cfg['has_phonetic_layer'] is True

    def test_lang_config_rtl_flag(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('fa')
        assert cfg['rtl'] is True

    def test_lang_config_default_font_is_naskh(self):
        """Persian defaults to Noto Naskh Arabic (shared with Arabic)."""
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('fa')
        assert 'Arabic' in cfg['default_font'] or 'Naskh' in cfg['default_font']

    def test_lang_config_phonetic_override_changes_name(self):
        from loom_core.styles import get_lang_config
        cfg_l = get_lang_config('fa', phonetic_system='learner')
        cfg_d = get_lang_config('fa', phonetic_system='dmg')
        assert cfg_l['romanization_name'] != cfg_d['romanization_name']

    def test_lang_config_annotation_system_name(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('fa')
        assert cfg['annotation_system_name'] == 'Transliteration'

    def test_lang_config_no_ass_annotation(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('fa')
        assert cfg['supports_ass_annotation'] is False
