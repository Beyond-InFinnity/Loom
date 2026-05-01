#!/usr/bin/env bash
# Fetch the bundled Noto font set into apps/desktop/src-tauri/resources/fonts/.
#
# Track A staging set (3 scripts, ~20 MB):
#   - Noto Sans (Latin / Greek / Cyrillic)
#   - Noto Sans JP (modern per-region CJK split — Japanese subset)
#   - Noto Sans Hebrew
#
# Each release ships many weights; we keep only Regular + Bold per the 3c
# bundling design (cuts CJK size by ~75% vs shipping every weight).
#
# Idempotent: re-running is a no-op if the target files already exist.
# To force a refresh, delete the target files first.
#
# Requirements: curl, unzip.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/apps/desktop/src-tauri/resources/fonts"
mkdir -p "$DEST"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# args: <out_basename> <github_owner/repo> <release_tag> <asset_filename> <pattern_regular> <pattern_bold>
fetch_pair() {
    local out_base="$1"
    local repo="$2"
    local tag="$3"
    local asset="$4"
    local pat_regular="$5"
    local pat_bold="$6"

    local target_regular="$DEST/${out_base}-Regular"
    local target_bold="$DEST/${out_base}-Bold"

    # Skip if both already present (any extension).
    if compgen -G "${target_regular}.*" > /dev/null && compgen -G "${target_bold}.*" > /dev/null; then
        echo "[skip] $out_base — already present"
        return 0
    fi

    local url="https://github.com/${repo}/releases/download/${tag}/${asset}"
    local zip_path="$STAGE/${asset}"
    local extract_dir="$STAGE/${out_base}_extract"

    echo "[fetch] $out_base ← $url"
    curl -fsSL -o "$zip_path" "$url"

    mkdir -p "$extract_dir"
    unzip -q "$zip_path" -d "$extract_dir"

    local found_regular found_bold
    found_regular="$(find "$extract_dir" -type f \( -iname "*.ttf" -o -iname "*.otf" \) | grep -E "$pat_regular" | head -1)"
    found_bold="$(find "$extract_dir" -type f \( -iname "*.ttf" -o -iname "*.otf" \) | grep -E "$pat_bold" | head -1)"

    if [[ -z "$found_regular" ]]; then
        echo "[error] no Regular face matched /$pat_regular/ in $asset" >&2
        exit 1
    fi
    if [[ -z "$found_bold" ]]; then
        echo "[error] no Bold face matched /$pat_bold/ in $asset" >&2
        exit 1
    fi

    cp "$found_regular" "${target_regular}.${found_regular##*.}"
    cp "$found_bold" "${target_bold}.${found_bold##*.}"
    echo "[ok]    $out_base — Regular: $(basename "$found_regular"), Bold: $(basename "$found_bold")"
}

# Patterns are anchored on the canonical Noto naming so we don't accidentally
# pick e.g. "SemiBold" when "Bold" is requested. The (\.|/) prefix ensures the
# match is bounded by a path separator or extension dot, not a prior word.
fetch_pair "NotoSans" \
    "notofonts/latin-greek-cyrillic" \
    "NotoSans-v2.015" \
    "NotoSans-v2.015.zip" \
    "NotoSans-Regular\.(ttf|otf)$" \
    "NotoSans-Bold\.(ttf|otf)$"

fetch_pair "NotoSansJP" \
    "notofonts/noto-cjk" \
    "Sans2.004" \
    "16_NotoSansJP.zip" \
    "NotoSansJP-Regular\.(ttf|otf)$" \
    "NotoSansJP-Bold\.(ttf|otf)$"

fetch_pair "NotoSansHebrew" \
    "notofonts/hebrew" \
    "NotoSansHebrew-v3.001" \
    "NotoSansHebrew-v3.001.zip" \
    "NotoSansHebrew-Regular\.(ttf|otf)$" \
    "NotoSansHebrew-Bold\.(ttf|otf)$"

echo ""
echo "Done. Bundled fonts in: $DEST"
ls -lh "$DEST"
