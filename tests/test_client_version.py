"""X-Loom-Version telemetry middleware (loom_api/client_version.py).

Imports only loom_api.client_version (stdlib) — NOT loom_api.web, which
pulls slowapi (requirements-web.txt, absent from the CI requirements).
Same layering rule as test_cors_origins.py.
"""
import asyncio
import logging

from loom_api.client_version import ClientVersionLog


async def _noop_app(scope, receive, send):
    return None


def _run(scope) -> None:
    asyncio.run(ClientVersionLog(_noop_app)(scope, None, None))


def _http_scope(headers, path="/romanize/batch"):
    return {"type": "http", "path": path, "headers": headers}


def test_logs_version_and_path(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run(_http_scope([(b"x-loom-version", b"0.4.0")]))
    assert len(caplog.records) == 1
    msg = caplog.records[0].getMessage()
    assert "version=0.4.0" in msg
    assert "path=/romanize/batch" in msg


def test_no_header_logs_nothing(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run(_http_scope([(b"x-loom-auth", b"some-key")]))
    assert caplog.records == []


def test_non_http_scope_passes_through(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run({"type": "lifespan"})
    assert caplog.records == []


def test_oversized_header_is_truncated(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run(_http_scope([(b"x-loom-version", b"9" * 500)]))
    msg = caplog.records[0].getMessage()
    assert "9" * 32 in msg
    assert "9" * 33 not in msg


def test_whitespace_stripped(caplog):
    with caplog.at_level(logging.INFO, logger="loom.version"):
        _run(_http_scope([(b"x-loom-version", b"  0.4.0  ")]))
    assert "version=0.4.0 " in caplog.records[0].getMessage()
