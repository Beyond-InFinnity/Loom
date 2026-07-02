"""Corpus export — Postgres landing zone → object storage (Parquet).

The archival half of ROMANIZATION_CACHE.md Layer 2: corpus rows are
append-only training data consumed in bulk, so Postgres holds only the
recent capture window and the system of record is partitioned Parquet in
an S3-compatible bucket (R2/S3).  Run via ``scripts/export_corpus.py``
(scheduled by .github/workflows/export-corpus.yml).

Flow per run:

1. Select settled, unarchived tracks (``captured_at`` older than
   ``--settle-days``; late-arriving captures of the same media are separate
   tracks so settling is per-track, not per-media).
2. **Denormalize on the way out:** join each line to romanization_cache on
   (normalized text, lang) — latest ``engine_version`` per (kind, system)
   wins, so romanizer fixes upgrade the exported corpus automatically
   without re-capturing anything.
3. Write one Parquet file per (platform, lang, capture-month) partition:
   ``corpus/platform=X/lang=Y/captured=YYYY-MM/part-<runid>.parquet``.
4. Upload; record a ``corpus_export_manifest`` row (path, track ids, row
   count, sha256) in the same transaction that stamps ``archived_at`` on
   the tracks — the manifest is what makes re-runs idempotent (already-
   archived tracks are never re-selected) and exports auditable.
5. Optional ``--prune``: delete corpus_line rows for tracks archived more
   than ``--prune-days`` ago.  Track + media rows are kept (they're tiny
   and preserve "what exists in the bucket" queryability); autovacuum
   recycles the freed space, so steady-state disk stays flat.

Layering: pure record-shaping/partitioning lives in this module and is
unit-tested; SQL, pyarrow, and boto3 are confined to the *Runner* class and
imported lazily (the API service never imports them — this module is only
reached by the export script).
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Iterable, Optional

logger = logging.getLogger("loom.corpus.export")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False


# ---------------------------------------------------------------------------
# Pure layer — record shaping + partitioning (unit-tested, no deps)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TrackMeta:
    track_pk: int
    platform: str
    media_id: str
    title: Optional[str]
    origin_lang: Optional[str]
    track_id: str
    lang_code: str
    is_cc: bool
    kind: Optional[str]
    captured_month: str  # "YYYY-MM"
    captured_at_iso: str
    styles_json: Optional[dict] = None  # ASS style definitions (file sources)


def partition_path(platform: str, lang_code: str, captured_month: str, run_id: str) -> str:
    """Hive-style partition layout — readable by Databricks / DuckDB /
    pandas / Spark without configuration."""
    return f"corpus/platform={platform}/lang={lang_code}/captured={captured_month}/part-{run_id}.parquet"


def build_records(
    track: TrackMeta,
    lines: Iterable[tuple[int, Optional[int], Optional[int], str, Optional[str]]],
    cache_rows: Iterable[tuple[str, str, str, Any, int]],
) -> list[dict[str, Any]]:
    """Shape one track's export records.

    ``lines``: (seq, start_ms, end_ms, text, style) in seq order.
    ``cache_rows``: (kind, phonetic_system, input_text, output_json,
    engine_version) — pass rows in ANY version order; the highest
    engine_version per (kind, system, text) wins here, so callers don't
    need DISTINCT ON gymnastics.

    Each record is fully self-contained (media + track + line + all known
    romanizations/annotations for that text) — the Parquet files need no
    side tables.  Multi-system results are nested JSON strings keyed by
    system name; texts the cache has never seen export with empty maps
    (capture is opt-in-wide, cache coverage follows actual processing).
    """
    # (text) -> {kind -> {system -> (engine_version, output)}}
    by_text: dict[str, dict[str, dict[str, tuple[int, Any]]]] = {}
    for kind, system, text, output, engine_ver in cache_rows:
        systems = by_text.setdefault(text, {}).setdefault(kind, {})
        best = systems.get(system)
        if best is None or engine_ver > best[0]:
            systems[system] = (engine_ver, output)

    track_styles_json = (
        json.dumps(track.styles_json, ensure_ascii=False)
        if track.styles_json is not None
        else None
    )
    records: list[dict[str, Any]] = []
    for seq, start_ms, end_ms, text, style in lines:
        kinds = by_text.get(text, {})
        romanizations = {
            system: output.get("romanized")
            for system, (_v, output) in kinds.get("romanize", {}).items()
            if isinstance(output, dict)
        }
        annotations = {
            system: output.get("spans")
            for system, (_v, output) in kinds.get("annotate", {}).items()
            if isinstance(output, dict)
        }
        engine_versions = {
            f"{kind}:{system}": version
            for kind, systems in kinds.items()
            for system, (version, _out) in systems.items()
        }
        records.append(
            {
                "platform": track.platform,
                "media_id": track.media_id,
                "title": track.title,
                "origin_lang": track.origin_lang,
                "track_id": track.track_id,
                "track_lang": track.lang_code,
                "is_cc": track.is_cc,
                "track_kind": track.kind,
                "captured_at": track.captured_at_iso,
                "seq": seq,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text,
                "style": style,
                "track_styles_json": track_styles_json,
                "romanizations_json": json.dumps(romanizations, ensure_ascii=False),
                "annotations_json": json.dumps(annotations, ensure_ascii=False),
                "engine_versions_json": json.dumps(engine_versions, ensure_ascii=False),
            }
        )
    return records


def group_tracks_by_partition(tracks: Iterable[TrackMeta]) -> dict[tuple[str, str, str], list[TrackMeta]]:
    """One output file per (platform, lang, capture-month) per run."""
    groups: dict[tuple[str, str, str], list[TrackMeta]] = {}
    for t in tracks:
        groups.setdefault((t.platform, t.lang_code, t.captured_month), []).append(t)
    return groups


PARQUET_COLUMNS = [
    "platform", "media_id", "title", "origin_lang", "track_id", "track_lang",
    "is_cc", "track_kind", "captured_at", "seq", "start_ms", "end_ms", "text",
    "style", "track_styles_json",
    "romanizations_json", "annotations_json", "engine_versions_json",
]


# ---------------------------------------------------------------------------
# Runner — SQL + Parquet + upload (lazy heavy deps; exercised live, not in CI)
# ---------------------------------------------------------------------------

class ExportRunner:
    """Drives one export run against a live database.

    ``sink`` decides where files land: LocalDirSink (testing / air-gapped
    demo work) or S3Sink (R2/S3).  ``dry_run`` walks the whole pipeline —
    selection, joins, Parquet in memory — but writes nothing and marks
    nothing archived.
    """

    def __init__(self, dsn: str, sink: "Sink", *, settle_days: int = 7, dry_run: bool = False) -> None:
        from .db import get_pool

        self._pool = get_pool(dsn)
        self._sink = sink
        self._settle_days = settle_days
        self._dry_run = dry_run

    # -- selection ----------------------------------------------------------

    def _select_tracks(self) -> list[TrackMeta]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT t.id, m.platform, m.platform_media_id, m.title, m.origin_lang,
                       t.platform_track_id, t.lang_code, t.is_cc, t.kind,
                       to_char(t.captured_at, 'YYYY-MM'), t.captured_at::text,
                       t.styles_json
                FROM corpus_track t
                JOIN corpus_media m ON m.id = t.media_id
                WHERE t.archived_at IS NULL
                  AND t.captured_at < now() - make_interval(days => %s)
                ORDER BY t.id
                """,
                (self._settle_days,),
            ).fetchall()
        return [TrackMeta(*row) for row in rows]

    def _track_lines(
        self, track_pk: int
    ) -> list[tuple[int, Optional[int], Optional[int], str, Optional[str]]]:
        with self._pool.connection() as conn:
            return conn.execute(
                "SELECT seq, start_ms, end_ms, text, style FROM corpus_line WHERE track_id = %s ORDER BY seq",
                (track_pk,),
            ).fetchall()

    def _cache_rows_for(self, lang_code: str, texts: list[str]) -> list[tuple[str, str, str, Any, int]]:
        if not texts:
            return []
        with self._pool.connection() as conn:
            return conn.execute(
                """
                SELECT kind, phonetic_system, input_text, output_json, engine_version
                FROM romanization_cache
                WHERE lang_code = %s AND input_text = ANY(%s)
                """,
                (lang_code, texts),
            ).fetchall()

    # -- run ----------------------------------------------------------------

    def run(self) -> int:
        """Execute one export pass.  Returns number of files written."""
        tracks = self._select_tracks()
        if not tracks:
            logger.info("export: nothing to do (no settled unarchived tracks)")
            return 0
        run_id = uuid.uuid4().hex[:12]
        files = 0
        for (platform, lang, month), group in group_tracks_by_partition(tracks).items():
            records: list[dict[str, Any]] = []
            for track in group:
                lines = self._track_lines(track.track_pk)
                texts = sorted({text for _s, _a, _b, text, _style in lines})
                records.extend(build_records(track, lines, self._cache_rows_for(track.lang_code, texts)))
            if not records:
                continue
            path = partition_path(platform, lang, month, run_id)
            payload = _to_parquet_bytes(records)
            digest = hashlib.sha256(payload).hexdigest()
            track_ids = [t.track_pk for t in group]
            if self._dry_run:
                logger.info("export (dry-run): would write %s (%d rows, %d bytes, sha256=%s…)",
                            path, len(records), len(payload), digest[:12])
                continue
            self._sink.put(path, payload)
            self._mark_archived(track_ids, path, len(records), digest)
            logger.info("export: wrote %s (%d rows from %d tracks)", path, len(records), len(track_ids))
            files += 1
        return files

    def _mark_archived(self, track_ids: list[int], path: str, row_count: int, digest: str) -> None:
        # Manifest row + archived_at stamps commit atomically: a crash
        # between upload and commit re-exports next run (harmless duplicate
        # file, distinct run id) rather than silently losing tracks.
        with self._pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO corpus_export_manifest (partition_path, track_ids, row_count, sha256)"
                    " VALUES (%s, %s, %s, %s)",
                    (path, track_ids, row_count, digest),
                )
                cur.execute(
                    "UPDATE corpus_track SET archived_at = now() WHERE id = ANY(%s)",
                    (track_ids,),
                )

    def prune(self, prune_days: int) -> int:
        """Delete line rows for tracks archived > prune_days ago.  Track and
        media rows stay (tiny; keep the 'what's in the bucket' index)."""
        if self._dry_run:
            logger.info("prune (dry-run): skipped")
            return 0
        with self._pool.connection() as conn:
            cur = conn.execute(
                """
                DELETE FROM corpus_line
                WHERE track_id IN (
                    SELECT id FROM corpus_track
                    WHERE archived_at IS NOT NULL
                      AND archived_at < now() - make_interval(days => %s)
                )
                """,
                (prune_days,),
            )
            deleted = cur.rowcount
        logger.info("prune: deleted %d line rows", deleted)
        return deleted


