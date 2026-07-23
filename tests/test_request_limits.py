"""Request-cost limits (2026-07 hardening): the BodySizeLimit middleware
(loom_api/body_limit.py), the env-int parser (loom_api/limits.py), and the
batch total-chars caps wired into the /romanize/batch + /annotate/batch
request models.

Imports loom_api.body_limit / loom_api.limits / the route MODULES — NOT
loom_api.web (slowapi is absent from the CI requirements; same layering
rule as test_client_version.py / test_cors_origins.py).
"""

import asyncio
import json
import logging

import pytest
from pydantic import ValidationError

from loom_api import limits
from loom_api.body_limit import BodySizeLimit


# ---------------------------------------------------------------------------
# Harness (pure-ASGI, like test_client_version.py)
# ---------------------------------------------------------------------------

class _App:
    """Records whether the inner app was reached."""

    def __init__(self):
        self.called = False

    async def __call__(self, scope, receive, send):
        self.called = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _run(mw, scope):
    sent = []

    async def send(msg):
        sent.append(msg)

    asyncio.run(mw(scope, None, send))
    return sent


def _scope(method="POST", headers=None, path="/annotate/batch"):
    return {"type": "http", "method": method, "path": path, "headers": headers or []}


def _cl(n):
    return [(b"content-length", str(n).encode())]


def _status(sent):
    return sent[0]["status"]


def _detail(sent):
    return json.loads(sent[1]["body"])["detail"]


# ---------------------------------------------------------------------------
# BodySizeLimit middleware
# ---------------------------------------------------------------------------

def test_under_cap_passes_through():
    app = _App()
    sent = _run(BodySizeLimit(app, max_bytes=100), _scope(headers=_cl(99)))
    assert app.called and _status(sent) == 200


def test_exactly_at_cap_passes():
    app = _App()
    sent = _run(BodySizeLimit(app, max_bytes=100), _scope(headers=_cl(100)))
    assert app.called and _status(sent) == 200


def test_over_cap_rejected_413():
    app = _App()
    sent = _run(BodySizeLimit(app, max_bytes=100), _scope(headers=_cl(101)))
    assert not app.called
    assert _status(sent) == 413
    assert "101 bytes" in _detail(sent) and "100-byte" in _detail(sent)


def test_over_cap_logs_warning(caplog):
    app = _App()
    with caplog.at_level(logging.WARNING, logger="loom.bodylimit"):
        _run(BodySizeLimit(app, max_bytes=100),
             _scope(headers=_cl(500), path="/romanize/batch"))
    assert len(caplog.records) == 1
    assert "/romanize/batch" in caplog.records[0].getMessage()


def test_missing_content_length_on_post_rejected_411():
    app = _App()
    sent = _run(BodySizeLimit(app, max_bytes=100), _scope(headers=[]))
    assert not app.called
    assert _status(sent) == 411
    assert "Content-Length" in _detail(sent)


def test_invalid_content_length_rejected_400():
    app = _App()
    sent = _run(BodySizeLimit(app, max_bytes=100),
                _scope(headers=[(b"content-length", b"banana")]))
    assert not app.called and _status(sent) == 400


def test_non_rfc_content_length_forms_rejected_400():
    # Strict [0-9]+ only: int() would happily take '+123' and '1_0', and a
    # negative would slip past the > comparison.  Unreachable behind uvicorn
    # (h11/httptools pre-validate) — pinned so the middleware never silently
    # depends on that.
    for bad in (b"+123", b"-5", b"1_0", b"0x10"):
        app = _App()
        sent = _run(BodySizeLimit(app, max_bytes=100),
                    _scope(headers=[(b"content-length", bad)]))
        assert not app.called and _status(sent) == 400, bad


def test_duplicate_content_length_first_wins():
    # Pin the first-match semantics the docstring's "uvicorn enforces
    # body==declared" claim leans on (uvicorn rejects conflicting duplicates
    # before the scope exists; this documents OUR half of the assumption).
    app = _App()
    _run(BodySizeLimit(app, max_bytes=100),
         _scope(headers=[(b"content-length", b"5"), (b"content-length", b"999")]))
    assert app.called


def test_rejection_log_sanitizes_path(caplog):
    # ASGI paths arrive percent-DECODED — /x%0Ay carries a real newline; it
    # must not be able to forge lines in the watched loom.* logs.
    import logging
    app = _App()
    with caplog.at_level(logging.WARNING, logger="loom.bodylimit"):
        _run(BodySizeLimit(app, max_bytes=10),
             _scope(headers=_cl(11), path="/x\nFORGED WARNING line"))
    msg = caplog.records[0].getMessage()
    assert "\n" not in msg and "\\x0a" in msg


