"""Postgres-backed store behaviour, driven through a FAKE connection pool.

CI installs requirements.txt only (no psycopg / psycopg_pool — the layering
rule), so these tests never touch a real database: ``loom_api.db.get_pool`` is
swapped for a tiny in-process fake that records every statement and can be
told to fail.  What they pin:

- ``/define/capabilities`` never blocks a request on the ~3 GB DISTINCT scan
  once any answer exists (stale-while-revalidate), survives a worker recycle
  through a small persisted JSON file, bounds the scan with a statement
  timeout, and answers 503 — never an authoritative empty list — when nothing
  is available at all (H-7, M-1).
- A ``PoolTimeout`` caused by CONTENTION (every pool slot busy) degrades only
  the request that hit it; it must not trip the 30 s breaker that turns a
  moment of saturation into 30 s of found:false / full cache misses.  A
  timeout while the pool cannot even connect is still an outage and still
  trips (H-4).
- The reading-column match is Japanese-only in the SQL too (H-8).
"""
from __future__ import annotations

import contextlib
import json
import threading
import time

import pytest

import loom_api.db as db
import loom_api.result_cache as rc
from loom_api.deps import set_dictionary_store


# --------------------------------------------------------------------------- #
# Fake pool
# --------------------------------------------------------------------------- #

class FakePoolTimeout(Exception):
    """Stand-in for psycopg_pool.PoolTimeout (absent in CI)."""


class _Cursor:
    def __init__(self, conn, rows=None):
        self._conn = conn
        self._rows = rows or []

    def fetchall(self):
        return list(self._rows)

    def executemany(self, sql, seq):
        self._conn.execute(sql, list(seq))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    def __init__(self, pool):
        self._pool = pool

    def execute(self, sql, params=None):
        self._pool.statements.append(sql)
        return _Cursor(self, self._pool.handler(sql, params))

    def cursor(self):
        return _Cursor(self)

    @contextlib.contextmanager
    def transaction(self):
        self._pool.statements.append("<BEGIN>")
        yield
        self._pool.statements.append("<COMMIT>")


class FakePool:
    def __init__(self):
        self.statements: list[str] = []
        self.handler = lambda sql, params: []
        self.fail_connect: Exception | None = None
        self.checkouts = 0
        # psycopg_pool.get_stats() keys the stores read on a PoolTimeout.
        self.stats = {"pool_min": 0, "pool_max": 4, "pool_size": 4, "pool_available": 0}

    @contextlib.contextmanager
    def connection(self, timeout=None):
        if self.fail_connect is not None:
            raise self.fail_connect
        self.checkouts += 1
        yield _Conn(self)

    def get_stats(self):
        return dict(self.stats)

    def scans(self) -> int:
        return sum("SELECT DISTINCT lang, gloss_lang" in s for s in self.statements)


@pytest.fixture
def fake_pool(monkeypatch):
    pool = FakePool()
    monkeypatch.setattr(db, "get_pool", lambda dsn: pool)
    monkeypatch.setattr(rc, "pool_timeout_types", lambda: (FakePoolTimeout,), raising=False)
    return pool


PAIRS = [("es", "en"), ("es", "es"), ("ja", "de"), ("ja", "en")]


def _serve_pairs(pool, pairs=PAIRS):
    def handler(sql, params):
        if "SELECT DISTINCT lang, gloss_lang" in sql:
            return list(pairs)
        return []
    pool.handler = handler


def _dict_store(dsn="postgresql://loom:hunter2-secret@db.internal:5432/loom"):
    from loom_api.dictionary import PostgresDictionaryStore
    return PostgresDictionaryStore(dsn)


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


# --------------------------------------------------------------------------- #
# /define/capabilities: 503 instead of an authoritative empty answer (M-1)
# --------------------------------------------------------------------------- #

