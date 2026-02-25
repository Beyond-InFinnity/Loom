"""Tests for ASS source style mapping (multi-style support).

Tests:
  - detect_ass_styles(): multi-style detection, single-style, SRT, smart defaults
  - _iter_dialogue_events(): style mapping filtering
  - _iter_preserved_events(): correct event yielding
  - _scale_pos_tag(): coordinate scaling
  - _get_source_playres(): default and explicit PlayRes
  - generate_ass_file(): preserved styles in output, excluded styles absent
  - PlayRes scaling for preserved events
  - _preserved_event_to_html(): ASS-to-CSS translation
  - PGSFrameEvent.preserved_html field
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


def _write_multi_style_ass(path, playres_x=1920, playres_y=1080):
    """Write a multi-style ASS file with 4 styles for testing.

    Styles: Default (dialogue, 10 events), Signs (preserve, 3 events),
    OP Song (exclude, 2 events), Unused (0 events).
    """
    subs = pysubs2.SSAFile()
    subs.info['PlayResX'] = str(playres_x)
    subs.info['PlayResY'] = str(playres_y)

    # Define styles
    subs.styles['Default'] = pysubs2.SSAStyle(
        fontname='Arial', fontsize=48, alignment=2, marginv=30,
        primarycolor=pysubs2.Color(255, 255, 255, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=2.0,
    )
    subs.styles['Signs'] = pysubs2.SSAStyle(
        fontname='Arial', fontsize=36, alignment=8, marginv=50,
        primarycolor=pysubs2.Color(255, 255, 0, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=1.5,
    )
    subs.styles['OP Song'] = pysubs2.SSAStyle(
        fontname='Arial', fontsize=30, alignment=8, marginv=20,
        primarycolor=pysubs2.Color(200, 200, 200, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=1.0,
    )
    subs.styles['Unused'] = pysubs2.SSAStyle(fontname='Arial', fontsize=24)

    # Add events
    for i in range(10):
        ev = pysubs2.SSAEvent(
            start=i * 3000, end=(i + 1) * 3000 - 100,
            text=f'Dialogue line {i + 1}', style='Default',
        )
        subs.events.append(ev)

    for i in range(3):
        ev = pysubs2.SSAEvent(
            start=i * 10000, end=i * 10000 + 5000,
            text=r'{\pos(960,50)}Sign text ' + str(i + 1), style='Signs',
        )
        subs.events.append(ev)

    for i in range(2):
        ev = pysubs2.SSAEvent(
            start=i * 15000, end=i * 15000 + 10000,
            text=f'Opening song line {i + 1}', style='OP Song',
        )
        subs.events.append(ev)

    subs.save(path)
    return subs


def _make_styles():
    """Build a minimal styles dict matching the app's structure."""
    return {
        'Bottom': {
            'enabled': True,
            'fontname': 'Arial', 'fontsize': 48,
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
            'fontname': 'Arial', 'fontsize': 52,
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
            'fontname': 'Arial', 'fontsize': 30,
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
            'enabled': False,
            'fontname': 'Arial', 'fontsize': 22,
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
# detect_ass_styles() tests
# ---------------------------------------------------------------------------

def test_detect_multi_style():
    """4-style ASS file returns correct event counts + smart defaults."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'multi.ass')
        _write_multi_style_ass(ass_path)

        result = detect_ass_styles(ass_path)
        assert result is not None, "Should detect multiple styles"
        assert len(result) == 4, f"Expected 4 styles, got {len(result)}"
        assert result['Default']['event_count'] == 10
        assert result['Signs']['event_count'] == 3
        assert result['OP Song']['event_count'] == 2
        assert result['Unused']['event_count'] == 0

        # Smart defaults
        assert result['Default']['role'] == 'dialogue'
        assert result['Signs']['role'] == 'preserve'
        assert result['OP Song']['role'] == 'preserve'  # OP/ED/song → preserve
        assert result['Unused']['role'] == 'exclude'

        print(f"  [PASS] Multi-style detection: {len(result)} styles with correct defaults")


def test_detect_single_style():
    """Single-style ASS returns None."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'single.ass')
        subs = pysubs2.SSAFile()
        subs.styles['Default'] = pysubs2.SSAStyle()
        ev = pysubs2.SSAEvent(start=0, end=3000, text='Hello', style='Default')
        subs.events.append(ev)
        subs.save(ass_path)

        result = detect_ass_styles(ass_path)
        assert result is None, "Single-style ASS should return None"
        print("  [PASS] Single-style ASS returns None")


def test_detect_srt():
    """SRT file returns None."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        srt_path = os.path.join(tmpdir, 'test.srt')
        _write_srt(srt_path, [
            ("00:00:01,000 --> 00:00:03,000", "Hello!"),
        ])

        result = detect_ass_styles(srt_path)
        assert result is None, "SRT should return None"
        print("  [PASS] SRT returns None")


def test_smart_default_signs():
    """Style named 'Signs' gets 'preserve' default."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'signs.ass')
        _write_multi_style_ass(ass_path)

        result = detect_ass_styles(ass_path)
        assert result['Signs']['role'] == 'preserve'
        print("  [PASS] Signs style → preserve")


def test_smart_default_song():
    """Style named 'OP Song' gets 'preserve' default (OP/ED karaoke preserved)."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'song.ass')
        _write_multi_style_ass(ass_path)

        result = detect_ass_styles(ass_path)
        assert result['OP Song']['role'] == 'preserve'
        print("  [PASS] OP Song style → preserve")


def test_smart_default_op_ed_patterns():
    """OP/ED style name variants all get 'preserve' default."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        for style_name in ['OP_Rom', 'ED_Rom', 'op_karaoke', 'ed_lyrics',
                           'Song_OP', 'Main_ED', 'Opening', 'Ending',
                           'Karaoke', 'OP Song']:
            ass_path = os.path.join(tmpdir, f'{style_name}.ass')
            subs = pysubs2.SSAFile()
            subs.styles['Default'] = pysubs2.SSAStyle(fontname='Arial', fontsize=48)
            subs.styles[style_name] = pysubs2.SSAStyle(fontname='Arial', fontsize=30)
            # Default has more events → dialogue; test style gets pattern-based default
            for i in range(10):
                subs.events.append(pysubs2.SSAEvent(
                    start=i*3000, end=(i+1)*3000, text=f'Line {i}', style='Default'))
            for i in range(3):
                subs.events.append(pysubs2.SSAEvent(
                    start=i*5000, end=(i+1)*5000, text=f'Lyric {i}', style=style_name))
            subs.save(ass_path)

            result = detect_ass_styles(ass_path)
            assert result[style_name]['role'] == 'preserve', \
                f"Style '{style_name}' should default to preserve, got '{result[style_name]['role']}'"

        print("  [PASS] OP/ED/song patterns all → preserve")


def test_has_animation_detection():
    """Styles with animation/karaoke tags get has_animation=True."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'anim.ass')
        subs = pysubs2.SSAFile()
        subs.styles['Default'] = pysubs2.SSAStyle(fontname='Arial', fontsize=48)
        subs.styles['OP_Rom'] = pysubs2.SSAStyle(fontname='Arial', fontsize=30)
        subs.styles['Signs'] = pysubs2.SSAStyle(fontname='Arial', fontsize=36)

        # Default: plain dialogue (no animation)
        for i in range(10):
            subs.events.append(pysubs2.SSAEvent(
                start=i*3000, end=(i+1)*3000,
                text=f'Dialogue {i}', style='Default'))

        # OP_Rom: has karaoke tags
        for i in range(5):
            subs.events.append(pysubs2.SSAEvent(
                start=i*5000, end=(i+1)*5000,
                text=r'{\k50}La {\k30}la {\k40}la', style='OP_Rom'))

        # Signs: has \fad but no karaoke
        for i in range(3):
            subs.events.append(pysubs2.SSAEvent(
                start=i*10000, end=i*10000+5000,
                text=r'{\pos(960,50)\fad(500,0)}Sign', style='Signs'))

        subs.save(ass_path)
        result = detect_ass_styles(ass_path)

        assert result['Default']['has_animation'] is False, "Plain dialogue should not have animation"
        assert result['OP_Rom']['has_animation'] is True, "Karaoke style should have animation"
        assert result['Signs']['has_animation'] is True, "Style with \\fad should have animation"
        print("  [PASS] has_animation: correct detection per style")


def test_smart_default_most_events():
    """Style with the most events gets 'dialogue' default."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'most.ass')
        _write_multi_style_ass(ass_path)

        result = detect_ass_styles(ass_path)
        assert result['Default']['role'] == 'dialogue'
        print("  [PASS] Most-events style → dialogue")


def test_preserve_pattern_beats_most_events():
    """Pattern match is final — preserve-pattern style stays preserve even with most events."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'op_most.ass')
        subs = pysubs2.SSAFile()
        subs.styles['Dialogue'] = pysubs2.SSAStyle(fontname='Arial', fontsize=48)
        subs.styles['OP_Rom'] = pysubs2.SSAStyle(fontname='Arial', fontsize=30)

        # OP_Rom has MORE events than Dialogue
        for i in range(100):
            subs.events.append(pysubs2.SSAEvent(
                start=i*3000, end=(i+1)*3000, text=f'Line {i}', style='Dialogue'))
        for i in range(505):
            subs.events.append(pysubs2.SSAEvent(
                start=i*1000, end=(i+1)*1000,
                text=r'{\k50}La {\k30}la', style='OP_Rom'))

        subs.save(ass_path)
        result = detect_ass_styles(ass_path)

        assert result['OP_Rom']['role'] == 'preserve', \
            f"OP_Rom should be preserve even with 505 events, got '{result['OP_Rom']['role']}'"
        assert result['Dialogue']['role'] == 'dialogue', \
            f"Dialogue should be dialogue, got '{result['Dialogue']['role']}'"
        print("  [PASS] Preserve pattern beats most-events rule")


def test_smart_default_unused():
    """0-event style gets 'exclude' default."""
    from app.processing import detect_ass_styles

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'unused.ass')
        _write_multi_style_ass(ass_path)

        result = detect_ass_styles(ass_path)
        assert result['Unused']['role'] == 'exclude'
        print("  [PASS] Unused style → exclude")


# ---------------------------------------------------------------------------
# _iter_dialogue_events() tests
# ---------------------------------------------------------------------------

def test_iter_dialogue_with_mapping():
    """Only 'dialogue' events yielded when style_mapping provided."""
    from app.processing import _iter_dialogue_events

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'iter.ass')
        _write_multi_style_ass(ass_path)
        subs = pysubs2.load(ass_path)

        mapping = {
            'Default': 'dialogue',
            'Signs': 'preserve',
            'OP Song': 'exclude',
            'Unused': 'exclude',
        }
        events = list(_iter_dialogue_events(subs, style_mapping=mapping))
        assert len(events) == 10, f"Expected 10 dialogue events, got {len(events)}"
        assert all(e.style == 'Default' for e in events)
        print(f"  [PASS] iter_dialogue with mapping: {len(events)} events")


def test_iter_dialogue_no_mapping():
    """None mapping uses existing layer behavior."""
    from app.processing import _iter_dialogue_events

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'iter_none.ass')
        _write_multi_style_ass(ass_path)
        subs = pysubs2.load(ass_path)

        events_none = list(_iter_dialogue_events(subs, style_mapping=None))
        events_default = list(_iter_dialogue_events(subs))
        # Both should return the same events
        assert len(events_none) == len(events_default)
        print(f"  [PASS] iter_dialogue no mapping: {len(events_none)} events")


# ---------------------------------------------------------------------------
# _iter_preserved_events() tests
# ---------------------------------------------------------------------------

def test_iter_preserved():
    """Correct events yielded for 'preserve' styles."""
    from app.processing import _iter_preserved_events

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, 'preserved.ass')
        _write_multi_style_ass(ass_path)
        subs = pysubs2.load(ass_path)

        mapping = {
            'Default': 'dialogue',
            'Signs': 'preserve',
            'OP Song': 'exclude',
            'Unused': 'exclude',
        }
        preserved = list(_iter_preserved_events(subs, mapping))
        assert len(preserved) == 3, f"Expected 3 preserved events, got {len(preserved)}"
        for event, style_obj in preserved:
            assert event.style == 'Signs'
            assert style_obj is not None
        print(f"  [PASS] iter_preserved: {len(preserved)} events")


# ---------------------------------------------------------------------------
# PlayRes scaling tests
# ---------------------------------------------------------------------------

def test_scale_pos_tag():
    r"""\pos(960,540) scaled correctly for different PlayRes."""
    from app.processing import _scale_pos_tag

    result = _scale_pos_tag(r'{\pos(960,540)}Hello', 2.0, 2.0)
    assert r'\pos(1920,1080)' in result, f"Expected scaled pos, got: {result}"

    result2 = _scale_pos_tag(r'{\pos(100,200)}Test', 0.5, 0.5)
    assert r'\pos(50,100)' in result2, f"Expected scaled pos, got: {result2}"
    print(f"  [PASS] _scale_pos_tag: correct coordinate scaling")


def test_get_source_playres():
    """Default (384,288) and explicit values returned correctly."""
    from app.processing import _get_source_playres

    # Explicit PlayRes
    subs = pysubs2.SSAFile()
    subs.info['PlayResX'] = '1920'
    subs.info['PlayResY'] = '1080'
    assert _get_source_playres(subs) == (1920, 1080)

    # Missing PlayRes → ASS spec defaults
    subs2 = pysubs2.SSAFile()
    assert _get_source_playres(subs2) == (384, 288)

    # Partial (only Y)
    subs3 = pysubs2.SSAFile()
    subs3.info['PlayResY'] = '720'
    assert _get_source_playres(subs3) == (384, 720)

    print("  [PASS] _get_source_playres: correct defaults and explicit values")


def test_preserve_playres_scaling():
    """1280x720 source → 1920x1080 output scales correctly."""
    from app.processing import _scale_preserved_event

    event = pysubs2.SSAEvent(
        start=0, end=3000,
        text=r'{\pos(640,360)}Hello',
        style='Signs',
    )
    event.marginv = 50
    event.marginl = 10
    event.marginr = 10

    scaled = _scale_preserved_event(event, (1280, 720), (1920, 1080))
    assert r'\pos(960,540)' in scaled.text, f"Expected scaled pos, got: {scaled.text}"
    assert scaled.marginv == 75, f"Expected marginv=75, got {scaled.marginv}"
    assert scaled.marginl == 15, f"Expected marginl=15, got {scaled.marginl}"
    print("  [PASS] Preserved event PlayRes scaling: 720→1080")


# ---------------------------------------------------------------------------
# generate_ass_file() with style mapping
# ---------------------------------------------------------------------------

def test_generate_ass_preserve():
    """Output .ass includes prefixed Preserve styles and events."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_ass = os.path.join(tmpdir, 'native.ass')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_multi_style_ass(native_ass)
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
                ("00:00:04,000 --> 00:00:06,000", "How are you?"),
            ])

            mapping = {
                'Default': 'dialogue',
                'Signs': 'preserve',
                'OP Song': 'exclude',
                'Unused': 'exclude',
            }

            styles = _make_styles()
            result = proc.generate_ass_file(
                native_ass, target_srt, styles, 'en',
                resolution=(1920, 1080),
                native_style_mapping=mapping,
            )

            assert result is not None, "generate_ass_file returned None"
            ass_subs = pysubs2.load(result)

            # Preserved styles should be present with prefix
            assert 'SRC_N_Signs' in ass_subs.styles, \
                f"Missing SRC_N_Signs style. Styles: {list(ass_subs.styles.keys())}"

            # Preserved events should be present
            preserved_events = [e for e in ass_subs.events if e.style == 'SRC_N_Signs']
            assert len(preserved_events) == 3, \
                f"Expected 3 preserved events, got {len(preserved_events)}"

            print(f"  [PASS] ASS preserve: SRC_N_Signs with {len(preserved_events)} events")
    finally:
        st.error = _orig_error


