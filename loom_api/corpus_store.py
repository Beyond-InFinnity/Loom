"""Media-identity subtitle corpus — ROMANIZATION_CACHE.md Layer 2.

Where Layer 1 (result_cache.py) stores anonymous content-addressed strings,
this layer stores *provenance*: which media, which track, what order, what
timing.  It exists for exactly two consumers — romanization/annotation
quality auditing and the Step 6 OCR training pipeline — and is fed by the
extension's opt-in capture call (POST /corpus/capture), gated end-to-end on
``opt_in_training``.

Schema (four tables, created lazily like romanization_cache):

    corpus_media   one row per (platform, platform_media_id); title/origin
                   lang are best-effort metadata from the capture payload.
    corpus_track   one row per captured caption track VERSION — identity is
                   (media, platform_track_id, content_hash), so a rewatch of
                   unchanged content is a dedup no-op while a revised track
                   (platform re-timed/re-translated it) captures fresh.
                   ``archived_at`` marks export to object storage.
    corpus_line    the bulk rows: (track, seq) → timed normalized text.
                   ON DELETE CASCADE so pruning a track prunes its lines.
    corpus_export_manifest
                   audit log of exports: which partition file, which tracks,
                   row count, content sha256.  Written by corpus_export.py;
                   what makes exports idempotent and provable.

Design rules shared with Layer 1: fail-open everywhere (a capture that hits
a down DB is dropped with a log line, never a 500 — capture is opportunistic
by contract), text normalized with the SAME normalize_text() as the cache so
export-time joins are exact-match, no user/IP/install identity anywhere.

The corpus deliberately does NOT store romanizations/annotations — those
live in romanization_cache, keyed by content.  The export job joins the two
at read time (latest engine_version wins), so engine fixes automatically
upgrade the exported corpus without re-capturing anything.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Optional, Protocol

from .result_cache import normalize_text

logger = logging.getLogger("loom.corpus")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False


@dataclass(frozen=True)
class CorpusLine:
    seq: int
    start_ms: Optional[int]
    end_ms: Optional[int]
    text: str  # normalized (normalize_text) by the route before storage
    # ASS style name (file sources: web upload / desktop / Loom Player).
    # The extension has no style visibility and sends None.  This is the
    # "style" of Step 6's (text, style, language) OCR training tuple.
    style: Optional[str] = None


@dataclass(frozen=True)
class CorpusCapture:
    platform: str
    platform_media_id: str
    platform_track_id: str
    track_lang: str
    lines: tuple[CorpusLine, ...]
    title: Optional[str] = None
    origin_lang: Optional[str] = None
    is_cc: bool = False
    track_kind: Optional[str] = None  # e.g. manual / asr
    # Style DEFINITIONS for the style names referenced by lines — an
    # opaque JSON map {style_name: {fontname, fontsize, colors, ...}}
    # exactly as the client has it.  Nullable; file sources only.
    styles: Optional[dict] = None


@dataclass(frozen=True)
class CaptureResult:
    stored: bool
    deduped: bool = False  # True when this exact track content was already captured
    lines: int = 0
    reason: str = ""


def track_content_hash(lines: tuple[CorpusLine, ...] | list[CorpusLine]) -> bytes:
    """Identity of a track's CONTENT: sha256 over the ordered normalized
    texts + timings + style names.  Same episode rewatched → same hash →
    dedup no-op; platform revises the track (or a restyle changes the
    training-relevant style names) → new hash → captured as a new version.
    Style DEFINITIONS (CorpusCapture.styles) deliberately don't hash —
    they're per-capture metadata, not line identity."""
    h = hashlib.sha256()
    for line in lines:
        h.update(
            f"{line.seq}\x1f{line.start_ms}\x1f{line.end_ms}\x1f{line.text}\x1f{line.style or ''}\x1e".encode(
                "utf-8"
            )
        )
    return h.digest()


class CorpusStore(Protocol):
    """Fail-open capture sink.  Implementations never raise into the
    request path — trouble degrades to ``CaptureResult(stored=False)``."""

    def capture(self, cap: CorpusCapture) -> CaptureResult: ...


class NullCorpusStore:
    """No corpus configured (no DSN, or LOOM_CORPUS=off)."""

    def capture(self, cap: CorpusCapture) -> CaptureResult:
        return CaptureResult(stored=False, reason="corpus disabled")


class InMemoryCorpusStore:
    """Dict-backed impl for tests.  Mirrors the Postgres dedup semantics."""

    def __init__(self) -> None:
        self.media: dict[tuple[str, str], dict] = {}
        self.tracks: dict[tuple[str, str, str, bytes], CorpusCapture] = {}

    def capture(self, cap: CorpusCapture) -> CaptureResult:
        self.media.setdefault(
            (cap.platform, cap.platform_media_id),
            {"title": cap.title, "origin_lang": cap.origin_lang},
        )
        key = (cap.platform, cap.platform_media_id, cap.platform_track_id, track_content_hash(cap.lines))
        if key in self.tracks:
            return CaptureResult(stored=False, deduped=True, lines=0, reason="already captured")
        self.tracks[key] = cap
        return CaptureResult(stored=True, lines=len(cap.lines))


