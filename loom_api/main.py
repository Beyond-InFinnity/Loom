"""FastAPI entry point.

Run locally:
    uvicorn loom_api.main:app --reload --port 8000

OpenAPI schema is at /openapi.json; interactive docs at /docs.
"""

from fastapi import FastAPI

from .routes import files, generate, health, language

app = FastAPI(
    title="Loom API",
    description="Subtitle generation engine over loom_core.",
    version="0.1.0",
)

app.include_router(health.router)
app.include_router(files.router)
app.include_router(language.router)
app.include_router(generate.router)
