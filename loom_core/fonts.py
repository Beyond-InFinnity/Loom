"""Font availability + glyph-coverage validation.

Two independent questions this module answers:

  1. **Availability** — is the requested family present in any indexed
     font directory?  No automatic substitution happens here — at
     render time the rasterizer (libass / Chromium) will pick a
     fallback if the font isn't shipped.  The validator surfaces this
     up-front by setting ``is_fallback`` when the requested family
     isn't found.

  2. **Glyph coverage** — does the resolved font actually contain
     glyphs for the characters we plan to render?  A Latin-only font
     may be perfectly available yet render Japanese as tofu boxes
     because its cmap has no hiragana/kanji.

Backed by a :class:`FontScanner` — a fontTools-only directory walker
that builds family-name and cmap maps once, then answers queries in
memory.  No fontconfig / fc-match dependency, so the same backend is
used identically on Linux, macOS, and Windows.

The 3c bundling track will point the scanner at a Tauri resource
directory containing the bundled Noto fonts.  Until then, the default
scanner probes platform-conventional system font directories so dev
and CI work without configuration.
"""

from __future__ import annotations

import functools
import os
import sys
import threading
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

# Maximum number of missing characters to report.  Useful for diagnostics
# without producing a thousand-char warning when someone picks an
# English-only font for a Korean subtitle track.
_MAX_REPORTED_MISSING = 8

_FONT_EXTS = frozenset({'.ttf', '.otf', '.ttc'})

# Name table record IDs we read.  Priority order — we keep the first
# usable string we find for each font face.
#   16 = Typographic Family (preferred when present; matches the user-
#        visible family name in modern font menus, e.g. "Noto Sans" for
#        all weights including "Noto Sans Light").
#    1 = Family Name (legacy 4-style family — splits weights across
#        family names on older fonts).
#    4 = Full Font Name (used as a last-resort match target so users
#        can ask for "Noto Sans CJK JP Regular" verbatim).
_NAME_RECORD_PRIORITY = (16, 1, 4)


# ---------------------------------------------------------------------------
# Per-language representative characters.  A font "covers" a language when
# its cmap includes every character in the relevant set.
#
# Design choices:
#   * The sets are deliberately small — 3 to 6 chars each — so the cost of
#     a full check is negligible.  They cover the minimum feature surface
#     that distinguishes the script: a consonant, a vowel/matra, a
#     diacritic, and any uniquely-shaped feature (Traditional vs
#     Simplified differentiator, nukta, pulli, etc.).
#   * Traditional + Simplified Chinese share Han ideographs but differ on
#     specific chars: 國 (TC) vs 国 (SC).  A font that has 国 but not
#     國 covers Simplified-only; we include one discriminator per variant.
#   * CJK Korean + Japanese share Han ideographs, but Korean text depends
#     on the Hangul block — 한 / 가 are the strongest coverage signal.
# ---------------------------------------------------------------------------

_LANG_COVERAGE_SAMPLES: dict[str, frozenset[str]] = {
    # Latin-script baselines (most fonts pass these trivially)
    "en": frozenset("Aa0,."),
    "vi": frozenset("ăâđêôơư"),      # Vietnamese-specific diacritics

    # CJK
    "ja": frozenset("あアー語"),        # hiragana, katakana, chōon, kanji
    "ko": frozenset("한국가"),          # Hangul syllable blocks
    "zh-hans": frozenset("国你好"),     # Simplified discriminator: 国
    "zh-hant": frozenset("國學"),       # Traditional discriminator: 國
    "zh": frozenset("你好"),            # Bare zh = shared chars only
    "yue": frozenset("國你好"),         # Cantonese uses Traditional

    # Cyrillic
    "ru": frozenset("АаЯя"),
    "uk": frozenset("єіїґ"),           # Ukrainian-unique chars
    "be": frozenset("ўіӯ"),            # Belarusian-unique
    "sr": frozenset("љњђћџј"),         # Serbian-unique
    "bg": frozenset("АаЯя"),           # Bulgarian = baseline Cyrillic
    "mk": frozenset("ѓќѕ"),            # Macedonian-unique
    "mn": frozenset("ӨөҮү"),           # Mongolian Cyrillic-unique

    # Thai
    "th": frozenset("กลืัำ"),         # consonants + matras + tones

    # Indic
    "hi": frozenset("नमस्ेी"),          # Devanagari: consonant + virama + matra
    "bn": frozenset("নমস্েী"),          # Bengali
    "ta": frozenset("வணக்ம"),          # Tamil (pulli ் as virama)
    "te": frozenset("నమస్ెీ"),          # Telugu
    "gu": frozenset("નમસ્ેી"),          # Gujarati
    "pa": frozenset("ਸਤ੍ੀ"),             # Gurmukhi

    # RTL scripts (R5-4 + Hebrew pilot)
    "ar": frozenset("السلامعلي"),       # Arabic core
    "fa": frozenset("پچژگ"),           # Farsi adds 4 chars to Arabic
    "ur": frozenset("ٹڈڑںے"),          # Urdu-specific additions
    "he": frozenset("אבשלםןץ"),         # Hebrew incl. final forms
    "yi": frozenset("אבײאָ"),           # Yiddish incl. digraph yod-yod
}


