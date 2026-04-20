"""R5-4 remaining: Urdu (ur) block romanization.

Urdu shares the Arabic-Persian script base + adds 5 letters:
  * ٹ ڈ ڑ — retroflex ṭ ḍ ṛ
  * ں     — nun ghunnah (nasalization marker)
  * ے     — yeh barree (final long /eː/)

Plus the aspiration marker ھ (heh doachashmee), which combines with
the preceding consonant to form aspirated pairs (بھ → bh, ٹھ → ṭh,
ڑھ → ṛh, etc.).

Two phonetic systems:
  * "learner" (default) — Hunterian-lite: retroflex underdots ṭ ḍ ṛ,
    digraph aspirates, emphatic Arabic marks collapsed to Persian
    phonology, nun-ghunnah as plain 'n', yeh-barree as 'e'.
  * "ala-lc" — scholarly: preserves Arabic emphatic marks (ṣ ḍ ṭ ẓ ḥ),
    uses combining candrabindu (n̐) for nun-ghunnah, uses ē macron
    for yeh-barree; inherits Persian dmg č / ž / š / ġ / ṯ / ḏ / ḫ.

Known limitations inherit from Arabic/Persian's no-tashkil situation.
Locked in tests so a future dictionary-aware pass surfaces as clean
diffs.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ---------------------------------------------------------------------------
# Common Urdu words — learner default
# ---------------------------------------------------------------------------

class TestUrduCommonWords:
    def test_salam(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('سلام').lower() == 'salām'

    def test_retroflex_only_word(self):
        """بڑا → baṛā (retroflex ṛ)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('بڑا').lower() == 'baṛā'

    def test_retroflex_plus_aspirate(self):
        """ٹھیک → ṭhīk (retroflex ṭ + aspirate ھ)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('ٹھیک').lower() == 'ṭhīk'

    def test_home_with_aspirated_g(self):
        """گھر → ghar (aspirated g)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('گھر').lower() == 'ghar'

    def test_brother_with_aspirated_b(self):
        """بھائی → bhāʾī (aspirated b + hamza seat)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('بھائی').lower()
        assert out.startswith('bh')
        assert 'ā' in out

    def test_urdu_word_itself(self):
        """اردو → shows default-'a' between r-d; locked as Aradū."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('اردو') == 'Aradū'


# ---------------------------------------------------------------------------
# Retroflexes — ṭ ḍ ṛ
# ---------------------------------------------------------------------------

class TestRetroflexes:
    def test_tteh_retroflex(self):
        """ٹ (U+0679) → ṭ in both systems."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ṭ' in r('ٹوپی').lower()  # ṭopī = hat

    def test_ddal_retroflex(self):
        """ڈ (U+0688) → ḍ in both systems."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ḍ' in r('ڈاکٹر').lower()  # ḍākṭar = doctor

    def test_rreh_retroflex(self):
        """ڑ (U+0691) → ṛ in both systems."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ṛ' in r('بڑا').lower()

    def test_retroflex_distinct_from_dental(self):
        """ت vs ٹ produce different outputs (t vs ṭ)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        dental = r('تاج').lower()      # tāj = crown
        retroflex = r('ٹاج').lower()   # synthetic — same word with retroflex
        assert dental != retroflex
        assert 't' in dental and 'ṭ' in retroflex


# ---------------------------------------------------------------------------
# Aspiration marker ھ (heh doachashmee)
# ---------------------------------------------------------------------------

class TestAspiration:
    def test_aspirate_combines_with_prev_consonant_b(self):
        """بھ → bh (not b followed by h)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('بھائی').lower()
        # Leading consonant cluster must be 'bh', not 'b' + 'h' separately
        # with an inserted short vowel.
        assert out.startswith('bh')

    def test_aspirate_combines_with_g(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('گھر').lower()
        assert out.startswith('gh')

    def test_aspirate_combines_with_retroflex(self):
        """ٹھ → ṭh (retroflex-aspirate combo)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ṭh' in r('ٹھیک').lower()

    def test_aspirate_combines_with_retroflex_r(self):
        """ڑھ → ṛh."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ṛh' in r('پڑھنا').lower()

    def test_aspirate_combines_with_d(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('دھوپ').lower()  # dhūp = sunshine
        assert out.startswith('dh')

    def test_aspirate_on_retroflex_d(self):
        """ڈھ → ḍh."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ḍh' in r('ڈھول').lower()  # ḍhol = drum


# ---------------------------------------------------------------------------
# Nun ghunnah ں + yeh barree ے
# ---------------------------------------------------------------------------

class TestNunGhunnahAndYehBarree:
    def test_nun_ghunnah_learner_plain_n(self):
        """ں → 'n' in learner mode."""
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('learner')
        out = r('میں').lower()
        # Plain 'n' — no combining candrabindu.
        assert '\u0310' not in out
        assert 'n' in out

    def test_nun_ghunnah_ala_lc_candrabindu(self):
        """ں → 'n̐' (n + U+0310 combining candrabindu) in ala-lc mode."""
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('ala-lc')
        out = r('میں')
        assert '\u0310' in out

    def test_yeh_barree_learner_e(self):
        """ے → 'e' in learner mode."""
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('learner')
        out = r('چائے').lower()
        # Ends with 'e' (no macron in learner mode).
        assert out.endswith('e')
        assert 'ē' not in out

    def test_yeh_barree_ala_lc_macron(self):
        """ے → 'ē' (with macron) in ala-lc mode."""
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('ala-lc')
        out = r('چائے').lower()
        assert 'ē' in out


# ---------------------------------------------------------------------------
# Emphatic-collapse contrast — learner collapses, ala-lc preserves
# ---------------------------------------------------------------------------

