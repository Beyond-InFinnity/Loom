"""Tests for the media-identity corpus (ROMANIZATION_CACHE.md Layer 2).

Covers POST /corpus/capture (opt-in gate, normalization, dedup semantics,
fail-soft contract), the content-hash identity rules, the export module's
pure record-shaping/partitioning layer, and provider wiring.  The Postgres
store and the SQL half of the export runner follow the same fail-open
pattern live-verified for Layer 1 and get their acceptance test on Railway
(memory: caption-pipeline changes need prod verification anyway).

Handlers are called directly with Pydantic models (house idiom); the store
is swapped via loom_api.deps.set_corpus_store.
"""
import json

import pytest

from loom_api.corpus_export import (
    TrackMeta,
    build_records,
    group_tracks_by_partition,
    partition_path,
)
from loom_api.corpus_store import (
    CorpusLine,
    InMemoryCorpusStore,
    NullCorpusStore,
    track_content_hash,
)
from loom_api.deps import set_corpus_store


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mem_store():
    store = InMemoryCorpusStore()
    set_corpus_store(store)
    yield store
    set_corpus_store(None)


@pytest.fixture
def capture_handler():
    from loom_api.routes.corpus import CaptureLine, CorpusCaptureRequest, corpus_capture
    return corpus_capture, CorpusCaptureRequest, CaptureLine


def _req(Req, Line, *, opt_in=True, texts=("こんにちは", "ありがとう"), media_id="vid1", track_id="tr1", **kw):
    lines = [Line(seq=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=t) for i, t in enumerate(texts)]
    return Req(
        opt_in_training=opt_in,
        platform="youtube",
        media_id=media_id,
        track_id=track_id,
        track_lang="ja",
        lines=lines,
        **kw,
    )


# ---------------------------------------------------------------------------
# POST /corpus/capture contract
# ---------------------------------------------------------------------------