@dataclass
class FontValidation:
    """Result of validating a font family name.

    Fields
    ------
    font_name : str
        The requested family (echoed back).
    resolved_path : str | None
        Absolute path to the font file the scanner indexed under this
        family name, or ``None`` when the family isn't in any scanned
        directory.
    resolved_family : str | None
        Display family name as it appears in the font's ``name`` table
        — may differ in casing / spacing from ``font_name``.  ``None``
        when the family isn't found.
    resolved_index : int
        For TrueType Collections (TTC), the font index inside the file.
        0 when not a collection or unknown.
    is_fallback : bool
        True when the requested family wasn't found in any scanned
        directory.  At render time the renderer will pick a system /
        engine fallback — that substitution is what this flag warns
        about.  Always False when the font is found.
    coverage_ok : bool | None
        True when every checked character is in the font's cmap, False
        when some are missing, None when no coverage check was performed
        (no lang_code / text given, or the font wasn't found).
    missing_chars : list[str]
        Characters that were checked and NOT found in the font's cmap.
        Capped at eight for diagnostic readability.
    warnings : list[str]
        Human-readable messages explaining missing fonts / missing
        coverage.  Empty list when everything is clean.
    """

    font_name: str
    resolved_path: str | None = None
    resolved_family: str | None = None
    resolved_index: int = 0
    is_fallback: bool = False
    coverage_ok: bool | None = None
    missing_chars: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_family(name: str | None) -> str:
    """Case-insensitive, whitespace-collapsed family name for comparison."""
    return " ".join((name or "").lower().split())


def _primary_subtag(lang_code: str) -> str:
    return (lang_code or "").lower().split("-")[0].split("_")[0]


def _coverage_sample_for(lang_code: str | None) -> frozenset[str] | None:
    """Look up the representative char sample for *lang_code*.

    Tries the full lowercased code first (so ``zh-Hans`` maps to its
    Simplified-specific set), then falls back to the primary subtag.
    """
    if not lang_code:
        return None
    lc = lang_code.lower()
    if lc in _LANG_COVERAGE_SAMPLES:
        return _LANG_COVERAGE_SAMPLES[lc]
    primary = _primary_subtag(lang_code)
    return _LANG_COVERAGE_SAMPLES.get(primary)


def _chars_not_in_cmap(cmap_codepoints: frozenset[int], chars) -> list[str]:
    """Return characters from *chars* whose codepoints are NOT in the
    cmap.  Preserves the order of first appearance in *chars*."""
    missing: list[str] = []
    seen: set[str] = set()
    for ch in chars:
        if ch in seen:
            continue
        seen.add(ch)
        if ord(ch) not in cmap_codepoints:
            missing.append(ch)
    return missing


