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

from fastapi import APIRouter, HTTPException, Request

from ..auth import bypass_keys_from_env, is_bypass_key

router = APIRouter(tags=["debug"])

_REDACTED_HEADERS = {b"x-loom-auth"}


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
    }
