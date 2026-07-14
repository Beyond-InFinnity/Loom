#!/usr/bin/env bash
#
# build-libmpv.sh — build a modern, self-contained libmpv.so for the Loom Player.
#
# WHY THIS EXISTS
#   The Player renders 4K via libmpv's OpenGL render API.  Smooth 4K on Intel/AMD
#   needs VAAPI hardware decode imported zero-copy into an EGL GL context
#   (EGL-dmabuf interop — proven: Godzilla 2160p @ 23.976fps, 0 drops).  That
#   requires libmpv built WITH `egl-x11` + `vaapi`, and a libmpv new enough to not
#   treat the VA surface-attribute probe as fatal (Ubuntu jammy's 0.34.1 does, and
#   falls back to a per-frame RAM copy — the ~8-15fps stutter).  No distro's libmpv
#   can be relied on for this, so the Player BUNDLES its own; this script builds it.
#
#   ffmpeg + libplacebo + libass are compiled STATIC and linked into libmpv, so the
#   result is one self-contained libmpv.so whose only external deps are ubiquitous
#   system libs (libva/libEGL/libX11/libc) — i.e. the relocatable bundle artifact.
#
# NO-SUDO POSTURE
#   Build tools (meson/ninja/nasm) come from an isolated conda prefix and are put on
#   PATH by *symlink only* (never activated) so their libs can't shadow system libs
#   during the ffmpeg/mpv link.  The ONLY sudo requirement is a handful of leaf -dev
#   headers; the script detects what's missing and prints the single apt line.
#
# USAGE
#   scripts/build-libmpv.sh            # build + install to vendor/mpv-prefix
#   Re-run after the printed `sudo apt install` line the first time.
#
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor"
MPVBUILD="$VENDOR/mpv-build"
BUILDTOOLS="$VENDOR/buildtools"          # conda: meson/ninja/nasm (no sudo)
TOOLBIN="$VENDOR/toolbin"                # symlinks to the 3 tools (keeps `python3` = system)
PREFIX="$VENDOR/mpv-prefix"              # libmpv.so + mpv binary land here
JOBS="$(nproc)"

# ---------------------------------------------------------------------------
# 1. Leaf system -dev deps — the ONLY sudo requirement.
#    (freetype/fontconfig/harfbuzz/fribidi/x11/egl/xrandr already present on this box.)
# ---------------------------------------------------------------------------
REQ_PKGS=(
  libva-dev libdrm-dev libgl1-mesa-dev libegl1-mesa-dev
  libx11-dev libxext-dev libxpresent-dev libxss-dev libxv-dev
  libfreetype6-dev libfontconfig1-dev libharfbuzz-dev libfribidi-dev
  libpulse-dev liblua5.2-dev
  autoconf automake libtool          # libass ./autogen.sh
)
missing=()
for p in "${REQ_PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if (( ${#missing[@]} )); then
  echo
  echo ">> Missing system -dev packages.  Run this ONE line, then re-run this script:"
  echo
  echo "     sudo apt install -y ${missing[*]}"
  echo
  exit 3
fi

# also need a C toolchain + make + pkg-config (apt: build-essential)
for t in gcc make pkg-config; do
  command -v "$t" >/dev/null || { echo ">> Missing '$t' — sudo apt install -y build-essential pkg-config"; exit 3; }
done

# ---------------------------------------------------------------------------
# 2. Build tools (no sudo): meson / ninja / nasm from an isolated conda prefix,
#    exposed via symlink so PATH does NOT gain conda's python3 (glad + mpv build
#    scripts then run on the system python3, avoiding conda's bleeding-edge py).
# ---------------------------------------------------------------------------
if [[ ! -x "$BUILDTOOLS/bin/meson" || ! -x "$BUILDTOOLS/bin/ninja" || ! -x "$BUILDTOOLS/bin/nasm" ]]; then
  CONDA_BASE="$(conda info --base 2>/dev/null || echo /home/connor/miniconda3)"
  # shellcheck disable=SC1091
  source "$CONDA_BASE/etc/profile.d/conda.sh"
  echo ">> staging meson/ninja/nasm into $BUILDTOOLS (conda-forge, no sudo)…"
  conda create -p "$BUILDTOOLS" -c conda-forge meson ninja nasm -y
fi
mkdir -p "$TOOLBIN"
for t in meson ninja nasm; do ln -sf "$BUILDTOOLS/bin/$t" "$TOOLBIN/$t"; done
export PATH="$TOOLBIN:$PATH"
command -v meson ninja nasm >/dev/null || { echo ">> build tools not on PATH"; exit 4; }
echo ">> tools: $(meson --version) meson, $(ninja --version) ninja, $(nasm -v | head -1)"
echo ">> python3 for build scripts: $(command -v python3) ($(python3 --version 2>&1))"

# ---------------------------------------------------------------------------
# 3. Fetch + pin sources.
#    NOTE: 'release' = latest release tag of each (maintainer-compatible set).
#    After the first green build, replace with exact @tags for full reproducibility
#    (switch-branch <name> @<tag>) — the resolved versions are printed at the end.
# ---------------------------------------------------------------------------
[[ -d "$MPVBUILD" ]] || git clone https://github.com/mpv-player/mpv-build.git "$MPVBUILD"
cd "$MPVBUILD"
scripts/switch-branch ffmpeg     release
scripts/switch-branch libplacebo release
scripts/switch-branch mpv        release
scripts/switch-branch libass     master
./update --skip-selfupdate       # respects the config/branch-* pins; no self git-pull

# ---------------------------------------------------------------------------
# 4. Component options.
# ---------------------------------------------------------------------------
# ffmpeg: force-enable vaapi (fail loud if libva missing); skip the CLI programs.
printf '%s\n' --enable-vaapi --disable-programs > ffmpeg_options
# mpv: SHARED libmpv, local prefix, and the exact render features the Player needs.
printf '%s\n' \
  -Dlibmpv=true -Dcplayer=true -Dprefix="$PREFIX" \
  -Dvaapi=enabled -Dvaapi-x11=enabled \
  -Degl=enabled -Degl-x11=enabled \
  -Dgl=enabled -Dgl-x11=enabled \
  -Dx11=enabled -Dlua=enabled \
  > mpv_options

# ---------------------------------------------------------------------------
# 5. Build (ffmpeg + libplacebo + libass static → linked into mpv/libmpv).
# ---------------------------------------------------------------------------
echo ">> building (this compiles ffmpeg from source — ~20-40 min)…"
./build -j"$JOBS"

# ---------------------------------------------------------------------------
# 6. Install to the local prefix (no sudo — $PREFIX is ours).
# ---------------------------------------------------------------------------
./install

# ---------------------------------------------------------------------------
# 7. Verify the artifact.
# ---------------------------------------------------------------------------
echo
echo "=================================================================="
echo "libmpv:  $(ls "$PREFIX"/lib/libmpv.so* 2>/dev/null)"
"$PREFIX/bin/mpv" --version | head -1
echo ">> gpu-context must list x11egl:"
"$PREFIX/bin/mpv" --gpu-context=help 2>&1 | grep -iE "x11egl|drm-egl" || echo "   (!!) x11egl NOT present — check egl-x11 feature"
echo ">> resolved source versions (pin these into section 3 for reproducibility):"
for c in ffmpeg libplacebo libass mpv; do
  printf "     %-11s %s\n" "$c" "$(git -C "$MPVBUILD/$c" describe --tags --always 2>/dev/null || echo '?')"
done
echo "=================================================================="