class TestCapabilitiesUnavailable:
    def test_route_answers_503_when_nothing_is_available(self, fake_pool):
        """The live 0.5.1 client caches ANY source_langs array for the whole
        tab session, so a 200 [] during a DB blip left every word
        un-clickable until reload.  A 503 makes it fall back to {ja, zh}."""
        from fastapi import HTTPException
        from loom_api.routes.define import define_capabilities

        def broken(sql, params):
            if "SELECT DISTINCT" in sql:
                raise RuntimeError("server closed the connection unexpectedly")
            return []
        fake_pool.handler = broken
        set_dictionary_store(_dict_store())
        try:
            with pytest.raises(HTTPException) as ei:
                define_capabilities()
            assert ei.value.status_code == 503
        finally:
            set_dictionary_store(None)

    def test_store_reports_unavailable_as_none(self, fake_pool):
        fake_pool.fail_connect = RuntimeError("connection refused")
        assert _dict_store().capabilities() is None

    def test_route_serves_computed_answer(self, fake_pool):
        from loom_api.routes.define import define_capabilities

        _serve_pairs(fake_pool)
        set_dictionary_store(_dict_store())
        try:
            resp = define_capabilities()
        finally:
            set_dictionary_store(None)
        assert resp.source_langs == ["es", "ja"]
        assert resp.gloss_langs_by_source == {"es": ["en", "es"], "ja": ["de", "en"]}

    def test_failed_first_scan_is_shared_not_rerun_per_caller(self, fake_pool):
        """A scan killed by our own statement_timeout does NOT trip the
        breaker, so nothing used to stop each caller queued behind it from
        re-running the (up to 180 s) scan in turn.  Now every queued caller —
        and the route for the pause after — shares the one failure: a 503, no
        second scan."""
        from fastapi import HTTPException
        from loom_api.routes.define import define_capabilities

        class QueryCanceled(Exception):
            sqlstate = "57014"

        def slow_timeout(sql, params):
            if "SELECT DISTINCT" in sql:
                time.sleep(0.2)
                raise QueryCanceled("canceling statement due to statement timeout")
            return []
        fake_pool.handler = slow_timeout
        store = _dict_store()
        results = []
        threads = [threading.Thread(target=lambda: results.append(store.capabilities()))
                   for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        assert results == [None] * 5
        assert fake_pool.scans() == 1
        set_dictionary_store(store)
        try:
            with pytest.raises(HTTPException) as ei:
                define_capabilities()
            assert ei.value.status_code == 503
        finally:
            set_dictionary_store(None)
        assert fake_pool.scans() == 1

    def test_null_store_still_answers_200_empty(self):
        """No dictionary configured is a legitimate answer, not an outage."""
        from loom_api.dictionary import NullDictionaryStore
        from loom_api.routes.define import define_capabilities

        set_dictionary_store(NullDictionaryStore())
        try:
            resp = define_capabilities()
        finally:
            set_dictionary_store(None)
        assert resp.source_langs == [] and resp.gloss_langs == ["en"]


# --------------------------------------------------------------------------- #
# /define/capabilities never waits on the scan once an answer exists (H-7)
# --------------------------------------------------------------------------- #

class TestCapabilitiesNeverBlocks:
    def test_stale_value_served_while_background_refresh_scans(self, fake_pool, monkeypatch):
        import loom_api.dictionary as dmod

        monkeypatch.setattr(dmod, "CAPABILITIES_TTL_SECONDS", 0.0)  # always stale
        _serve_pairs(fake_pool)
        store = _dict_store()
        first = store.capabilities()                 # nothing cached: computes
        assert first is not None and fake_pool.scans() == 1

        release, started = threading.Event(), threading.Event()

        def slow(sql, params):
            if "SELECT DISTINCT" in sql:
                started.set()
                release.wait(10)                     # a 40 s cold scan, in miniature
                return [("fr", "en")]
            return []
        fake_pool.handler = slow
        t0 = time.monotonic()
        assert store.capabilities() == first         # stale, instantly
        assert started.wait(5), "a background refresh should be scanning"
        assert store.capabilities() == first         # still instant mid-scan
        assert time.monotonic() - t0 < 1.0
        release.set()
        assert _wait_for(lambda: store.capabilities().source_langs == ("fr",))

    def test_failed_refresh_keeps_serving_the_last_good_answer(self, fake_pool, monkeypatch):
        import loom_api.dictionary as dmod

        monkeypatch.setattr(dmod, "CAPABILITIES_TTL_SECONDS", 0.0)
        _serve_pairs(fake_pool)
        store = _dict_store()
        good = store.capabilities()

        def broken(sql, params):
            raise RuntimeError("canceling statement due to statement timeout")
        fake_pool.handler = broken
        for _ in range(5):
            assert store.capabilities() == good
        time.sleep(0.1)
        assert store.capabilities() == good

    def test_scan_is_bounded_by_a_transaction_local_statement_timeout(self, fake_pool):
        """A stuck refresh must not pin one of the pool's FOUR connections
        forever — and the timeout must be SET LOCAL so it cannot leak onto the
        pooled connection's next borrower."""
        _serve_pairs(fake_pool)
        _dict_store().capabilities()
        s = fake_pool.statements
        scan = next(i for i, x in enumerate(s) if "SELECT DISTINCT" in x)
        timeout = next(i for i, x in enumerate(s) if "statement_timeout" in x)
        begin = max(i for i, x in enumerate(s[:timeout]) if x == "<BEGIN>")
        commit = next(i for i, x in enumerate(s) if x == "<COMMIT>" and i > scan)
        assert begin < timeout < scan < commit
        assert "SET LOCAL" in s[timeout]


class TestCapabilitiesWarmup:
    def test_warm_never_raises(self):
        from loom_api.dictionary import _warm_capabilities

        class Boom:
            def capabilities(self):
                raise RuntimeError("db down at boot")
        _warm_capabilities(Boom())  # must not raise

    def test_not_started_under_pytest(self):
        from loom_api.dictionary import start_capabilities_warmup

        class Never:
            def capabilities(self):
                raise AssertionError("must not run under pytest")
        assert start_capabilities_warmup(Never()) is False

    def test_started_outside_pytest_computes_once(self, monkeypatch):
        from loom_api.dictionary import start_capabilities_warmup

        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        called = threading.Event()

        class Store:
            def capabilities(self):
                called.set()
        assert start_capabilities_warmup(Store()) is True
        assert called.wait(5)


# --------------------------------------------------------------------------- #
# Persistence across worker recycles (H-7)
# --------------------------------------------------------------------------- #

class TestCapabilitiesPersistence:
    DSN = "postgresql://loom:hunter2-secret@db.internal:5432/loom"

    @pytest.fixture
    def cache_file(self, tmp_path, monkeypatch):
        path = tmp_path / "caps.json"
        monkeypatch.setenv("LOOM_CAPABILITIES_CACHE_FILE", str(path))
        return path

    def test_recycled_worker_serves_persisted_answer_without_scanning(
            self, fake_pool, cache_file):
        _serve_pairs(fake_pool)
        first = _dict_store(self.DSN).capabilities()
        assert fake_pool.scans() == 1 and cache_file.exists()
        # A fresh worker (new store, same container /tmp) — no scan at all.
        def no_scan(sql, params):
            if "SELECT DISTINCT" in sql:
                pytest.fail("a recycled worker must not re-run the scan")
            return []
        fake_pool.handler = no_scan
        again = _dict_store(self.DSN).capabilities()
        assert again == first
        assert fake_pool.scans() == 1

    def test_file_never_contains_the_dsn(self, fake_pool, cache_file):
        _serve_pairs(fake_pool)
        _dict_store(self.DSN).capabilities()
        text = cache_file.read_text()
        assert "hunter2" not in text and "db.internal" not in text
        payload = json.loads(text)
        from loom_api.dictionary import CAPABILITIES_VERSION
        assert payload["capabilities_version"] == CAPABILITIES_VERSION
        assert payload["dsn_fingerprint"]

    def test_write_is_atomic_no_temp_files_left(self, fake_pool, cache_file):
        _serve_pairs(fake_pool)
        _dict_store(self.DSN).capabilities()
        assert [p.name for p in cache_file.parent.iterdir()] == [cache_file.name]

    def test_other_dsn_ignores_the_file(self, fake_pool, cache_file):
        _serve_pairs(fake_pool)
        _dict_store(self.DSN).capabilities()
        _serve_pairs(fake_pool, [("de", "en")])
        caps = _dict_store("postgresql://other@elsewhere/dict").capabilities()
        assert caps.source_langs == ("de",)
        assert fake_pool.scans() == 2

    def test_capabilities_version_mismatch_ignores_the_file(
            self, fake_pool, cache_file, monkeypatch):
        import loom_api.dictionary as dmod

        _serve_pairs(fake_pool)
        _dict_store(self.DSN).capabilities()
        monkeypatch.setattr(dmod, "CAPABILITIES_VERSION", dmod.CAPABILITIES_VERSION + 1)
        _serve_pairs(fake_pool, [("de", "en")])
        assert _dict_store(self.DSN).capabilities().source_langs == ("de",)

    def test_old_file_is_served_stale_and_refreshed_in_background(
            self, fake_pool, cache_file):
        _serve_pairs(fake_pool)
        first = _dict_store(self.DSN).capabilities()
        payload = json.loads(cache_file.read_text())
        payload["computed_at"] -= 10 * 86400          # ten days old
        cache_file.write_text(json.dumps(payload))
        _serve_pairs(fake_pool, [("de", "en")])
        store = _dict_store(self.DSN)
        assert store.capabilities() == first          # served at once, stale
        assert _wait_for(lambda: store.capabilities().source_langs == ("de",))
        # ...and the refreshed answer is re-persisted for the next worker.
        assert _wait_for(
            lambda: json.loads(cache_file.read_text())["source_langs"] == ["de"])

    def test_corrupt_file_is_ignored(self, fake_pool, cache_file):
        cache_file.write_text("{not json")
        _serve_pairs(fake_pool)
        assert _dict_store(self.DSN).capabilities().source_langs == ("es", "ja")

    def test_off_disables_persistence(self, fake_pool, tmp_path, monkeypatch):
        monkeypatch.setenv("LOOM_CAPABILITIES_CACHE_FILE", "off")
        monkeypatch.chdir(tmp_path)
        _serve_pairs(fake_pool)
        _dict_store(self.DSN).capabilities()
        _dict_store(self.DSN).capabilities()
        assert fake_pool.scans() == 2                 # nothing carried over
        assert list(tmp_path.iterdir()) == []

    def test_default_path_is_in_the_temp_dir(self, monkeypatch):
        import os
        import tempfile
        from loom_api.dictionary import capabilities_cache_path

        monkeypatch.delenv("LOOM_CAPABILITIES_CACHE_FILE", raising=False)
        assert capabilities_cache_path() == os.path.join(
            tempfile.gettempdir(), "loom-capabilities.json")
        for off in ("off", "0", "OFF"):
            monkeypatch.setenv("LOOM_CAPABILITIES_CACHE_FILE", off)
            assert capabilities_cache_path() is None


# --------------------------------------------------------------------------- #
# PoolTimeout: contention degrades one request, it does not trip (H-4)
# --------------------------------------------------------------------------- #

def _ja_row_handler(sql, params):
    if "FROM dictionary_entry" in sql and "headword" in sql:
        return [("猫", "ねこ", [{"gloss": ["cat"]}], True, "jmdict", "en")]
    return []


class TestDictionaryPoolContention:
    def test_contended_lookup_degrades_only_that_request(self, fake_pool):
        store = _dict_store()
        fake_pool.handler = _ja_row_handler
        fake_pool.stats.update(pool_size=4, pool_max=4)       # every slot busy
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection after 2.50 sec")
        assert store.lookup("ja", ["猫"]) == {}
        fake_pool.fail_connect = None                         # a peer released one
        assert "猫" in store.lookup("ja", ["猫"]), "contention must not trip the breaker"

    def test_timeout_while_pool_cannot_connect_still_trips(self, fake_pool):
        """psycopg_pool raises the SAME PoolTimeout when the database is down
        (measured: pool_size stays at 1 — the one retrying connect attempt).
        That is an outage, and the breaker exists to stop every request
        paying a 2.5 s wait for it."""
        store = _dict_store()
        fake_pool.handler = _ja_row_handler
        fake_pool.stats.update(pool_size=1, pool_max=4)
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection after 2.50 sec")
        assert store.lookup("ja", ["猫"]) == {}
        fake_pool.fail_connect = None
        before = fake_pool.checkouts
        assert store.lookup("ja", ["猫"]) == {}               # backing off
        assert fake_pool.checkouts == before

    def test_operational_error_still_trips(self, fake_pool):
        store = _dict_store()

        def broken(sql, params):
            raise RuntimeError("terminating connection due to administrator command")
        fake_pool.handler = broken
        assert store.lookup("ja", ["猫"]) == {}
        fake_pool.handler = _ja_row_handler
        assert store.lookup("ja", ["猫"]) == {}               # still backing off

    def test_scan_statement_timeout_does_not_trip(self, fake_pool):
        """Our own statement_timeout firing means the scan was slow, not that
        the DB is down — it must not blank every definition for 30 s."""
        class QueryCanceled(Exception):
            sqlstate = "57014"   # what psycopg.errors.QueryCanceled carries

        def slow(sql, params):
            if "SELECT DISTINCT" in sql:
                raise QueryCanceled("canceling statement due to statement timeout")
            return _ja_row_handler(sql, params)
        fake_pool.handler = slow
        store = _dict_store()
        assert store.capabilities() is None
        assert "猫" in store.lookup("ja", ["猫"])

    def test_contended_capabilities_compute_does_not_trip(self, fake_pool):
        store = _dict_store()
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection")
        assert store.capabilities() is None
        fake_pool.fail_connect = None
        fake_pool.handler = _ja_row_handler
        assert "猫" in store.lookup("ja", ["猫"])


class TestResultCachePoolContention:
    def _cache(self):
        return rc.PostgresResultCache("postgresql://cache")

    def _row(self):
        return rc.CacheRow(key=b"k" * 32, kind="romanize", lang_code="ja",
                           phonetic_system="Hepburn", mode="-", engine_version=1,
                           input_text="猫", output={"romanized": "neko"})

    def test_contended_get_many_does_not_trip(self, fake_pool):
        cache = self._cache()
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection")
        assert cache.get_many([b"k" * 32]) == {}
        fake_pool.fail_connect = None
        fake_pool.handler = lambda sql, params: [(b"k" * 32, {"romanized": "neko"})]
        assert cache.get_many([b"k" * 32]) == {b"k" * 32: {"romanized": "neko"}}

    def test_contended_put_many_does_not_trip(self, fake_pool):
        cache = self._cache()
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection")
        cache.put_many([self._row()])
        fake_pool.fail_connect = None
        fake_pool.handler = lambda sql, params: [(b"k" * 32, {"romanized": "neko"})]
        assert cache.get_many([b"k" * 32]), "contention must not trip the breaker"

    def test_timeout_while_pool_cannot_connect_still_trips(self, fake_pool):
        cache = self._cache()
        fake_pool.stats.update(pool_size=1)
        fake_pool.fail_connect = FakePoolTimeout("couldn't get a connection")
        assert cache.get_many([b"k" * 32]) == {}
        fake_pool.fail_connect = None
        before = fake_pool.checkouts
        assert cache.get_many([b"k" * 32]) == {}
        assert fake_pool.checkouts == before

    def test_operational_error_still_trips(self, fake_pool):
        cache = self._cache()

        def broken(sql, params):
            raise RuntimeError("server closed the connection unexpectedly")
        fake_pool.handler = broken
        assert cache.get_many([b"k" * 32]) == {}
        before = fake_pool.checkouts
        assert cache.get_many([b"k" * 32]) == {}
        assert fake_pool.checkouts == before


class TestRealPsycopgPool:
    """The two facts the contention logic rests on, checked against the real
    library where it is installed (skipped in CI)."""

    def test_pool_timeout_type_is_psycopg_pools(self):
        psycopg_pool = pytest.importorskip("psycopg_pool")
        assert psycopg_pool.PoolTimeout in rc.pool_timeout_types()

    def test_down_database_times_out_unsaturated(self):
        import logging
        psycopg_pool = pytest.importorskip("psycopg_pool")
        logging.getLogger("psycopg.pool").setLevel(logging.CRITICAL)
        pool = psycopg_pool.ConnectionPool(
            "postgresql://loom@127.0.0.1:1/none?connect_timeout=1",
            min_size=0, max_size=4, open=True, name="loom-test-down")
        try:
            with pytest.raises(psycopg_pool.PoolTimeout):
                with pool.connection(timeout=0.5):
                    pass
            assert rc.pool_is_saturated(pool) is False
        finally:
            pool.close(timeout=1)


# --------------------------------------------------------------------------- #
# Reading-column match is Japanese-only in SQL too (H-8)
# --------------------------------------------------------------------------- #

class TestReadingMatchSql:
    def _lookup_sql(self, pool):
        return [s for s in pool.statements if "FROM dictionary_entry" in s and "headword" in s]

    def test_non_japanese_query_does_not_match_reading(self, fake_pool):
        store = _dict_store()
        store.lookup("ko", ["나무"])
        (sql,) = self._lookup_sql(fake_pool)
        assert "reading = ANY" not in sql

    def test_japanese_query_still_matches_reading(self, fake_pool):
        store = _dict_store()
        store.lookup("ja", ["たべる"])
        (sql,) = self._lookup_sql(fake_pool)
        assert "reading = ANY" in sql

    def test_non_japanese_rows_are_not_bucketed_by_reading(self, fake_pool):
        store = _dict_store()
        fake_pool.handler = lambda sql, params: [
            ("나무", "나무", [{"gloss": ["tree"]}], True, "krdict", "en"),
            ("남우", "나무", [{"gloss": ["actor"]}], False, "krdict", "en"),
        ]
        d = store.lookup("ko", ["나무"])["나무"]
        assert [s.gloss for s in d.senses] == [("tree",)]

    def test_japanese_rows_still_bucketed_by_reading(self, fake_pool):
        store = _dict_store()
        fake_pool.handler = lambda sql, params: [
            ("食べる", "たべる", [{"gloss": ["to eat"]}], True, "jmdict", "en")]
        assert store.lookup("ja", ["たべる"])["たべる"].senses[0].gloss == ("to eat",)
