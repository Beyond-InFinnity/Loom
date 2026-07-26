"""GET /debug/echo — owner-gated raw-header echo (loom_api/routes/debug.py)
plus the shared bypass-key helpers it split out of web.py (loom_api/auth.py).

The endpoint exists to diagnose Railway's edge proxy behavior from outside
(X-Forwarded-For chain shape, hop count, header stripping) — see the
2026-07-26 CDN77 finding.  It must be invisible (404) without a valid
X-Loom-Auth key, and must preserve header ORDER and DUPLICATES exactly as
received (a dict would silently merge repeated X-Forwarded-For lines, which
is precisely the evidence we need).

Imports the route MODULE + loom_api.auth — NOT loom_api.web (slowapi is
absent from the CI requirements; same layering rule as
test_request_limits.py).  The web-app mount is asserted in a
slowapi-gated test at the bottom.
"""

import pytest
from fastapi import HTTPException, Request

from loom_api.auth import bypass_keys_from_env, is_bypass_key
from loom_api.routes.debug import echo


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

def _request(headers, client=("203.0.113.9", 51234), scheme="https"):
    """Build a real fastapi.Request from a minimal ASGI scope."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/debug/echo",
        "headers": headers,
        "client": client,
        "scheme": scheme,
        "http_version": "1.1",
        "query_string": b"",
    }
    return Request(scope)


# ---------------------------------------------------------------------------
# loom_api.auth — pure key-check helpers
# ---------------------------------------------------------------------------

def test_is_bypass_key_matches_a_listed_key():
    assert is_bypass_key("secret-b", ["secret-a", "secret-b"]) is True


def test_is_bypass_key_rejects_unlisted_key():
    assert is_bypass_key("nope", ["secret-a", "secret-b"]) is False


def test_is_bypass_key_false_on_empty_presented():
    assert is_bypass_key("", ["secret-a"]) is False
    assert is_bypass_key(None, ["secret-a"]) is False


def test_is_bypass_key_false_when_no_keys_configured():
    assert is_bypass_key("anything", []) is False


def test_bypass_keys_from_env_parses_comma_list(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", " k1 , k2 ,, k3 ")
    assert bypass_keys_from_env() == ["k1", "k2", "k3"]


def test_bypass_keys_from_env_empty_when_unset(monkeypatch):
    monkeypatch.delenv("LOOM_BYPASS_KEYS", raising=False)
    assert bypass_keys_from_env() == []


# ---------------------------------------------------------------------------
# GET /debug/echo — auth gate
# ---------------------------------------------------------------------------

def test_no_key_is_404(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    with pytest.raises(HTTPException) as exc:
        echo(_request([]))
    assert exc.value.status_code == 404


def test_wrong_key_is_404(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    with pytest.raises(HTTPException) as exc:
        echo(_request([(b"x-loom-auth", b"wrong")]))
    assert exc.value.status_code == 404


def test_unconfigured_keys_is_404_even_with_header(monkeypatch):
    monkeypatch.delenv("LOOM_BYPASS_KEYS", raising=False)
    with pytest.raises(HTTPException) as exc:
        echo(_request([(b"x-loom-auth", b"k1")]))
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# GET /debug/echo — payload
# ---------------------------------------------------------------------------

def test_valid_key_echoes_received_headers_in_order(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    body = echo(
        _request(
            [
                (b"x-forwarded-for", b"1.2.3.4, 5.6.7.8"),
                (b"x-real-ip", b"5.6.7.8"),
                (b"x-loom-auth", b"k1"),
            ]
        )
    )
    assert body["headers"][0] == ["x-forwarded-for", "1.2.3.4, 5.6.7.8"]
    assert body["headers"][1] == ["x-real-ip", "5.6.7.8"]


def test_duplicate_header_lines_are_preserved(monkeypatch):
    # Two separate X-Forwarded-For lines must BOTH survive — merging them is
    # exactly the information loss this endpoint exists to avoid.
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    body = echo(
        _request(
            [
                (b"x-forwarded-for", b"1.2.3.4"),
                (b"x-forwarded-for", b"9.9.9.9"),
                (b"x-loom-auth", b"k1"),
            ]
        )
    )
    xff = [h for h in body["headers"] if h[0] == "x-forwarded-for"]
    assert xff == [["x-forwarded-for", "1.2.3.4"], ["x-forwarded-for", "9.9.9.9"]]


def test_auth_header_value_is_redacted(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    body = echo(_request([(b"x-loom-auth", b"k1")]))
    auth = [h for h in body["headers"] if h[0] == "x-loom-auth"]
    assert auth == [["x-loom-auth", "***"]]


def test_client_and_scheme_reported(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    body = echo(_request([(b"x-loom-auth", b"k1")], client=("100.64.0.5", 4321)))
    assert body["client"] == "100.64.0.5:4321"
    assert body["scheme"] == "https"
    assert body["http_version"] == "1.1"


def test_missing_client_reported_as_none(monkeypatch):
    monkeypatch.setenv("LOOM_BYPASS_KEYS", "k1")
    body = echo(_request([(b"x-loom-auth", b"k1")], client=None))
    assert body["client"] is None


# ---------------------------------------------------------------------------
# Web-app integration (needs slowapi, like tests/test_request_limits.py)
# ---------------------------------------------------------------------------

def test_web_app_mounts_debug_echo():
    pytest.importorskip("slowapi")
    from loom_api import web

    assert "/debug/echo" in {getattr(r, "path", None) for r in web.app.routes}
