"""Tests for _build_pgs_timeline() union timeline builder and concurrent event merging."""

import pytest
from app.processing import _build_pgs_timeline, _is_music_only, _merge_concurrent_target_events


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _td(start, end, top_html="Top", romaji_text=None):
    """Shorthand for a target_event_data dict."""
    return {"start": start, "end": end, "top_html": top_html, "romaji_text": romaji_text}


def _ne(start, end, text="Bottom"):
    """Shorthand for a native_events tuple."""
    return (start, end, text)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAlignedTiming:
    """When both tracks have identical boundaries, output should match 1:1."""

    def test_single_aligned_event(self):
        target = [_td(0, 5000, "A")]
        native = [_ne(0, 5000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 1
        assert result[0] == (0, 5000, "A", None, "X")

    def test_multiple_aligned_events(self):
        target = [_td(0, 3000, "A"), _td(3000, 6000, "B")]
        native = [_ne(0, 3000, "X"), _ne(3000, 6000, "Y")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 2
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 6000, "B", None, "Y")


class TestOffsetNative:
    """Primary fix case: native changes mid-target-event."""

    def test_native_split_within_target(self):
        """Native changes at 3s within target 0-5s → 2 intervals."""
        target = [_td(0, 5000, "A")]
        native = [_ne(0, 3000, "X"), _ne(3000, 5000, "Y")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 2
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 5000, "A", None, "Y")

    def test_full_offset_example(self):
        """The motivating example from the plan."""
        target = [_td(0, 5000, "A"), _td(5000, 10000, "B")]
        native = [_ne(0, 3000, "X"), _ne(3000, 8000, "Y")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        # Expected intervals: [0-3 A+X] [3-5 A+Y] [5-8 B+Y] [8-10 B+None]
        assert len(result) == 4
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 5000, "A", None, "Y")
        assert result[2] == (5000, 8000, "B", None, "Y")
        assert result[3] == (8000, 10000, "B", None, None)

    def test_romaji_preserved_across_splits(self):
        """Romaji computed once per target event, reused in all derived intervals."""
        target = [_td(0, 6000, "A", romaji_text="a-romaji")]
        native = [_ne(0, 2000, "X"), _ne(2000, 4000, "Y"), _ne(4000, 6000, "Z")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 3
        for iv in result:
            assert iv[3] == "a-romaji"


class TestNativeOnlyIntervals:
    """Native-only intervals (no active target) should still appear."""

    def test_native_extends_beyond_target(self):
        target = [_td(1000, 3000, "A")]
        native = [_ne(0, 5000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 3
        # [0-1000 native-only] [1000-3000 both] [3000-5000 native-only]
        assert result[0] == (0, 1000, "", None, "X")
        assert result[1] == (1000, 3000, "A", None, "X")
        assert result[2] == (3000, 5000, "", None, "X")

    def test_native_only_before_target(self):
        target = [_td(5000, 8000, "A")]
        native = [_ne(0, 3000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        # Two separate intervals with a gap between them.
        assert len(result) == 2
        assert result[0] == (0, 3000, "", None, "X")
        assert result[1] == (5000, 8000, "A", None, None)


class TestTargetOnlyIntervals:
    """Target-only intervals (no active native) should have bottom_text=None."""

    def test_target_extends_beyond_native(self):
        target = [_td(0, 5000, "A")]
        native = [_ne(0, 3000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 2
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 5000, "A", None, None)

    def test_target_only_no_native_at_all(self):
        target = [_td(0, 5000, "A")]
        native = []
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 1
        assert result[0] == (0, 5000, "A", None, None)


class TestGapInNative:
    """Gap in native track mid-target → target-only interval for the gap."""

    def test_gap_produces_target_only_interval(self):
        target = [_td(0, 10000, "A")]
        native = [_ne(0, 3000, "X"), _ne(7000, 10000, "Z")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 3
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 7000, "A", None, None)  # gap
        assert result[2] == (7000, 10000, "A", None, "Z")


class TestBottomDisabled:
    """When bottom is disabled, degenerates to target-only timeline."""

    def test_bottom_disabled_ignores_native(self):
        target = [_td(0, 5000, "A"), _td(5000, 10000, "B")]
        native = [_ne(0, 3000, "X"), _ne(3000, 10000, "Y")]
        result = _build_pgs_timeline(target, native, bottom_enabled=False)
        assert len(result) == 2
        assert result[0] == (0, 5000, "A", None, None)
        assert result[1] == (5000, 10000, "B", None, None)


class TestContentKeyContinuity:
    """Content stays consistent across split intervals."""

    def test_top_html_identical_across_native_splits(self):
        """Same top_html in every interval derived from one target event."""
        target = [_td(0, 9000, "TopContent")]
        native = [_ne(0, 3000, "A"), _ne(3000, 6000, "B"), _ne(6000, 9000, "C")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 3
        top_htmls = [iv[2] for iv in result]
        assert all(h == "TopContent" for h in top_htmls)
        # Each native interval has different bottom text.
        bottoms = [iv[4] for iv in result]
        assert bottoms == ["A", "B", "C"]


class TestRegionCountTransition:
    """When object count changes (1↔2 regions), the epoch system will emit
    Epoch Start.  The timeline must produce intervals that reflect these
    transitions."""

    def test_native_only_to_both_tracks(self):
        """Transition from native-only (1 region) to both (2 regions)."""
        target = [_td(3000, 6000, "A")]
        native = [_ne(0, 6000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 2
        # First: native-only → 1 region
        assert result[0] == (0, 3000, "", None, "X")
        # Second: both → 2 regions (epoch system detects object count change)
        assert result[1] == (3000, 6000, "A", None, "X")

    def test_both_tracks_to_target_only(self):
        """Transition from both (2 regions) to target-only (1 region)."""
        target = [_td(0, 6000, "A")]
        native = [_ne(0, 3000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 2
        assert result[0] == (0, 3000, "A", None, "X")
        assert result[1] == (3000, 6000, "A", None, None)


class TestEdgeCases:
    """Miscellaneous edge cases."""

    def test_empty_target(self):
        target = []
        native = [_ne(0, 5000, "X")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        # Native-only events should still produce intervals.
        assert len(result) == 1
        assert result[0] == (0, 5000, "", None, "X")

    def test_empty_both(self):
        result = _build_pgs_timeline([], [], bottom_enabled=True)
        assert result == []

    def test_zero_duration_interval_skipped(self):
        """If two boundaries coincide, the zero-duration interval is skipped."""
        target = [_td(0, 3000, "A"), _td(3000, 6000, "B")]
        native = [_ne(0, 3000, "X"), _ne(3000, 6000, "Y")]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        # All intervals have positive duration.
        for iv in result:
            assert iv[1] > iv[0]

    def test_many_native_changes_within_one_target(self):
        """Stress test: many native splits within one target event."""
        target = [_td(0, 10000, "A")]
        native = [_ne(i * 1000, (i + 1) * 1000, f"N{i}") for i in range(10)]
        result = _build_pgs_timeline(target, native, bottom_enabled=True)
        assert len(result) == 10
        for i, iv in enumerate(result):
            assert iv == (i * 1000, (i + 1) * 1000, "A", None, f"N{i}")


# ---------------------------------------------------------------------------
# _is_music_only tests
# ---------------------------------------------------------------------------

class TestIsMusicOnly:
    """Detection of music-indicator-only subtitle events."""

    def test_single_note(self):
        assert _is_music_only("♪") is True

    def test_double_note(self):
        assert _is_music_only("♪♪") is True

    def test_mixed_music_chars(self):
        assert _is_music_only("♪♫♩♬") is True

    def test_music_with_spaces(self):
        assert _is_music_only("  ♪  ") is True

    def test_music_in_html(self):
        assert _is_music_only("<ruby>♪</ruby>") is True

    def test_music_in_ass_tags(self):
        assert _is_music_only("{\\b1}♪{\\b0}") is True

    def test_dialogue_not_music(self):
        assert _is_music_only("いいわね？") is False

    def test_music_plus_dialogue(self):
        assert _is_music_only("♪ Hello") is False

    def test_empty_string(self):
        assert _is_music_only("") is False

    def test_whitespace_only(self):
        assert _is_music_only("   ") is False


# ---------------------------------------------------------------------------
# _merge_concurrent_target_events tests
# ---------------------------------------------------------------------------

class TestMergeConcurrentEvents:
    """Merging overlapping target events with identical timing."""

    def test_no_concurrent_unchanged(self):
        """Non-overlapping events pass through unchanged."""
        data = [_td(0, 3000, "A"), _td(3000, 6000, "B")]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 2
        assert result[0]['top_html'] == "A"
        assert result[1]['top_html'] == "B"

    def test_music_dropped_when_dialogue_concurrent(self):
        """♪ event at same timestamp as dialogue → only dialogue survives."""
        data = [
            _td(0, 3000, "♪"),
            _td(0, 3000, "（無線:ミサト）いいわね？"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert result[0]['top_html'] == "（無線:ミサト）いいわね？"

    def test_music_first_dialogue_second(self):
        """Order shouldn't matter — dialogue kept regardless of position."""
        data = [
            _td(0, 3000, "（無線:ミサト）いいわね？"),
            _td(0, 3000, "♪"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert result[0]['top_html'] == "（無線:ミサト）いいわね？"

    def test_music_with_html_tags_dropped(self):
        """Music note wrapped in annotation HTML is still detected."""
        data = [
            _td(0, 3000, "<ruby>♪</ruby>"),
            _td(0, 3000, "<ruby>日本語</ruby>", romaji_text="nihongo"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert "日本語" in result[0]['top_html']
        assert result[0]['romaji_text'] == "nihongo"

    def test_all_music_keeps_one(self):
        """Multiple concurrent music events → keep just one."""
        data = [
            _td(0, 3000, "♪"),
            _td(0, 3000, "♪♪"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1

    def test_multiple_dialogue_stacked(self):
        """Two concurrent dialogue events → stacked with <br>."""
        data = [
            _td(0, 3000, "Line A", romaji_text="romaji A"),
            _td(0, 3000, "Line B", romaji_text="romaji B"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert result[0]['top_html'] == "Line A<br>Line B"
        assert result[0]['romaji_text'] == "romaji A\\Nromaji B"

    def test_romaji_none_excluded_from_stack(self):
        """When one event has no romaji, it's excluded from the joined string."""
        data = [
            _td(0, 3000, "Line A", romaji_text="romaji A"),
            _td(0, 3000, "Line B", romaji_text=None),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert result[0]['romaji_text'] == "romaji A"

    def test_music_romaji_dropped_with_event(self):
        """When ♪ is dropped, its romaji (also ♪) is discarded."""
        data = [
            _td(0, 3000, "♪", romaji_text="♪"),
            _td(0, 3000, "会話", romaji_text="kaiwa"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 1
        assert result[0]['romaji_text'] == "kaiwa"

    def test_empty_input(self):
        assert _merge_concurrent_target_events([]) == []

    def test_different_timestamps_not_merged(self):
        """Events at different timestamps remain separate."""
        data = [
            _td(0, 3000, "♪"),
            _td(3000, 6000, "♪"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 2

    def test_preserves_surrounding_events(self):
        """Merge applies only to concurrent events; others pass through."""
        data = [
            _td(0, 3000, "Before"),
            _td(3000, 6000, "♪"),
            _td(3000, 6000, "Dialogue"),
            _td(6000, 9000, "After"),
        ]
        result = _merge_concurrent_target_events(data)
        assert len(result) == 3
        assert result[0]['top_html'] == "Before"
        assert result[1]['top_html'] == "Dialogue"
        assert result[2]['top_html'] == "After"


class TestEVAConcurrentEvents:
    """Simulate the EVA E02 scenario: ♪ + dialogue at the same timestamp,
    going through merge → union timeline → PGS frame generation."""

    def test_eva_0_01_34(self):
        """EVA E02 @0:01:34.76 — ♪ concurrent with dialogue line.

        After merge: only dialogue survives.  Timeline with native track
        produces correct interval.
        """
        # ms for 0:01:34.760 = 94760, end at 0:01:37.890 = 97890
        target = [
            _td(94760, 97890, "♪", romaji_text="♪"),
            _td(94760, 97890, "（無線:ミサト）いいわね？　シンジ君",
                romaji_text="(musen: misato) ī wa ne? shinji kun"),
        ]
        native = [_ne(94760, 97890, "Ready, Shinji?")]

        merged = _merge_concurrent_target_events(target)
        assert len(merged) == 1
        assert "ミサト" in merged[0]['top_html']
        assert "musen" in merged[0]['romaji_text']

        # Full pipeline: merge → timeline
        timeline = _build_pgs_timeline(merged, native, bottom_enabled=True)
        assert len(timeline) == 1
        iv = timeline[0]
        assert iv[0] == 94760  # start
        assert iv[1] == 97890  # end
        assert "ミサト" in iv[2]  # top_html
        assert "musen" in iv[3]  # romaji
        assert iv[4] == "Ready, Shinji?"  # bottom

    def test_eva_0_09_52(self):
        """EVA E02 @0:09:52 — ♪ concurrent with dialogue.

        Same pattern: music note dropped, dialogue + romaji preserved.
        """
        # ms for 0:09:52.000 = 592000, end at 0:09:55.500 = 595500
        target = [
            _td(592000, 595500, "♪♪"),
            _td(592000, 595500, "碇くんがエヴァに乗ったのよ！",
                romaji_text="ikari kun ga eva ni notta no yo!"),
        ]
        native = [_ne(592000, 595500, "Ikari got into the Eva!")]

        merged = _merge_concurrent_target_events(target)
        assert len(merged) == 1
        assert "碇" in merged[0]['top_html']
        assert merged[0]['romaji_text'] == "ikari kun ga eva ni notta no yo!"

        timeline = _build_pgs_timeline(merged, native, bottom_enabled=True)
        assert len(timeline) == 1
        assert timeline[0][4] == "Ikari got into the Eva!"

    def test_eva_bottom_disabled(self):
        """Degenerate path (no native track) also benefits from merge."""
        target = [
            _td(94760, 97890, "♪"),
            _td(94760, 97890, "（無線:ミサト）いいわね？　シンジ君"),
        ]

        merged = _merge_concurrent_target_events(target)
        timeline = _build_pgs_timeline(merged, [], bottom_enabled=False)
        assert len(timeline) == 1
        assert "ミサト" in timeline[0][2]
        assert timeline[0][4] is None  # no bottom