class TestEmphaticCollapse:
    def test_learner_drops_sad_mark(self):
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('learner')
        out = r('صبح').lower()
        assert 'ṣ' not in out
        assert 's' in out

    def test_ala_lc_keeps_sad_mark(self):
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('ala-lc')
        out = r('صبح').lower()
        assert 'ṣ' in out

    def test_learner_drops_ha_mark(self):
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('learner')
        out = r('حال').lower()
        assert 'ḥ' not in out

    def test_ala_lc_keeps_ha_mark(self):
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('ala-lc')
        out = r('حال').lower()
        assert 'ḥ' in out


# ---------------------------------------------------------------------------
# Persian-extra letters + Persian-yeh codepoint normalization
# ---------------------------------------------------------------------------

class TestPersianExtras:
    def test_pe(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'p' in r('پاکستان').lower()

    def test_che(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'ch' in r('چائے').lower()

    def test_gaf(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert 'g' in r('گھر').lower()

    def test_persian_yeh_normalized(self):
        """ی (U+06CC) treated same as ي (U+064A) in Urdu too."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        persian_yeh = '\u06cc'
        arabic_yeh = '\u064a'
        assert r(f'د{persian_yeh}ن') == r(f'د{arabic_yeh}ن')

    def test_persian_keheh_handled(self):
        """ک (U+06A9) handled same as ك (U+0643)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        persian_keheh = '\u06a9'
        arabic_kaf = '\u0643'
        assert r(f'{persian_keheh}تاب') == r(f'{arabic_kaf}تاب')


# ---------------------------------------------------------------------------
# Tashkil + mixed content + passthrough
# ---------------------------------------------------------------------------

class TestTashkilAndPassthrough:
    def test_tashkil_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('سَلَام').lower() == r('سلام').lower()

    def test_mixed_english_urdu(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('Hello سلام').lower()
        assert 'hello' in out
        assert 'salām' in out

    def test_empty_string(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('') == ''

    def test_numbers_and_punct(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        out = r('123 سلام!')
        assert '123' in out
        assert '!' in out


# ---------------------------------------------------------------------------
# Capitalization + polish
# ---------------------------------------------------------------------------

class TestCapitalization:
    def test_sentence_initial_cap(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('سلام')[0].isupper()


# ---------------------------------------------------------------------------
# Phonetic-system fallback
# ---------------------------------------------------------------------------

class TestPhoneticSystemFallback:
    def test_invalid_scheme_falls_back_to_learner(self):
        from loom_core.romanize import _make_urdu_romanizer
        r = _make_urdu_romanizer('bogus')
        # Learner behavior: no combining candrabindu, no ē macron.
        assert '\u0310' not in r('میں')


# ---------------------------------------------------------------------------
# Known limitations — lock in for regression signal
# ---------------------------------------------------------------------------

class TestKnownLimitations:
    """Documented current outputs that will flip when a tashkil/dictionary
    pass lands.  Keep these as exact-match assertions so the improvement
    signal is clean."""

    def test_shukria_gets_final_h_from_heh(self):
        """شکریہ → shukriya; the final ہ heh emits 'h' not silent 'a'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        # Default-'a' insertion + final ہ as 'h' gives "Shakarīh".
        assert r('شکریہ') == 'Shakarīh'

    def test_kitab_short_vowel_guess(self):
        """کتاب → kitāb; default-'a' gives Katāb."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('کتاب') == 'Katāb'

    def test_pakistan_extra_vowel(self):
        """پاکستان → Pākistān; default-'a' between k-s gives Pākastān.
        Lock current rough output."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('پاکستان') == 'Pākasatān'

    def test_chaye_yeh_barree_with_hamza(self):
        """چائے → chāy; current output keeps hamza seat + ے as 'e'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('چائے') == 'Chāʾe'

    def test_nahin_nasalization_plain_n(self):
        """نہیں → nahīn (plain n in learner, not n̐).  Ideal 'nahīṉ'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ur')
        assert r('نہیں') == 'Nahīn'


# ---------------------------------------------------------------------------
# Language detection + lang_config
# ---------------------------------------------------------------------------

class TestUrduLanguageDetection:
    def test_dominant_script_arabic_for_urdu_text(self):
        """Urdu shares the Arabic script; _dominant_script returns 'Arabic'."""
        from loom_core.language import _dominant_script
        assert _dominant_script('میں اردو بول سکتا ہوں') == 'Arabic'

    def test_is_rtl_text_detects_urdu(self):
        from loom_core.language import is_rtl_text
        assert is_rtl_text('میں اردو بول سکتا ہوں')


class TestUrduLangConfig:
    def test_lang_config_returns_romanizer(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ur')
        assert cfg['romanize_func'] is not None
        assert cfg['has_phonetic_layer'] is True

    def test_lang_config_rtl_flag(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ur')
        assert cfg['rtl'] is True

    def test_lang_config_default_font_is_nastaliq(self):
        """Urdu's canonical font is Noto Nastaliq Urdu."""
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ur')
        assert 'Nastaliq' in cfg['default_font'] or 'Urdu' in cfg['default_font']

    def test_lang_config_phonetic_override_changes_name(self):
        from loom_core.styles import get_lang_config
        cfg_l = get_lang_config('ur', phonetic_system='learner')
        cfg_a = get_lang_config('ur', phonetic_system='ala-lc')
        assert cfg_l['romanization_name'] != cfg_a['romanization_name']

    def test_lang_config_annotation_system_name(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ur')
        assert cfg['annotation_system_name'] == 'Transliteration'

    def test_lang_config_no_ass_annotation(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('ur')
        assert cfg['supports_ass_annotation'] is False