def test_generate_ass_exclude():
    """Excluded styles not in output."""
    import app.processing as proc
    import streamlit as st
    _orig_error = st.error
    st.error = lambda msg: None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            native_ass = os.path.join(tmpdir, 'native.ass')
            target_srt = os.path.join(tmpdir, 'target.srt')

            _write_multi_style_ass(native_ass)
            _write_srt(target_srt, [
                ("00:00:01,000 --> 00:00:03,000", "Hello!"),
            ])

            mapping = {
                'Default': 'dialogue',
                'Signs': 'preserve',
                'OP Song': 'exclude',
                'Unused': 'exclude',
            }

            styles = _make_styles()
            result = proc.generate_ass_file(
                native_ass, target_srt, styles, 'en',
                resolution=(1920, 1080),
                native_style_mapping=mapping,
            )

            assert result is not None
            ass_subs = pysubs2.load(result)

            # Excluded styles should not be present
            all_styles = set(ass_subs.styles.keys())
            assert 'SRC_N_OP Song' not in all_styles, \
                f"Excluded style found in output: {all_styles}"
            assert 'SRC_N_Unused' not in all_styles, \
                f"Unused style found in output: {all_styles}"

            # No events from excluded styles
            all_event_styles = {e.style for e in ass_subs.events}
            assert 'OP Song' not in all_event_styles
            assert 'Unused' not in all_event_styles

            print(f"  [PASS] ASS exclude: no excluded styles in output")
    finally:
        st.error = _orig_error


