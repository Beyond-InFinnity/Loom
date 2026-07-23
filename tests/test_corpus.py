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


def _req(Req, Line, *, opt_in=True, texts=("こんにちは", "ありがとう"), media_id="vid1", track_id="tr1", style=None, **kw):
    lines = [Line(seq=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=t, style=style) for i, t in enumerate(texts)]
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

    def test_style_and_styles_map_are_captured(self, mem_store, capture_handler):
        handler, Req, Line = capture_handler
        resp = handler(
            _req(
                Req,
                Line,
                style="Default",
                styles={"Default": {"fontname": "Trebuchet MS", "fontsize": 48}},
            )
        )
        assert resp.stored is True
        (cap,) = mem_store.tracks.values()
        assert all(ln.style == "Default" for ln in cap.lines)
        assert cap.styles == {"Default": {"fontname": "Trebuchet MS", "fontsize": 48}}

    def test_style_participates_in_content_identity(self, mem_store, capture_handler):
        # A restyled track is a new content version, not a dedup no-op —
        # style is training data for the OCR corpus.
        handler, Req, Line = capture_handler
        handler(_req(Req, Line, style="Default"))
        resp = handler(_req(Req, Line, style="Signs"))
        assert resp.stored is True and resp.deduped is False
        assert len(mem_store.tracks) == 2

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
    LINES = [(0, 0, 900, "こんにちは", None), (1, 1000, 1900, "東京", "Default")]

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

    def test_style_columns_export(self):
        styles = {"Default": {"fontname": "Trebuchet MS", "fontsize": 48}}
        records = build_records(_track(styles_json=styles), self.LINES, [])
        assert records[0]["style"] is None
        assert records[1]["style"] == "Default"
        assert json.loads(records[1]["track_styles_json"]) == styles

    def test_styleless_track_exports_null_styles(self):
        records = build_records(_track(), self.LINES[:1], [])
        assert records[0]["track_styles_json"] is None


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
# Sidecar → prod forward: file payload shaping (loom_api/corpus_forward.py)
# ---------------------------------------------------------------------------

class TestForwardPayload:
    def _subs(self):
        import pysubs2

        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle(fontname="Trebuchet MS", fontsize=48)
        subs.styles["Signs"] = pysubs2.SSAStyle(fontname="Impact", fontsize=60)
        subs.append(pysubs2.SSAEvent(start=0, end=900, text="こんにちは", style="Default"))
        note = pysubs2.SSAEvent(start=500, end=600, text="editor note", style="Default")
        note.is_comment = True
        subs.append(note)
        subs.append(
            pysubs2.SSAEvent(start=1000, end=1900, text="{\\pos(10,10)}東京", style="Signs")
        )
        return subs

    def test_payload_shape_styles_and_comment_skip(self):
        from pathlib import Path

        from loom_api.corpus_forward import build_file_capture_payload

        payload = build_file_capture_payload(
            path=Path("/tmp/Show.S01E01.[Fansub].ass"),
            lang_code="ja",
            role="target",
            subs=self._subs(),
        )
        assert payload["platform"] == "desktop"
        assert payload["media_id"] == "Show.S01E01.[Fansub]"
        assert payload["track_id"].startswith("target:")
        assert payload["track_lang"] == "ja"
        assert payload["opt_in_training"] is True
        # Comment dropped; ASS override tags stripped via plaintext; seq
        # preserves the original event index across the drop.
        assert [(ln["seq"], ln["text"], ln["style"]) for ln in payload["lines"]] == [
            (0, "こんにちは", "Default"),
            (2, "東京", "Signs"),
        ]
        assert payload["styles"]["Default"]["fontname"] == "Trebuchet MS"
        assert payload["styles"]["Signs"]["fontsize"] in {"60", "60.0"}

    def test_forward_disabled_by_env(self, monkeypatch):
        from loom_api import corpus_forward

        monkeypatch.setenv("LOOM_CORPUS_FORWARD_URL", "off")
        assert corpus_forward._forward_url() is None
        monkeypatch.setenv("LOOM_CORPUS_FORWARD_URL", "https://example.com/")
        assert corpus_forward._forward_url() == "https://example.com"
        monkeypatch.delenv("LOOM_CORPUS_FORWARD_URL", raising=False)
        assert corpus_forward._forward_url() == "https://api.loom.nerv-analytic.ai"


# ---------------------------------------------------------------------------
# Spool: offline store-and-forward (loom_api/corpus_forward.py)
# ---------------------------------------------------------------------------

