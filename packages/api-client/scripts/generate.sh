#!/usr/bin/env bash
# Regenerate packages/api-client/src/types.ts from loom_api's OpenAPI
# schema.  Run from repo root: `npm run gen:api-client`.
#
# Two-step pipeline:
#   1. Import loom_api in dev Python and dump app.openapi() → openapi.json
#      (no need to run uvicorn; FastAPI's openapi() is a pure call)
#   2. Run openapi-typescript on openapi.json → src/types.ts
#
# Pin the Python interpreter via LOOM_PYTHON env var (default: dev env).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/api-client"
PY="${LOOM_PYTHON:-/home/connor/miniconda3/envs/srtstitcher/bin/python}"

cd "$REPO_ROOT"

echo "[gen]   dump openapi.json from loom_api.main:app"
"$PY" -c "from loom_api.main import app; import json, sys; json.dump(app.openapi(), sys.stdout, indent=2)" \
    > "$PKG_DIR/openapi.json"

echo "[gen]   openapi-typescript → src/types.ts"
npx --workspace packages/api-client openapi-typescript \
    "$PKG_DIR/openapi.json" \
    -o "$PKG_DIR/src/types.ts"

echo "[ok]    api-client regenerated ($(wc -l < "$PKG_DIR/src/types.ts") lines)"
