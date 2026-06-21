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

**ADD A SITE HERE** when the extension gains support for it.
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
)

_COMPILED_REGEX = re.compile(ALLOW_ORIGIN_REGEX)


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
