"""Idle-aware worker self-recycling (P3) — stdlib-only, layering-safe.

Railway bills RAM continuously, and each language's NLP dictionary loads
lazily on first use then stays resident for the worker's whole life
(jieba+opencc+pypinyin alone ≈ 160 MB / ~1 s; ja is mmap'd ≈ 9 MB / 6 ms;
ko ≈ 58 ms — all measured 2026-07).  gunicorn's --max-requests recycles by
request COUNT, which at this traffic fires only ~every 3 days, so a worker
sits at its accumulated peak RSS (~700–900 MB with every language loaded)
for days — pure billing waste on a ~$5/mo box (RAM ≈ $10/GB-month).

This sheds that creep WITHOUT the reload landing on real users: a background
thread SIGTERMs the worker (gunicorn respawns a fresh ~77 MB one) only when
it is BOTH genuinely idle AND bloated:

    no non-trivial request for IDLE_RECYCLE_SECONDS  (default 30 min)
    AND RSS > IDLE_RECYCLE_RSS_MB                     (default 400 MB)
    AND no request in flight

The RSS floor is load-bearing: a lean single-language worker (ja-only,
mmap'd, ~90 MB) never trips it, so the common case keeps its warm dicts and
pays no reload.  Only a worker crept to multi-language bloat sheds — exactly
when reclaiming RAM is worth the one-time reload on the next burst.  NO
warm-up (decided 2026-07): the reload is effectively Chinese-only (~1 s,
first genuinely-new line), ja/ko are tens of ms, and any repeated line is
served from the result cache without touching a dictionary at all.

Safe-by-construction (verified from gunicorn 26 source): the master owns the
listening socket and never exits, so the respawn gap queues connections
rather than refusing them; uvicorn drains in-flight requests on SIGTERM; a
clean worker exit is always respawned — the same path --max-requests uses,
which stays as a leak backstop.  Kill switch: LOOM_IDLE_RECYCLE=off.

Kept free of FastAPI/slowapi imports (same layering rule as body_limit.py /
client_version.py) so it's unit-testable without requirements-web.txt.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from typing import Callable

from .limits import _env_bool, _env_int

logger = logging.getLogger("loom.recycle")

# Read once at worker boot; override via Railway env (restart to apply).
IDLE_RECYCLE_ENABLED = _env_bool("LOOM_IDLE_RECYCLE", True)
IDLE_RECYCLE_SECONDS = _env_int("LOOM_IDLE_RECYCLE_SECONDS", 1800)     # 30 min
IDLE_RECYCLE_RSS_MB = _env_int("LOOM_IDLE_RECYCLE_RSS_MB", 400)
CHECK_INTERVAL_SECONDS = _env_int("LOOM_IDLE_RECYCLE_CHECK_SECONDS", 60)

# Liveness probes must NOT count as activity, or a periodic health check could
# keep a bloated idle worker awake forever.  (A lean worker wouldn't trip the
# RSS floor anyway, but a bloated-then-idle worker still getting /health pings
# would — so this is load-bearing.)
_IGNORED_PATHS = frozenset({"/", "/health"})


def _rss_mb() -> float:
    """Resident set size in MB (Linux/Railway).  -1 if unavailable."""
    try:
        with open("/proc/self/statm") as f:  # noqa: PLW1514
            pages = int(f.read().split()[1])
        import resource  # noqa: PLC0415 — stdlib, cheap

        return pages * resource.getpagesize() / (1024 * 1024)
    except Exception:
        return -1.0


class RecycleState:
    """Idle/in-flight tracker: written by the middleware, read by the
    recycler thread.  All access is under one lock (compound read in
    snapshot must be consistent)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._in_flight = 0
        self._last_activity = time.monotonic()

    def enter(self) -> None:
        with self._lock:
            self._in_flight += 1

    def leave(self) -> None:
        with self._lock:
            self._in_flight -= 1
            self._last_activity = time.monotonic()

    def snapshot(self) -> tuple[float, int]:
        with self._lock:
            return self._last_activity, self._in_flight


