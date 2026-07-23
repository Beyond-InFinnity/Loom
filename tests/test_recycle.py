"""Idle-aware worker recycling (loom_api/recycle.py).

Imports only loom_api.recycle / loom_api.limits (stdlib) — NOT loom_api.web
(slowapi is absent from the CI requirements; same layering rule as
test_request_limits.py / test_client_version.py).

The pure decision (`should_recycle`) is exhaustively covered; the middleware's
in-flight/last-activity bookkeeping and `_check_once`'s SIGTERM path are tested
with a recording `kill` so no real signal is ever raised.
"""

import asyncio
import time

import pytest

from loom_api import limits, recycle
from loom_api.recycle import IdleActivityTracker, RecycleState, should_recycle


# ---------------------------------------------------------------------------
# should_recycle — the pure decision
# ---------------------------------------------------------------------------

_BASE = dict(
    now=10_000.0,
    last_activity=0.0,       # idle for 10_000 s
    in_flight=0,
    rss_mb=500.0,            # above the default 400 floor
    idle_seconds=1800,
    rss_floor_mb=400,
    enabled=True,
)


def _sr(**over):
    return should_recycle(**{**_BASE, **over})


def test_recycles_when_idle_and_bloated_and_quiet():
    assert _sr() is True


def test_never_recycles_when_disabled():
    assert _sr(enabled=False) is False


def test_never_recycles_with_a_request_in_flight():
    assert _sr(in_flight=1) is False


def test_never_recycles_below_the_rss_floor():
    assert _sr(rss_mb=399.0) is False


def test_rss_exactly_at_floor_recycles():
    # Only strictly-below is spared.
    assert _sr(rss_mb=400.0) is True


def test_never_recycles_before_the_idle_threshold():
    assert _sr(now=1000.0, last_activity=0.0) is False   # only 1000 s idle


def test_idle_exactly_at_threshold_recycles():
    assert _sr(now=1800.0, last_activity=0.0) is True


def test_zero_idle_seconds_is_a_kill_switch():
    assert _sr(idle_seconds=0) is False


def test_zero_rss_floor_is_a_kill_switch():
    assert _sr(rss_floor_mb=0) is False


def test_unreadable_rss_never_recycles():
    # _rss_mb returns -1.0 on failure -> below any positive floor -> no recycle.
    assert _sr(rss_mb=-1.0) is False


# ---------------------------------------------------------------------------
# RecycleState — in-flight + last-activity bookkeeping
# ---------------------------------------------------------------------------

def test_state_tracks_in_flight():
    s = RecycleState()
    assert s.snapshot()[1] == 0
    s.enter(); s.enter()
    assert s.snapshot()[1] == 2
    s.leave()
    assert s.snapshot()[1] == 1


def test_leave_advances_last_activity():
    s = RecycleState()
    first = s.snapshot()[0]
    s.enter()
    time.sleep(0.01)
    s.leave()
    assert s.snapshot()[0] > first


# ---------------------------------------------------------------------------
# IdleActivityTracker middleware
# ---------------------------------------------------------------------------

class _App:
    def __init__(self):
        self.calls = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1


def _run(mw, scope):
    asyncio.run(mw(scope, None, lambda m: asyncio.sleep(0)))


def _http(path):
    return {"type": "http", "method": "POST", "path": path, "headers": []}


def test_middleware_counts_a_real_request_then_releases():
    s = RecycleState()
    app = _App()
    before = s.snapshot()[0]
    time.sleep(0.01)
    _run(IdleActivityTracker(app, s), _http("/annotate/batch"))
    last_activity, in_flight = s.snapshot()
    assert app.calls == 1
    assert in_flight == 0            # entered then left
    assert last_activity > before    # activity advanced


def test_middleware_ignores_health_probe():
    s = RecycleState()
    app = _App()
    before = s.snapshot()[0]
    time.sleep(0.01)
    _run(IdleActivityTracker(app, s), _http("/health"))
    last_activity, in_flight = s.snapshot()
    assert app.calls == 1
    assert in_flight == 0
    assert last_activity == before   # /health did NOT count as activity


def test_middleware_ignores_root_liveness():
    s = RecycleState()
    before = s.snapshot()[0]
    time.sleep(0.01)
    _run(IdleActivityTracker(_App(), s), _http("/"))
    assert s.snapshot()[0] == before


