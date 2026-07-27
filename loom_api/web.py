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

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .body_limit import BodySizeLimit
from .client_version import ClientVersionLog
from .cors import ALLOW_ORIGIN_REGEX, resolve_exact_origins
from .deps import get_corpus_store, get_dictionary_store, get_result_cache
from .ratelimit import RateLimit
from .recycle import IdleActivityTracker, start_idle_recycler
from .routes import annotate, corpus, debug, define, health, language, romanize, styles

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
# clients see the real status, not an opaque CORS failure).
# Cap + rationale: loom_api/body_limit.py; env override LOOM_MAX_BODY_BYTES.
app.add_middleware(BodySizeLimit)

# Per-IP request-RATE limiting.  Registered before CORS (so it sits INSIDE it)
# for the same reason as BodySizeLimit: a 429 must exit through CORSMiddleware
# or a Chrome-MV3 extension fetch sees an opaque CORS failure instead of the
# real status.  Being outside BodySizeLimit also means a throttled request is
# rejected before its body is read.  CORS preflights are answered by
# CORSMiddleware further out and so never consume a slot.
#
#   30/minute    — burst cap.  Stops single-IP flooding (a scraper, a botnet
#                  stress test, a client spamming retries).  Real usage is far
#                  below it: an extension activation is a handful of batch
#                  calls, and a definition click is one request.
#
#   2000/day     — sustained-abuse cap, well above any plausible single user.
#
# Override via LOOM_RATE_LIMIT (comma-separated, all applied simultaneously);
# `0`/`off` disables.  Owner keys in LOOM_BYPASS_KEYS skip the limiter — the
# Step-6 OCR pipeline fans out tens of thousands of calls.  /health and / are
# always exempt so a platform liveness probe can't be throttled.
#
# NOT slowapi: it resolved the matched route's `.endpoint` to decide whether
# to limit, FastAPI 0.140 wrapped include_router() routes in `_IncludedRouter`
# (no `.endpoint`), and slowapi then silently exempted EVERY request — live
# prod took 250 requests from one IP with zero 429s.  loom_api/ratelimit.py
# reads only the ASGI scope, so a framework upgrade cannot disarm it again.
app.add_middleware(RateLimit)

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

# Owner-bypass keys (Tier A) live in LOOM_BYPASS_KEYS — comma-separated long
# random strings, generated with
#   python -c "import secrets; print(secrets.token_hex(32))"
# The frontend stores one in localStorage (apps/web/components/owner-key-
# bootstrap.tsx) and sends it as X-Loom-Auth on every request.  Parsing + the
# constant-time comparison live in loom_api/auth.py, shared by the rate
# limiter (which skips limiting for a valid key) and the owner-gated
# /debug/echo route.  Why a full bypass rather than a bigger bucket: the
# operator is the only legitimate consumer of unrestricted access, and a
# higher bucket would still throttle the Step-6 synthetic-data pipeline at the
# boundary.  Revoking is an env-var rotation, no code change.

# Extension-version telemetry: log X-Loom-Version headers (ext ≥0.4.0) so
# Railway logs show the live version mix across all browsers.  Watch via
# `loom.version` lines.  Implementation + rationale: loom_api/client_version.py.
app.add_middleware(ClientVersionLog)
# Idle-recycle activity tracker — registered LAST so it is OUTERMOST and sees
# every request (in-flight count + last-activity time for loom_api/recycle.py).
# /health and / are excluded so a liveness probe can't keep a bloated idle
# worker awake. Pure book-keeping; never rejects or alters a request.
app.add_middleware(IdleActivityTracker)

# Eagerly build the romanize/annotate result cache (ROMANIZATION_CACHE.md
# Layer 1) and the corpus store (Layer 2) at worker boot rather than on the
# first request — Postgres schema init (or, with the DB down, its fail-open
# timeout) belongs in the boot path, not in a user's first request latency.
# With no DATABASE_URL these return Null impls and cost nothing.
get_result_cache()
get_corpus_store()
get_dictionary_store()

# Arm idle-aware worker recycling (P3): sheds accumulated NLP-dictionary RAM
# when the worker is BOTH idle and bloated, so the average RSS (= the Railway
# bill) stays near baseline without inflicting the reload on real users.
# No-op under pytest / when LOOM_IDLE_RECYCLE=off. See loom_api/recycle.py.
start_idle_recycler()

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
# GET /debug/echo — owner-gated raw-header echo for edge-proxy diagnosis
# (404 without a valid X-Loom-Auth; see routes/debug.py).
app.include_router(debug.router)
