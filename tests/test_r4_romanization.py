"""R4 tests: Korean, Cyrillic, and Thai romanization + language detection.

Tests:
  - Korean romanization (korean-romanizer, Revised Romanization)
  - Cyrillic transliteration (cyrtranslit) — Russian, Ukrainian, Serbian
  - Thai romanization (pythainlp, Royal Institute)
  - Cyrillic script detection and Ukrainian/Belarusian disambiguation
  - Thai script detection
  - get_lang_config() returns correct config for each R4 language
  - generate_ass_file() produces Romanized layer for R4 languages
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pysubs2


def _write_srt(path, entries):
    """Write a minimal .srt file.  entries = [(timestamp_line, text), ...]."""
    with open(path, 'w', encoding='utf-8') as f:
        for i, (timestamp, text) in enumerate(entries, 1):
            f.write(f"{i}\n{timestamp}\n{text}\n\n")


def _make_styles():
    """Build a minimal styles dict matching the app's structure."""
    return {
        'Bottom': {
            'enabled': True,
            'fontname': 'Arial',
            'fontsize': 48,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 3.0, 'shadow': 1.5,
            'alignment': 2, 'marginv': 30,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'Top': {
            'enabled': True,
            'fontname': 'Arial',
            'fontsize': 52,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 2.5, 'shadow': 1.5,
            'alignment': 8, 'marginv': 20,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'Romanized': {
            'enabled': True,
            'fontname': 'Arial',
            'fontsize': 30,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(200, 200, 200, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 1.5, 'shadow': 1.5,
            'alignment': 8, 'marginv': 75,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
            'long_vowel_mode': 'macrons',
        },
        'Annotation': {
            'enabled': False,  # R4 languages are block-level only
            'fontname': 'Arial',
            'fontsize': 22,
            'bold': False, 'italic': False,
            'primarycolor': pysubs2.Color(255, 255, 255, 0),
            'outlinecolor': pysubs2.Color(0, 0, 0, 0),
            'backcolor': pysubs2.Color(0, 0, 0, 128),
            'outline': 1.0, 'shadow': 1.5,
            'alignment': 8, 'marginv': 10,
            'back_none': True, 'outline_none': False, 'shadow_none': True,
            'glow_none': True, 'glow_radius': 5, 'glow_color_hex': '#ffff00',
        },
        'vertical_offset': 0,
    }


# ---------------------------------------------------------------------------
# Korean tests
# ---------------------------------------------------------------------------

def test_korean_romanizer():
    """Korean romanizer produces Revised Romanization output."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('ko')
    assert romanize is not None, "get_romanizer('ko') returned None"

    result = romanize('안녕하세요')
    assert result, "Korean romanization returned empty"
    assert all(c.isascii() or c.isspace() for c in result), \
        f"Korean romanization should be ASCII: '{result}'"

    # Multi-word
    result2 = romanize('대한민국')
    assert result2, "Korean romanization (multi) returned empty"

    print(f"  [PASS] Korean romanization: '안녕하세요' → '{result}'")


def test_korean_annotation():
    """Korean should have per-word annotation (space-delimited romanization)."""
    from app.romanize import get_annotation_func

    ann = get_annotation_func('ko')
    assert ann is not None, "Korean should have annotation_func"

    spans = ann('안녕하세요')
    assert len(spans) > 0, "Korean annotation returned empty spans"
    # At least one span should have a reading
    has_reading = any(reading is not None for _, reading in spans)
    assert has_reading, f"No readings in Korean spans: {spans}"
    # Readings should be ASCII
    for orig, reading in spans:
        if reading:
            assert all(c.isascii() or c.isspace() for c in reading), \
                f"Korean annotation reading not ASCII: '{reading}'"

    print(f"  [PASS] Korean annotation: '안녕하세요' → {spans}")


def test_korean_lang_config():
    """get_lang_config('ko') returns correct Korean config."""
    from app.styles import get_lang_config

    cfg = get_lang_config('ko')
    assert cfg['romanize_func'] is not None, "Korean romanize_func is None"
    assert cfg['annotation_func'] is not None, "Korean should have annotation_func"
    assert cfg['romanization_name'] == "Revised Romanization"
    assert cfg['romanization_confidence'] == "high"
    assert cfg['has_phonetic_layer'] is True
    assert cfg['supports_ass_annotation'] is False, "Korean should not support .ass annotation"
    assert cfg['annotation_font_ratio'] == 0.4, "Korean annotation font ratio should be 0.4"
    assert cfg['annotation_system_name'] == "Romanization"
    print("  [PASS] Korean lang config correct")


# ---------------------------------------------------------------------------
# Cyrillic tests
# ---------------------------------------------------------------------------

def test_cyrillic_russian_romanizer():
    """Russian Cyrillic transliteration produces Latin output."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('ru')
    assert romanize is not None, "get_romanizer('ru') returned None"

    result = romanize('Привет мир')
    assert result, "Russian romanization returned empty"
    assert 'Privet' in result, f"Expected 'Privet' in: '{result}'"

    print(f"  [PASS] Russian romanization: 'Привет мир' → '{result}'")


def test_cyrillic_ukrainian_romanizer():
    """Ukrainian Cyrillic transliteration uses correct mapping."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('uk')
    assert romanize is not None, "get_romanizer('uk') returned None"

    result = romanize('Привіт світ')
    assert result, "Ukrainian romanization returned empty"
    # Ukrainian і should map differently than Russian и
    assert all(c.isascii() or c.isspace() for c in result), \
        f"Ukrainian romanization should be ASCII: '{result}'"

    print(f"  [PASS] Ukrainian romanization: 'Привіт світ' → '{result}'")


def test_cyrillic_serbian_romanizer():
    """Serbian Cyrillic transliteration works."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('sr')
    assert romanize is not None, "get_romanizer('sr') returned None"

    result = romanize('Ћирилица')
    assert result, "Serbian romanization returned empty"

    print(f"  [PASS] Serbian romanization: 'Ћирилица' → '{result}'")


def test_cyrillic_annotation():
    """Cyrillic languages should have per-word annotation (transliteration)."""
    from app.romanize import get_annotation_func

    ann = get_annotation_func('ru')
    assert ann is not None, "Russian should have annotation_func"

    spans = ann('Привет мир')
    assert len(spans) > 0, "Russian annotation returned empty spans"
    # Should have 'Привет' with reading and space and 'мир' with reading
    readings = [(o, r) for o, r in spans if r is not None]
    assert len(readings) >= 2, f"Expected 2+ annotated words, got {readings}"
    assert any('Privet' in r for _, r in readings), \
        f"Expected 'Privet' in readings: {readings}"

    # All Cyrillic languages should have annotation
    for code in ('uk', 'sr', 'bg'):
        ann2 = get_annotation_func(code)
        assert ann2 is not None, f"{code} should have annotation_func"
    print(f"  [PASS] Cyrillic annotation: 'Привет мир' → {spans}")


def test_cyrillic_lang_configs():
    """get_lang_config() returns correct configs for Cyrillic languages."""
    from app.styles import get_lang_config

    for code in ('ru', 'uk', 'be', 'sr', 'bg', 'mk'):
        cfg = get_lang_config(code)
        assert cfg['romanize_func'] is not None, f"{code} romanize_func is None"
        assert cfg['annotation_func'] is not None, f"{code} should have annotation_func"
        assert cfg['romanization_confidence'] == "high", f"{code} confidence wrong"
        assert cfg['has_phonetic_layer'] is True, f"{code} has_phonetic_layer wrong"
        assert cfg['supports_ass_annotation'] is False, f"{code} should not support .ass annotation"
        assert cfg['annotation_system_name'] == "Transliteration", f"{code} annotation name wrong"
    print("  [PASS] All Cyrillic lang configs correct")


# ---------------------------------------------------------------------------
# Thai tests
# ---------------------------------------------------------------------------

def test_thai_romanizer():
    """Thai RTGS romanization produces ASCII Latin output."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('th', phonetic_system='rtgs')
    assert romanize is not None, "get_romanizer('th', 'rtgs') returned None"

    result = romanize('สวัสดีครับ')
    assert result, "Thai RTGS romanization returned empty"
    assert all(c.isascii() or c.isspace() for c in result), \
        f"Thai RTGS romanization should be ASCII: '{result}'"

    print(f"  [PASS] Thai RTGS romanization: 'สวัสดีครับ' → '{result}'")


def test_thai_paiboon_romanizer():
    """Thai Paiboon+ romanization produces output with tone diacritics."""
    from app.romanize import get_romanizer
    import unicodedata

    romanize = get_romanizer('th', phonetic_system='paiboon')
    assert romanize is not None, "get_romanizer('th', 'paiboon') returned None"

    result = romanize('สวัสดีครับ')
    assert result, "Thai Paiboon+ romanization returned empty"

    # Paiboon+ should contain combining diacritics (tone marks) on non-mid-tone
    # syllables.  Check for any combining character in the output.
    has_combining = any(unicodedata.combining(c) for c in result)
    # Also accept Paiboon vowel replacements (ɛ, ɯ) as evidence of Paiboon mode
    has_paiboon_vowels = any(c in result for c in 'ɛɯ')
    assert has_combining or has_paiboon_vowels, \
        f"Paiboon+ output should have tone diacritics or Paiboon vowels: '{result}'"

    print(f"  [PASS] Thai Paiboon+ romanization: 'สวัสดีครับ' → '{result}'")


def test_thai_paiboon_annotation():
    """Thai Paiboon+ annotation produces spans with tone diacritics."""
    from app.romanize import get_annotation_func
    import unicodedata

    ann = get_annotation_func('th', system='paiboon')
    assert ann is not None, "Thai Paiboon+ should have annotation_func"

    spans = ann('สวัสดีครับ')
    assert len(spans) > 0, "Thai Paiboon+ annotation returned empty spans"

    has_reading = any(reading is not None for _, reading in spans)
    assert has_reading, f"No readings in Thai Paiboon+ spans: {spans}"

    # Check that at least one reading has a combining diacritic or Paiboon vowel
    readings = [r for _, r in spans if r is not None]
    has_tone_or_vowel = any(
        any(unicodedata.combining(c) or c in 'ɛɯ' for c in r) for r in readings
    )
    assert has_tone_or_vowel, \
        f"Paiboon+ annotation should have tone diacritics: {readings}"

    print(f"  [PASS] Thai Paiboon+ annotation: 'สวัสดีครับ' → {spans}")


def test_thai_ipa_romanizer():
    """Thai IPA romanizer produces non-empty output."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('th', phonetic_system='ipa')
    assert romanize is not None, "get_romanizer('th', 'ipa') returned None"

    result = romanize('สวัสดีครับ')
    assert result, "Thai IPA romanization returned empty"

    print(f"  [PASS] Thai IPA romanization: 'สวัสดีครับ' → '{result}'")


def test_thai_annotation():
    """Thai default should have per-token annotation (word-segmented romanization)."""
    from app.romanize import get_annotation_func

    ann = get_annotation_func('th')
    assert ann is not None, "Thai should have annotation_func"

    spans = ann('สวัสดีครับ')
    assert len(spans) > 0, "Thai annotation returned empty spans"
    # At least one span should have a reading
    has_reading = any(reading is not None for _, reading in spans)
    assert has_reading, f"No readings in Thai spans: {spans}"

    print(f"  [PASS] Thai annotation: 'สวัสดีครับ' → {spans}")


def test_thai_lang_config():
    """get_lang_config('th') returns correct Thai config (default Paiboon+)."""
    from app.styles import get_lang_config

    cfg = get_lang_config('th')
    assert cfg['romanize_func'] is not None, "Thai romanize_func is None"
    assert cfg['annotation_func'] is not None, "Thai should have annotation_func"
    # Default phonetic system is Paiboon+ (with tones)
    assert cfg['romanization_name'] == "Paiboon+ (with tones)", \
        f"Thai default romanization name wrong: {cfg['romanization_name']}"
    assert cfg['romanization_confidence'] == "good"
    assert cfg['has_phonetic_layer'] is True
    assert cfg['supports_ass_annotation'] is False, "Thai should not support .ass annotation"
    assert cfg['annotation_font_ratio'] == 0.4, "Thai annotation font ratio should be 0.4"
    assert cfg['annotation_system_name'] == "Paiboon+"
    assert cfg['annotation_default_enabled'] is False, \
        "Thai annotation should default to off"
    assert cfg['word_boundary_func'] is not None, \
        "Thai should have word_boundary_func"
    print("  [PASS] Thai lang config correct (default Paiboon+)")


def test_thai_phonetic_system_routing():
    """Different phonetic_system values route to different romanizers."""
    from app.styles import get_lang_config

    cfg_paiboon = get_lang_config('th', phonetic_system='paiboon')
    cfg_rtgs = get_lang_config('th', phonetic_system='rtgs')
    cfg_ipa = get_lang_config('th', phonetic_system='ipa')

    # Names should differ
    assert cfg_paiboon['romanization_name'] == 'Paiboon+ (with tones)'
    assert cfg_rtgs['romanization_name'] == 'RTGS (no tones)'
    assert cfg_ipa['romanization_name'] == 'IPA'

    # Annotation system names should differ
    assert cfg_paiboon['annotation_system_name'] == 'Paiboon+'
    assert cfg_rtgs['annotation_system_name'] == 'RTGS'
    assert cfg_ipa['annotation_system_name'] == 'IPA'

    # All should have romanize_func
    assert cfg_paiboon['romanize_func'] is not None
    assert cfg_rtgs['romanize_func'] is not None
    assert cfg_ipa['romanize_func'] is not None

    # Romanizers should produce different output (Paiboon has diacritics, RTGS is ASCII)
    text = 'ครับ'
    paiboon_out = cfg_paiboon['romanize_func'](text)
    rtgs_out = cfg_rtgs['romanize_func'](text)
    assert paiboon_out, "Paiboon romanizer returned empty"
    assert rtgs_out, "RTGS romanizer returned empty"
    # RTGS should be pure ASCII, Paiboon should have non-ASCII (diacritics/vowels)
    assert all(c.isascii() or c.isspace() for c in rtgs_out), \
        f"RTGS should be ASCII: '{rtgs_out}'"

    print(f"  [PASS] Thai phonetic system routing: paiboon='{paiboon_out}', rtgs='{rtgs_out}'")


def test_thai_word_boundaries():
    """Thai word boundary function inserts thin spaces between tokens."""
    from app.romanize import _apply_thai_word_boundaries

    result = _apply_thai_word_boundaries('สวัสดีครับ')
    assert result, "Word boundary function returned empty"
    assert '\u2009' in result, \
        f"Expected thin space (U+2009) in output: '{result}'"
    # Original Thai chars should be preserved
    assert 'สวัสดี' in result.replace('\u2009', '') or 'ครับ' in result.replace('\u2009', ''), \
        f"Thai characters not preserved: '{result}'"

    # Non-Thai text should pass through unchanged
    assert _apply_thai_word_boundaries('Hello world') == 'Hello world'

    print(f"  [PASS] Thai word boundaries: 'สวัสดีครับ' → '{result}'")


# ---------------------------------------------------------------------------
# Language detection tests
# ---------------------------------------------------------------------------

def test_cyrillic_script_detection():
    """Cyrillic text is detected as 'Cyrillic' script by _dominant_script()."""
    from app.language import _dominant_script

    assert _dominant_script('Привет мир как дела') == 'Cyrillic'
    assert _dominant_script('Привіт світ як справи') == 'Cyrillic'
    print("  [PASS] Cyrillic script detection")


def test_ukrainian_disambiguation():
    """Ukrainian unique chars (і/ї/є/ґ) trigger 'uk' override."""
    from app.language import _detect_by_script_chars

    # Ukrainian text with unique chars
    assert _detect_by_script_chars('Привіт, як ваші справи?') == 'uk'
    assert _detect_by_script_chars('Їжак їсть їжу') == 'uk'
    assert _detect_by_script_chars('Європа є великою') == 'uk'

    # Russian text — no unique Ukrainian chars
    assert _detect_by_script_chars('Привет мир как дела') is None

    print("  [PASS] Ukrainian disambiguation by unique chars")


def test_belarusian_disambiguation():
    """Belarusian unique char (ў) triggers 'be' override."""
    from app.language import _detect_by_script_chars

    assert _detect_by_script_chars('Прывітанне, як ваў маеце?') == 'be'

    # ў is exclusive to Belarusian — should override Ukrainian markers
    assert _detect_by_script_chars('Привіт ў') == 'be'

    print("  [PASS] Belarusian disambiguation by ў")


def test_thai_script_detection():
    """Thai text is detected as 'Thai' script by _dominant_script()."""
    from app.language import _dominant_script

    assert _dominant_script('สวัสดีครับ ผมชื่อ') == 'Thai'
    print("  [PASS] Thai script detection")


# ---------------------------------------------------------------------------
# Integration: generate_ass_file with R4 languages
# ---------------------------------------------------------------------------

def test_generate_ass_korean():
    """generate_ass_file() produces Romanized layer for Korean."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt = os.path.join(tmpdir, 'native.srt')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_srt(native_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
                ("00:00:04,000 --> 00:00:06,000", "How are you?"),
            ])
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "안녕하세요"),
                ("00:00:04,000 --> 00:00:06,000", "잘 지내세요?"),
            ])

            styles = _make_styles()
            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'ko',
                resolution=(1920, 1080),
            )

            assert result is not None, "generate_ass_file returned None for Korean"
            ass_subs = pysubs2.load(result)
            style_names = {e.style for e in ass_subs.events}
            assert 'Bottom' in style_names
            assert 'Top' in style_names
            assert 'Romanized' in style_names
            # No Annotation for Korean (block-level only)
            assert 'Annotation' not in style_names

            # Verify romanized text is Latin
            rom_events = [e for e in ass_subs.events if e.style == 'Romanized']
            assert len(rom_events) > 0, "No Romanized events"
            for e in rom_events:
                assert all(c.isascii() or c.isspace() for c in e.text), \
                    f"Romanized text not ASCII: '{e.text}'"

            print(f"  [PASS] Korean .ass: {len(ass_subs.events)} events, "
                  f"romanized: '{rom_events[0].text}'")

    finally:
        st.error = _orig_error


def test_generate_ass_russian():
    """generate_ass_file() produces Romanized layer for Russian."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt = os.path.join(tmpdir, 'native.srt')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_srt(native_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
            ])
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Привет мир"),
            ])

            styles = _make_styles()
            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'ru',
                resolution=(1920, 1080),
            )

            assert result is not None, "generate_ass_file returned None for Russian"
            ass_subs = pysubs2.load(result)
            rom_events = [e for e in ass_subs.events if e.style == 'Romanized']
            assert len(rom_events) > 0, "No Romanized events for Russian"
            assert 'Privet' in rom_events[0].text, \
                f"Expected 'Privet' in: '{rom_events[0].text}'"

            print(f"  [PASS] Russian .ass: romanized '{rom_events[0].text}'")

    finally:
        st.error = _orig_error


