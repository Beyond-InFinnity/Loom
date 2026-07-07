"""CORS origin policy for the slim web API (``loom_api/web.py``).

Extracted into its own module — deliberately free of FastAPI/slowapi
imports — so the origin policy can be unit-tested without standing up the
full app.  Importing ``web.py`` pulls ``slowapi``, which lives only in
``requirements-web.txt`` (the production deploy), not the CI
``requirements.txt`` — so a TestClient test against the real app can't run
in CI.  This module needs only the stdlib ``re``.

The regression this guards: the browser extension's content-script fetches
carry the *streaming site's* page origin on Chrome MV3 (Firefox MV2 bypasses
CORS, which masks it).  Every site the extension injects into must be
allow-listed here or annotate/romanize/presets fail under CORS on Chrome.
Netflix support (v0.2.0) shipped without its entry — annotations and
romanization silently failed on Chrome/Netflix while dual subs (served from
Netflix's own manifest) kept working.  ``tests/test_cors_origins.py`` exists
so the next streaming site can't ship the same way.

**ADDING A SITE:** two options — (1) append its page origin to the
``LOOM_CORS_ORIGINS`` Railway env var (no code change / no source rebuild;
see :func:`resolve_exact_origins`), preferred for one-offs; or (2) for a site
with many subdomains, add a clause to :data:`ALLOW_ORIGIN_REGEX` here (guarded
by ``tests/test_cors_origins.py``).
"""
import re

# Exact-match origins: production frontend + local dev ports.  The live
# deploy may extend this via the ``LOOM_CORS_ORIGINS`` env var (see web.py).
DEFAULT_ORIGINS = [
    "https://loom.nerv-analytic.ai",
    "http://localhost:3000",
    "http://localhost:1420",
]

# Regex origins: the extension itself (randomized per-install
# ``extension://`` origin) plus every streaming site it injects into (whose
# page origin rides the content-script fetch on Chrome MV3).
ALLOW_ORIGIN_REGEX = (
    r"chrome-extension://.*"
    r"|moz-extension://.*"
    r"|https://[a-z0-9-]+\.youtube\.com"
    r"|https://[a-z0-9-]+\.netflix\.com"
    # iQIYI international play pages are on www.iq.com; WeTV's page origin is
    # the bare apex https://wetv.vip (no subdomain) — hence the optional
    # subdomain group on both.  (Page origins captured from live HARs, 2026-06.)
    r"|https://([a-z0-9-]+\.)?iq\.com"
    r"|https://([a-z0-9-]+\.)?wetv\.vip"
    # Prime Video plays on www.primevideo.com (detail page hosts the inline
    # player); page origin rides the annotate/romanize fetch on Chrome MV3.
    # (Captured from a live HAR, 2026-07-07.)
    r"|https://([a-z0-9-]+\.)?primevideo\.com"
)

_COMPILED_REGEX = re.compile(ALLOW_ORIGIN_REGEX)


def resolve_exact_origins(env_value: str | None) -> list[str]:
    """:data:`DEFAULT_ORIGINS` plus any comma-separated origins from the
    ``LOOM_CORS_ORIGINS`` env var.

    Crucially this APPENDS rather than replaces, so a deploy can whitelist a
    new streaming site (or preview URL) by editing one Railway env var — no
    code change, no source rebuild. Whitespace/empties are dropped; order is
    defaults-first then env, deduped preserving first occurrence.
    """
    extra = [o.strip() for o in (env_value or "").split(",") if o.strip()]
    seen: dict[str, None] = {}
    for o in (*DEFAULT_ORIGINS, *extra):
        seen.setdefault(o, None)
    return list(seen)


def is_allowed_origin(origin: str, exact_origins: list[str] | None = None) -> bool:
    """Whether ``origin`` is CORS-allowed by this API.

    Mirrors Starlette's ``CORSMiddleware`` semantics: an origin is allowed
    when it's in the exact-match list OR the regex *fullmatches* it.
    ``exact_origins`` defaults to :data:`DEFAULT_ORIGINS` (pass the
    env-resolved list to test the deployed policy).
    """
    origins = DEFAULT_ORIGINS if exact_origins is None else exact_origins
    if origin in origins:
        return True
    return _COMPILED_REGEX.fullmatch(origin) is not None
