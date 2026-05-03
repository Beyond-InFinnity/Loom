#!/usr/bin/env bash
# Stage the ffmpeg.wasm runtime files into apps/web/public/ffmpeg/ so
# the dev server (and production build) can serve them as same-origin
# static assets.  Run after `npm install`.
#
# Why static-served instead of bundled:
#   - The internal worker is type:"module" and uses relative imports,
#     which require a real URL with a base path.
#   - With COEP=require-corp on every route, same-origin assets bypass
#     CORP requirements without per-file header config.
#
# Files copied:
#   ffmpeg-core.js   — ESM build of the Emscripten-compiled ffmpeg.
#                      MUST be the ESM build, not UMD (the worker does
#                      `(await import(coreURL)).default`).
#   ffmpeg-core.wasm — The wasm binary, ~31MB.
#   worker.js        — FFmpeg class's internal message-handling worker.
#   const.js,
#   errors.js,
#   classes.js,
#   types.js,
#   index.js,
#   utils.js         — Sibling ESM modules that worker.js imports
#                      relatively.  All must be co-located.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"

# npm hoists ffmpeg packages to the workspace root in our setup.
CORE_SRC="$REPO_ROOT/node_modules/@ffmpeg/core/dist/esm"
FFMPEG_ESM_SRC="$REPO_ROOT/node_modules/@ffmpeg/ffmpeg/dist/esm"
DEST="$WEB_DIR/public/ffmpeg"

if [[ ! -d "$CORE_SRC" ]]; then
    echo "ERROR: $CORE_SRC not found.  Run 'npm install' first." >&2
    exit 1
fi
if [[ ! -d "$FFMPEG_ESM_SRC" ]]; then
    echo "ERROR: $FFMPEG_ESM_SRC not found.  Run 'npm install' first." >&2
    exit 1
fi

mkdir -p "$DEST"

cp "$CORE_SRC/ffmpeg-core.js"   "$DEST/"
cp "$CORE_SRC/ffmpeg-core.wasm" "$DEST/"
cp "$FFMPEG_ESM_SRC"/*.js       "$DEST/"

echo "[ok] staged $(ls "$DEST" | wc -l) files into public/ffmpeg/"
ls -lh "$DEST"