class TestCaptureRoute:
    def test_opt_in_false_stores_nothing(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        resp = handler(_req(Req, Line, opt_in=False))
        assert resp.stored is False
        assert "opt_in" in resp.reason
        assert mem_store.tracks == {} and mem_store.media == {}

    def test_opt_in_true_stores_track_and_lines(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        resp = handler(_req(Req, Line))
        assert resp.stored is True and resp.lines == 2 and resp.deduped is False
        assert ("youtube", "vid1") in mem_store.media
        (cap,) = mem_store.tracks.values()
        assert [ln.text for ln in cap.lines] == ["こんにちは", "ありがとう"]
        assert cap.lines[1].start_ms == 1000 and cap.lines[1].end_ms == 1900

    def test_texts_are_normalized_and_empties_dropped(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        resp = handler(_req(Req, Line, texts=("  こんにちは\n", "   ", "ガラス")))  # decomposed ガ
        assert resp.stored is True and resp.lines == 2  # whitespace-only line dropped
        (cap,) = mem_store.tracks.values()
        assert cap.lines[0].text == "こんにちは"        # stripped
        assert cap.lines[1].text == "ガラス"             # NFC-composed

    def test_all_empty_lines_is_a_no_op(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        resp = handler(_req(Req, Line, texts=("", "  ")))
        assert resp.stored is False and "no non-empty" in resp.reason
        assert mem_store.tracks == {}

    def test_identical_recapture_dedups(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        assert handler(_req(Req, Line)).stored is True
        resp = handler(_req(Req, Line))
        assert resp.stored is False and resp.deduped is True
        assert len(mem_store.tracks) == 1

    def test_revised_track_content_captures_as_new_version(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        handler(_req(Req, Line, texts=("こんにちは",)))
        resp = handler(_req(Req, Line, texts=("こんにちは、世界",)))  # platform revised the line
        assert resp.stored is True and resp.deduped is False
        assert len(mem_store.tracks) == 2  # two content versions of the same track

    def test_platform_is_lowercased(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        handler(
            Req(
                opt_in_training=True,
                platform="  NetFlix ",
                media_id="81234",
                track_id="t1",
                track_lang="ja",
                lines=[Line(seq=0, text="こんにちは")],
            )
        )
        assert ("netflix", "81234") in mem_store.media

    def test_default_store_is_fail_soft_no_op(self, capture_handler, monkeypatch):
        # No DSN configured → NullCorpusStore → 200 stored=false, never a raise.
        handler, Req, Line = capture_handler
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("LOOM_CORPUS_URL", raising=False)
        set_corpus_store(None)
        try:
            resp = handler(_req(Req, Line))
            assert resp.stored is False and resp.reason
        finally:
            set_corpus_store(None)


# ---------------------------------------------------------------------------
# Content-hash identity
# ---------------------------------------------------------------------------

class TestContentHash:
    def _lines(self, *texts, offset=0):
        return tuple(
            CorpusLine(seq=i, start_ms=i * 1000 + offset, end_ms=i * 1000 + 900 + offset, text=t)
            for i, t in enumerate(texts)
        )

    def test_same_content_same_hash(self):
        assert track_content_hash(self._lines("a", "b")) == track_content_hash(self._lines("a", "b"))

    def test_text_change_changes_hash(self):
        assert track_content_hash(self._lines("a", "b")) != track_content_hash(self._lines("a", "c"))

    def test_retiming_changes_hash(self):
        # A re-timed track is a new content version — timing is training data.
        assert track_content_hash(self._lines("a", "b")) != track_content_hash(self._lines("a", "b", offset=500))

    def test_order_changes_hash(self):
        assert track_content_hash(self._lines("a", "b")) != track_content_hash(self._lines("b", "a"))


# ---------------------------------------------------------------------------
# Export: pure record shaping + partitioning
# ---------------------------------------------------------------------------

def _track(**kw):
    defaults = dict(
        track_pk=1, platform="netflix", media_id="81234", title="Frieren",
        origin_lang="ja", track_id="t-ja", lang_code="ja", is_cc=False,
        kind="manual", captured_month="2026-07", captured_at_iso="2026-07-02 10:00:00+00",
    )
    defaults.update(kw)
    return TrackMeta(**defaults)


class TestExportRecords:
    LINES = [(0, 0, 900, "こんにちは"), (1, 1000, 1900, "東京")]

    def test_records_are_self_contained_and_ordered(self):
        cache_rows = [
            ("romanize", "Romaji", "こんにちは", {"romanized": "konnichiwa"}, 1),
            ("annotate", "Furigana", "東京", {"spans": [["東京", "とうきょう"]]}, 1),
        ]
        records = build_records(_track(), self.LINES, cache_rows)
        assert [r["seq"] for r in records] == [0, 1]
        first, second = records
        assert first["platform"] == "netflix" and first["media_id"] == "81234" and first["title"] == "Frieren"
        assert json.loads(first["romanizations_json"]) == {"Romaji": "konnichiwa"}
        assert json.loads(first["annotations_json"]) == {}
        assert json.loads(second["annotations_json"]) == {"Furigana": [["東京", "とうきょう"]]}
        assert json.loads(second["engine_versions_json"]) == {"annotate:Furigana": 1}

    def test_latest_engine_version_wins(self):
        cache_rows = [
            ("romanize", "Romaji", "こんにちは", {"romanized": "old-buggy"}, 1),
            ("romanize", "Romaji", "こんにちは", {"romanized": "konnichiwa"}, 2),
        ]
        records = build_records(_track(), self.LINES[:1], cache_rows)
        assert json.loads(records[0]["romanizations_json"]) == {"Romaji": "konnichiwa"}
        assert json.loads(records[0]["engine_versions_json"]) == {"romanize:Romaji": 2}

    def test_multiple_systems_aggregate(self):
        cache_rows = [
            ("romanize", "Pinyin", "こんにちは", {"romanized": "x"}, 1),
            ("romanize", "Romaji", "こんにちは", {"romanized": "konnichiwa"}, 1),
        ]
        records = build_records(_track(), self.LINES[:1], cache_rows)
        assert set(json.loads(records[0]["romanizations_json"])) == {"Pinyin", "Romaji"}

    def test_uncached_text_exports_with_empty_maps(self):
        records = build_records(_track(), self.LINES, [])
        assert all(json.loads(r["romanizations_json"]) == {} for r in records)
        assert all(json.loads(r["annotations_json"]) == {} for r in records)

    def test_malformed_cache_output_is_skipped(self):
        records = build_records(_track(), self.LINES[:1], [("romanize", "Romaji", "こんにちは", "not-a-dict", 1)])
        assert json.loads(records[0]["romanizations_json"]) == {}


class TestPartitioning:
    def test_grouping(self):
        tracks = [
            _track(track_pk=1), _track(track_pk=2),
            _track(track_pk=3, platform="youtube"),
            _track(track_pk=4, captured_month="2026-08"),
        ]
        groups = group_tracks_by_partition(tracks)
        assert set(groups) == {
            ("netflix", "ja", "2026-07"), ("youtube", "ja", "2026-07"), ("netflix", "ja", "2026-08"),
        }
        assert [t.track_pk for t in groups[("netflix", "ja", "2026-07")]] == [1, 2]

    def test_partition_path_is_hive_style(self):
        path = partition_path("netflix", "ja", "2026-07", "abc123")
        assert path == "corpus/platform=netflix/lang=ja/captured=2026-07/part-abc123.parquet"


# ---------------------------------------------------------------------------
# Provider wiring
# ---------------------------------------------------------------------------

class TestProvider:
    def test_no_dsn_yields_null_store(self, monkeypatch):
        import loom_api.deps as deps
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("LOOM_CORPUS_URL", raising=False)
        set_corpus_store(None)
        try:
            assert isinstance(deps.get_corpus_store(), NullCorpusStore)
        finally:
            set_corpus_store(None)

    def test_kill_switch_beats_dsn(self, monkeypatch):
        import loom_api.deps as deps
        monkeypatch.setenv("DATABASE_URL", "postgres://nope")
        monkeypatch.setenv("LOOM_CORPUS", "off")
        set_corpus_store(None)
        try:
            assert isinstance(deps.get_corpus_store(), NullCorpusStore)
        finally:
            set_corpus_store(None)
