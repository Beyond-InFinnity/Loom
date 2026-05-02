#!/usr/bin/env bash
# Populate apps/desktop/src-tauri/resources/ with everything the
# bundled Tauri desktop app needs at runtime:
#
#   resources/fonts/                — Noto fonts (~48 MB)
#   resources/python/runtime/       — python-build-standalone CPython
#                                     (~85 MB install_only flavour)
#   resources/python/venv/          — relocatable venv with all deps
#                                     (~150 MB minus torch)
#   resources/python/source/        — loom_core + loom_api source
#                                     (~few MB)
#   resources/playwright-browsers/  — Chromium for Playwright (~170 MB)
#
# Total ~450 MB, dominated by Chromium + the full venv (CPU-only torch
# is ~200 MB rather than the default ~800 MB CUDA wheel).
#
# Idempotent: re-running rebuilds only the parts that are missing.
# To force a clean rebuild, delete the relevant subdirectory first.
#
# Requirements:
#   * uv (https://astral.sh/uv) — falls back to ~/.local/bin/uv install
#     if not on PATH
#   * curl, unzip (transitively required by fetch_noto_fonts.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$REPO_ROOT/apps/desktop/src-tauri/resources"
PY_DIR="$RES/python"
RUNTIME_DIR="$PY_DIR/runtime"
VENV_DIR="$PY_DIR/venv"
SRC_DIR="$PY_DIR/source"
BROWSERS_DIR="$RES/playwright-browsers"

# Pin Python version.  Major.Minor lets uv pick the latest stable
# patch in that line; bump to a full X.Y.Z if reproducibility across
# build hosts becomes blocking.
PY_VER="3.11"

mkdir -p "$RES" "$PY_DIR" "$BROWSERS_DIR"

# ── uv discovery ─────────────────────────────────────────────────────
# uv may not be on PATH (Astral installer drops it in ~/.local/bin/).
if command -v uv >/dev/null 2>&1; then
    UV="$(command -v uv)"
elif [[ -x "$HOME/.local/bin/uv" ]]; then
    UV="$HOME/.local/bin/uv"
else
    echo "[error] uv not installed.  Run:" >&2
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
fi
echo "[uv]    $($UV --version)"

# ── Step 1: fonts ────────────────────────────────────────────────────
echo ""
echo "=== Step 1/4: Noto fonts ==="
bash "$REPO_ROOT/scripts/fetch_noto_fonts.sh"

# ── Step 2: bundled Python interpreter ───────────────────────────────
echo ""
echo "=== Step 2/4: python-build-standalone interpreter ==="
if [[ ! -d "$RUNTIME_DIR" ]] || ! find "$RUNTIME_DIR" -name 'python3*' -type f -executable | grep -q .; then
    mkdir -p "$RUNTIME_DIR"
    UV_PYTHON_INSTALL_DIR="$RUNTIME_DIR" "$UV" python install "$PY_VER"
else
    echo "[skip]  interpreter already in $RUNTIME_DIR"
fi

# Resolve the actual python binary uv installed.  uv lays out as
#   $RUNTIME_DIR/cpython-3.11.X-linux-x86_64-gnu/bin/python3.11
# (note: only the X.Y-suffixed binary is created, not a bare python3
# symlink).
PY_BIN="$(find "$RUNTIME_DIR" -path '*/bin/python3.[0-9]*' -type f \
    ! -name '*-config' | head -1)"
if [[ -z "$PY_BIN" ]]; then
    echo "[error] could not locate bundled python3.X under $RUNTIME_DIR" >&2
    exit 1
fi
echo "[ok]    interpreter: $PY_BIN ($($PY_BIN --version))"