def _default_system_font_dirs() -> list[Path]:
    """Platform-conventional font directories.  Used by the default
    scanner when no LOOM_FONT_DIR is set.

    Returns paths regardless of whether they exist; the scanner filters
    non-existent dirs at construction time.
    """
    home = Path.home()
    if sys.platform == "darwin":
        return [
            Path("/System/Library/Fonts"),
            Path("/Library/Fonts"),
            home / "Library" / "Fonts",
            # Homebrew (Apple Silicon) — picks up `brew install --cask
            # font-noto-sans-cjk` and similar.
            Path("/opt/homebrew/share/fonts"),
            # Homebrew (Intel) fallback path.
            Path("/usr/local/share/fonts"),
        ]
    if sys.platform.startswith("win"):
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        local_app = os.environ.get("LOCALAPPDATA")
        dirs = [windir / "Fonts"]
        if local_app:
            dirs.append(Path(local_app) / "Microsoft" / "Windows" / "Fonts")
        return dirs
    # Linux / other Unix.
    return [
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
        home / ".local" / "share" / "fonts",
        home / ".fonts",
    ]


# ---------------------------------------------------------------------------
# FontScanner — the fontTools-only backend
# ---------------------------------------------------------------------------

class FontScanner:
    """Indexes one or more font directories and answers family-name +
    cmap queries against them.

    The index is built lazily on first query and rebuilt when a
    directory's mtime changes.  Thread-safe — all index access goes
    through an internal lock.

    Resolution semantics differ from fontconfig:
      * fontconfig always returns *some* font (silent substitution).
      * FontScanner returns ``None`` when a family isn't indexed —
        callers can decide whether to warn, fall through to a default,
        or fail.

    For tests, construct directly with a controlled directory; for
    production use the module-level :func:`get_default_scanner`.
    """

    def __init__(self, directories: list[Path | str] | None = None):
        if directories is None:
            directories = _default_system_font_dirs()
        # Filter to existing dirs, resolve to absolute, dedupe.
        seen: set[Path] = set()
        self._dirs: list[Path] = []
        for d in directories:
            p = Path(d)
            try:
                if not p.is_dir():
                    continue
                resolved = p.resolve()
            except OSError:
                continue
            if resolved in seen:
                continue
            seen.add(resolved)
            self._dirs.append(resolved)

        self._lock = threading.Lock()
        # normalized family name → list of (path, ttc_index) faces.
        # First-indexed face wins on resolve(); duplicates are still
        # tracked so callers asking for cmaps via cmap_for() find them.
        self._families: dict[str, list[tuple[str, int]]] = {}
        # normalized family → display name (first-seen casing/spacing).
        self._display_names: dict[str, str] = {}
        # (path, ttc_index) → cmap codepoints frozenset.
        self._cmaps: dict[tuple[str, int], frozenset[int]] = {}
        # (path, ttc_index) → preferred display family for that face
        # (typographic family if present, else legacy family).  Used by
        # iter_faces() to emit one @font-face block per face under a
        # canonical family name.
        self._face_families: dict[tuple[str, int], str] = {}
        # (path, ttc_index) → OS/2 usWeightClass (raw, e.g. 400/700).
        # Defaults to 400 when the face's OS/2 table is absent or
        # unreadable.
        self._face_weights: dict[tuple[str, int], int] = {}
        # Per-directory rglob mtime snapshot for lazy rebuild.
        self._dir_mtimes: dict[Path, float] = {}
        self._built = False

    # ── introspection ─────────────────────────────────────────────────

    def directories(self) -> list[Path]:
        return list(self._dirs)

    def families(self) -> list[str]:
        """Sorted list of family display names indexed in this scanner."""
        self._ensure_built()
        return sorted(self._display_names.values())

    def __len__(self) -> int:
        self._ensure_built()
        return len(self._cmaps)

    # ── core lookup API ───────────────────────────────────────────────

    def resolve(self, family: str) -> tuple[str, int] | None:
        """Return ``(path, ttc_index)`` for *family*, or ``None`` when
        the family isn't indexed.  Case- and whitespace-insensitive."""
        if not family:
            return None
        self._ensure_built()
        norm = _normalize_family(family)
        faces = self._families.get(norm)
        if not faces:
            return None
        return faces[0]

    def display_family(self, family: str) -> str | None:
        """Canonical display name (first-seen casing/spacing) for an
        indexed family, or ``None`` when not found."""
        if not family:
            return None
        self._ensure_built()
        return self._display_names.get(_normalize_family(family))

    def cmap_for(self, face: tuple[str, int]) -> frozenset[int] | None:
        """Return the cmap codepoint set for a previously-resolved face."""
        self._ensure_built()
        return self._cmaps.get(face)

    def invalidate(self) -> None:
        """Drop the cached index — next query rebuilds.  Tests use
        this when fonts change underneath the scanner."""
        with self._lock:
            self._built = False
            self._families.clear()
            self._display_names.clear()
            self._cmaps.clear()
            self._face_families.clear()
            self._face_weights.clear()
            self._dir_mtimes.clear()

    # ── face iteration (used by build_font_face_css) ──────────────────

    def iter_faces(self) -> Iterator[tuple[str, tuple[str, int]]]:
        """Yield ``(display_family, (path, ttc_index))`` for every
        indexed face, deduplicated by face — a face that exposes both
        a typographic and a legacy family name appears once, under its
        preferred (typographic) name.

        Stable ordering: family name, then weight ascending, then path.
        Tests rely on the ordering for deterministic CSS output.
        """
        self._ensure_built()
        items = []
        for face in self._cmaps:
            family = self._face_families.get(face)
            if family is None:
                continue
            items.append((family, face))
        items.sort(key=lambda fa: (
            fa[0],
            self._face_weights.get(fa[1], 400),
            fa[1][0],
            fa[1][1],
        ))
        for entry in items:
            yield entry

    def face_weight(self, face: tuple[str, int]) -> int:
        """OS/2 ``usWeightClass`` for an indexed face, or 400 (Regular)
        as a default when the face is unknown or its OS/2 table was
        unreadable."""
        self._ensure_built()
        return self._face_weights.get(face, 400)

    # ── internal: index build ─────────────────────────────────────────

    def _ensure_built(self) -> None:
        with self._lock:
            if self._needs_rebuild():
                self._rebuild()

    def _needs_rebuild(self) -> bool:
        if not self._built:
            return True
        for d in self._dirs:
            try:
                mtime = d.stat().st_mtime
            except OSError:
                continue
            if self._dir_mtimes.get(d) != mtime:
                return True
        return False

    def _rebuild(self) -> None:
        self._families.clear()
        self._display_names.clear()
        self._cmaps.clear()
        self._face_families.clear()
        self._face_weights.clear()
        self._dir_mtimes.clear()
        # Track style + weight per face so we can prefer Regular when a
        # family has multiple weights/widths indexed.  Without this, the
        # first-indexed face wins, which on a system with NotoSansCJK-
        # Black.ttc + NotoSansCJK-Regular.ttc means Pillow measures text
        # at Black-weight widths even though the renderer ships Regular.
        face_priority: dict[tuple[str, int], tuple[int, int, str]] = {}
        for d in self._dirs:
            try:
                self._dir_mtimes[d] = d.stat().st_mtime
            except OSError:
                continue
            try:
                paths = sorted(d.rglob("*"))
            except OSError:
                continue
            for path in paths:
                if not path.is_file():
                    continue
                if path.suffix.lower() not in _FONT_EXTS:
                    continue
                self._index_file(path, face_priority)
        # Sort each family's face list by (Regular-ness, weight distance
        # from 400, path) so resolve() returns the closest-to-Regular face.
        for norm, faces in self._families.items():
            faces.sort(key=lambda f: face_priority.get(f, (9, 999, "")))
        self._built = True

    def _index_file(self, path: Path,
                    face_priority: dict[tuple[str, int],
                                        tuple[int, int, str]]) -> None:
        """Open *path*, walk every face it contains, record family
        names + cmap.  Silently skips faces fontTools can't parse —
        a corrupt font in the dir mustn't break the whole scanner.

        ``face_priority`` is populated with a sort key per face so
        :meth:`_rebuild` can prefer Regular weights at lookup time."""
        try:
            from fontTools.ttLib import TTFont  # lazy
        except ImportError:
            return

        is_collection = path.suffix.lower() == '.ttc'
        if is_collection:
            num_faces = self._count_ttc_faces(path)
        else:
            num_faces = 1

        for index in range(num_faces):
            try:
                tt = TTFont(str(path), fontNumber=index, lazy=True)
            except Exception:
                continue
            try:
                family_names = self._extract_family_names(tt)
                cmap = tt.getBestCmap()
                style_rank, weight_rank, raw_weight = self._weight_priority(tt)
            except Exception:
                family_names = []
                cmap = None
                style_rank, weight_rank, raw_weight = 9, 999, 400
            finally:
                try:
                    tt.close()
                except Exception:
                    pass

            if not family_names or cmap is None:
                continue

            face = (str(path), index)
            self._cmaps[face] = frozenset(cmap.keys())
            face_priority[face] = (style_rank, weight_rank, str(path))
            self._face_weights[face] = raw_weight
            # First family name in priority order is the preferred
            # display family for the @font-face emitter.
            self._face_families[face] = family_names[0]
            for fam in family_names:
                norm = _normalize_family(fam)
                if not norm:
                    continue
                self._families.setdefault(norm, []).append(face)
                # First display name wins.
                self._display_names.setdefault(norm, fam)

    @staticmethod
    def _weight_priority(tt) -> tuple[int, int, int]:
        """Return ``(style_rank, weight_rank, raw_weight)`` for sorting
        faces of the same family + emitting @font-face blocks.  Lower
        ``style_rank`` and ``weight_rank`` are better.

        ``style_rank`` is 0 for Regular/Roman/Book/Normal subfamily
        names (matched case-insensitively against name record 2),
        1 otherwise — covers the common case where filenames don't
        carry the weight (e.g. NotoSansCJK-Regular.ttc).

        ``weight_rank`` is ``abs(usWeightClass - 400)`` from OS/2 — a
        finer-grained tiebreaker that prefers weights closer to
        Regular (400) when no face is explicitly marked Regular.

        ``raw_weight`` is the unsigned ``usWeightClass`` (e.g. 400 for
        Regular, 700 for Bold).  Stored verbatim per face so the
        @font-face emitter can write ``font-weight: 700;`` without
        guessing.  Defaults to 400 when OS/2 is missing.
        """
        style_rank = 1
        weight_rank = 999
        raw_weight = 400
        name_table = tt.get('name')
        if name_table is not None:
            for record in name_table.names:
                if record.nameID != 2:  # subfamily / style
                    continue
                try:
                    s = record.toUnicode().strip().lower()
                except Exception:
                    continue
                if s in ('regular', 'roman', 'book', 'normal'):
                    style_rank = 0
                    break
        os2 = tt.get('OS/2')
        if os2 is not None:
            try:
                raw_weight = int(os2.usWeightClass)
                weight_rank = abs(raw_weight - 400)
            except (AttributeError, ValueError, TypeError):
                pass
        return style_rank, weight_rank, raw_weight

    @staticmethod
    def _count_ttc_faces(path: Path) -> int:
        """Number of faces inside a TTC.  Falls back to 1 when the
        collection header can't be read."""
        try:
            from fontTools.ttLib.ttCollection import TTCollection
        except ImportError:
            return 1
        try:
            with open(path, 'rb') as f:
                coll = TTCollection(f, lazy=True)
                return len(coll.fonts)
        except Exception:
            return 1

    @staticmethod
    def _extract_family_names(tt) -> list[str]:
        """Return de-duplicated family-name strings from the font's
        ``name`` table, prioritized by record ID (typographic family →
        family → full name).  Within each ID, prefers Windows Unicode
        records (platform 3, encoding 1) over Mac Roman.

        The returned order is the priority order — callers that only
        need the "best" name take ``[0]``; the scanner indexes all of
        them so users can match either the typographic family ("Noto
        Sans") or the legacy four-style family ("Noto Sans Light")."""
        name_table = tt.get('name')
        if name_table is None:
            return []

        seen: set[str] = set()
        names: list[str] = []

        def _decode(record) -> str | None:
            try:
                s = record.toUnicode()
            except Exception:
                return None
            if not s:
                return None
            s = s.strip()
            return s or None

        for nameID in _NAME_RECORD_PRIORITY:
            # Two passes: prefer Windows Unicode, then any other.
            preferred = [r for r in name_table.names
                         if r.nameID == nameID
                         and r.platformID == 3 and r.platEncID == 1]
            others = [r for r in name_table.names
                      if r.nameID == nameID
                      and not (r.platformID == 3 and r.platEncID == 1)]
            for record in preferred + others:
                s = _decode(record)
                if s is None or s in seen:
                    continue
                seen.add(s)
                names.append(s)
        return names


