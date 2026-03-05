"""Tests for ASS multi-channel detection and extraction.

Tests:
  - detect_ass_channels(): multi-channel detection, single-channel, sorting
  - Comment and drawing event exclusion from channel counts
  - extract_ass_channel(): preserves Script Info + Styles, filters events
  - Cache key consistency (idempotent extraction)
  - Edge cases: empty file, nonexistent file
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pysubs2

from app.sub_utils import detect_ass_channels, extract_ass_channel


def _write_multi_channel_ass(path, channels, script_info=None):
    """Create an ASS file with multiple style channels.

    Parameters
    ----------
    path : str
        Output file path.
    channels : list[tuple[str, int]]
        ``(style_name, event_count)`` pairs.
    script_info : dict | None
        Extra Script Info fields to set.
    """
    subs = pysubs2.SSAFile()
    if script_info:
        subs.info.update(script_info)
    for style_name, count in channels:
        subs.styles[style_name] = pysubs2.SSAStyle()
        for i in range(count):
            ev = pysubs2.SSAEvent(
                start=i * 1000, end=(i + 1) * 1000,
                text=f"Line {i + 1} for {style_name}",
                style=style_name,
            )
            subs.events.append(ev)
    subs.save(path)
    return path


# ---------------------------------------------------------------------------
# detect_ass_channels() tests
# ---------------------------------------------------------------------------

def test_detect_multi_channel():
    """Multiple styles detected with correct counts, sorted by count desc."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Default", 100), ("JP", 80), ("Signs", 10)],
        )
        cache = {}
        channels = detect_ass_channels(path, cache=cache)

        assert len(channels) == 3
        assert channels[0] == {'style': 'Default', 'count': 100}
        assert channels[1] == {'style': 'JP', 'count': 80}
        assert channels[2] == {'style': 'Signs', 'count': 10}


def test_detect_single_channel():
    """Single-style ASS returns a one-element list."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "single.ass"),
            [("Default", 50)],
        )
        channels = detect_ass_channels(path, cache={})

        assert len(channels) == 1
        assert channels[0] == {'style': 'Default', 'count': 50}


def test_detect_comment_events_excluded():
    """Comment events are not counted toward channel size."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        for i in range(5):
            ev = pysubs2.SSAEvent(
                start=i * 1000, end=(i + 1) * 1000,
                text=f"Line {i + 1}", style="Default",
            )
            if i >= 3:
                ev.is_comment = True
            subs.events.append(ev)
        path = os.path.join(tmpdir, "comments.ass")
        subs.save(path)

        channels = detect_ass_channels(path, cache={})
        assert len(channels) == 1
        assert channels[0]['count'] == 3


def test_detect_drawing_events_excluded():
    r"""Events with \p1 drawing commands are excluded from counts."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        # 2 normal + 1 drawing
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="Normal line 1", style="Default"))
        subs.events.append(pysubs2.SSAEvent(
            start=1000, end=2000, text="Normal line 2", style="Default"))
        subs.events.append(pysubs2.SSAEvent(
            start=2000, end=3000,
            text=r"{\p1}m 0 0 l 100 0 100 100 0 100",
            style="Default"))
        path = os.path.join(tmpdir, "drawing.ass")
        subs.save(path)

        channels = detect_ass_channels(path, cache={})
        assert channels[0]['count'] == 2


def test_detect_empty_style_excluded():
    """Styles with 0 dialogue events (only comments) don't appear."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        subs.styles["Ghost"] = pysubs2.SSAStyle()
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="Hello", style="Default"))
        # Ghost only has a comment event
        ev = pysubs2.SSAEvent(
            start=0, end=1000, text="Hidden", style="Ghost")
        ev.is_comment = True
        subs.events.append(ev)
        path = os.path.join(tmpdir, "ghost.ass")
        subs.save(path)

        channels = detect_ass_channels(path, cache={})
        assert len(channels) == 1
        assert channels[0]['style'] == 'Default'


def test_detect_nonexistent_file():
    """Nonexistent file returns empty list without raising."""
    channels = detect_ass_channels("/nonexistent/file.ass", cache={})
    assert channels == []


def test_detect_sorting_by_count():
    """Channels are sorted by event count descending."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "sorted.ass"),
            [("A", 5), ("B", 50), ("C", 20)],
        )
        channels = detect_ass_channels(path, cache={})

        assert channels[0]['style'] == 'B'
        assert channels[1]['style'] == 'C'
        assert channels[2]['style'] == 'A'


# ---------------------------------------------------------------------------
# extract_ass_channel() tests
# ---------------------------------------------------------------------------

def test_extract_filters_to_selected_style():
    """Extracted file contains only events of the requested style."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Default", 10), ("JP", 5), ("Signs", 3)],
        )
        out = os.path.join(tmpdir, "jp_only.ass")
        extract_ass_channel(path, "JP", out, cache={})

        result = pysubs2.load(out)
        assert len(result.events) == 5
        assert all(e.style == "JP" for e in result.events)