# uv venv links bin/python to the runtime interpreter via an *absolute*
# symlink.  After Tauri bundles the resource tree to e.g.
# /usr/lib/<app>/resources/, that absolute target no longer exists and
# the venv is broken.  Convert to a relative symlink within the tree.
RUNTIME_PY_REL="$(realpath --relative-to="$PY_DIR/venv/bin" "$PY_BIN")"
fix_venv_python_symlink() {
    if [[ -L "$PY_DIR/venv/bin/python" ]]; then
        local current
        current="$(readlink "$PY_DIR/venv/bin/python")"
        # If already relative (doesn't start with /) and points where we
        # want, leave it alone.
        if [[ "$current" != /* && "$current" == "$RUNTIME_PY_REL" ]]; then
            return 0
        fi
    fi
    ln -sfn "$RUNTIME_PY_REL" "$PY_DIR/venv/bin/python"
    echo "[fix]   venv/bin/python → $RUNTIME_PY_REL (relative)"
}

# ── Step 3: relocatable venv + deps ──────────────────────────────────
echo ""
echo "=== Step 3/4: venv + Python deps ==="
if [[ ! -d "$VENV_DIR" ]]; then
    "$UV" venv "$VENV_DIR" --python "$PY_BIN" --relocatable --seed
else
    echo "[skip]  venv already at $VENV_DIR"
fi

# Always run the symlink fixup — re-running setup_bundle.sh after
# moving / re-extracting the resource tree should converge to a
# relative symlink.
fix_venv_python_symlink

VENV_PY="$VENV_DIR/bin/python"

# Install CPU-only torch first so the subsequent requirements.txt
# resolve sees torch already satisfied and doesn't pull the ~800 MB
# CUDA wheel.  Loom's only torch-dependent path is pythainlp's
# thai2rom neural romanizer; CPU inference is fine for that.
echo "[deps]  torch (CPU-only)"
VIRTUAL_ENV="$VENV_DIR" "$UV" pip install \
    --python "$VENV_PY" \
    --index-url "https://download.pytorch.org/whl/cpu" \
    torch

# Rest of requirements.  Streamlit is in requirements.txt for the
# dev/debug client; the bundled FastAPI sidecar doesn't need it
# (or its data stack: pyarrow, pydeck, altair).  Install everything
# from one source of truth, then uninstall the dev-only stack — saves
# ~200 MB (pyarrow alone is 149 MB).
echo "[deps]  requirements.txt (FastAPI + romanizers + ML deps)"
VIRTUAL_ENV="$VENV_DIR" "$UV" pip install \
    --python "$VENV_PY" \
    -r "$REPO_ROOT/requirements.txt"

# Strip dev/debug-only packages from the bundled venv.  uv pip
# uninstall is no-op-tolerant (warns if not installed), so re-runs
# of setup_bundle.sh after this step are idempotent.
echo "[trim]  remove dev-only stack (streamlit + data viz)"
VIRTUAL_ENV="$VENV_DIR" "$UV" pip uninstall \
    --python "$VENV_PY" \
    streamlit pyarrow pydeck altair pandas \
    || true

# Loom source — copy loom_core + loom_api into a dedicated source
# directory.  Sidecar spawn will set cwd here so `loom_api.main:app`
# resolves without PYTHONPATH gymnastics.  Copy (not symlink) so the
# installed app is self-contained.
echo "[src]   copy loom_core + loom_api → $SRC_DIR"
mkdir -p "$SRC_DIR"
rsync -a --delete \
    --exclude='__pycache__' --exclude='*.pyc' --exclude='.pytest_cache' \
    "$REPO_ROOT/loom_core" "$REPO_ROOT/loom_api" "$SRC_DIR/"

# ── Step 4: Playwright Chromium ──────────────────────────────────────
echo ""
echo "=== Step 4/4: Playwright Chromium ==="
# Only install if the chromium-* dir under PLAYWRIGHT_BROWSERS_PATH is
# missing.  Playwright stamps a per-revision dir; presence of any
# chromium-NNNN dir means it's already there.
if find "$BROWSERS_DIR" -maxdepth 1 -name 'chromium-*' -type d 2>/dev/null | grep -q .; then
    echo "[skip]  Chromium already at $BROWSERS_DIR"
else
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" "$VENV_PY" -m playwright install chromium
fi

# Drop the chromium-headless-shell (~257 MB) — Playwright auto-fetches
# it as a sibling but our rasterizer launches the regular chromium for
# both headed and headless paths.  The shell is only used when a
# caller explicitly requests channel='chromium-headless-shell'.
if find "$BROWSERS_DIR" -maxdepth 1 -name 'chromium_headless_shell-*' -type d 2>/dev/null | grep -q .; then
    echo "[trim]  remove chromium_headless_shell (unused)"
    rm -rf "$BROWSERS_DIR"/chromium_headless_shell-*
fi

# ── Cleanup: prune __pycache__ + .pyc / .pyo ─────────────────────────
# Tauri's resources/python/**/* glob would otherwise sweep every
# bytecode cache dir into the bundle.  Cheap to drop here; CPython
# regenerates on first import inside the bundled venv.
echo ""
echo "=== Cleanup: prune bytecode caches ==="
PYCACHE_BEFORE="$(du -sh "$PY_DIR" 2>/dev/null | cut -f1)"
find "$PY_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$PY_DIR" \( -name '*.pyc' -o -name '*.pyo' \) -delete 2>/dev/null || true
PYCACHE_AFTER="$(du -sh "$PY_DIR" 2>/dev/null | cut -f1)"
echo "[trim]  python/ ${PYCACHE_BEFORE} → ${PYCACHE_AFTER}"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=== Bundle ready ==="
du -sh "$RES"/* 2>/dev/null | sort -h
echo ""
echo "Next: cd apps/desktop && npm run tauri build"
