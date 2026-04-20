"""R5-2 tests: Indic scripts — Hindi, Bengali, Tamil, Telugu, Gujarati,
Punjabi. Block-level IAST romanization via aksharamukha.

Covers:
  - Per-language romanizer produces readable IAST
  - Devanagari danda (।) and double danda (॥) converted to ASCII periods
  - Sentence-initial capitalization via _polish_romaji
  - Mixed-script passthrough (Latin interleaved with Indic)
  - ASS override tags stripped before transliteration
  - Empty / non-Indic input handling
  - _dominant_script detects each script correctly
  - detect_language_from_text resolves to correct BCP-47 code
  - get_lang_config returns correct fields for each language
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# Sample phrases + their expected IAST (substring match — case-insensitive
# so _polish_romaji's sentence-initial caps don't require test coupling).
_INDIC_SAMPLES = {
    "hi": ("नमस्ते दुनिया",  "namaste duniyā"),
    "bn": ("নমস্কার বিশ্ব",   "namaskāra biśba"),
    "ta": ("வணக்கம் உலகம்",  "vaṇakkam ulakam"),
    "te": ("నమస్కారం",        "namaskāra"),
    "gu": ("નમસ્તે વિશ્વ",    "namaste viśva"),
    "pa": ("ਸਤ ਸ੍ਰੀ ਅਕਾਲ",    "sata srī akāla"),
}


# ---------------------------------------------------------------------------
# Per-language block romanizers
# ---------------------------------------------------------------------------

class TestIndicRomanizers:
    def test_all_languages_return_romanizer(self):
        from loom_core.romanize import get_romanizer
        for lang in _INDIC_SAMPLES:
            r = get_romanizer(lang)
            assert r is not None, f"get_romanizer({lang!r}) returned None"

    def test_hindi_iast_output(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r(_INDIC_SAMPLES['hi'][0])
        assert _INDIC_SAMPLES['hi'][1] in out.lower()

    def test_bengali_iast_output(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('bn')
        out = r(_INDIC_SAMPLES['bn'][0])
        assert _INDIC_SAMPLES['bn'][1] in out.lower()

    def test_tamil_iast_output(self):
        """Aksharamukha-specific: Tamil IAST must produce 'vaṇakkam',
        not sanscript's phonologically distorted 'vaṇaghghaṃ'."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ta')
        out = r(_INDIC_SAMPLES['ta'][0])
        assert _INDIC_SAMPLES['ta'][1] in out.lower()
        # Regression guard: sanscript's bad output pattern must not surface.
        assert 'ghgh' not in out.lower()

    def test_telugu_iast_output(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('te')
        out = r(_INDIC_SAMPLES['te'][0])
        assert _INDIC_SAMPLES['te'][1] in out.lower()

    def test_gujarati_iast_output(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('gu')
        out = r(_INDIC_SAMPLES['gu'][0])
        assert _INDIC_SAMPLES['gu'][1] in out.lower()

    def test_punjabi_iast_output(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('pa')
        out = r(_INDIC_SAMPLES['pa'][0])
        assert _INDIC_SAMPLES['pa'][1] in out.lower()


class TestIndicDandaConversion:
    """Devanagari / Bengali / Gurmukhi sentence terminator ।
    converts to ASCII period via aksharamukha.  The double danda ॥
    ends a verse — aksharamukha emits two periods which is acceptable."""

    def test_devanagari_danda_becomes_period(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('नमस्ते।')
        assert '।' not in out
        assert '.' in out

    def test_bengali_danda_becomes_period(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('bn')
        out = r('নমস্কার।')
        assert '।' not in out and '.' in out

    def test_gurmukhi_danda_becomes_period(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('pa')
        out = r('ਸਤ ਸ੍ਰੀ ਅਕਾਲ।')
        assert '।' not in out and '.' in out


class TestIndicPolishIntegration:
    """Sentence-initial caps + no space before punct — inherited from the
    universal _polish_romaji pass."""

    def test_hindi_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('नमस्ते दुनिया')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()

    def test_hindi_post_period_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('नमस्ते। आप कैसे हैं?')
        idx = out.find('.')
        tail = out[idx + 1:].lstrip()
        assert tail and tail[0].isupper(), (
            f"Post-danda must capitalize: {out!r}"
        )

    def test_tamil_not_weirdly_spaced_punct(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ta')
        out = r('வணக்கம் உலகம்.')
        assert ' .' not in out


class TestIndicEdgeCases:
    def test_empty_input(self):
        from loom_core.romanize import get_romanizer
        for lang in _INDIC_SAMPLES:
            r = get_romanizer(lang)
            assert r('') == ''

    def test_mixed_latin_indic(self):
        """Latin segments pass through; Indic segments romanize."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('Hello नमस्ते world')
        assert 'Hello' in out
        assert 'namaste' in out.lower()
        assert 'world' in out

    def test_ass_tags_stripped(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('{\\an8}नमस्ते')
        assert '{' not in out
        assert '\\an8' not in out
        assert 'namaste' in out.lower()

    def test_devanagari_numerals_converted(self):
        """Aksharamukha converts Devanagari digits (१२३) to ASCII (123)."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('hi')
        out = r('१२३')
        assert '123' in out


# ---------------------------------------------------------------------------
# Script detection
# ---------------------------------------------------------------------------

class TestIndicScriptDetection:
    def test_devanagari_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("नमस्ते दुनिया") == "Devanagari"

    def test_bengali_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("নমস্কার বিশ্ব") == "Bengali"

    def test_tamil_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("வணக்கம் உலகம்") == "Tamil"

    def test_telugu_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("నమస్కారం") == "Telugu"

    def test_gujarati_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("નમસ્તે વિશ્વ") == "Gujarati"

    def test_gurmukhi_script_detected(self):
        from loom_core.language import _dominant_script
        assert _dominant_script("ਸਤ ਸ੍ਰੀ ਅਕਾਲ") == "Gurmukhi"

    def test_latin_majority_not_misdetected(self):
        """Latin with minor Indic content should stay Latin (or None)."""
        from loom_core.language import _dominant_script
        assert _dominant_script(
            "This is an English line with one नम character"
        ) == "Latin"


class TestIndicLanguageDetection:
    """detect_language_from_text resolves each dominant Indic script to
    the right BCP-47 primary subtag."""

    def _detect(self, text):
        from loom_core.language import detect_language_from_text
        return detect_language_from_text(text)

    def test_hindi(self):
        assert self._detect("नमस्ते दुनिया। आप कैसे हैं?") == "hi"

    def test_bengali(self):
        assert self._detect("নমস্কার বিশ্ব। আপনি কেমন আছেন?") == "bn"

    def test_tamil(self):
        assert self._detect("வணக்கம் உலகம். நீங்கள் எப்படி இருக்கிறீர்கள்?") == "ta"

    def test_telugu(self):
        assert self._detect("నమస్కారం ప్రపంచం. మీరు ఎలా ఉన్నారు?") == "te"

    def test_gujarati(self):
        assert self._detect("નમસ્તે વિશ્વ. તમે કેમ છો?") == "gu"

    def test_punjabi(self):
        assert self._detect("ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਦੁਨੀਆ। ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?") == "pa"


# ---------------------------------------------------------------------------
# Language config
# ---------------------------------------------------------------------------

class TestIndicLangConfig:
    def test_hindi_config(self):
        from loom_core.styles import get_lang_config
        cfg = get_lang_config('hi')
        assert cfg['romanize_func'] is not None
        assert cfg['has_phonetic_layer'] is True
        # R5-3: Hindi has per-akshara annotation.
        assert cfg['annotation_func'] is not None
        assert cfg['romanization_name'] == "IAST"
        assert cfg['romanization_confidence'] == "moderate"
        assert cfg['supports_ass_annotation'] is False, (
            "Devanagari uses alphabetic rendering — PGS-only annotation "
            "(conjunct/matra glyphs have variable widths)."
        )
        assert cfg['default_font'] == "Noto Sans Devanagari"
        assert cfg['rtl'] is False

    def test_all_indic_langs_have_annotation(self):
        """R5-3 (full): all six Indic languages ship per-akshara
        annotation via the unified Brahmic splitter."""
        from loom_core.styles import get_lang_config
        for lang in ('hi', 'bn', 'ta', 'te', 'gu', 'pa'):
            assert get_lang_config(lang)['annotation_func'] is not None, (
                f"{lang}: expected non-None annotation_func"
            )

    def test_all_indic_configs_have_romanizer_and_annotation(self):
        from loom_core.styles import get_lang_config
        for lang in ('hi', 'bn', 'ta', 'te', 'gu', 'pa'):
            cfg = get_lang_config(lang)
            assert cfg['has_phonetic_layer'], (
                f"{lang}: expected has_phonetic_layer=True"
            )
            assert cfg['romanization_name'] == "IAST"
            assert cfg['annotation_func'] is not None, (
                f"{lang}: R5-3 full ships annotation for all 6 Indic langs"
            )

    def test_per_language_default_fonts(self):
        from loom_core.styles import get_lang_config
        expected = {
            'hi': 'Noto Sans Devanagari',
            'bn': 'Noto Sans Bengali',
            'ta': 'Noto Sans Tamil',
            'te': 'Noto Sans Telugu',
            'gu': 'Noto Sans Gujarati',
            'pa': 'Noto Sans Gurmukhi',
        }
        for lang, font in expected.items():
            cfg = get_lang_config(lang)
            assert cfg['default_font'] == font, (
                f"{lang}: expected {font!r}, got {cfg['default_font']!r}"
            )

    def test_annotation_system_name_is_transliteration(self):
        from loom_core.styles import get_lang_config
        for lang in ('hi', 'bn', 'ta', 'te', 'gu', 'pa'):
            cfg = get_lang_config(lang)
            assert cfg['annotation_system_name'] == "Transliteration"


# ---------------------------------------------------------------------------
# R5-3: Devanagari akshara splitter + per-akshara annotation (Hindi)
# ---------------------------------------------------------------------------

class TestDevanagariAksharaSplitter:
    """Verifies the akshara boundary algorithm for representative
    Devanagari patterns — simple, matra-bearing, conjunct, and with
    modifiers (anusvara, nukta)."""

    def _aksharas(self, text: str) -> list:
        from loom_core.romanize import _split_devanagari_aksharas
        return [seg for seg, is_a in _split_devanagari_aksharas(text) if is_a]

    def test_simple_three_akshara_word(self):
        """नमस्ते → [न, म, स्ते] — s-virama-te is one conjunct akshara."""
        assert self._aksharas("नमस्ते") == ["न", "म", "स्ते"]

    def test_single_conjunct_word(self):
        """क्या → [क्या] — entire word is one conjunct akshara (k-virama-y-ā)."""
        assert self._aksharas("क्या") == ["क्या"]

    def test_conjunct_with_matra(self):
        """श्री → [श्री] — sh-virama-r + ii-matra, one akshara."""
        assert self._aksharas("श्री") == ["श्री"]

    def test_standalone_plus_conjunct(self):
        """रक्त → [र, क्त] — ra is its own akshara; k-virama-t conjuncts."""
        assert self._aksharas("रक्त") == ["र", "क्त"]

    def test_anusvara_attaches(self):
        """हैं → [हैं] — ha + ai-matra + anusvara all in one akshara."""
        assert self._aksharas("हैं") == ["हैं"]

    def test_matra_then_consonant_then_conjunct(self):
        """हिन्दी → [हि, न्दी]"""
        assert self._aksharas("हिन्दी") == ["हि", "न्दी"]

    def test_mixed_latin_devanagari(self):
        """Latin chars flow through as non-akshara spans; Devanagari
        groups into aksharas."""
        from loom_core.romanize import _split_devanagari_aksharas
        out = _split_devanagari_aksharas("Hi नमस्ते!")
        assert [seg for seg, is_a in out if is_a] == ["न", "म", "स्ते"]
        # Non-akshara count covers every non-Devanagari char individually.
        assert [seg for seg, is_a in out if not is_a] == list("Hi ") + ["!"]

    def test_empty_input(self):
        from loom_core.romanize import _split_devanagari_aksharas
        assert _split_devanagari_aksharas("") == []

    def test_pure_latin_all_non_akshara(self):
        from loom_core.romanize import _split_devanagari_aksharas
        out = _split_devanagari_aksharas("Hello!")
        assert all(not is_a for _, is_a in out)


class TestDevanagariAnnotation:
    """End-to-end: get_annotation_func('hi') produces per-akshara spans
    with IAST readings."""

    def test_hindi_has_annotation_func(self):
        from loom_core.romanize import get_annotation_func
        ann = get_annotation_func('hi')
        assert ann is not None

    def test_namaste_spans(self):
        from loom_core.romanize import get_annotation_func
        ann = get_annotation_func('hi')
        spans = ann("नमस्ते")
        # Three aksharas, three readings
        annotated = [(o, r) for o, r in spans if r is not None]
        assert annotated == [("न", "na"), ("म", "ma"), ("स्ते", "ste")]

    def test_non_devanagari_passes_through_unannotated(self):
        from loom_core.romanize import get_annotation_func
        ann = get_annotation_func('hi')
        spans = ann("Hello नम!")
        for orig, reading in spans:
            from loom_core.romanize import _split_devanagari_aksharas
            is_a = any(
                s == orig and a
                for s, a in _split_devanagari_aksharas("Hello नम!")
            )
            if is_a:
                assert reading is not None, f"Akshara {orig!r} should have reading"
            else:
                assert reading is None, (
                    f"Non-Devanagari {orig!r} should not have a reading"
                )

    def test_danda_not_annotated(self):
        """The Devanagari danda (।) is punctuation, not an akshara —
        it must not carry a reading in the annotation spans."""
        from loom_core.romanize import get_annotation_func
        ann = get_annotation_func('hi')
        spans = ann("नम।")
        danda_spans = [(o, r) for o, r in spans if o == "।"]
        assert danda_spans == [("।", None)]

    def test_empty_input(self):
        from loom_core.romanize import get_annotation_func
        assert get_annotation_func('hi')("") == []

    def test_ass_tags_stripped(self):
        from loom_core.romanize import get_annotation_func
        ann = get_annotation_func('hi')
        spans = ann("{\\an8}नम")
        # Aksharas present with readings, no ASS override tag surfaces.
        annotated = [(o, r) for o, r in spans if r is not None]
        assert annotated == [("न", "na"), ("म", "ma")]

    def test_ruby_html_integration(self):
        """build_annotation_html wraps each annotated span as ruby,
        passing non-annotated text straight through."""
        from loom_core.romanize import get_annotation_func, build_annotation_html
        ann = get_annotation_func('hi')
        spans = ann("नम")
        html = build_annotation_html(spans, mode='ruby')
        assert "<ruby>न<rt>na</rt></ruby>" in html
        assert "<ruby>म<rt>ma</rt></ruby>" in html

    def test_all_indic_langs_have_annotation(self):
        """All six Brahmic scripts share the unified splitter +
        aksharamukha per-akshara romanizer."""
        from loom_core.romanize import get_annotation_func
        for lang in ('hi', 'bn', 'ta', 'te', 'gu', 'pa'):
            assert get_annotation_func(lang) is not None


# ---------------------------------------------------------------------------
# R5-3 full: Brahmic per-akshara annotation for bn/ta/te/gu/pa
# ---------------------------------------------------------------------------


class TestBrahmicSplitterPerScript:
    """Verifies the generalized _split_brahmic_aksharas algorithm on
    representative words for each of the 5 non-Hindi Indic scripts."""

    def _aksharas(self, text: str, primary: str) -> list:
        from loom_core.romanize import (
            _split_brahmic_aksharas, _BRAHMIC_BLOCKS,
        )
        block = _BRAHMIC_BLOCKS[primary]
        return [s for s, a in _split_brahmic_aksharas(text, block) if a]

    def test_bengali_namaskara(self):
        """নমস্কার → [ন, ম, স্কা, র] — skā is the conjunct sk-ā."""
        assert self._aksharas("নমস্কার", "bn") == [
            "ন", "ম", "স্কা", "র",
        ]

    def test_tamil_vanakkam(self):
        """வணக்கம் → [வ, ண, க்க, ம்] — kka conjunct + trailing pulli m."""
        assert self._aksharas("வணக்கம்", "ta") == [
            "வ", "ண", "க்க", "ம்",
        ]

    def test_tamil_single_akshara_with_pulli(self):
        """ம் (single consonant + pulli) is one akshara."""
        assert self._aksharas("ம்", "ta") == ["ம்"]

    def test_telugu_namaskaram(self):
        """నమస్కారం — anusvara attaches to the final akshara."""
        assert self._aksharas("నమస్కారం", "te") == [
            "న", "మ", "స్కా", "రం",
        ]

    def test_gujarati_namaste_vishva(self):
        """નમસ્તે વિશ્વ → [ન, મ, સ્તે, વિ, શ્વ]"""
        assert self._aksharas("નમસ્તે વિશ્વ", "gu") == [
            "ન", "મ", "સ્તે", "વિ", "શ્વ",
        ]

    def test_gurmukhi_sri(self):
        """ਸ੍ਰੀ — s-virama-r with ī matra, single conjunct akshara."""
        assert self._aksharas("ਸ੍ਰੀ", "pa") == ["ਸ੍ਰੀ"]

    def test_cross_script_isolation(self):
        """Bengali text run through the Devanagari splitter should fall
        through as 'other' spans — no accidental cross-script aksharas."""
        from loom_core.romanize import (
            _split_brahmic_aksharas, _BRAHMIC_BLOCKS,
        )
        devanagari = _BRAHMIC_BLOCKS["hi"]
        out = _split_brahmic_aksharas("নমস্কার", devanagari)
        # No akshara spans — Bengali chars are outside the Devanagari block.
        assert all(not is_a for _, is_a in out)


class TestBrahmicAnnotationPerScript:
    """End-to-end per-akshara annotation readings for each script."""

    def test_bengali(self):
        from loom_core.romanize import get_annotation_func
        spans = get_annotation_func("bn")("নম")
        assert [(o, r) for o, r in spans if r] == [("ন", "na"), ("ম", "ma")]

    def test_tamil_conjunct_romanizes_together(self):
        """வணக்கம் — the kka conjunct must be one span with reading 'kka',
        not two separate spans with 'k' + 'ka'."""
        from loom_core.romanize import get_annotation_func
        spans = get_annotation_func("ta")("வணக்கம்")
        annotated = [(o, r) for o, r in spans if r]
        assert ("க்க", "kka") in annotated

    def test_telugu(self):
        from loom_core.romanize import get_annotation_func
        spans = get_annotation_func("te")("నమ")
        assert [(o, r) for o, r in spans if r] == [("న", "na"), ("మ", "ma")]

    def test_gujarati(self):
        from loom_core.romanize import get_annotation_func
        spans = get_annotation_func("gu")("નમ")
        assert [(o, r) for o, r in spans if r] == [("ન", "na"), ("મ", "ma")]

    def test_gurmukhi(self):
        from loom_core.romanize import get_annotation_func
        spans = get_annotation_func("pa")("ਸਤ")
        assert [(o, r) for o, r in spans if r] == [("ਸ", "sa"), ("ਤ", "ta")]

    def test_ruby_html_for_each_script(self):
        """Every Indic script wraps into ruby HTML with its IAST reading."""
        from loom_core.romanize import get_annotation_func, build_annotation_html
        cases = {
            "bn": ("নম", ["<ruby>ন<rt>na</rt>", "<ruby>ম<rt>ma</rt>"]),
            "ta": ("வண", ["<ruby>வ<rt>va</rt>", "<ruby>ண<rt>ṇa</rt>"]),
            "te": ("నమ", ["<ruby>న<rt>na</rt>", "<ruby>మ<rt>ma</rt>"]),
            "gu": ("નમ", ["<ruby>ન<rt>na</rt>", "<ruby>મ<rt>ma</rt>"]),
            "pa": ("ਸਤ", ["<ruby>ਸ<rt>sa</rt>", "<ruby>ਤ<rt>ta</rt>"]),
        }
        for lang, (text, expected_fragments) in cases.items():
            ann = get_annotation_func(lang)
            html = build_annotation_html(ann(text), mode="ruby")
            for frag in expected_fragments:
                assert frag in html, (
                    f"{lang}: expected {frag!r} in ruby HTML, got {html!r}"
                )

    def test_block_romanization_coherent_with_per_akshara(self):
        """Sanity: the per-akshara readings, joined, should match the
        block romanization (modulo punctuation + polish).  Lets us
        catch cases where the splitter boundaries produce different
        readings than aksharamukha's block output."""
        from loom_core.romanize import get_romanizer, get_annotation_func
        for lang, text in [
            ("hi", "नमस्ते"),
            ("bn", "নমস্কার"),
            ("ta", "வணக்கம்"),
            ("te", "నమస్కారం"),
            ("gu", "નમસ્તે"),
            ("pa", "ਸਤ"),
        ]:
            block = get_romanizer(lang)(text)
            pieces = [r for _, r in get_annotation_func(lang)(text) if r]
            joined = "".join(pieces)
            assert block.lower().replace(" ", "").rstrip(".") == joined, (
                f"{lang}: block {block!r} vs joined aksharas {joined!r}"
            )