def _to_parquet_bytes(records: list[dict[str, Any]]) -> bytes:
    import io

    import pyarrow as pa  # lazy: export-script-only dep
    import pyarrow.parquet as pq

    table = pa.Table.from_pylist(records).select(PARQUET_COLUMNS)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Sinks
# ---------------------------------------------------------------------------

class Sink:
    def put(self, path: str, payload: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class LocalDirSink(Sink):
    """Write partitions under a local directory (testing / offline work)."""

    def __init__(self, base_dir: str) -> None:
        self._base = base_dir

    def put(self, path: str, payload: bytes) -> None:
        import os

        full = os.path.join(self._base, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(payload)


class S3Sink(Sink):
    """S3-compatible upload (AWS S3, Cloudflare R2 via endpoint_url).

    Credentials come from the standard AWS env vars / config chain
    (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY); R2 additionally needs
    ``endpoint_url`` = https://<account_id>.r2.cloudflarestorage.com.
    """

    def __init__(self, bucket: str, endpoint_url: Optional[str] = None) -> None:
        import boto3  # lazy: export-script-only dep

        self._bucket = bucket
        self._client = boto3.client("s3", endpoint_url=endpoint_url)

    def put(self, path: str, payload: bytes) -> None:
        self._client.put_object(Bucket=self._bucket, Key=path, Body=payload)