def test_middleware_decrements_even_if_app_raises():
    s = RecycleState()

    async def boom(scope, receive, send):
        raise RuntimeError("downstream error")

    with pytest.raises(RuntimeError):
        _run(IdleActivityTracker(boom, s), _http("/romanize/batch"))
    assert s.snapshot()[1] == 0       # finally: still released


def test_middleware_passes_non_http_through():
    s = RecycleState()
    app = _App()
    asyncio.run(IdleActivityTracker(app, s)({"type": "lifespan"}, None, None))
    assert app.calls == 1 and s.snapshot()[1] == 0


# ---------------------------------------------------------------------------
# _check_once — SIGTERM path, with a recording kill (never a real signal)
# ---------------------------------------------------------------------------

def _force_config(monkeypatch, *, enabled=True, idle=1800, floor=400):
    monkeypatch.setattr(recycle, "IDLE_RECYCLE_ENABLED", enabled)
    monkeypatch.setattr(recycle, "IDLE_RECYCLE_SECONDS", idle)
    monkeypatch.setattr(recycle, "IDLE_RECYCLE_RSS_MB", floor)


def test_check_once_fires_when_idle_and_bloated(monkeypatch):
    _force_config(monkeypatch)
    s = RecycleState()
    # Force "idle for 2000 s".
    with s._lock:
        s._last_activity = time.monotonic() - 2000
    killed = []
    fired = recycle._check_once(s, get_rss=lambda: 500.0, kill=lambda pid, sig: killed.append((pid, sig)))
    assert fired is True
    assert killed and killed[0][1] == recycle.signal.SIGTERM


def test_check_once_quiet_lean_worker_does_not_fire(monkeypatch):
    _force_config(monkeypatch)
    s = RecycleState()
    with s._lock:
        s._last_activity = time.monotonic() - 2000
    killed = []
    fired = recycle._check_once(s, get_rss=lambda: 120.0, kill=lambda pid, sig: killed.append(1))
    assert fired is False and killed == []


def test_check_once_bloated_but_busy_does_not_fire(monkeypatch):
    _force_config(monkeypatch)
    s = RecycleState()
    with s._lock:
        s._last_activity = time.monotonic() - 2000
    s.enter()  # in_flight = 1
    killed = []
    fired = recycle._check_once(s, get_rss=lambda: 800.0, kill=lambda pid, sig: killed.append(1))
    assert fired is False and killed == []


# ---------------------------------------------------------------------------
# start_idle_recycler — guards (must never start a killer thread under pytest)
# ---------------------------------------------------------------------------

def test_recycler_never_starts_under_pytest():
    # PYTEST_CURRENT_TEST is set by pytest -> guard returns False, no thread,
    # so a stray SIGTERM can never reach the test runner.
    assert recycle.start_idle_recycler() is False


def test_recycler_noop_when_disabled(monkeypatch):
    monkeypatch.setattr(recycle, "IDLE_RECYCLE_ENABLED", False)
    monkeypatch.setattr(recycle, "_started", False)
    assert recycle.start_idle_recycler() is False


# ---------------------------------------------------------------------------
# limits._env_bool
# ---------------------------------------------------------------------------

def test_env_bool_default_when_absent(monkeypatch):
    monkeypatch.delenv("LOOM_TEST_BOOL", raising=False)
    assert limits._env_bool("LOOM_TEST_BOOL", True) is True
    assert limits._env_bool("LOOM_TEST_BOOL", False) is False


def test_env_bool_off_values(monkeypatch):
    for word in ("off", "0", "false", "no", "disabled", "OFF"):
        monkeypatch.setenv("LOOM_TEST_BOOL", word)
        assert limits._env_bool("LOOM_TEST_BOOL", True) is False


def test_env_bool_on_values(monkeypatch):
    for word in ("on", "1", "true", "yes", "enabled", "ON"):
        monkeypatch.setenv("LOOM_TEST_BOOL", word)
        assert limits._env_bool("LOOM_TEST_BOOL", False) is True


def test_env_bool_junk_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("LOOM_TEST_BOOL", "maybe")
    assert limits._env_bool("LOOM_TEST_BOOL", True) is True