# ---------------------------------------------------------------------------
# _preserved_event_to_html() tests
# ---------------------------------------------------------------------------

def test_preserved_event_to_html():
    """ASS style+overrides produce correct positioned CSS div."""
    from app.processing import _preserved_event_to_html

    style = pysubs2.SSAStyle(
        fontname='Arial', fontsize=36, alignment=2, marginv=30,
        primarycolor=pysubs2.Color(255, 255, 0, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=2.0,
    )
    event = pysubs2.SSAEvent(
        start=0, end=3000,
        text='Hello World',
        style='Signs',
    )

    html = _preserved_event_to_html(
        event, style,
        source_res=(1920, 1080),
        canvas_res=(1920, 1080),
        scale=1.0,
    )
    assert 'Hello World' in html
    assert 'position:absolute' in html
    assert 'font-size:36.0px' in html
    assert "font-family:'Arial'" in html
    print(f"  [PASS] preserved_event_to_html: basic CSS generation")


def test_preserved_html_pos():
    r"""\pos(x,y) generates absolute CSS positioning."""
    from app.processing import _preserved_event_to_html

    style = pysubs2.SSAStyle(
        fontname='Arial', fontsize=36, alignment=8,
        primarycolor=pysubs2.Color(255, 255, 255, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=1.0,
    )
    event = pysubs2.SSAEvent(
        start=0, end=3000,
        text=r'{\pos(960,50)}Sign text',
        style='Signs',
    )

    html = _preserved_event_to_html(
        event, style,
        source_res=(1920, 1080),
        canvas_res=(1920, 1080),
        scale=1.0,
    )
    assert 'Sign text' in html
    assert 'left:960.0px' in html
    assert 'top:50.0px' in html
    assert r'\pos' not in html  # Override tags should be stripped
    print(f"  [PASS] preserved_html_pos: absolute positioning from \\pos()")


# ---------------------------------------------------------------------------
# _strip_animation_tags() tests
# ---------------------------------------------------------------------------

def test_strip_animation_tags():
    """Animation/timing tags stripped, visual tags preserved."""
    from app.processing import _strip_animation_tags

    # Karaoke tags stripped
    assert _strip_animation_tags(r'{\k50}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\kf100}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\ko50}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\K80}Hello') == 'Hello'

    # Animation/timing tags stripped
    assert _strip_animation_tags(r'{\t(0,500,\fs40)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\move(0,0,100,100)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\fad(500,0)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\fade(0,255,0,0,500,500,1000)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\clip(0,0,960,540)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\iclip(0,0,960,540)}Hello') == 'Hello'
    assert _strip_animation_tags(r'{\org(960,540)}Hello') == 'Hello'

    # Visual tags preserved
    text_with_visual = r'{\an8\pos(960,50)\fn Arial\fs36\c&HFFFFFF&\bord2}Sign text'
    result = _strip_animation_tags(text_with_visual)
    assert result == text_with_visual  # No change — all visual tags

    # Mixed: animation stripped, visual kept
    mixed = r'{\an8\k50\pos(960,50)\fad(500,0)}Hello'
    result = _strip_animation_tags(mixed)
    assert r'\an8' in result
    assert r'\pos(960,50)' in result
    assert r'\k50' not in result
    assert r'\fad' not in result

    print("  [PASS] _strip_animation_tags: animation stripped, visual preserved")


def test_strip_animation_in_preserved_html():
    """Preserved event HTML doesn't contain animation tag artifacts."""
    from app.processing import _preserved_event_to_html

    style = pysubs2.SSAStyle(
        fontname='Arial', fontsize=36, alignment=8, marginv=50,
        primarycolor=pysubs2.Color(255, 255, 0, 0),
        outlinecolor=pysubs2.Color(0, 0, 0, 0),
        outline=1.5,
    )
    # Event with karaoke + fade tags — should render as plain static text
    event = pysubs2.SSAEvent(
        start=0, end=3000,
        text=r'{\an8\k50\pos(960,50)\fad(500,0)}Song lyric',
        style='OP_Rom',
    )

    html = _preserved_event_to_html(
        event, style,
        source_res=(1920, 1080),
        canvas_res=(1920, 1080),
        scale=1.0,
    )
    assert 'Song lyric' in html
    assert r'\k' not in html
    assert r'\fad' not in html
    # Position should still be applied from \pos tag
    assert 'left:960.0px' in html
    assert 'top:50.0px' in html
    print("  [PASS] Preserved HTML: animation tags stripped, position kept")


# ---------------------------------------------------------------------------
# _dedup_preserved_for_pgs() tests
# ---------------------------------------------------------------------------

def test_dedup_karaoke_layers():
    """Multi-layer karaoke at same timestamp deduplicates to lowest layer."""
    from app.processing import _dedup_preserved_for_pgs

    style = pysubs2.SSAStyle(fontname='Arial', fontsize=30)

    # 3 layers at the same time with the same text — karaoke composite
    ev0 = pysubs2.SSAEvent(
        start=0, end=5000, layer=0,
        text=r'{\bord3\3c&H000000&}Opening lyric line', style='OP_Rom',
    )
    ev1 = pysubs2.SSAEvent(
        start=0, end=5000, layer=1,
        text=r'{\c&HFFFFFF&}Opening lyric line', style='OP_Rom',
    )
    ev2 = pysubs2.SSAEvent(
        start=0, end=5000, layer=2,
        text=r'{\k50\clip(0,0,960,540)}Opening lyric line', style='OP_Rom',
    )

    result = _dedup_preserved_for_pgs([
        (ev0, style), (ev1, style), (ev2, style),
    ])

    assert len(result) == 1, f"Expected 1 event after dedup, got {len(result)}"
    assert result[0][0].layer == 0, "Should keep lowest layer"
    print("  [PASS] dedup_karaoke_layers: 3→1, lowest layer kept")


def test_dedup_different_styles_not_merged():
    """Events from different styles are never merged."""
    from app.processing import _dedup_preserved_for_pgs

    style_op = pysubs2.SSAStyle(fontname='Arial', fontsize=30)
    style_signs = pysubs2.SSAStyle(fontname='Arial', fontsize=36)

    ev_op = pysubs2.SSAEvent(
        start=0, end=5000, layer=0,
        text='Opening lyric', style='OP_Rom',
    )
    ev_sign = pysubs2.SSAEvent(
        start=0, end=5000, layer=0,
        text='Opening lyric', style='Signs',
    )

    result = _dedup_preserved_for_pgs([
        (ev_op, style_op), (ev_sign, style_signs),
    ])

    assert len(result) == 2, f"Different styles should not merge, got {len(result)}"
    print("  [PASS] dedup: different styles not merged")


def test_dedup_non_overlapping_kept():
    """Non-overlapping events from the same style are all kept."""
    from app.processing import _dedup_preserved_for_pgs

    style = pysubs2.SSAStyle(fontname='Arial', fontsize=30)

    ev1 = pysubs2.SSAEvent(
        start=0, end=3000, layer=0,
        text='Line 1', style='OP_Rom',
    )
    ev2 = pysubs2.SSAEvent(
        start=5000, end=8000, layer=0,
        text='Line 2', style='OP_Rom',
    )

    result = _dedup_preserved_for_pgs([(ev1, style), (ev2, style)])

    assert len(result) == 2, f"Non-overlapping should both survive, got {len(result)}"
    print("  [PASS] dedup: non-overlapping events kept")


def test_dedup_substring_match():
    """Layer with substring of main text is a karaoke duplicate."""
    from app.processing import _dedup_preserved_for_pgs

    style = pysubs2.SSAStyle(fontname='Arial', fontsize=30)

    # Layer 0: full text (base)
    ev0 = pysubs2.SSAEvent(
        start=0, end=5000, layer=0,
        text=r'{\bord3}La la la opening song', style='OP_Rom',
    )
    # Layer 1: partial sweep — substring of base text
    ev1 = pysubs2.SSAEvent(
        start=0, end=5000, layer=1,
        text=r'{\k50\clip(0,0,400,540)}La la', style='OP_Rom',
    )

    result = _dedup_preserved_for_pgs([(ev0, style), (ev1, style)])

    assert len(result) == 1, f"Substring match should dedup, got {len(result)}"
    assert result[0][0].layer == 0
    print("  [PASS] dedup: substring match deduplicates")


def test_dedup_unrelated_text_not_merged():
    """Same-style overlapping events with different text are NOT merged."""
    from app.processing import _dedup_preserved_for_pgs

    style = pysubs2.SSAStyle(fontname='Arial', fontsize=30)

    ev1 = pysubs2.SSAEvent(
        start=0, end=5000, layer=0,
        text='First completely different line', style='OP_Rom',
    )
    ev2 = pysubs2.SSAEvent(
        start=0, end=5000, layer=1,
        text='Second unrelated line', style='OP_Rom',
    )

    result = _dedup_preserved_for_pgs([(ev1, style), (ev2, style)])

    assert len(result) == 2, f"Unrelated text should not merge, got {len(result)}"
    print("  [PASS] dedup: unrelated text not merged")


# ---------------------------------------------------------------------------
# PGSFrameEvent preserved_html field
# ---------------------------------------------------------------------------

def test_pgs_frame_preserved_field():
    """PGSFrameEvent carries preserved_html field."""
    from app.rasterize import PGSFrameEvent

    ev = PGSFrameEvent(
        start_ms=0, end_ms=3000,
        bottom_text='Hello', top_html='World',
        romaji_text=None,
    )
    assert ev.preserved_html is None, "Default should be None"

    ev2 = PGSFrameEvent(
        start_ms=0, end_ms=3000,
        bottom_text='Hello', top_html='World',
        romaji_text=None,
        preserved_html='<div>Sign</div>',
    )
    assert ev2.preserved_html == '<div>Sign</div>'
    print("  [PASS] PGSFrameEvent.preserved_html field works")


if __name__ == '__main__':
    print("Running style mapping tests...\n")

    # Detection tests
    test_detect_multi_style()
    test_detect_single_style()
    test_detect_srt()
    test_smart_default_signs()
    test_smart_default_song()
    test_smart_default_op_ed_patterns()
    test_has_animation_detection()
    test_smart_default_most_events()
    test_preserve_pattern_beats_most_events()
    test_smart_default_unused()

    # Iteration tests
    test_iter_dialogue_with_mapping()
    test_iter_dialogue_no_mapping()
    test_iter_preserved()

    # Scaling tests
    test_scale_pos_tag()
    test_get_source_playres()
    test_preserve_playres_scaling()

    # ASS generation tests
    test_generate_ass_preserve()
    test_generate_ass_exclude()

    # HTML translation tests
    test_preserved_event_to_html()
    test_preserved_html_pos()

    # Animation tag stripping tests
    test_strip_animation_tags()
    test_strip_animation_in_preserved_html()

    # PGS dedup tests
    test_dedup_karaoke_layers()
    test_dedup_different_styles_not_merged()
    test_dedup_non_overlapping_kept()
    test_dedup_substring_match()
    test_dedup_unrelated_text_not_merged()

    # PGS tests
    test_pgs_frame_preserved_field()

    print("\nAll style mapping tests passed!")
