"""Slim FastAPI entry point for the production web service (Step 4e-1).

This is what Railway runs at ``api.loom.nerv-analytic.ai``.  Unlike
``loom_api.main:app`` (which serves the desktop sidecar with the full
file/job/video/mux surface), this app exposes ONLY pure text-processing:

    GET  /health         — liveness probe
    GET  /language/config/{code}  — wire-safe language metadata
    POST /romanize       — text → romanized text
    POST /annotate       — text → annotation spans + HTML

The browser does everything else client-side via ffmpeg.wasm + html2canvas
+ LoomGenerator (Steps 4c–4d), so the server's job is reduced to the two
calls that genuinely require a Python runtime: MeCab/fugashi, jieba +
pypinyin, pythainlp, aksharamukha, korean-romanizer, cyrtranslit.

Run locally:
    uvicorn loom_api.web:app --reload --port 8000

Bandwidth: text-in / text-out, ~100KB per request worst-case.  No file
uploads, no async jobs — process per request, return, done.
"""

import hmac
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

from .body_limit import BodySizeLimit
from .client_version import ClientVersionLog
from .cors import ALLOW_ORIGIN_REGEX, resolve_exact_origins
from .deps import get_corpus_store, get_dictionary_store, get_result_cache
from .routes import annotate, corpus, define, health, language, romanize, styles

app = FastAPI(
    title="Loom Web API",
    description=(
        "Lean text-processing endpoints for Loom's web frontend.  All video / "
        "subtitle-file / rasterization work happens client-side; this service "
        "only handles romanization + annotation, which need a Python runtime "
        "for MeCab/jieba/pythainlp/aksharamukha/etc."
    ),
    version="0.1.0",
)

# Origins allowed to call this API.  DEFAULT_ORIGINS (production frontend +
# local dev) are ALWAYS allowed; the ``LOOM_CORS_ORIGINS`` env var APPENDS to
# them (comma-separated).  Appending — not replacing — means a new streaming
# site (or preview URL) can be whitelisted by editing one Railway env var, no
# code change or source rebuild.  The browser extension ships from a randomized
# chrome-extension:// / moz-extension:// origin per install, whitelisted by the
# regex below (exact-listing every install ID isn't workable).
_origins = resolve_exact_origins(os.environ.get("LOOM_CORS_ORIGINS"))

# Body-size guard — registered FIRST so it runs INNERMOST (add_middleware is
# LIFO): its 411/413 rejections flow back out through CORSMiddleware (browser
# clients see the real status, not an opaque CORS failure) and oversized
# requests still consume a rate-limit slot in the outer slowapi layer.
# Cap + rationale: loom_api/body_limit.py; env override LOOM_MAX_BODY_BYTES.
app.add_middleware(BodySizeLimit)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    # The browser extension fetches from a content script. On Chrome MV3 that
    # fetch carries the *page* origin of the streaming site (e.g.
    # https://www.youtube.com), NOT chrome-extension:// — so the sites the
    # extension runs on must be allow-listed, or annotate/romanize 400 under
    # CORS. (Firefox MV2 content scripts bypass CORS, which masked this.) Two
    # ways to add a site now: append its origin to the LOOM_CORS_ORIGINS env
    # var (no code change — preferred for one-offs), or for a site with many
    # subdomains add a clause to ALLOW_ORIGIN_REGEX in loom_api/cors.py
    # (guarded by tests/test_cors_origins.py).
    allow_origin_regex=ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# IP-keyed rate limits.  Two layers stacked:
