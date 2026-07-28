"""X-Loom-Version telemetry must actually EMIT, and must not be forgeable.

Two coupled defects, which is why they're fixed and tested together:

1. It emits nothing.  uvicorn/gunicorn configure only their own loggers, so a
   `loom.*` logger with no handler falls back to Python's lastResort handler,
   which drops anything below WARNING — and this middleware logs at INFO.
   `result_cache.py` already works around exactly this by attaching its own
   handler.  Result: zero `loom.version` lines in 9 hours of live traffic with
   two active users, so "which extension versions are live" — the documented
   reason this middleware exists — has never been answerable from prod logs.
   (It also fooled a debugging session: the absence of `loom.ratelimit`'s INFO
   startup line read as "the middleware isn't wired in".)

2. Fixing (1) ARMS a log-forgery bug.  This is the only middleware that
   interpolates the request path raw; body_limit.py and ratelimit.py both run
   it through a sanitizer first.  ASGI paths arrive percent-DECODED, so a
   request to `/x%0A2026-01-01 loom.ratelimit 429 client=1.2.3.4` writes a
   forged second line into the logs an operator reads to spot abuse.
"""

import logging

from loom_api.client_version import ClientVersionLog


class _App:
    async def __call__(self, scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _run(headers, path="/annotate"):
    import asyncio

    mw = ClientVersionLog(_App())
    scope = {"type": "http", "method": "POST", "path": path, "headers": headers}
    asyncio.run(mw(scope, None, lambda m: asyncio.sleep(0)))


def test_version_line_is_emitted_at_a_level_that_survives_no_handler(caplog):
    """The record must reach a handler in prod, where nothing configures
    `loom.version`."""
    logger = logging.getLogger("loom.version")
    assert logger.handlers or logger.level >= logging.WARNING, (
        "loom.version has no handler and logs below WARNING -> lastResort drops it"
    )


def test_version_header_is_logged(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run([(b"x-loom-version", b"0.5.1")])
    assert any("0.5.1" in r.getMessage() for r in caplog.records)


def test_newline_in_path_cannot_forge_a_log_line(caplog):
    forged = "/annotate\n2026-01-01 loom.ratelimit 429 client=1.2.3.4"
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run([(b"x-loom-version", b"0.5.1")], path=forged)
    for r in caplog.records:
        assert "\n" not in r.getMessage(), "raw newline reached the log line"
        assert "\r" not in r.getMessage()


def test_absurdly_long_path_is_truncated(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run([(b"x-loom-version", b"0.5.1")], path="/" + "a" * 9000)
    for r in caplog.records:
        assert len(r.getMessage()) < 1000, "an 8KB URL becomes an 8KB log line"


def test_request_without_the_header_logs_nothing(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run([(b"user-agent", b"curl/8")])
    assert not caplog.records
