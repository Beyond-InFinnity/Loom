"""loom_api — FastAPI service over loom_core.

Wraps the pure engine in HTTP. Hosted as:
  - localhost sidecar inside the Tauri desktop app (step 3)
  - production service (Fly.io / Railway) behind api.loom.nerv-analytic.ai (step 4)

The wire contracts live in ``loom_core.models`` (Pydantic v2). Field aliases
on ``StyleConfig`` round-trip to the dict shape the engine consumes today,
so the engine signatures stay unchanged across the API boundary.
"""
