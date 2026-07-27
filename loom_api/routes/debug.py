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
    """Live slowapi state as the RUNNING worker sees it.

    A 250-request burst against prod never 429'd while the identical stack
    (same pinned package versions, same gunicorn flags, same limit string)
    enforced correctly on a laptop — so the divergence is in the deployed
    process, not the code.  slowapi's Limiter resolves much of its config
    through starlette's Config (which reads os.environ), so the deployed
    limiter can differ from the constructor arguments in web.py.  Everything
    here is best-effort: a diagnostic must never be the thing that 500s.
    """
    report: dict = {"env_LOOM_RATE_LIMIT": os.environ.get("LOOM_RATE_LIMIT")}
    limiter = getattr(getattr(request.app, "state", None), "limiter", None) if request.scope.get("app") else None
    if limiter is None:
        report["present"] = False
        return report
    report["present"] = True
    for field, attr in (
        ("enabled", "enabled"),
        ("key_style", "_key_style"),
        ("key_prefix", "_key_prefix"),
        ("storage_dead", "_storage_dead"),
        ("auto_check", "_auto_check"),
        ("swallow_errors", "_swallow_errors"),
    ):
        try:
            report[field] = getattr(limiter, attr)
        except Exception as exc:  # pragma: no cover - defensive
            report[field] = f"<err {type(exc).__name__}>"
    for field, attr in (("default_limits", "_default_limits"),
                        ("application_limits", "_application_limits")):
        try:
            report[field] = [str(lim) for group in getattr(limiter, attr, []) for lim in group]
        except Exception as exc:  # pragma: no cover - defensive
            report[field] = f"<err {type(exc).__name__}>"
    try:
        report["storage"] = type(limiter._storage).__name__
    except Exception:  # pragma: no cover - defensive
        report["storage"] = None
    try:
        from slowapi.util import get_remote_address

        report["remote_address_key"] = get_remote_address(request)
    except Exception as exc:  # pragma: no cover - defensive
        report["remote_address_key"] = f"<err {type(exc).__name__}>"
    # Does slowapi's middleware resolve a handler for this path?  It silently
    # exempts the request when it can't (_should_exempt returns True on None).
    try:
        from slowapi.middleware import _find_route_handler

        handler = _find_route_handler(request.app.routes, request.scope)
        report["route_handler"] = None if handler is None else getattr(handler, "__name__", str(handler))
    except Exception as exc:  # pragma: no cover - defensive
        report["route_handler"] = f"<err {type(exc).__name__}>"
    # Why did matching fail?  Report the scope fields route matching consumes
    # (root_path is stripped from path by starlette's get_route_path) plus the
    # per-route match verdicts.
    try:
        report["scope"] = {
            k: request.scope.get(k)
            for k in ("path", "root_path", "method", "type")
        }
        raw = request.scope.get("raw_path")
        report["scope"]["raw_path"] = raw.decode("latin-1") if isinstance(raw, bytes) else raw
        report["n_routes"] = len(request.app.routes)
        matches = []
        for route in list(request.app.routes)[:40]:
            try:
                m, _child = route.matches(request.scope)
                matches.append([getattr(route, "path", str(route)), str(m), hasattr(route, "endpoint")])
            except Exception as exc:  # pragma: no cover - defensive
                matches.append([getattr(route, "path", "?"), f"<err {type(exc).__name__}>", None])
        report["route_matches"] = [m for m in matches if not str(m[1]).endswith("NONE")]
    except Exception as exc:  # pragma: no cover - defensive
        report["scope"] = f"<err {type(exc).__name__}>"
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
