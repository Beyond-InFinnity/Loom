"""FastAPI entry point.

Run locally:
    uvicorn loom_api.main:app --reload --port 8000

OpenAPI schema is at /openapi.json; interactive docs at /docs.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import (
    align,
    annotate,
    files,
    generate,
    health,
    jobs,
    language,
    mux,
    preview,
    romanize,
    styles,
    subs,
    video,
)

app = FastAPI(
    title="Loom API",
    description="Subtitle generation engine over loom_core.",
    version="0.1.0",
)

# Allow cross-origin requests from the Tauri webview (loaded from
# http://localhost:1420 in dev) and from browser extensions / web pages
# during step 4+. ``allow_origins=["*"]`` is fine until we ship — tighten
# to a known list (loom.nerv-analytic.ai, tauri://localhost,
# extension://...) before any production deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(files.router)
app.include_router(language.router)
app.include_router(romanize.router)
app.include_router(annotate.router)
app.include_router(generate.router)
app.include_router(jobs.router)
app.include_router(video.router)
app.include_router(subs.router)
app.include_router(align.router)
app.include_router(preview.router)
app.include_router(styles.router)
app.include_router(mux.router)