#
#   100/minute   — burst limit.  Stops single-IP flooding (a botnet stress
#                  test or a misconfigured client spamming retries).  A
#                  legitimate generation fans out ~300 /romanize calls in
#                  ~30 seconds (in parallel via Promise.all on the client),
#                  which spikes briefly above 100/min — but slowapi's
#                  fixed-window counter resets each minute, so a real
#                  generation completes within one window.  If we ever see
#                  legitimate users hitting this, raise to 200/minute.
#
#   2000/day     — sustained-abuse cap.  ~6 generations/day per IP, well
#                  above any plausible single-user demand and well below
#                  what a scraper would need for "all of Pinyin novels"
#                  type extraction.
#
# Override via LOOM_RATE_LIMIT — comma-separated, all limits applied
# simultaneously.  Examples:
#   LOOM_RATE_LIMIT="200/minute,5000/day"   (looser)
#   LOOM_RATE_LIMIT="60/minute,500/day"     (tighter, abuse mode)
#   LOOM_RATE_LIMIT="2000/day"              (single limit, no burst control)
_rate_env = os.environ.get("LOOM_RATE_LIMIT", "100/minute,2000/day").strip()
_rate_limits = [s.strip() for s in _rate_env.split(",") if s.strip()]
limiter = Limiter(key_func=get_remote_address, default_limits=_rate_limits)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Owner-bypass keys.  Comma-separated long random strings — generate with
#   python -c "import secrets; print(secrets.token_hex(32))"
# Set in Railway as LOOM_BYPASS_KEYS.  Frontend stores the key in
# localStorage (see apps/web/components/owner-key-bootstrap.tsx) and
# attaches it as X-Loom-Auth on every request via the openapi-fetch
# middleware.  Requests carrying a key in the allow-list bypass the
# slowapi pipeline entirely — same code path as if the rate limiter
# weren't installed.
#
# Why bypass instead of an "owner bucket" with a higher per-key limit:
# the operator is the only legitimate consumer of unrestricted access,
# and a higher bucket would still rate-limit the synthetic-data
# generation pipeline (Step 6) at the bucket boundary.  Skipping the
# limiter entirely is the right semantics — and downgrading later (if a
# key leaks) just means rotating the env var, no code change.
_bypass_env = os.environ.get("LOOM_BYPASS_KEYS", "").strip()
_BYPASS_KEYS: list[str] = [k.strip() for k in _bypass_env.split(",") if k.strip()]


def _is_bypass_key(presented: str) -> bool:
    """Constant-time check: is `presented` in the allow-list?

    Iterates every key with hmac.compare_digest to keep timing leakage
    proportional only to len(_BYPASS_KEYS), not to which key matched
    (or how many leading bytes agreed).
    """
    if not presented or not _BYPASS_KEYS:
        return False
    matched = False
    for k in _BYPASS_KEYS:
        if hmac.compare_digest(presented, k):
            matched = True
    return matched


class BypassAwareSlowAPI:
    """ASGI middleware that wraps SlowAPIMiddleware: requests carrying a
    valid X-Loom-Auth header skip the rate limiter entirely.  All other
    traffic falls through to slowapi's standard IP-keyed pipeline."""

    def __init__(self, app):
        # _inner = the slowapi-wrapped pipeline (full app behind a limiter)
        # _app   = the raw inner app (used when bypass triggers)
        self._inner = SlowAPIMiddleware(app)
        self._app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            for k, v in scope.get("headers", []):
                if k == b"x-loom-auth":
                    if _is_bypass_key(v.decode("latin-1").strip()):
                        return await self._app(scope, receive, send)
                    break
        return await self._inner(scope, receive, send)


# Extension-version telemetry: log X-Loom-Version headers (ext ≥0.4.0) so
# Railway logs show the live version mix across all browsers.  Watch via
# `loom.version` lines.  Implementation + rationale: loom_api/client_version.py.
app.add_middleware(ClientVersionLog)
app.add_middleware(BypassAwareSlowAPI)

# Eagerly build the romanize/annotate result cache (ROMANIZATION_CACHE.md
# Layer 1) and the corpus store (Layer 2) at worker boot rather than on the
# first request — Postgres schema init (or, with the DB down, its fail-open
# timeout) belongs in the boot path, not in a user's first request latency.
# With no DATABASE_URL these return Null impls and cost nothing.
get_result_cache()
get_corpus_store()
get_dictionary_store()

app.include_router(health.router)
app.include_router(language.router)
app.include_router(romanize.router)
app.include_router(annotate.router)
# /styles/presets (lang-scoped color presets) + /styles/fonts. The extension's
# settings panel fetches /styles/presets on open; without this the slim API
# 404s it (color presets silently fail to load). color_presets + styles are
# pure-Python (no ffmpeg/playwright), so mounting here is safe for the slim API.
app.include_router(styles.router)
# POST /corpus/capture — opt-in media-identity subtitle capture (Layer 2).
app.include_router(corpus.router)
# POST /define/batch — per-word dictionary lookup (VOCAB_LOOKUP.md).
app.include_router(define.router)
