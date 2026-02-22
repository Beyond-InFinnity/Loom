"""Integration tests for separate .ass and PGS output pipelines.

Tests:
  - generate_ass_file() returns str (path), always has all 4 layers
  - generate_pgs_file() produces valid .sup with display sets (when Playwright available)
  - generate_ass_file() without annotation has 3 layers (no Annotation)
  - build_output_filename() produces correct filenames
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pysubs2
from app.processing import build_output_filename


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
            'fontname': 'Noto Sans CJK JP',
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
            'enabled': True,
            'fontname': 'Noto Sans CJK JP',
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


def _make_test_srts(tmpdir):
    """Create native + target SRT files for testing."""
    native_srt = os.path.join(tmpdir, 'native.srt')
    target_srt = os.path.join(tmpdir, 'target.srt')

    _write_srt(native_srt, [
        ("00:00:01,000 --> 00:00:03,000", "Hello, world!"),
        ("00:00:04,000 --> 00:00:06,000", "How are you?"),
        ("00:00:07,000 --> 00:00:09,000", "Goodbye!"),
    ])
    _write_srt(target_srt, [
        ("00:00:01,000 --> 00:00:03,000", "こんにちは世界"),
        ("00:00:04,000 --> 00:00:06,000", "元気ですか"),
        ("00:00:07,000 --> 00:00:09,000", "さようなら"),
    ])
    return native_srt, target_srt


def test_generate_ass_all_four_layers():
    """generate_ass_file() always produces all 4 layers including Annotation."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    errors = []
    st.error = lambda msg: errors.append(msg)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt, target_srt = _make_test_srts(tmpdir)
            styles = _make_styles()

            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'ja',
                resolution=(1920, 1080),
                output_playres=(1920, 1080),
            )

            assert result is not None, f"generate_ass_file returned None. Errors: {errors}"
            # Return value is now a str (path), not a tuple
            assert isinstance(result, str), f"Expected str, got {type(result)}"

            ass_path = result
            assert os.path.exists(ass_path), f".ass file missing: {ass_path}"
            ass_subs = pysubs2.load(ass_path)

            style_names = {e.style for e in ass_subs.events}
            assert 'Bottom' in style_names, f"Missing Bottom events. Styles: {style_names}"
            assert 'Top' in style_names, f"Missing Top events. Styles: {style_names}"
            assert 'Romanized' in style_names, f"Missing Romanized events. Styles: {style_names}"
            # Annotation should now ALWAYS be in the .ass file
            assert 'Annotation' in style_names, (
                f"Missing Annotation events — should always be present in .ass. "
                f"Styles: {style_names}"
            )
            assert 'Annotation' in ass_subs.styles, (
                "Annotation style def should be in .ass"
            )

            print(f"  .ass: {len(ass_subs.events)} events, styles: {list(ass_subs.styles.keys())}")
            print("  [PASS] generate_ass_file() returns str, all 4 layers present")

    finally:
        st.error = _orig_error


def test_generate_ass_without_annotation():
    """When annotation is disabled, .ass has 3 layers (no Annotation)."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt, target_srt = _make_test_srts(tmpdir)
            styles = _make_styles()
            styles['Annotation']['enabled'] = False

            result = proc.generate_ass_file(
                native_srt, target_srt, styles, 'ja',
            )

            assert result is not None
            assert isinstance(result, str), f"Expected str, got {type(result)}"
            assert os.path.exists(result)

            ass_subs = pysubs2.load(result)
            style_names = {e.style for e in ass_subs.events}
            assert 'Annotation' not in style_names, (
                f"Annotation should not appear when disabled. Styles: {style_names}"
            )
            print("  [PASS] No Annotation events when disabled")

    finally:
        st.error = _orig_error


def test_generate_pgs_full_frame():
    """generate_pgs_file() produces a .sup with display sets (requires Playwright)."""
    from app.rasterize import is_playwright_available
    if not is_playwright_available():
        print("  [SKIP] Playwright not installed — skipping PGS test")
        return

    import app.processing as proc
    from app.ocr import _parse_sup
    import streamlit as st
    _orig_error = st.error
    errors = []
    st.error = lambda msg: errors.append(msg)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_srt, target_srt = _make_test_srts(tmpdir)
            styles = _make_styles()

            sup_path = proc.generate_pgs_file(
                native_srt, target_srt, styles, 'ja',
                resolution=(1920, 1080),
                output_resolution=(1920, 1080),
            )

            assert sup_path is not None, f"generate_pgs_file returned None. Errors: {errors}"
            assert os.path.exists(sup_path), f".sup file missing: {sup_path}"
            assert os.path.getsize(sup_path) > 0, ".sup file is empty"

            display_sets = _parse_sup(sup_path)
            assert len(display_sets) > 0, "No display sets in .sup file"

            print(f"  .sup: {len(display_sets)} display set(s), "
                  f"size: {os.path.getsize(sup_path)} bytes")
            print("  [PASS] generate_pgs_file() produces valid .sup")

    finally:
        st.error = _orig_error


def test_build_output_filename():
    """build_output_filename() produces structured filenames."""
    # Full filename with all parts
    name = build_output_filename(
        media_title="Attack on Titan S01E01",
        year="2013",
        native_lang="en",
        target_lang="ja",
        annotation_system="furigana",
        romanization_system="hepburn",
        ext="ass",
    )
    assert name == "Attack.on.Titan.S01E01.2013.en.ja.furigana.hepburn.ass", f"Got: {name}"

    # .sup extension
    name_sup = build_output_filename(
        media_title="Seven Samurai",
        year="1954",
        native_lang="en",
        target_lang="ja",
        annotation_system="furigana",
        romanization_system="hepburn",
        ext="sup",
    )
    assert name_sup == "Seven.Samurai.1954.en.ja.furigana.hepburn.sup", f"Got: {name_sup}"

    # No annotation/romanization
    name_minimal = build_output_filename(
        media_title="My Video",
        target_lang="zh",
        ext="ass",
    )
    assert name_minimal == "My.Video.zh.ass", f"Got: {name_minimal}"

    # No media title — fallback
    name_fallback = build_output_filename(ext="ass")
    assert name_fallback == "stitched_subs.ass", f"Got: {name_fallback}"

    # Special characters sanitized
    name_special = build_output_filename(
        media_title="Movie: The Sequel (2024)",
        year="2024",
        ext="ass",
    )
    assert ".." not in name_special, f"Double dots in: {name_special}"
    assert ":" not in name_special, f"Colon in: {name_special}"

    # Romanization with slash (Japanese "Romaji / Furigana") — no slash in output,
    # takes first part only, no redundancy with annotation_system
    name_ja = build_output_filename(
        media_title="AoT",
        target_lang="ja",
        annotation_system="furigana",
        romanization_system="Romaji / Furigana",
        ext="ass",
    )
    assert "/" not in name_ja, f"Slash in: {name_ja}"
    assert name_ja == "AoT.ja.furigana.romaji.ass", f"Got: {name_ja}"

    print("  [PASS] build_output_filename() tests")


if __name__ == '__main__':
    print("Running integration tests...\n")
    test_generate_ass_all_four_layers()
    test_generate_ass_without_annotation()
    test_generate_pgs_full_frame()
    test_build_output_filename()
    print("\nAll integration tests passed!")