def test_get_without_content_length_passes():
    app = _App()
    _run(BodySizeLimit(app, max_bytes=100), _scope(method="GET"))
    assert app.called


def test_options_passes_untouched():
    # Real preflights are short-circuited by CORSMiddleware before reaching
    # this (it sits innermost), but it must be transparent to them anyway.
    app = _App()
    _run(BodySizeLimit(app, max_bytes=100), _scope(method="OPTIONS"))
    assert app.called


def test_disabled_cap_passes_everything():
    app = _App()
    _run(BodySizeLimit(app, max_bytes=0), _scope(headers=_cl(10**9)))
    assert app.called


def test_non_http_scope_passes_through():
    app = _App()
    _run(BodySizeLimit(app, max_bytes=1), {"type": "lifespan"})
    assert app.called


def test_default_cap_reads_limits_module(monkeypatch):
    # No max_bytes override → the middleware follows loom_api.limits at
    # request time (env changes only need a worker restart, tests can patch).
    monkeypatch.setattr(limits, "MAX_BODY_BYTES", 50)
    app = _App()
    sent = _run(BodySizeLimit(app), _scope(headers=_cl(51)))
    assert not app.called and _status(sent) == 413


def test_rejection_response_is_wellformed_json():
    sent = _run(BodySizeLimit(_App(), max_bytes=10), _scope(headers=_cl(11)))
    start, body = sent
    headers = dict(start["headers"])
    assert headers[b"content-type"] == b"application/json"
    assert int(headers[b"content-length"]) == len(body["body"])


# ---------------------------------------------------------------------------
# limits._env_int
# ---------------------------------------------------------------------------

def test_env_int_default_when_absent(monkeypatch):
    monkeypatch.delenv("LOOM_TEST_LIMIT", raising=False)
    assert limits._env_int("LOOM_TEST_LIMIT", 7) == 7


def test_env_int_parses_value(monkeypatch):
    monkeypatch.setenv("LOOM_TEST_LIMIT", "123")
    assert limits._env_int("LOOM_TEST_LIMIT", 7) == 123


def test_env_int_off_disables(monkeypatch):
    for word in ("off", "OFF", "none", "disabled", "0"):
        monkeypatch.setenv("LOOM_TEST_LIMIT", word)
        assert limits._env_int("LOOM_TEST_LIMIT", 7) == 0


def test_env_int_junk_falls_back_to_default(monkeypatch):
    # Never crash worker boot on a typo'd env var.
    monkeypatch.setenv("LOOM_TEST_LIMIT", "10MB")
    assert limits._env_int("LOOM_TEST_LIMIT", 7) == 7


def test_env_int_negative_clamps_to_zero(monkeypatch):
    monkeypatch.setenv("LOOM_TEST_LIMIT", "-5")
    assert limits._env_int("LOOM_TEST_LIMIT", 7) == 0


# ---------------------------------------------------------------------------
# Batch total-chars cap (RomanizeBatchRequest / AnnotateBatchRequest)
# ---------------------------------------------------------------------------
# The models live in the route modules; importing them pulls loom_core but
# not slowapi, so this stays CI-safe.

def _romanize_req():
    from loom_api.routes.romanize import RomanizeBatchRequest
    return RomanizeBatchRequest


def _annotate_req():
    from loom_api.routes.annotate import AnnotateBatchRequest
    return AnnotateBatchRequest


def test_romanize_batch_over_total_cap_is_422(monkeypatch):
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 10)
    with pytest.raises(ValidationError) as ei:
        _romanize_req()(texts=["abcdef", "ghijk"], lang_code="ja")  # 11 chars
    assert "exceeds" in str(ei.value)


def test_romanize_batch_exactly_at_cap_ok(monkeypatch):
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 11)
    req = _romanize_req()(texts=["abcdef", "ghijk"], lang_code="ja")
    assert req.texts == ["abcdef", "ghijk"]


def test_annotate_batch_over_total_cap_is_422(monkeypatch):
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 10)
    with pytest.raises(ValidationError) as ei:
        _annotate_req()(texts=["abcdefghijk"], lang_code="ja")
    assert "exceeds" in str(ei.value)


def test_annotate_batch_under_cap_ok(monkeypatch):
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 100)
    req = _annotate_req()(texts=["こんにちは", "ありがとう"], lang_code="ja")
    assert len(req.texts) == 2


def test_total_cap_disabled_allows_anything(monkeypatch):
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 0)
    req = _romanize_req()(texts=["x" * 9000, "y" * 9000], lang_code="ja")
    assert len(req.texts) == 2


