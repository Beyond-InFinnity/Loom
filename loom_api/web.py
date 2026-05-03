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

from .routes import annotate, health, language, romanize

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

# Origins allowed to call this API.  Production frontend lives at
# loom.nerv-analytic.ai; localhost ports cover Vercel preview + local dev.
# Override via ``LOOM_CORS_ORIGINS`` (comma-separated) when the deploy URL
# changes or a preview deployment needs ad-hoc access.
_DEFAULT_ORIGINS = [
    "https://loom.nerv-analytic.ai",
    "http://localhost:3000",
    "http://localhost:1420",
]
_origins_env = os.environ.get("LOOM_CORS_ORIGINS", "").strip()
_origins = [o.strip() for o in _origins_env.split(",") if o.strip()] if _origins_env else _DEFAULT_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(language.router)
app.include_router(romanize.router)
app.include_router(annotate.router)