_SCHEMA = """
CREATE TABLE IF NOT EXISTS corpus_media (
    id                 BIGSERIAL PRIMARY KEY,
    platform           TEXT NOT NULL,
    platform_media_id  TEXT NOT NULL,
    title              TEXT,
    origin_lang        TEXT,
    first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (platform, platform_media_id)
);
CREATE TABLE IF NOT EXISTS corpus_track (
    id                 BIGSERIAL PRIMARY KEY,
    media_id           BIGINT NOT NULL REFERENCES corpus_media(id) ON DELETE CASCADE,
    platform_track_id  TEXT NOT NULL,
    lang_code          TEXT NOT NULL,
    is_cc              BOOLEAN NOT NULL DEFAULT FALSE,
    kind               TEXT,
    content_hash       BYTEA NOT NULL,
    line_count         INT NOT NULL,
    styles_json        JSONB,
    captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at        TIMESTAMPTZ,
    UNIQUE (media_id, platform_track_id, content_hash)
);
CREATE TABLE IF NOT EXISTS corpus_line (
    track_id  BIGINT NOT NULL REFERENCES corpus_track(id) ON DELETE CASCADE,
    seq       INT NOT NULL,
    start_ms  INT,
    end_ms    INT,
    text      TEXT NOT NULL,
    style     TEXT,
    PRIMARY KEY (track_id, seq)
);
CREATE INDEX IF NOT EXISTS corpus_line_text_idx ON corpus_line (text);
-- Style columns arrived after the initial schema shipped; a database
-- created by an earlier build needs them added (CREATE TABLE IF NOT
-- EXISTS never alters an existing table).  Both are idempotent.
ALTER TABLE corpus_track ADD COLUMN IF NOT EXISTS styles_json JSONB;
ALTER TABLE corpus_line  ADD COLUMN IF NOT EXISTS style TEXT;
CREATE TABLE IF NOT EXISTS corpus_export_manifest (
    id              BIGSERIAL PRIMARY KEY,
    partition_path  TEXT NOT NULL,
    track_ids       BIGINT[] NOT NULL,
    row_count       INT NOT NULL,
    sha256          TEXT NOT NULL,
    exported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


class PostgresCorpusStore:
    """Same fail-open + backoff pattern as PostgresResultCache; shares the
    process-wide connection pool (loom_api/db.py)."""

    _BACKOFF_SECONDS = 30.0

    def __init__(self, dsn: str) -> None:
        from .db import get_pool  # lazy: pool construction needs psycopg

        self._pool = get_pool(dsn)
        self._backoff_until = 0.0
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        try:
            with self._pool.connection(timeout=10) as conn:
                conn.execute(_SCHEMA)
        except Exception:
            logger.warning("corpus: schema init failed (fail-open)", exc_info=True)
            self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    def _down(self) -> bool:
        return time.monotonic() < self._backoff_until

    def _trip(self, op: str) -> None:
        logger.warning("corpus: %s failed (fail-open, %ss backoff)", op, self._BACKOFF_SECONDS, exc_info=True)
        self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    def capture(self, cap: CorpusCapture) -> CaptureResult:
        if self._down():
            return CaptureResult(stored=False, reason="corpus backend backoff")
        content_hash = track_content_hash(cap.lines)
        try:
            with self._pool.connection(timeout=2.5) as conn:
                with conn.cursor() as cur:
                    # Upsert media.  COALESCE keeps the first non-null
                    # title/origin_lang we ever saw (later captures may
                    # arrive without metadata).
                    cur.execute(
                        "INSERT INTO corpus_media (platform, platform_media_id, title, origin_lang)"
                        " VALUES (%s, %s, %s, %s)"
                        " ON CONFLICT (platform, platform_media_id) DO UPDATE SET"
                        "   title = COALESCE(corpus_media.title, EXCLUDED.title),"
                        "   origin_lang = COALESCE(corpus_media.origin_lang, EXCLUDED.origin_lang)"
                        " RETURNING id",
                        (cap.platform, cap.platform_media_id, cap.title, cap.origin_lang),
                    )
                    media_id = cur.fetchone()[0]

                    # Insert the track version; conflict = identical content
                    # already captured → dedup no-op, no line writes.
                    from psycopg.types.json import Json  # lazy: web-only dep

                    cur.execute(
                        "INSERT INTO corpus_track"
                        " (media_id, platform_track_id, lang_code, is_cc, kind, content_hash, line_count, styles_json)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
                        " ON CONFLICT (media_id, platform_track_id, content_hash) DO NOTHING"
                        " RETURNING id",
                        (
                            media_id,
                            cap.platform_track_id,
                            cap.track_lang,
                            cap.is_cc,
                            cap.track_kind,
                            content_hash,
                            len(cap.lines),
                            Json(cap.styles) if cap.styles is not None else None,
                        ),
                    )
                    row = cur.fetchone()
                    if row is None:
                        return CaptureResult(stored=False, deduped=True, reason="already captured")
                    track_id = row[0]

                    cur.executemany(
                        "INSERT INTO corpus_line (track_id, seq, start_ms, end_ms, text, style)"
                        " VALUES (%s, %s, %s, %s, %s, %s)",
                        [(track_id, ln.seq, ln.start_ms, ln.end_ms, ln.text, ln.style) for ln in cap.lines],
                    )
            logger.info(
                "capture platform=%s media=%s track=%s lang=%s lines=%d",
                cap.platform, cap.platform_media_id, cap.platform_track_id, cap.track_lang, len(cap.lines),
            )
            return CaptureResult(stored=True, lines=len(cap.lines))
        except Exception:
            self._trip("capture")
            return CaptureResult(stored=False, reason="corpus backend error")


def normalize_capture_lines(
    raw: list[tuple[int, Optional[int], Optional[int], str, Optional[str]]],
) -> tuple[CorpusLine, ...]:
    """Route-side helper: normalize texts identically to the result cache
    (export joins are exact-match on normalized text) and drop empties."""
    out: list[CorpusLine] = []
    for seq, start_ms, end_ms, text, style in raw:
        norm = normalize_text(text)
        if norm:
            out.append(
                CorpusLine(seq=seq, start_ms=start_ms, end_ms=end_ms, text=norm, style=style)
            )
    return tuple(out)
