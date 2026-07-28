"""X-Loom-Version telemetry middleware (stdlib-only, like cors.py).

The extension sends its manifest version in an X-Loom-Version header on
every API call (apps/extension/lib/api-client.ts, since ext 0.4.0).  This
middleware logs one `loom.version` INFO line per header-carrying request,
so Railway logs answer "which extension versions are live, on every
browser" — AMO usage stats cover Firefox only, and Chrome's dashboard is
a separate silo with no per-day version breakdown export.

Volume is trivial: the extension makes ~4 API calls per activation.
Requests without the header (older extensions, the web app, curl) log
nothing.  Kept free of FastAPI/slowapi imports so tests can exercise it
without requirements-web.txt (same layering rule as cors.py).
"""

from __future__ import annotations

import logging

from .limits import log_safe

logger = logging.getLogger("loom.version")
# Uvicorn/gunicorn configure only their OWN loggers; a loom.* logger with no
# handler falls back to Python's lastResort, which drops anything below
# WARNING — so this INFO line has never appeared in prod (zero lines across 9
# hours of live traffic with active users, making the "which extension versions
# are live" question this middleware exists to answer unanswerable).  Same
# idempotent fix result_cache.py already carries.
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    # NOTE: propagate is deliberately left ON (unlike result_cache.py).  Prod
    # configures no root handler, so nothing duplicates, and leaving it on
    # keeps the records visible to pytest's caplog, which attaches to root —
    # i.e. the existing behavioural tests keep testing something.

_MAX_VERSION_LEN = 32
_MAX_PATH_LEN = 200


class ClientVersionLog:
    """Pure-ASGI middleware: log X-Loom-Version when present, pass through."""

    def __init__(self, app) -> None:
        self._app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            for k, v in scope.get("headers", []):
                if k == b"x-loom-version":
                    # Sanitize the path: ASGI delivers it percent-DECODED, so
                    # a request to `/x%0A<forged line>` would otherwise write a
                    # second, fake entry into the logs an operator reads to
                    # spot abuse.  body_limit.py and ratelimit.py already do
                    # this; this was the one middleware that didn't — which is
                    # why the handler above and this call had to land together.
                    logger.info(
                        "client version=%s path=%s",
                        log_safe(v.decode("latin-1").strip()[:_MAX_VERSION_LEN]),
                        log_safe(scope.get("path", "?"), _MAX_PATH_LEN),
                    )
                    break
        return await self._app(scope, receive, send)