# ---------------------------------------------------------------------------
# Module-level default scanner (lazy, env-aware)
# ---------------------------------------------------------------------------

_default_scanner: FontScanner | None = None
_default_scanner_lock = threading.Lock()


def get_default_scanner() -> FontScanner:
    """Return the process-wide default :class:`FontScanner`.

    Resolution order for the directories scanned:

      1. ``LOOM_FONT_DIR`` environment variable (``os.pathsep``-separated).
      2. Platform-conventional system font directories
         (``/usr/share/fonts`` on Linux, ``/Library/Fonts`` on macOS,
         ``C:\\Windows\\Fonts`` on Windows, plus user-local equivalents).

    To override for testing, call :func:`set_default_scanner`."""
    global _default_scanner
    with _default_scanner_lock:
        if _default_scanner is None:
            env_dir = os.environ.get("LOOM_FONT_DIR")
            if env_dir:
                dirs: list[Path | str] = [
                    p for p in env_dir.split(os.pathsep) if p
                ]
                _default_scanner = FontScanner(dirs)
            else:
                _default_scanner = FontScanner(None)  # system defaults
        return _default_scanner


def set_default_scanner(scanner: FontScanner | None) -> None:
    """Replace the module-level default scanner.  Pass ``None`` to
    clear it so the next :func:`get_default_scanner` call rebuilds
    from environment.  Tests use this to swap in a fixture scanner."""
    global _default_scanner
    with _default_scanner_lock:
        _default_scanner = scanner


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate_font(font_name: str, *, lang_code: str | None = None,
                  text: str | None = None,
                  scanner: FontScanner | None = None) -> FontValidation:
    """Validate that *font_name* is indexed and covers the required glyphs.

    When *text* is provided, coverage is checked against the unique
    characters of that text.  Otherwise, when *lang_code* is provided,
    the per-language representative sample from
    ``_LANG_COVERAGE_SAMPLES`` is used.  With neither, only availability
    is checked — ``coverage_ok`` stays ``None``.

    Pass an explicit ``scanner`` to query a custom directory; otherwise
    the module-level default scanner is used.  Never raises — on any
    backend failure the returned :class:`FontValidation` carries a
    warning so callers can decide what to do.
    """
    v = FontValidation(font_name=font_name)

    if not font_name:
        v.warnings.append("empty font name")
        return v

    scanner = scanner or get_default_scanner()
    face = scanner.resolve(font_name)
    if face is None:
        # Family not indexed.  Mark as fallback so callers know the
        # rasterizer will pick something else at render time.
        v.is_fallback = True
        scanned = ", ".join(str(d) for d in scanner.directories()) or "<none>"
        v.warnings.append(
            f"font {font_name!r} not found in scanned font directories "
            f"({scanned}) — exact font not installed"
        )
        return v

    path, index = face
    v.resolved_path = path
    v.resolved_index = index
    v.resolved_family = scanner.display_family(font_name)

    # Coverage check — source chars: explicit text > lang sample > nothing.
    chars_to_check: frozenset[str] | None = None
    if text:
        chars_to_check = frozenset(text)
    elif lang_code:
        sample = _coverage_sample_for(lang_code)
        if sample is None:
            v.warnings.append(
                f"no coverage sample available for lang_code {lang_code!r}"
            )
        else:
            chars_to_check = sample

    if chars_to_check is None:
        return v

    cmap = scanner.cmap_for(face)
    if cmap is None:
        v.warnings.append(
            f"could not read font cmap from {path!r} — coverage unchecked"
        )
        return v

    missing = _chars_not_in_cmap(cmap, chars_to_check)
    if not missing:
        v.coverage_ok = True
        return v

    v.coverage_ok = False
    v.missing_chars = missing[:_MAX_REPORTED_MISSING]
    truncated = "" if len(missing) <= _MAX_REPORTED_MISSING else (
        f" (+{len(missing) - _MAX_REPORTED_MISSING} more)"
    )
    visible = "".join(v.missing_chars)
    v.warnings.append(
        f"font {v.resolved_family or font_name!r} is missing glyphs for: "
        f"{visible!r}{truncated}"
    )
    return v