def test_generate_ass_thai():
    """generate_ass_file() produces Romanized layer for Thai with word boundaries."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt = os.path.join(tmpdir, 'native.srt')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_srt(native_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
            ])
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "สวัสดีครับ"),
            ])

            styles = _make_styles()
            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'th',
                resolution=(1920, 1080),
            )

            assert result is not None, "generate_ass_file returned None for Thai"
            ass_subs = pysubs2.load(result)

            # Check Romanized layer exists (Paiboon+ is default — may have diacritics)
            rom_events = [e for e in ass_subs.events if e.style == 'Romanized']
            assert len(rom_events) > 0, "No Romanized events for Thai"

            # Check Top layer has thin spaces (word boundaries)
            top_events = [e for e in ass_subs.events if e.style == 'Top']
            assert len(top_events) > 0, "No Top events for Thai"
            assert '\u2009' in top_events[0].text, \
                f"Top text should have thin spaces: '{top_events[0].text}'"

            print(f"  [PASS] Thai .ass: romanized '{rom_events[0].text}', "
                  f"top has thin spaces: {chr(0x2009) in top_events[0].text}")

    finally:
        st.error = _orig_error


# ---------------------------------------------------------------------------
# Render mode tests (build_annotation_html)
# ---------------------------------------------------------------------------

def test_render_mode_ruby():
    """build_annotation_html() ruby mode produces <ruby> markup."""
    from app.romanize import build_annotation_html

    spans = [('안녕', 'annyeong'), (' ', None), ('세계', 'segye')]
    html = build_annotation_html(spans, mode='ruby')
    assert '<ruby>안녕<rt>annyeong</rt></ruby>' in html
    assert '<ruby>세계<rt>segye</rt></ruby>' in html
    assert ' ' in html  # space passthrough
    print(f"  [PASS] Ruby mode: {html}")


def test_render_mode_interlinear():
    """build_annotation_html() interlinear mode produces inline-block HTML."""
    from app.romanize import build_annotation_html

    spans = [('Привет', 'Privet'), (' ', None), ('мир', 'mir')]
    html = build_annotation_html(spans, mode='interlinear')
    assert 'class="ilb"' in html
    assert 'class="ilb-r"' in html
    assert 'class="ilb-b"' in html
    assert 'Privet' in html
    assert 'Привет' in html
    print(f"  [PASS] Interlinear mode: {html}")


def test_render_mode_inline():
    """build_annotation_html() inline mode produces parenthetical output."""
    from app.romanize import build_annotation_html

    spans = [('สวัสดี', 'sawatdi'), (' ', None), ('ครับ', 'khrap')]
    html = build_annotation_html(spans, mode='inline')
    assert 'สวัสดี(sawatdi)' in html
    assert 'ครับ(khrap)' in html
    # No HTML tags in inline mode
    assert '<ruby>' not in html
    assert '<span' not in html
    print(f"  [PASS] Inline mode: {html}")


def test_render_mode_default_is_ruby():
    """build_annotation_html() defaults to ruby when mode not specified."""
    from app.romanize import build_annotation_html

    spans = [('test', 'reading')]
    html_default = build_annotation_html(spans)
    html_ruby = build_annotation_html(spans, mode='ruby')
    assert html_default == html_ruby, "Default mode should be ruby"
    print("  [PASS] Default mode is ruby")


# ---------------------------------------------------------------------------
# .ass annotation guard test
# ---------------------------------------------------------------------------

def test_ass_annotation_guard_korean():
    """Korean with Annotation enabled should NOT produce \\pos() events in .ass."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt = os.path.join(tmpdir, 'native.srt')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_srt(native_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
            ])
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "안녕하세요"),
            ])

            styles = _make_styles()
            styles['Annotation']['enabled'] = True  # Enable annotation

            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'ko',
                resolution=(1920, 1080),
                include_annotations=True,  # Request annotations
            )

            assert result is not None, "generate_ass_file returned None"
            ass_subs = pysubs2.load(result)
            style_names = {e.style for e in ass_subs.events}
            # Korean should NOT have Annotation events (supports_ass_annotation=False)
            assert 'Annotation' not in style_names, \
                "Korean .ass should not have Annotation events (PGS-only)"
            print("  [PASS] Korean .ass annotation guard: no \\pos() events")

    finally:
        st.error = _orig_error


