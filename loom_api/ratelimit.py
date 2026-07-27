"""Per-IP request-RATE limiting — pure ASGI, stdlib only.

Replaces slowapi (2026-07-26).  slowapi's middleware decides whether to
limit a request by resolving the matched route's ``.endpoint``; FastAPI
0.140 began wrapping ``include_router()`` routes in an ``_IncludedRouter``
that exposes no ``.endpoint``, so ``_find_route_handler`` returned None and
``_should_exempt`` short-circuited EVERY request.  It failed silently — no
error, no log line, just 200s — and was only caught by bursting prod (250
requests from one IP, zero 429s).  Loom registers every route via
``include_router``, and ``requirements-web.txt`` pins nothing, so prod
drifted onto 0.140 while a laptop still resolved 0.136 and enforced
correctly.

Hence this module's rule: **never inspect framework internals.**  It reads
only the ASGI scope (path, headers, client), so a FastAPI/Starlette upgrade
cannot disarm it.  Same layering rule as body_limit.py / client_version.py
(stdlib-only, unit-testable without the app).

Complements loom_api/limits.py: those caps bound how BIG one request may
be, these bound how MANY.

Config — ``LOOM_RATE_LIMIT`` (same format as before), e.g.
``30/minute,2000/day``; ``0``/``off``/empty disables entirely.  Owner keys
in ``LOOM_BYPASS_KEYS`` skip the limiter (the Step-6 OCR pipeline fans out
tens of thousands of calls).  ``/health`` and ``/`` are always exempt so a
platform liveness probe can never be throttled into failing a deploy.
"""

import json
import logging
import os
import threading
import time
from typing import Callable, Iterable, Optional

from .auth import bypass_keys_from_env, is_bypass_key

logger = logging.getLogger("loom.ratelimit")

DEFAULT_RATE_LIMIT = "30/minute,2000/day"

_PERIODS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}

# Upper bound on tracked client keys.  A bot rotating source IPs would
# otherwise grow the map without limit; when exceeded, entries whose windows
# have all rolled over are dropped (an in-window entry is never evicted, so
# eviction can't be used to escape a limit).
DEFAULT_MAX_KEYS = 20_000

EXEMPT_PATHS = ("/health", "/")


def parse_limits(raw: Optional[str]) -> list[tuple[int, int]]:
    """``"30/minute,2000/day"`` → ``[(30, 60), (2000, 86400)]``.

    Junk entries are skipped rather than raising — a typo in an env var must
    never take the service down at boot.  ``0``/``off``/empty → no limits.
    """
    if raw is None:
        return []
    text = raw.strip().lower()
    if text in ("", "0", "off", "none", "false"):
        return []
    out: list[tuple[int, int]] = []
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk or "/" not in chunk:
            continue
        count_s, _, period_s = chunk.partition("/")
        period = _PERIODS.get(period_s.strip().rstrip("s"))
        try:
            count = int(count_s.strip())
        except ValueError:
            continue
        if period and count > 0:
            out.append((count, period))
    return out


class RateLimit:
    """Fixed-window per-IP limiter.

    Fixed window (not sliding) matches what the previous configuration
    documented and what the caps were sized against: a burst may straddle a
    boundary and briefly allow up to 2x, which is irrelevant against
    scraping and keeps the state per client to two ints per limit.
    """

    def __init__(
        self,
        app,
        *,
        limits: Optional[Iterable[tuple[int, int]]] = None,
        bypass_keys: Optional[Iterable[str]] = None,
        exempt_paths: Optional[Iterable[str]] = None,
        clock: Callable[[], float] = time.time,
        max_keys: int = DEFAULT_MAX_KEYS,
    ):
        self._app = app
        self._limits = (
            parse_limits(os.environ.get("LOOM_RATE_LIMIT", DEFAULT_RATE_LIMIT))
            if limits is None
            else list(limits)
        )
        self._bypass = bypass_keys_from_env() if bypass_keys is None else list(bypass_keys)
        self._exempt = set(EXEMPT_PATHS if exempt_paths is None else exempt_paths)
        self._clock = clock
        self._max_keys = max_keys
        # key -> [last_seen, [[window_index, count], ...] aligned to _limits]
        self._state: dict[str, list] = {}
        self._lock = threading.Lock()
        if self._limits:
            logger.info("loom.ratelimit active limits=%s", self._limits)
        else:
            logger.warning("loom.ratelimit DISABLED (no limits configured)")

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not self._limits:
            return await self._app(scope, receive, send)
        if scope.get("path", "") in self._exempt:
            return await self._app(scope, receive, send)
        if self._has_bypass_key(scope):
            return await self._app(scope, receive, send)

        try:
            retry_after = self._consume(self._client_key(scope))
        except Exception:  # pragma: no cover - defensive
            # Fail OPEN, like the result cache: a limiter bug must never take
            # the API down.
            logger.exception("loom.ratelimit check failed; allowing request")
            return await self._app(scope, receive, send)

        if retry_after is None:
            return await self._app(scope, receive, send)
        return await self._reject(scope, send, retry_after)

    # -- internals ---------------------------------------------------------

    def _has_bypass_key(self, scope) -> bool:
        if not self._bypass:
            return False
        for k, v in scope.get("headers", []):
            if k == b"x-loom-auth":
                return is_bypass_key(v.decode("latin-1").strip(), self._bypass)
        return False

    @staticmethod
    def _client_key(scope) -> str:
        client = scope.get("client")
        if not client:
            # No peer (ASGI allows None). One shared bucket is the safe
            # reading — better than exempting.
            return "unknown"
        return str(client[0])

    def _consume(self, key: str) -> Optional[int]:
        """Count this request. Returns None if allowed, else Retry-After secs."""
        now = self._clock()
        with self._lock:
            entry = self._state.get(key)
            if entry is None:
                if len(self._state) >= self._max_keys:
                    self._prune(now)
                entry = [now, [[-1, 0] for _ in self._limits]]
                self._state[key] = entry
            entry[0] = now
            windows = entry[1]
            retry: Optional[int] = None
            for i, (count, period) in enumerate(self._limits):
                win = int(now // period)
                state = windows[i]
                if state[0] != win:
                    state[0] = win
                    state[1] = 0
                state[1] += 1
                if state[1] > count and retry is None:
                    retry = max(1, int((win + 1) * period - now))
            return retry

    def _prune(self, now: float) -> None:
        """Drop entries whose every window has rolled over (caller holds lock)."""
        longest = max(period for _c, period in self._limits)
        stale = [k for k, e in self._state.items() if now - e[0] >= longest]
        for k in stale:
            del self._state[k]
        if len(self._state) >= self._max_keys:
            # Still full of in-window clients: evict the least recently seen.
            for k, _e in sorted(self._state.items(), key=lambda kv: kv[1][0])[: self._max_keys // 10]:
                del self._state[k]

    async def _reject(self, scope, send, retry_after: int):
        logger.warning(
            "loom.ratelimit 429 client=%s path=%s retry_after=%ss",
            self._client_key(scope),
            _log_safe(scope.get("path", "")),
            retry_after,
        )
        body = json.dumps({"detail": "Rate limit exceeded"}).encode()
        await send({
            "type": "http.response.start",
            "status": 429,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"retry-after", str(retry_after).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def _log_safe(text: str, limit: int = 120) -> str:
    """ASGI paths arrive percent-DECODED, so a raw path can inject newlines."""
    return "".join(c if c.isprintable() else "?" for c in text)[:limit]