# ---------------------------------------------------------------------------
# @font-face CSS generation (Chromium consumption — used by the rasterizer)
# ---------------------------------------------------------------------------

_CSS_FORMAT_HINTS: dict[str, str] = {
    '.otf': 'opentype',
    '.ttf': 'truetype',
    '.woff': 'woff',
    '.woff2': 'woff2',
}


def build_font_face_css(scanner: FontScanner | None = None) -> str:
    """Emit a CSS string of ``@font-face`` blocks — one per indexed face.

    The 3c bundling design routes Chromium's font selection via
    explicit ``unicode-range`` descriptors rather than fontconfig
    fallback.  Without this, Chromium picks a system fallback for any
    codepoint the requested family doesn't cover, defeating the point
    of bundling Noto.

    Each block emits:

      * ``font-family`` — the face's preferred display family name
        (typographic family if present, else the legacy 4-style family).
        Callers in ``StyleConfig`` request this name verbatim.
      * ``font-weight`` — OS/2 ``usWeightClass`` (e.g. 400 / 700).  CSS
        looks up the weight when the consumer writes
        ``font-family: 'Noto Sans'; font-weight: bold``.
      * ``src`` — ``file://`` URL with a ``format(...)`` hint derived
        from extension.
      * ``unicode-range`` — contiguous ranges coalesced from the face's
        cmap.  See :func:`_coalesce_unicode_ranges`.

    Returns an empty string when *scanner* has no indexed faces — the
    caller's CSS template then renders without any @font-face blocks
    and Chromium falls through to its default fallback (system fonts
    if the bundle didn't ship; tofu otherwise).

    TTC face index > 0 is skipped for now — Chromium has no per-face
    selector for collections.  The current bundled set is split-out
    .otf so this never triggers; revisit when shipping pan-CJK .ttc.
    """
    if scanner is None:
        scanner = get_default_scanner()

    blocks: list[str] = []
    for family, face in scanner.iter_faces():
        path, ttc_index = face
        if ttc_index != 0:
            continue
        cmap = scanner.cmap_for(face)
        if not cmap:
            continue
        weight = scanner.face_weight(face)
        ranges = _coalesce_unicode_ranges(cmap)
        if not ranges:
            continue
        url = Path(path).as_uri()
        fmt = _CSS_FORMAT_HINTS.get(Path(path).suffix.lower(), '')
        src = f"url({url})"
        if fmt:
            src += f" format('{fmt}')"
        # Single-quote escape for safety on family names that contain
        # an apostrophe (none of the bundled Noto fonts do, but defensive).
        family_escaped = family.replace("\\", "\\\\").replace("'", "\\'")
        blocks.append(
            f"@font-face {{\n"
            f"  font-family: '{family_escaped}';\n"
            f"  font-weight: {weight};\n"
            f"  font-style: normal;\n"
            f"  src: {src};\n"
            f"  unicode-range: {ranges};\n"
            f"}}"
        )
    return "\n".join(blocks)


def _coalesce_unicode_ranges(codepoints: Iterable[int]) -> str:
    """Coalesce a set of codepoints into a CSS ``unicode-range`` string.

    Output format: ``U+20-7E, U+A0-FF, U+2000-206F`` (ranges) and
    ``U+2030`` (singletons).  Ascending by start.  Empty input → empty
    string (caller is expected to skip the block).

    Coalescing is mandatory for CJK faces — emitting ~30k literal
    codepoints per face would balloon the CSS to MBs and slow Chromium
    parsing measurably.
    """
    sorted_pts = sorted(set(int(c) for c in codepoints))
    if not sorted_pts:
        return ''

    parts: list[str] = []
    start = end = sorted_pts[0]
    for cp in sorted_pts[1:]:
        if cp == end + 1:
            end = cp
            continue
        parts.append(_fmt_range(start, end))
        start = end = cp
    parts.append(_fmt_range(start, end))
    return ', '.join(parts)


def _fmt_range(start: int, end: int) -> str:
    if start == end:
        return f"U+{start:X}"
    return f"U+{start:X}-{end:X}"