def test_per_item_oversize_alone_does_not_reject(monkeypatch):
    # Per-item >5000 stays FAIL-SOFT (the route zeroes it via _computable);
    # only the batch SUM hard-rejects.  A single 6000-char item under a big
    # sum cap must therefore validate fine.
    monkeypatch.setattr(limits, "BATCH_MAX_TOTAL_CHARS", 100_000)
    req = _annotate_req()(texts=["z" * 6000], lang_code="ja")
    assert len(req.texts[0]) == 6000


# ---------------------------------------------------------------------------
# limits.log_safe — control chars must not forge lines in watched logs
# ---------------------------------------------------------------------------

def test_log_safe_escapes_control_chars():
    assert limits.log_safe("a\nb\rc") == "a\\x0ab\\x0dc"
    assert limits.log_safe("del\x7f") == "del\\x7f"


def test_log_safe_passes_plain_text_and_truncates():
    assert limits.log_safe("netflix") == "netflix"
    assert limits.log_safe("x" * 500) == "x" * 256


# ---------------------------------------------------------------------------
# Export-enrich chunking must stay under the server caps (the enrich loop
# treats any request failure as "server unreachable" and breaks out of the
# language — a 422/413 from its own chunk sizing must be impossible)
# ---------------------------------------------------------------------------

def test_chunked_by_budget_respects_both_limits():
    from loom_api.corpus_export import chunked_by_budget
    # count limit
    assert [len(c) for c in chunked_by_budget(["a"] * 5, 2, 100)] == [2, 2, 1]
    # char budget
    assert chunked_by_budget(["aaaa", "bbbb", "cc"], 10, 8) == [["aaaa", "bbbb"], ["cc"]]
    # a single over-budget item gets its own chunk (callers pre-filter)
    assert chunked_by_budget(["x" * 20, "y"], 10, 8) == [["x" * 20], ["y"]]
    # order preserved, empty in → empty out
    assert chunked_by_budget([], 10, 10) == []
    assert [t for c in chunked_by_budget(list("abcdef"), 2, 100) for t in c] == list("abcdef")


def test_enrich_chunks_stay_under_server_caps():
    from loom_api.corpus_export import (
        ENRICH_CHUNK_MAX_CHARS,
        ENRICH_CHUNK_MAX_ITEMS,
        ENRICH_MAX_TEXT_CHARS,
        chunked_by_budget,
    )
    # 300 legal corpus lines at the per-item max — the shape that used to
    # produce a 10M-char count-only chunk.
    texts = ["x" * ENRICH_MAX_TEXT_CHARS] * 300
    for c in chunked_by_budget(texts, ENRICH_CHUNK_MAX_ITEMS, ENRICH_CHUNK_MAX_CHARS):
        assert sum(len(t) for t in c) <= ENRICH_CHUNK_MAX_CHARS
        assert len(c) <= ENRICH_CHUNK_MAX_ITEMS
    # And the budget itself sits well under the server's batch cap (4x).
    assert ENRICH_CHUNK_MAX_CHARS * 4 <= limits.BATCH_MAX_TOTAL_CHARS or \
        limits.BATCH_MAX_TOTAL_CHARS == 0


# ---------------------------------------------------------------------------
# Integration: the guard must be WIRED on the real web app, inside CORS.
# Needs slowapi (requirements-web.txt) — skips cleanly where it's absent
# (CI installs requirements.txt only; the local full-suite env has it).
# ---------------------------------------------------------------------------

def test_body_limit_wired_on_real_app_and_cors_decorates_rejection(monkeypatch):
    pytest.importorskip("slowapi")
    monkeypatch.setattr(limits, "MAX_BODY_BYTES", 100)
    import loom_api.web as web

    sent = []

    async def send(msg):
        sent.append(msg)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/annotate/batch",
        "raw_path": b"/annotate/batch",
        "root_path": "",
        "query_string": b"",
        "client": ("203.0.113.9", 1234),
        "server": ("testserver", 80),
        "headers": [
            (b"host", b"testserver"),
            (b"content-length", b"101"),
            (b"content-type", b"application/json"),
            (b"origin", b"https://loom.nerv-analytic.ai"),
        ],
    }
    asyncio.run(web.app(scope, receive, send))
    start = sent[0]
    # The 413 proves BodySizeLimit is registered on the real app; the CORS
    # header on the REJECTION proves the innermost placement (rejections
    # flow back out through CORSMiddleware) — the load-bearing claim the
    # web.py comment makes, pinned executable.
    assert start["status"] == 413
    headers = {k.decode(): v.decode() for k, v in start["headers"]}
    assert headers.get("access-control-allow-origin") == "https://loom.nerv-analytic.ai"
    assert json.loads(sent[1]["body"])["detail"].startswith("Request body too large")