STATE = RecycleState()


def should_recycle(
    *,
    now: float,
    last_activity: float,
    in_flight: int,
    rss_mb: float,
    idle_seconds: int,
    rss_floor_mb: int,
    enabled: bool,
) -> bool:
    """Pure decision — recycle only when enabled, quiet, idle, AND bloated.

    A zero/negative idle_seconds or rss_floor_mb reads as "disabled" (so the
    _env_int 0/off convention turns any single threshold into a kill switch).
    rss_mb == floor recycles (only strictly-below is spared); idle exactly at
    the threshold recycles."""
    if not enabled or idle_seconds <= 0 or rss_floor_mb <= 0:
        return False
    if in_flight > 0:
        return False
    if rss_mb < rss_floor_mb:
        return False
    return (now - last_activity) >= idle_seconds


class IdleActivityTracker:
    """Pure-ASGI middleware: maintain in-flight count + last-activity time.
    Registered OUTERMOST so every real request counts (even one rejected by
    an inner guard means the worker is busy, not idle).  /health and / don't
    count — see _IGNORED_PATHS."""

    def __init__(self, app, state: RecycleState = STATE) -> None:
        self._app = app
        self._state = state

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") in _IGNORED_PATHS:
            return await self._app(scope, receive, send)
        self._state.enter()
        try:
            await self._app(scope, receive, send)
        finally:
            self._state.leave()


def _check_once(
    state: RecycleState,
    *,
    get_rss: Callable[[], float] = _rss_mb,
    kill: Callable[[int, int], None] = os.kill,
) -> bool:
    """One recycle check.  Returns True (and SIGTERMs self) when the worker
    should recycle, else False.  Extracted from the loop so it's testable
    without a real signal (pass a recording `kill`)."""
    last_activity, in_flight = state.snapshot()
    rss = get_rss()
    if should_recycle(
        now=time.monotonic(),
        last_activity=last_activity,
        in_flight=in_flight,
        rss_mb=rss,
        idle_seconds=IDLE_RECYCLE_SECONDS,
        rss_floor_mb=IDLE_RECYCLE_RSS_MB,
        enabled=IDLE_RECYCLE_ENABLED,
    ):
        logger.info(
            "idle-recycle: idle %.0fs >= %ds, rss %.0f MB > %d floor, in_flight 0"
            " -> SIGTERM self (gunicorn respawns a fresh worker)",
            time.monotonic() - last_activity,
            IDLE_RECYCLE_SECONDS,
            rss,
            IDLE_RECYCLE_RSS_MB,
        )
        kill(os.getpid(), signal.SIGTERM)
        return True
    return False


def _recycle_loop(state: RecycleState, *, get_rss: Callable[[], float] = _rss_mb) -> None:
    while True:
        time.sleep(max(1, CHECK_INTERVAL_SECONDS))
        try:
            if _check_once(state, get_rss=get_rss):
                return  # SIGTERM sent; let the process wind down
        except Exception:
            logger.warning("idle-recycle check failed (continuing)", exc_info=True)


_started = False


def start_idle_recycler(state: RecycleState = STATE) -> bool:
    """Start the recycler daemon thread once per worker.  Returns True iff it
    started.  No-op when disabled, already started, or running under pytest
    (a stray SIGTERM must never reach a test runner)."""
    global _started
    if not IDLE_RECYCLE_ENABLED:
        logger.info("idle-recycle disabled (LOOM_IDLE_RECYCLE=off)")
        return False
    if _started or "PYTEST_CURRENT_TEST" in os.environ:
        return False
    _started = True
    threading.Thread(
        target=_recycle_loop, args=(state,), name="loom-idle-recycler", daemon=True
    ).start()
    logger.info(
        "idle-recycle armed: idle>=%ds AND rss>%dMB AND quiet, checked every %ds",
        IDLE_RECYCLE_SECONDS,
        IDLE_RECYCLE_RSS_MB,
        CHECK_INTERVAL_SECONDS,
    )
    return True
