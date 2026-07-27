"""GET /debug/echo — owner-gated raw-request echo for edge-proxy diagnosis.

Railway fronts the API with a proxy chain it reshuffles without notice
(2026-07-26: a CDN77 layer appeared, breaking the --forwarded-allow-ips
real-client-IP resolution from P2).  This endpoint reports the request
exactly as the app receives it — the full header list in arrival order
WITH duplicates (a dict would merge repeated X-Forwarded-For lines, which
is precisely the evidence being collected), plus the resolved client
address — so the current chain shape can be probed from outside with a
spoofed X-Forwarded-For and a known egress IP, with no log-diving.

Gate: X-Loom-Auth must match a LOOM_BYPASS_KEYS entry (the existing owner
Tier-A key).  Anything else gets FastAPI's stock 404, indistinguishable
from a route that doesn't exist — scanners see nothing.  Keys are re-read
from the env per request (cheap; and monkeypatch-friendly in tests).
"""

import os

from fastapi import APIRouter, HTTPException, Request

from ..auth import bypass_keys_from_env, is_bypass_key

router = APIRouter(tags=["debug"])

_REDACTED_HEADERS = {b"x-loom-auth"}


def _ratelimit_report(request: Request) -> dict:
    """Effective rate-limit config as the RUNNING worker sees it.

    Exists because the limiter once failed SILENTLY in prod (slowapi +
    FastAPI 0.140 `_IncludedRouter` — see loom_api/ratelimit.py): a burst
    from one IP got 250×200 and nothing was logged.  Reporting the parsed
    limits and the key a request buckets under makes "is limiting actually
    on?" answerable in one curl instead of a deploy-and-guess loop.
    Best-effort throughout: a diagnostic must never be what 500s.
    """
    report: dict = {"env_LOOM_RATE_LIMIT": os.environ.get("LOOM_RATE_LIMIT")}
    try:
        from ..ratelimit import DEFAULT_RATE_LIMIT, EXEMPT_PATHS, parse_limits

        raw = os.environ.get("LOOM_RATE_LIMIT", DEFAULT_RATE_LIMIT)
        limits = parse_limits(raw)
        report["limits"] = [[count, period] for count, period in limits]
        report["enforcing"] = bool(limits)
        report["exempt_paths"] = list(EXEMPT_PATHS)
    except Exception as exc:  # pragma: no cover - defensive
        report["limits"] = f"<err {type(exc).__name__}>"
    client = request.scope.get("client")
    report["bucket_key"] = str(client[0]) if client else "unknown"
    # The env parse above says what the config SHOULD be; this reports the
    # LIVE middleware instance, which is what actually decides.  Prod once
    # served a burst unthrottled while the env parsed correctly — only
    # instance state distinguishes "misconfigured" from "not wired in".
    try:
        app = request.scope.get("app")
        report["registered_middleware"] = [
            getattr(m.cls, "__name__", str(m.cls)) for m in getattr(app, "user_middleware", [])
        ]
        node = getattr(app, "middleware_stack", None)
        found = None
        for _ in range(20):
            if node is None:
                break
            if type(node).__name__ == "RateLimit":
                found = node
                break
            node = getattr(node, "app", None) or getattr(node, "_app", None)
        if found is None:
            report["live_instance"] = None
        else:
            report["live_instance"] = {
                "limits": [list(t) for t in getattr(found, "_limits", [])],
                "tracked_keys": len(getattr(found, "_state", {})),
                "exempt": sorted(getattr(found, "_exempt", [])),
                "bypass_keys": len(getattr(found, "_bypass", [])),
            }
    except Exception as exc:  # pragma: no cover - defensive
        report["live_instance"] = f"<err {type(exc).__name__}>"
    return report


# include_in_schema=False: the public openapi.json must not advertise the
# endpoint (and the generated @loom/api-client stays byte-identical).
@router.get("/debug/echo", include_in_schema=False)
def echo(request: Request) -> dict:
    presented = request.headers.get("x-loom-auth")
    if not is_bypass_key(presented, bypass_keys_from_env()):
        raise HTTPException(status_code=404)

    headers = [
        [k.decode("latin-1"), "***" if k in _REDACTED_HEADERS else v.decode("latin-1")]
        for k, v in request.scope["headers"]
    ]
    client = request.client
    return {
        "client": f"{client.host}:{client.port}" if client else None,
        "scheme": request.scope.get("scheme"),
        "http_version": request.scope.get("http_version"),
        "headers": headers,
        "ratelimit": _ratelimit_report(request),
    }
