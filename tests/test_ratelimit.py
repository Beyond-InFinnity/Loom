"""Per-IP request-RATE limiting (loom_api/ratelimit.py).

Replaces slowapi, which silently stopped limiting anything when FastAPI
0.140 wrapped included routers in `_IncludedRouter`: slowapi's middleware
resolves the matched route's `.endpoint` to decide whether to limit, the
wrapper doesn't expose one, so `_find_route_handler` returned None and
`_should_exempt` short-circuited EVERY request (confirmed live in prod —
250 requests from one IP, zero 429s).  This implementation is pure-ASGI +
stdlib (same layering rule as body_limit.py / client_version.py) and never
inspects framework internals, so a FastAPI upgrade cannot silently
disarm it.

Complements the request-COST caps in limits.py: those bound how big one
request may be, these bound how many.
"""

import asyncio
import json

import pytest

from loom_api.ratelimit import RateLimit, parse_limits


# ---------------------------------------------------------------------------
# Harness (mirrors tests/test_request_limits.py)
# ---------------------------------------------------------------------------

class _App:
    def __init__(self):
        self.calls = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


class _Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def _scope(path="/annotate/batch", client=("203.0.113.5", 4000), headers=None, method="POST"):
    return {"type": "http", "method": method, "path": path,
            "headers": headers or [], "client": client}


def _run(mw, scope):
    sent = []

    async def send(msg):
        sent.append(msg)

    asyncio.run(mw(scope, None, send))
    return sent


def _status(sent):
    return sent[0]["status"]


def _header(sent, name):
    for k, v in sent[0]["headers"]:
        if k.decode().lower() == name:
            return v.decode()
    return None


# ---------------------------------------------------------------------------
# parse_limits
# ---------------------------------------------------------------------------

def test_parse_limits_reads_count_and_period():
    assert parse_limits("30/minute,2000/day") == [(30, 60), (2000, 86400)]


def test_parse_limits_supports_second_and_hour():
    assert parse_limits("5/second,100/hour") == [(5, 1), (100, 3600)]


def test_parse_limits_off_disables():
    for raw in ("off", "0", "", "  "):
        assert parse_limits(raw) == []


def test_parse_limits_skips_junk_entries():
    assert parse_limits("30/minute,garbage,2000/day") == [(30, 60), (2000, 86400)]


# ---------------------------------------------------------------------------
# Enforcement
# ---------------------------------------------------------------------------

def test_requests_under_the_limit_pass_through():
    app = _App()
    mw = RateLimit(app, limits=[(3, 60)], clock=_Clock())
    for _ in range(3):
        assert _status(_run(mw, _scope())) == 200
    assert app.calls == 3


def test_request_over_the_limit_is_429_and_never_reaches_the_app():
    app = _App()
    mw = RateLimit(app, limits=[(3, 60)], clock=_Clock())
    for _ in range(3):
        _run(mw, _scope())
    sent = _run(mw, _scope())
    assert _status(sent) == 429
    assert app.calls == 3


def test_429_carries_retry_after():
    app = _App()
    clock = _Clock(t=1000.0)
    mw = RateLimit(app, limits=[(1, 60)], clock=clock)
    _run(mw, _scope())
    sent = _run(mw, _scope())
    retry = _header(sent, "retry-after")
    assert retry is not None and 0 < int(retry) <= 60


def test_429_body_is_json_detail():
    app = _App()
    mw = RateLimit(app, limits=[(1, 60)], clock=_Clock())
    _run(mw, _scope())
    sent = _run(mw, _scope())
    body = json.loads(sent[1]["body"])
    assert "detail" in body


def test_separate_ips_have_separate_buckets():
    app = _App()
    mw = RateLimit(app, limits=[(2, 60)], clock=_Clock())
    for _ in range(2):
        _run(mw, _scope(client=("1.1.1.1", 1)))
    # a different IP is unaffected by the first IP's exhausted bucket
    assert _status(_run(mw, _scope(client=("2.2.2.2", 1)))) == 200
    assert _status(_run(mw, _scope(client=("1.1.1.1", 1)))) == 429


def test_window_rollover_restores_capacity():
    app = _App()
    clock = _Clock(t=1000.0)
    mw = RateLimit(app, limits=[(2, 60)], clock=clock)
    for _ in range(2):
        _run(mw, _scope())
    assert _status(_run(mw, _scope())) == 429
    clock.t += 61
    assert _status(_run(mw, _scope())) == 200