class TestSpool:
    @pytest.fixture
    def spool(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOOM_CORPUS_SPOOL_DIR", str(tmp_path / "spool"))
        monkeypatch.delenv("LOOM_CORPUS_FORWARD_URL", raising=False)
        return tmp_path / "spool"

    def _payload(self, media_id="vid1"):
        return {
            "opt_in_training": True,
            "platform": "desktop",
            "media_id": media_id,
            "track_id": "target:vid1",
            "track_lang": "ja",
            "lines": [{"seq": 0, "start_ms": 0, "end_ms": 900, "text": "こんにちは", "style": None}],
        }

    def test_spool_write_is_content_addressed(self, spool):
        from loom_api.corpus_forward import spool_payload

        p1 = spool_payload(self._payload())
        p2 = spool_payload(self._payload())  # identical content → same file
        p3 = spool_payload(self._payload(media_id="vid2"))
        assert p1 == p2 and p1 != p3
        assert len(list(spool.glob("*.json"))) == 2
        assert not list(spool.glob("*.tmp"))

    def test_flush_success_deletes(self, spool, monkeypatch):
        from loom_api import corpus_forward

        spooled = corpus_forward.spool_payload(self._payload())
        posted = []
        monkeypatch.setattr(
            corpus_forward, "_post_capture",
            lambda url, payload: posted.append(payload) or {"stored": True},
        )
        assert corpus_forward.flush_spool() == 1
        assert posted[0]["media_id"] == "vid1"
        assert not spooled.exists()

    def test_flush_network_failure_keeps_files(self, spool, monkeypatch):
        from loom_api import corpus_forward

        spooled = corpus_forward.spool_payload(self._payload())

        def boom(url, payload):
            raise OSError("network unreachable")

        monkeypatch.setattr(corpus_forward, "_post_capture", boom)
        assert corpus_forward.flush_spool() == 0
        assert spooled.exists()  # retried on the next flush

    def test_flush_validation_reject_quarantines(self, spool, monkeypatch):
        import urllib.error

        from loom_api import corpus_forward

        spooled = corpus_forward.spool_payload(self._payload())

        def reject(url, payload):
            raise urllib.error.HTTPError(url, 422, "unprocessable", None, None)

        monkeypatch.setattr(corpus_forward, "_post_capture", reject)
        assert corpus_forward.flush_spool() == 0
        assert not spooled.exists()
        assert len(list(spool.glob("*.rejected.json"))) == 1

    def test_flush_disabled_by_env_is_no_op(self, spool, monkeypatch):
        from loom_api import corpus_forward

        spooled = corpus_forward.spool_payload(self._payload())
        monkeypatch.setenv("LOOM_CORPUS_FORWARD_URL", "off")
        assert corpus_forward.flush_spool() == 0
        assert spooled.exists()


class TestChunked:
    def test_chunking(self):
        from loom_api.corpus_export import chunked

        assert chunked([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
        assert chunked([], 2) == []
        assert chunked([1], 5) == [[1]]


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


# ---------------------------------------------------------------------------
# Styles size guard (2026-07 hardening): oversized styles map is dropped,
# the capture itself (the lines — the actual corpus) still stores.
# ---------------------------------------------------------------------------

class TestStylesSizeGuard:
    def test_oversized_styles_dropped_lines_kept(self, mem_store, capture_handler, monkeypatch, caplog):
        import logging
        from loom_api import limits
        monkeypatch.setattr(limits, "CORPUS_STYLES_MAX_BYTES", 64)
        handler, Req, Line = capture_handler
        big = {"Default": {"pad": "x" * 200}}
        # loom.corpus has propagate=False (corpus_store.py) so caplog's root
        # handler never sees it — attach the capture handler directly.
        corpus_logger = logging.getLogger("loom.corpus")
        corpus_logger.addHandler(caplog.handler)
        try:
            resp = handler(_req(Req, Line, styles=big))
        finally:
            corpus_logger.removeHandler(caplog.handler)
        assert resp.stored is True and resp.lines == 2
        (cap,) = mem_store.tracks.values()
        assert cap.styles is None
        assert any("styles dropped" in r.getMessage() for r in caplog.records)

    def test_styles_under_cap_kept(self, mem_store, capture_handler, monkeypatch):
        from loom_api import limits
        monkeypatch.setattr(limits, "CORPUS_STYLES_MAX_BYTES", 10_000)
        handler, Req, Line = capture_handler
        styles = {"Default": {"fontname": "Noto Sans CJK JP"}}
        resp = handler(_req(Req, Line, styles=styles))
        assert resp.stored is True
        (cap,) = mem_store.tracks.values()
        assert cap.styles == styles

    def test_guard_disabled_keeps_oversized(self, mem_store, capture_handler, monkeypatch):
        from loom_api import limits
        monkeypatch.setattr(limits, "CORPUS_STYLES_MAX_BYTES", 0)
        handler, Req, Line = capture_handler
        big = {"Default": {"pad": "x" * 200}}
        resp = handler(_req(Req, Line, styles=big))
        assert resp.stored is True
        (cap,) = mem_store.tracks.values()
        assert cap.styles == big

    def test_styles_exactly_at_cap_kept(self, mem_store, capture_handler, monkeypatch):
        # Strict `>` boundary: a map serializing to exactly the cap is kept.
        import json as _json
        from loom_api import limits
        handler, Req, Line = capture_handler
        styles = {"Default": {"fontname": "Noto"}}
        exact = len(_json.dumps(styles, ensure_ascii=False).encode("utf-8"))
        monkeypatch.setattr(limits, "CORPUS_STYLES_MAX_BYTES", exact)
        resp = handler(_req(Req, Line, styles=styles))
        assert resp.stored is True
        (cap,) = mem_store.tracks.values()
        assert cap.styles == styles

    def test_empty_styles_dict_kept_as_is(self, mem_store, capture_handler):
        # {} is not None: serializes to 2 bytes, sails under any cap, stored
        # verbatim (empty map ≠ absent map).
        handler, Req, Line = capture_handler
        resp = handler(_req(Req, Line, styles={}))
        assert resp.stored is True
        (cap,) = mem_store.tracks.values()
        assert cap.styles == {}