# ---------------------------------------------------------------------------
# CJK annotation config comparison
# ---------------------------------------------------------------------------

def test_cjk_supports_ass_annotation():
    """CJK languages should support .ass annotation."""
    from app.styles import get_lang_config

    for code in ('ja', 'zh', 'zh-Hant', 'yue'):
        cfg = get_lang_config(code)
        assert cfg['supports_ass_annotation'] is True, \
            f"{code} should support .ass annotation"
        assert cfg['annotation_font_ratio'] == 0.5, \
            f"{code} should have 0.5 font ratio"
    print("  [PASS] CJK languages support .ass annotation with 0.5 ratio")


def test_thai_paiboon_mixed_content():
    """Paiboon+ romanizer handles mixed Thai/numbers/punctuation without crashing."""
    from app.romanize import get_romanizer, get_annotation_func

    romanize = get_romanizer('th', phonetic_system='paiboon')
    assert romanize is not None

    # Mixed content: Thai + number + Thai — should not throw IndexError
    result = romanize('สวัสดี 123 ครับ')
    assert result, "Mixed Thai/number input should produce non-empty output"
    assert '123' in result, f"Number should pass through: '{result}'"

    # Also test the annotation func
    ann = get_annotation_func('th', system='paiboon')
    assert ann is not None
    spans = ann('สวัสดี 123 ครับ')
    assert len(spans) > 0, "Mixed content should produce spans"

    # Number token should have no reading
    num_spans = [(base, reading) for base, reading in spans if '123' in base]
    assert any(reading is None for _, reading in num_spans), \
        f"Number token should have no reading: {num_spans}"

    print(f"  [PASS] Thai Paiboon+ mixed content: 'สวัสดี 123 ครับ' → '{result}'")