def test_all_limits_enforced_not_just_the_first():
    app = _App()
    clock = _Clock(t=1000.0)
    mw = RateLimit(app, limits=[(5, 60), (6, 86400)], clock=clock)
    for _ in range(5):
        _run(mw, _scope())
    clock.t += 61  # minute bucket resets, daily does not
    assert _status(_run(mw, _scope())) == 200  # 6th of the day
    assert _status(_run(mw, _scope())) == 429  # daily cap bites


# ---------------------------------------------------------------------------
# Exemptions
# ---------------------------------------------------------------------------

def test_health_is_exempt_so_platform_probes_never_throttle():
    app = _App()
    mw = RateLimit(app, limits=[(1, 60)], clock=_Clock())
    for _ in range(5):
        assert _status(_run(mw, _scope(path="/health", method="GET"))) == 200


def test_owner_key_bypasses():
    app = _App()
    mw = RateLimit(app, limits=[(1, 60)], bypass_keys=["k1"], clock=_Clock())
    hdr = [(b"x-loom-auth", b"k1")]
    for _ in range(5):
        assert _status(_run(mw, _scope(headers=hdr))) == 200


def test_wrong_key_does_not_bypass():
    app = _App()
    mw = RateLimit(app, limits=[(1, 60)], bypass_keys=["k1"], clock=_Clock())
    hdr = [(b"x-loom-auth", b"nope")]
    _run(mw, _scope(headers=hdr))
    assert _status(_run(mw, _scope(headers=hdr))) == 429


def test_non_ascii_auth_header_still_counts_and_never_raises():
    """A garbage X-Loom-Auth must not become a free pass OR a 500.

    The bypass check ran outside the fail-open try/except, so a non-ASCII
    header raised out of the middleware: 500 to the client (with no CORS
    headers, since ServerErrorMiddleware sits outside CORS) and — worse — the
    request was never counted, so repeating it was an unlimited unauthenticated
    request source.
    """
    app = _App()
    mw = RateLimit(app, limits=[(2, 60)], bypass_keys=["k1"], clock=_Clock())
    hdr = [(b"x-loom-auth", "\xe9x".encode("latin-1"))]
    assert _status(_run(mw, _scope(headers=hdr))) == 200
    assert _status(_run(mw, _scope(headers=hdr))) == 200
    assert _status(_run(mw, _scope(headers=hdr))) == 429  # counted, not bypassed


def test_bypass_check_failure_cannot_escape_the_middleware(monkeypatch):
    """Defence in depth: even if the key check itself blows up, the limiter
    must fail OPEN (serve the request) rather than 500 — the same contract the
    counting path already had."""
    from loom_api import ratelimit as rl

    def boom(*_a, **_k):
        raise RuntimeError("key check exploded")

    monkeypatch.setattr(rl, "is_bypass_key", boom)
    app = _App()
    mw = rl.RateLimit(app, limits=[(5, 60)], bypass_keys=["k1"], clock=_Clock())
    assert _status(_run(mw, _scope(headers=[(b"x-loom-auth", b"k1")]))) == 200
    assert app.calls == 1


def test_empty_limits_disables_middleware():
    app = _App()
    mw = RateLimit(app, limits=[], clock=_Clock())
    for _ in range(50):
        assert _status(_run(mw, _scope())) == 200


def test_non_http_scope_passes_through():
    app = _App()
    mw = RateLimit(app, limits=[(1, 60)], clock=_Clock())
    asyncio.run(mw({"type": "lifespan"}, None, lambda m: asyncio.sleep(0)))
    assert app.calls == 1


def test_missing_client_does_not_crash():
    app = _App()
    mw = RateLimit(app, limits=[(2, 60)], clock=_Clock())
    assert _status(_run(mw, _scope(client=None))) == 200


# ---------------------------------------------------------------------------
# Memory bounding (a bot rotating IPs must not grow the map forever)
# ---------------------------------------------------------------------------

def test_state_is_pruned_when_it_exceeds_max_keys():
    app = _App()
    clock = _Clock(t=1000.0)
    mw = RateLimit(app, limits=[(5, 60)], clock=clock, max_keys=50)
    for i in range(60):
        _run(mw, _scope(client=(f"10.0.0.{i}", 1)))
    clock.t += 61  # everything now stale
    _run(mw, _scope(client=("10.1.0.1", 1)))
    assert len(mw._state) <= 50
