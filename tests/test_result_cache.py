"""Tests for the content-addressed result cache (ROMANIZATION_CACHE.md Layer 1).

Covers the cache-specific contract layered onto /romanize/batch +
/annotate/batch, whose pre-cache behavior is already locked by
test_romanize_batch.py (which runs against the default NullResultCache —
those tests double as the "no cache configured = byte-identical behavior"
guarantee).  This file owns:

- Read-through/write-back: second identical batch performs ZERO computations
- In-batch dedup: a text repeated N times is computed once even on cold cache
- Positional alignment survives mixed hit / miss / empty inputs
- Key identity: phonetic_system=None vs the explicit default share entries;
  NFC composition variants share entries; long_vowel_mode fragments the key
  ONLY on the Japanese path
- Key isolation: engine_version bump makes old rows unreachable
- Robustness: malformed cached values are ignored and recomputed
- /annotate caches spans, not HTML — render_mode changes re-render from a hit

Tests call handlers directly with Pydantic models (house idiom, see
test_romanize_batch.py) and swap the cache via loom_api.deps.set_result_cache.
"""
import pytest

from loom_api.deps import set_result_cache
from loom_api.result_cache import (
    CacheRow,
    InMemoryResultCache,
    cache_key,
    normalize_text,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mem_cache():
    """Install an InMemoryResultCache for the duration of the test."""
    cache = InMemoryResultCache()
    set_result_cache(cache)
    yield cache
    set_result_cache(None)


@pytest.fixture
def compute_counter(monkeypatch):
    """Wrap get_lang_config in both route modules so every romanize_func /
    annotation_func invocation increments a counter.  This is how tests
    assert 'the heavy path did not run' on cache hits."""
    from loom_core.styles import get_lang_config as real_get_lang_config
    from loom_api.routes import annotate as ann_mod
    from loom_api.routes import romanize as rom_mod

    counts = {"n": 0}

    def counted(lang_code, phonetic_system=None):
        cfg = dict(real_get_lang_config(lang_code, phonetic_system=phonetic_system))
        romanize_func = cfg.get("romanize_func")
        annotation_func = cfg.get("annotation_func")
        if romanize_func:
            def counted_romanize(text, _f=romanize_func):
                counts["n"] += 1
                return _f(text)
            cfg["romanize_func"] = counted_romanize
        if annotation_func:
            # The Japanese romanize path goes through annotation_func too,
            # so counting it covers both routes' heavy work.
            def counted_annotate(text, _f=annotation_func):
                counts["n"] += 1
                return _f(text)
            cfg["annotation_func"] = counted_annotate
        return cfg

    monkeypatch.setattr(rom_mod, "get_lang_config", counted)
    monkeypatch.setattr(ann_mod, "get_lang_config", counted)
    return counts


@pytest.fixture
def romanize_handler():
    from loom_api.routes.romanize import RomanizeBatchRequest, romanize_batch
    return romanize_batch, RomanizeBatchRequest


@pytest.fixture
def annotate_handler():
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch
    return annotate_batch, AnnotateBatchRequest


# ---------------------------------------------------------------------------
# Key construction unit tests
# ---------------------------------------------------------------------------

class TestKeys:
    def test_nfc_variants_share_a_key(self):
        composed = "ガラス"                 # U+30AC precomposed
        decomposed = "ガラス"          # カ + combining voiced mark
        assert normalize_text(composed) == normalize_text(decomposed)

    def test_whitespace_variants_share_a_key(self):
        assert normalize_text("  こんにちは\n") == normalize_text("こんにちは")

    def test_key_components_all_participate(self):
        base = ("romanize", "ja", "Romaji", "macrons", 1, "東京")
        k = cache_key(*base)
        assert cache_key("annotate", *base[1:]) != k
        assert cache_key(base[0], "ko", *base[2:]) != k
        assert cache_key(*base[:2], "Furigana", *base[3:]) != k
        assert cache_key(*base[:3], "doubled", *base[4:]) != k
        assert cache_key(*base[:4], 2, base[5]) != k
        assert cache_key(*base[:5], "京都") != k
        assert cache_key(*base) == k  # deterministic


# ---------------------------------------------------------------------------
# /romanize/batch read-through/write-back
# ---------------------------------------------------------------------------

class TestRomanizeCaching:
    def test_second_identical_batch_computes_nothing(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        req = Req(texts=["привет", "спасибо", "пока"], lang_code="ru")
        first = handler(req)
        computed_cold = compute_counter["n"]
        assert computed_cold == 3
        second = handler(Req(texts=["привет", "спасибо", "пока"], lang_code="ru"))
        assert compute_counter["n"] == computed_cold  # zero new computations
        assert [i.romanized for i in first.results] == [i.romanized for i in second.results]
        assert all(i.romanized for i in second.results)

    def test_in_batch_dedup_computes_repeated_line_once(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        resp = handler(Req(texts=["привет"] * 5, lang_code="ru"))
        assert compute_counter["n"] == 1
        assert len({i.romanized for i in resp.results}) == 1
        assert resp.results[0].romanized

    def test_positional_alignment_with_mixed_hits_misses_empties(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        handler(Req(texts=["привет"], lang_code="ru"))  # seed one entry
        seeded = compute_counter["n"]
        resp = handler(Req(texts=["привет", "", "мир", "   ", "привет"], lang_code="ru"))
        assert compute_counter["n"] == seeded + 1  # only "мир" computed
        assert len(resp.results) == 5
        assert resp.results[0].romanized == resp.results[4].romanized != ""
        assert resp.results[1].romanized == ""
        assert resp.results[2].romanized != ""
        assert resp.results[3].romanized == ""

    def test_none_and_explicit_default_system_share_entries(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        handler(Req(texts=["你好"], lang_code="zh-Hans"))  # default resolves to pinyin
        computed = compute_counter["n"]
        handler(Req(texts=["你好"], lang_code="zh-Hans", phonetic_system="pinyin"))
        assert compute_counter["n"] == computed  # hit — same resolved system

    def test_long_vowel_mode_fragments_key_only_for_japanese(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        macrons = handler(Req(texts=["東京"], lang_code="ja", long_vowel_mode="macrons"))
        after_first = compute_counter["n"]
        doubled = handler(Req(texts=["東京"], lang_code="ja", long_vowel_mode="doubled"))
        assert compute_counter["n"] > after_first  # ja: mode is in the key → recompute
        assert macrons.results[0].romanized != doubled.results[0].romanized

        handler(Req(texts=["привет мир"], lang_code="ru", long_vowel_mode="macrons"))
        after_ru = compute_counter["n"]
        handler(Req(texts=["привет мир"], lang_code="ru", long_vowel_mode="doubled"))
        assert compute_counter["n"] == after_ru  # non-ja: mode neutralized → hit

    def test_engine_version_bump_makes_old_rows_unreachable(self, mem_cache, compute_counter, romanize_handler, monkeypatch):
        handler, Req = romanize_handler
        handler(Req(texts=["привет"], lang_code="ru"))
        seeded = compute_counter["n"]
        from loom_api.routes import romanize as rom_mod
        monkeypatch.setattr(rom_mod, "engine_version", lambda lang: 999)
        handler(Req(texts=["привет"], lang_code="ru"))
        assert compute_counter["n"] == seeded + 1  # recomputed under the new version

    def test_malformed_cache_value_is_recomputed(self, mem_cache, compute_counter, romanize_handler):
        handler, Req = romanize_handler
        handler(Req(texts=["привет"], lang_code="ru"))
        # Corrupt every stored value (wrong shape) — the route must treat
        # them as misses, not crash or serve garbage.
        for k in list(mem_cache.store):
            mem_cache.store[k] = {"unexpected": 42}
        seeded = compute_counter["n"]
        resp = handler(Req(texts=["привет"], lang_code="ru"))
        assert compute_counter["n"] == seeded + 1
        assert resp.results[0].romanized

    def test_unsupported_language_never_touches_cache(self, mem_cache, romanize_handler):
        handler, Req = romanize_handler
        resp = handler(Req(texts=["hello", "world"], lang_code="en"))
        assert all(i.romanized == "" for i in resp.results)
        assert resp.has_phonetic_layer is False
        assert mem_cache.store == {}

    def test_rows_written_carry_resolved_metadata(self, mem_cache, romanize_handler):
        handler, Req = romanize_handler
        handler(Req(texts=["你好"], lang_code="zh-Hans"))
        assert len(mem_cache.store) == 1
        (value,) = mem_cache.store.values()
        assert isinstance(value, dict) and isinstance(value["romanized"], str)


# ---------------------------------------------------------------------------
# Single endpoints — same cache (the web app fans out singles)
# ---------------------------------------------------------------------------

class TestSingleEndpointCaching:
    def test_single_romanize_hits_cache_and_shares_it_with_batch(self, mem_cache, compute_counter):
        from loom_api.routes.romanize import (
            RomanizeBatchRequest,
            RomanizeRequest,
            romanize,
            romanize_batch,
        )
        first = romanize(RomanizeRequest(text="привет", lang_code="ru"))
        cold = compute_counter["n"]
        assert cold == 1 and first.romanized
        # Repeat single: zero compute.
        second = romanize(RomanizeRequest(text="привет", lang_code="ru"))
        assert compute_counter["n"] == cold
        assert second.romanized == first.romanized
        # The batch endpoint shares the same keys — also a hit.
        batch = romanize_batch(RomanizeBatchRequest(texts=["привет"], lang_code="ru"))
        assert compute_counter["n"] == cold
        assert batch.results[0].romanized == first.romanized

    def test_single_annotate_caches_spans_across_render_modes(self, mem_cache, compute_counter):
        from loom_api.routes.annotate import AnnotateRequest, annotate
        ruby = annotate(AnnotateRequest(text="東京に行く", lang_code="ja", render_mode="ruby"))
        cold = compute_counter["n"]
        inline = annotate(AnnotateRequest(text="東京に行く", lang_code="ja", render_mode="inline"))
        assert compute_counter["n"] == cold  # spans from cache
        assert inline.html != ruby.html
        assert [s.model_dump() for s in inline.spans] == [s.model_dump() for s in ruby.spans]


# ---------------------------------------------------------------------------
# /annotate/batch — spans cached, HTML re-rendered
# ---------------------------------------------------------------------------

class TestAnnotateCaching:
    def test_second_identical_batch_computes_nothing(self, mem_cache, compute_counter, annotate_handler):
        handler, Req = annotate_handler
        first = handler(Req(texts=["東京に行く"], lang_code="ja"))
        cold = compute_counter["n"]
        assert cold >= 1
        second = handler(Req(texts=["東京に行く"], lang_code="ja"))
        assert compute_counter["n"] == cold
        assert [s.model_dump() for s in second.results[0].spans] == [
            s.model_dump() for s in first.results[0].spans
        ]
        assert second.results[0].html == first.results[0].html != ""

    def test_render_mode_change_hits_cache_but_rerenders_html(self, mem_cache, compute_counter, annotate_handler):
        handler, Req = annotate_handler
        ruby = handler(Req(texts=["東京に行く"], lang_code="ja", render_mode="ruby"))
        cold = compute_counter["n"]
        inline = handler(Req(texts=["東京に行く"], lang_code="ja", render_mode="inline"))
        assert compute_counter["n"] == cold  # spans came from cache
        assert inline.results[0].html != ruby.results[0].html
        assert [s.model_dump() for s in inline.results[0].spans] == [
            s.model_dump() for s in ruby.results[0].spans
        ]

    def test_positional_alignment_with_mixed_hits_misses_empties(self, mem_cache, compute_counter, annotate_handler):
        handler, Req = annotate_handler
        handler(Req(texts=["東京"], lang_code="ja"))
        seeded = compute_counter["n"]
        resp = handler(Req(texts=["東京", "", "京都"], lang_code="ja"))
        assert compute_counter["n"] == seeded + 1
        assert len(resp.results) == 3
        assert resp.results[0].html != ""
        assert resp.results[1].spans == [] and resp.results[1].html == ""
        assert resp.results[2].html != ""

    def test_reading_none_survives_json_roundtrip(self, mem_cache, annotate_handler):
        # Kana-only tokens carry reading=None; the cached spans go through a
        # JSON-shaped [[base, reading], ...] encoding and must come back as
        # None, not the string "None".
        handler, Req = annotate_handler
        first = handler(Req(texts=["これは東京です"], lang_code="ja"))
        second = handler(Req(texts=["これは東京です"], lang_code="ja"))
        readings_first = [s.reading for s in first.results[0].spans]
        readings_second = [s.reading for s in second.results[0].spans]
        assert readings_first == readings_second
        assert None in readings_second  # kana tokens unannotated

    def test_unannotatable_language_never_touches_cache(self, mem_cache, annotate_handler):
        handler, Req = annotate_handler
        resp = handler(Req(texts=["hello"], lang_code="en"))
        assert resp.results[0].spans == [] and resp.results[0].html == ""
        assert mem_cache.store == {}


# ---------------------------------------------------------------------------
# Provider wiring
# ---------------------------------------------------------------------------

class TestProvider:
    def test_default_is_null_cache_without_dsn(self, monkeypatch):
        import loom_api.deps as deps
        from loom_api.result_cache import NullResultCache
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("LOOM_RESULT_CACHE_URL", raising=False)
        set_result_cache(None)
        try:
            assert isinstance(deps.get_result_cache(), NullResultCache)
        finally:
            set_result_cache(None)

    def test_kill_switch_beats_dsn(self, monkeypatch):
        import loom_api.deps as deps
        from loom_api.result_cache import NullResultCache
        monkeypatch.setenv("DATABASE_URL", "postgres://nope")
        monkeypatch.setenv("LOOM_RESULT_CACHE", "off")
        set_result_cache(None)
        try:
            assert isinstance(deps.get_result_cache(), NullResultCache)
        finally:
            set_result_cache(None)

    def test_bad_dsn_fails_open_to_null(self, monkeypatch):
        # psycopg may or may not be installed in the dev env; either way a
        # nonsense DSN must degrade to NullResultCache, never raise.
        import loom_api.deps as deps
        from loom_api.result_cache import NullResultCache, PostgresResultCache
        monkeypatch.setenv("DATABASE_URL", "not-a-valid-dsn://")
        monkeypatch.delenv("LOOM_RESULT_CACHE", raising=False)
        set_result_cache(None)
        try:
            cache = deps.get_result_cache()
            assert isinstance(cache, (NullResultCache, PostgresResultCache))
            # Whatever came back must behave fail-open end-to-end.
            assert cache.get_many([b"\x00" * 32]) == {}
            cache.put_many(
                [
                    CacheRow(
                        key=b"\x00" * 32,
                        kind="romanize",
                        lang_code="ru",
                        phonetic_system="x",
                        mode="-",
                        engine_version=1,
                        input_text="x",
                        output={"romanized": "x"},
                    )
                ]
            )
        finally:
            set_result_cache(None)
