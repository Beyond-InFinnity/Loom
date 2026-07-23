"""Request body-size guard (stdlib-only, like client_version.py).

Rejects oversized request bodies from the Content-Length header BEFORE
FastAPI buffers or parses them.  Without this every POST route accepts an
arbitrarily large body: pydantic's list/str caps fire only AFTER starlette
has read the entire body into RAM and json-parsed it, and nothing below us
bounds body size — uvicorn's h11/httptools limits cover the request line +
headers only, and gunicorn's --limit-request-* flags likewise.  (Measured
2026-07: a 60 MB JSON body parses in ~0.08 s but is fully buffered first;
the cost is memory + the pipeline work the payload then demands.)

Placement: added INNERMOST in web.py (add_middleware is LIFO — this one is
registered first, before CORSMiddleware) so rejections flow back out
through CORS (a browser client sees a real 413, not an opaque CORS error)
and still consume a rate-limit slot on the way in.

Semantics:

- Content-bearing methods (POST/PUT/PATCH) MUST declare Content-Length —
  411 otherwise.  Every Loom client (fetch with a string body, python
  urllib/httpx) always sends it; requiring it means the cap cannot be
  bypassed with Transfer-Encoding: chunked.  uvicorn enforces that the
  actual body matches the declared length, so the header is authoritative.
- Declared length over the cap → 413 with a JSON ``detail``.
- ``LOOM_MAX_BODY_BYTES=0``/``off`` disables entirely (kill switch).

Kept free of FastAPI/starlette imports so tests can exercise it without
requirements-web.txt (same layering rule as client_version.py / cors.py).
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from . import limits

logger = logging.getLogger("loom.bodylimit")

_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


class BodySizeLimit:
    """Pure-ASGI middleware: reject oversized / undeclared request bodies."""

    def __init__(self, app, max_bytes: Optional[int] = None) -> None:
        self._app = app
        # None → follow limits.MAX_BODY_BYTES at request time (monkeypatchable
        # in tests, picked up on worker restart after an env change).
        self._max_override = max_bytes

    @property
    def _max_bytes(self) -> int:
        return limits.MAX_BODY_BYTES if self._max_override is None else self._max_override

    async def __call__(self, scope, receive, send):
        max_bytes = self._max_bytes
        if scope["type"] != "http" or not max_bytes:
            return await self._app(scope, receive, send)
        if scope.get("method", "").upper() not in _BODY_METHODS:
            return await self._app(scope, receive, send)

        declared: Optional[int] = None
        for k, v in scope.get("headers", []):
            if k == b"content-length":
                # Strict RFC form only ([0-9]+): int() would also accept
                # '+123' / '1_0' and a negative value would slip past the
                # `>` check.  Unreachable behind uvicorn (h11/httptools
                # pre-validate), but this middleware shouldn't rely on it.
                sv = v.strip()
                if not sv.isdigit():
                    return await self._reject(send, 400, "Invalid Content-Length header.")
                declared = int(sv)
                break

        if declared is None:
            return await self._reject(
                send, 411,
                "Content-Length required (chunked request bodies are not accepted).",
            )
        if declared > max_bytes:
            logger.warning(
                "rejected body: %d bytes > %d cap (%s %s)",
                declared, max_bytes,
                scope.get("method", "?"),
                limits.log_safe(str(scope.get("path", "?"))),
            )
            return await self._reject(
                send, 413,
                f"Request body too large: {declared} bytes exceeds the "
                f"{max_bytes}-byte limit. Split the batch into smaller requests.",
            )
        return await self._app(scope, receive, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