def test_extract_preserves_script_info():
    """Extracted file preserves [Script Info] section."""
    with tempfile.TemporaryDirectory() as tmpdir:
        info = {"Title": "Test Video", "PlayResX": "1920", "PlayResY": "1080"}
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "source.ass"),
            [("Default", 5), ("JP", 3)],
            script_info=info,
        )
        out = os.path.join(tmpdir, "extracted.ass")
        extract_ass_channel(path, "JP", out, cache={})

        result = pysubs2.load(out)
        assert result.info.get("Title") == "Test Video"
        assert result.info.get("PlayResX") == "1920"
        assert result.info.get("PlayResY") == "1080"


def test_extract_preserves_all_styles():
    """Extracted file preserves ALL styles from [V4+ Styles], not just the selected one."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle(fontname="Arial", fontsize=48)
        subs.styles["JP"] = pysubs2.SSAStyle(fontname="MS Gothic", fontsize=36)
        subs.styles["Signs"] = pysubs2.SSAStyle(fontname="Verdana", fontsize=24)
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="Hi", style="Default"))
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="JP line", style="JP"))
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="Sign text", style="Signs"))
        path = os.path.join(tmpdir, "source.ass")
        subs.save(path)

        out = os.path.join(tmpdir, "default_only.ass")
        extract_ass_channel(path, "Default", out, cache={})

        result = pysubs2.load(out)
        # All original styles preserved
        assert "Default" in result.styles
        assert "JP" in result.styles
        assert "Signs" in result.styles
        assert result.styles["Default"].fontname == "Arial"
        # But only Default events
        assert len(result.events) == 1
        assert result.events[0].style == "Default"


def test_extract_includes_comments_for_channel():
    """Comment events matching the style are preserved in extraction."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        subs.styles["JP"] = pysubs2.SSAStyle()
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000, text="English", style="Default"))
        ev_jp = pysubs2.SSAEvent(
            start=0, end=1000, text="JP dialogue", style="JP")
        subs.events.append(ev_jp)
        ev_comment = pysubs2.SSAEvent(
            start=0, end=1000, text="JP note", style="JP")
        ev_comment.is_comment = True
        subs.events.append(ev_comment)
        path = os.path.join(tmpdir, "with_comments.ass")
        subs.save(path)

        out = os.path.join(tmpdir, "jp_ch.ass")
        extract_ass_channel(path, "JP", out, cache={})

        result = pysubs2.load(out)
        assert len(result.events) == 2
        assert all(e.style == "JP" for e in result.events)


def test_extract_does_not_mutate_cache():
    """Extraction deep-copies; cached SSAFile is not modified."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Default", 10), ("JP", 5)],
        )
        cache = {}
        # Warm the cache
        channels = detect_ass_channels(path, cache=cache)
        total_before = sum(ch['count'] for ch in channels)

        # Extract a channel
        out = os.path.join(tmpdir, "jp.ass")
        extract_ass_channel(path, "JP", out, cache=cache)

        # Re-detect — cache should still reflect original file
        channels_after = detect_ass_channels(path, cache=cache)
        total_after = sum(ch['count'] for ch in channels_after)
        assert total_after == total_before


def test_extract_idempotent():
    """Extracting the same channel twice produces identical results."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Default", 10), ("JP", 5)],
        )
        out1 = os.path.join(tmpdir, "jp_1.ass")
        out2 = os.path.join(tmpdir, "jp_2.ass")

        extract_ass_channel(path, "JP", out1, cache={})
        extract_ass_channel(path, "JP", out2, cache={})

        r1 = pysubs2.load(out1)
        r2 = pysubs2.load(out2)
        assert len(r1.events) == len(r2.events)
        for e1, e2 in zip(r1.events, r2.events):
            assert e1.text == e2.text
            assert e1.start == e2.start
            assert e1.end == e2.end
            assert e1.style == e2.style


# ---------------------------------------------------------------------------
# Cache key integration
# ---------------------------------------------------------------------------

def test_cache_key_hit():
    """Simulates the UI cache: same (path, style) key returns cached path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_channel_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Default", 10), ("JP", 5)],
        )

        # Simulate the cache dict used by render_hybrid_selector
        ch_cache = {}
        cache_key = (path, "JP")

        # First call: not in cache → extract
        assert cache_key not in ch_cache
        out = os.path.join(tmpdir, "jp_cached.ass")
        extract_ass_channel(path, "JP", out, cache={})
        ch_cache[cache_key] = out

        # Second call: cache hit → skip extraction
        assert cache_key in ch_cache
        assert ch_cache[cache_key] == out
        assert os.path.isfile(ch_cache[cache_key])


if __name__ == '__main__':
    import inspect

    print("Running ASS channel detection tests...\n")
    test_funcs = [
        obj for name, obj in sorted(globals().items())
        if name.startswith('test_') and callable(obj)
    ]
    for func in test_funcs:
        func_name = func.__name__
        sig = inspect.signature(func)
        if 'tmp_path' in sig.parameters:
            continue  # pytest-only fixture
        print(f"  {func_name}...", end=' ')
        with tempfile.TemporaryDirectory() as _td:
            func()
        print("PASS")

    print(f"\nAll {len(test_funcs)} ASS channel tests passed!")