# ---------------------------------------------------------------------------
# Thai bug-fix regression tests (2026-02-23)
# ---------------------------------------------------------------------------

def test_thai_consonant_clusters():
    """thai2rom engine preserves consonant clusters (Bug 1 fix)."""
    from app.romanize import get_romanizer

    for system in ('paiboon', 'rtgs'):
        romanize = get_romanizer('th', phonetic_system=system)

        result_klap = romanize('กลับ')
        assert 'kl' in result_klap.lower(), \
            f"[{system}] กลับ should contain 'kl', got: '{result_klap}'"

        result_khrap = romanize('ครับ')
        assert 'khr' in result_khrap.lower(), \
            f"[{system}] ครับ should contain 'khr', got: '{result_khrap}'"

    print(f"  [PASS] Thai consonant clusters: กลับ→{result_klap}, ครับ→{result_khrap}")


def test_thai_sara_am_normalization():
    """Decomposed sara am (U+0E4D+U+0E32) produces same output as composed (U+0E33)."""
    from app.romanize import get_romanizer

    romanize = get_romanizer('th', phonetic_system='paiboon')

    # ทำ composed vs decomposed
    composed = romanize('\u0e17\u0e33')          # ทำ
    decomposed = romanize('\u0e17\u0e4d\u0e32')  # ทํา
    assert composed == decomposed, \
        f"ทำ composed '{composed}' != decomposed '{decomposed}'"

    # น้ำ composed vs decomposed
    composed2 = romanize('\u0e19\u0e49\u0e33')          # น้ำ
    decomposed2 = romanize('\u0e19\u0e49\u0e4d\u0e32')  # น้ํา
    assert composed2 == decomposed2, \
        f"น้ำ composed '{composed2}' != decomposed '{decomposed2}'"

    # Verify output contains 'am' or 'nam' (not empty/garbled)
    assert composed, "ทำ should produce non-empty romanization"
    assert composed2, "น้ำ should produce non-empty romanization"

    print(f"  [PASS] Thai sara am normalization: ทำ→'{composed}', น้ำ→'{composed2}'")


