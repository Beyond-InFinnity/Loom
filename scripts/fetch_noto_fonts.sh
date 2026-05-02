#!/usr/bin/env bash
# Fetch the bundled Noto font set into apps/desktop/src-tauri/resources/fonts/.
#
# Full design manifest:
#   * Noto Sans (Latin / Greek / Cyrillic) — catch-all baseline
#   * Noto Sans CJK split — JP, KR, SC, TC (one per region)
#   * Noto Sans Thai
#   * Noto Naskh Arabic — Arabic + Persian (شاهد uses Naskh)
#   * Noto Nastaliq Urdu — Urdu's calligraphic style (single weight)
#   * Noto Sans Hebrew
#   * Noto Sans for each Indic script: Devanagari, Bengali, Tamil,
#     Telugu, Gujarati, Gurmukhi
#
# Each release ships many weights; we keep only Regular + Bold (or the
# single shipped weight for Nastaliq) per the 3c bundling design — cuts
# CJK size by ~75% vs shipping every weight.  Total ~45 MB on disk.
#
# Idempotent: re-running is a no-op if target files already exist.
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

# args: <out_basename> <github_owner/repo> <release_tag> <asset_filename> <pattern_face>
# Used for single-weight families like Nastaliq Urdu (calligraphic
# scripts ship a single weight; "Bold" Nastaliq doesn't really exist).
fetch_single() {
    local out_base="$1"
    local repo="$2"
    local tag="$3"
    local asset="$4"
    local pat="$5"

    local target="$DEST/${out_base}-Regular"
    if compgen -G "${target}.*" > /dev/null; then
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

    local found
    found="$(find "$extract_dir" -type f \( -iname "*.ttf" -o -iname "*.otf" \) | grep -E "$pat" | head -1)"

    if [[ -z "$found" ]]; then
        echo "[error] no face matched /$pat/ in $asset" >&2
        exit 1
    fi

    cp "$found" "${target}.${found##*.}"
    echo "[ok]    $out_base — $(basename "$found")"
}

# ── Latin / Cyrillic / Greek catch-all ───────────────────────────────
fetch_pair "NotoSans" \
    "notofonts/latin-greek-cyrillic" \
    "NotoSans-v2.015" \
    "NotoSans-v2.015.zip" \
    "NotoSans-Regular\.(ttf|otf)$" \
    "NotoSans-Bold\.(ttf|otf)$"

# ── CJK regional split (JP / KR / SC / TC) ───────────────────────────
# Each region's typographic family gets its own .otf so unicode-range
# routing in the @font-face emitter can place a codepoint to the right
# regional variant — Simplified 国 ↔ Traditional 國 disambiguation
# depends on these being separate faces.
fetch_pair "NotoSansJP" \
    "notofonts/noto-cjk" \
    "Sans2.004" \
    "16_NotoSansJP.zip" \
    "NotoSansJP-Regular\.(ttf|otf)$" \
    "NotoSansJP-Bold\.(ttf|otf)$"

fetch_pair "NotoSansKR" \
    "notofonts/noto-cjk" \
    "Sans2.004" \
    "17_NotoSansKR.zip" \
    "NotoSansKR-Regular\.(ttf|otf)$" \
    "NotoSansKR-Bold\.(ttf|otf)$"

fetch_pair "NotoSansSC" \
    "notofonts/noto-cjk" \
    "Sans2.004" \
    "18_NotoSansSC.zip" \
    "NotoSansSC-Regular\.(ttf|otf)$" \
    "NotoSansSC-Bold\.(ttf|otf)$"

fetch_pair "NotoSansTC" \
    "notofonts/noto-cjk" \
    "Sans2.004" \
    "19_NotoSansTC.zip" \
    "NotoSansTC-Regular\.(ttf|otf)$" \
    "NotoSansTC-Bold\.(ttf|otf)$"

# ── Thai ──────────────────────────────────────────────────────────────
fetch_pair "NotoSansThai" \
    "notofonts/thai" \
    "NotoSansThai-v2.002" \
    "NotoSansThai-v2.002.zip" \
    "NotoSansThai-Regular\.(ttf|otf)$" \
    "NotoSansThai-Bold\.(ttf|otf)$"

# ── Arabic / Persian (Naskh covers both) ─────────────────────────────
fetch_pair "NotoNaskhArabic" \
    "notofonts/arabic" \
    "NotoNaskhArabic-v2.021" \
    "NotoNaskhArabic-v2.021.zip" \
    "NotoNaskhArabic-Regular\.(ttf|otf)$" \
    "NotoNaskhArabic-Bold\.(ttf|otf)$"

# ── Urdu (Nastaliq is single-weight by design) ───────────────────────
fetch_single "NotoNastaliqUrdu" \
    "notofonts/nastaliq" \
    "NotoNastaliqUrdu-v4.000" \
    "NotoNastaliqUrdu-v4.000.zip" \
    "NotoNastaliqUrdu-Regular\.(ttf|otf)$"

# ── Hebrew ────────────────────────────────────────────────────────────
fetch_pair "NotoSansHebrew" \
    "notofonts/hebrew" \
    "NotoSansHebrew-v3.001" \
    "NotoSansHebrew-v3.001.zip" \
    "NotoSansHebrew-Regular\.(ttf|otf)$" \
    "NotoSansHebrew-Bold\.(ttf|otf)$"

# ── Indic scripts (Devanagari, Bengali, Tamil, Telugu, Gujarati, Gurmukhi)
fetch_pair "NotoSansDevanagari" \
    "notofonts/devanagari" \
    "NotoSansDevanagari-v2.006" \
    "NotoSansDevanagari-v2.006.zip" \
    "NotoSansDevanagari-Regular\.(ttf|otf)$" \
    "NotoSansDevanagari-Bold\.(ttf|otf)$"

fetch_pair "NotoSansBengali" \
    "notofonts/bengali" \
    "NotoSansBengali-v3.011" \
    "NotoSansBengali-v3.011.zip" \
    "NotoSansBengali-Regular\.(ttf|otf)$" \
    "NotoSansBengali-Bold\.(ttf|otf)$"

fetch_pair "NotoSansTamil" \
    "notofonts/tamil" \
    "NotoSansTamil-v2.004" \
    "NotoSansTamil-v2.004.zip" \
    "NotoSansTamil-Regular\.(ttf|otf)$" \
    "NotoSansTamil-Bold\.(ttf|otf)$"

fetch_pair "NotoSansTelugu" \
    "notofonts/telugu" \
    "NotoSansTelugu-v2.005" \
    "NotoSansTelugu-v2.005.zip" \
    "NotoSansTelugu-Regular\.(ttf|otf)$" \
    "NotoSansTelugu-Bold\.(ttf|otf)$"

fetch_pair "NotoSansGujarati" \
    "notofonts/gujarati" \
    "NotoSansGujarati-v2.106" \
    "NotoSansGujarati-v2.106.zip" \
    "NotoSansGujarati-Regular\.(ttf|otf)$" \
    "NotoSansGujarati-Bold\.(ttf|otf)$"

fetch_pair "NotoSansGurmukhi" \
    "notofonts/gurmukhi" \
    "NotoSansGurmukhi-v2.004" \
    "NotoSansGurmukhi-v2.004.zip" \
    "NotoSansGurmukhi-Regular\.(ttf|otf)$" \
    "NotoSansGurmukhi-Bold\.(ttf|otf)$"

echo ""
echo "Done. Bundled fonts in: $DEST"
ls -lh "$DEST"
