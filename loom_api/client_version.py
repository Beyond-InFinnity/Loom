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

logger = logging.getLogger("loom.version")

_MAX_VERSION_LEN = 32


class ClientVersionLog:
    """Pure-ASGI middleware: log X-Loom-Version when present, pass through."""

    def __init__(self, app) -> None:
        self._app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            for k, v in scope.get("headers", []):
                if k == b"x-loom-version":
                    logger.info(
                        "client version=%s path=%s",
                        v.decode("latin-1").strip()[:_MAX_VERSION_LEN],
                        scope.get("path", "?"),
                    )
                    break
        return await self._app(scope, receive, send)