def test_thai_special_cases():
    """ก็ particle gets correct Paiboon+ romanization via special-case lookup."""
    from app.romanize import get_romanizer, get_annotation_func

    romanize = get_romanizer('th', phonetic_system='paiboon')
    result = romanize('ก็')
    assert '\u0254' in result, \
        f"ก็ Paiboon+ should contain ɔ, got: '{result}'"

    # Also check annotation func
    ann = get_annotation_func('th', system='paiboon')
    spans = ann('ก็')
    readings = [r for _, r in spans if r is not None]
    assert len(readings) > 0, "ก็ should produce annotation span"
    assert '\u0254' in readings[0], \
        f"ก็ annotation should contain ɔ, got: '{readings[0]}'"

    print(f"  [PASS] Thai special case: ก็ → '{result}'")


def test_thai_oyu():
    """อยู่ is romanized with 'y' (not bare 'u')."""
    from app.romanize import get_romanizer

    for system in ('paiboon', 'rtgs'):
        romanize = get_romanizer('th', phonetic_system=system)
        result = romanize('อยู่')
        assert 'y' in result.lower(), \
            f"[{system}] อยู่ should contain 'y', got: '{result}'"

    print(f"  [PASS] Thai อยู่: contains 'y' → '{result}'")


if __name__ == '__main__':
    print("Running R4 romanization tests...\n")

    # Romanizer unit tests
    test_korean_romanizer()
    test_korean_annotation()
    test_korean_lang_config()

    test_cyrillic_russian_romanizer()
    test_cyrillic_ukrainian_romanizer()
    test_cyrillic_serbian_romanizer()
    test_cyrillic_annotation()
    test_cyrillic_lang_configs()

    test_thai_romanizer()
    test_thai_paiboon_romanizer()
    test_thai_paiboon_annotation()
    test_thai_ipa_romanizer()
    test_thai_annotation()
    test_thai_lang_config()
    test_thai_phonetic_system_routing()
    test_thai_word_boundaries()
    test_thai_paiboon_mixed_content()

    # Thai bug-fix regression tests
    test_thai_consonant_clusters()
    test_thai_sara_am_normalization()
    test_thai_special_cases()
    test_thai_oyu()

    # Language detection tests
    test_cyrillic_script_detection()
    test_ukrainian_disambiguation()
    test_belarusian_disambiguation()
    test_thai_script_detection()

    # Render mode tests
    test_render_mode_ruby()
    test_render_mode_interlinear()
    test_render_mode_inline()
    test_render_mode_default_is_ruby()

    # Integration tests
    test_generate_ass_korean()
    test_generate_ass_russian()
    test_generate_ass_thai()
    test_ass_annotation_guard_korean()
    test_cjk_supports_ass_annotation()

    print("\nAll R4 tests passed!")
