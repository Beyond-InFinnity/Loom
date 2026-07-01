"""Content-addressed result cache for /romanize/batch + /annotate/batch.

Layer 1 of ROMANIZATION_CACHE.md: romanize/annotate are pure functions of
(text, lang, system, mode), so results are cached by a hash of exactly those
inputs — media identity never enters the key.  The batch routes wrap their
compute loops read-through/write-back: one ``get_many`` per batch, compute
only the misses, one ``put_many`` for the new rows.

Design rules (all load-bearing — see ROMANIZATION_CACHE.md §6):

- **Fail-open.**  The cache is an accelerator, never a dependency.  The
  Postgres impl catches every DB error internally, logs it, and answers as
  an empty cache (with a short backoff so a dead DB doesn't add per-request
  connect timeouts).  Routes never see cache exceptions.
- **Version-stamped keys.**  ``loom_core.romanize.engine_version(lang)`` and
  ``NORMALIZATION_VERSION`` are part of every key.  Fixing a romanizer =
  bump the version there; stale rows become unreachable, no invalidation.
- **Resolved-system keys.**  The request's ``phonetic_system`` may be None
  (falls back to the language default inside ``get_lang_config``), so keys
  use the *resolved* system name from the returned config — an explicit
  default and an omitted one hash identically.
- **Spans, not HTML.**  /annotate caches the expensive span computation;
  ``build_annotation_html`` is a cheap pure renderer re-run per request, so
  ``render_mode`` stays out of the key.

Wiring: routes call ``loom_api.deps.get_result_cache()`` inside the handler
body (NOT FastAPI ``Depends`` — tests call handlers directly with Pydantic
models, same reason as ``tests/test_romanize_batch.py``).  With no
``DATABASE_URL`` configured the provider returns ``NullResultCache`` and the
compute path is byte-identical to the pre-cache behavior.
"""

from __future__ import annotations

import hashlib
import logging
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Protocol, Sequence

logger = logging.getLogger("loom.cache")
# Uvicorn/gunicorn don't configure app loggers; without a handler the stdlib
# lastResort handler drops INFO.  Attach one (idempotent) so hit/miss + RSS
# telemetry — the §5 measurement that decides Option A vs B — actually emits.
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False

# Bump when normalize_text() changes (it participates in every key exactly
# like engine_version — ROMANIZATION_CACHE.md §6 gotcha 5).
NORMALIZATION_VERSION = 1


def normalize_text(text: str) -> str:
    """Canonical form used for both hashing AND computation.

    NFC + strip only: raises the hit rate across composition-form and
    whitespace variants of the same subtitle line without changing what the
    romanizers see in any way they're sensitive to (they tokenize/strip
    internally).  Computing on the normalized text — not just keying on it —
    keeps 'two inputs, one key' from ever serving a result computed from a
    different byte sequence than the key describes.
    """
    return unicodedata.normalize("NFC", text).strip()


def cache_key(
    kind: str,
    lang_code: str,
    system_name: str,
    mode: str,
    engine_ver: int,
    normalized_text: str,
) -> bytes:
    """sha256 over the canonical key tuple.  ``system_name`` must be the
    RESOLVED system (e.g. romanization_name from get_lang_config), never the
    raw request field.  ``mode`` is long_vowel_mode for the Japanese romanize
    path and the constant '-' everywhere it can't affect output."""
    payload = "\x1f".join(
        (kind, lang_code, system_name, mode, str(engine_ver), str(NORMALIZATION_VERSION), normalized_text)
    )
    return hashlib.sha256(payload.encode("utf-8")).digest()


@dataclass(frozen=True)
class CacheRow:
    key: bytes
    kind: str  # 'romanize' | 'annotate'
    lang_code: str
    phonetic_system: str  # resolved system name, never null
    mode: str
    engine_version: int
    input_text: str  # normalized form (what was actually computed on)
    output: Any  # JSON-serializable: {"romanized": str} | {"spans": [[base, reading], ...]}


class ResultCache(Protocol):
    """Read-through/write-back seam.  Implementations must be fail-open:
    ``get_many`` answers ``{}`` and ``put_many`` no-ops on any backend
    trouble — never raise into the request path."""

    def get_many(self, keys: Sequence[bytes]) -> Mapping[bytes, Any]:
        """Resolve keys to stored ``output`` values.  Missing keys absent."""

    def put_many(self, rows: Iterable[CacheRow]) -> None:
        """Persist freshly computed rows.  Duplicate keys are ignored."""


class NullResultCache:
    """No cache configured — every lookup misses, writes vanish."""

    def get_many(self, keys: Sequence[bytes]) -> dict[bytes, Any]:
        return {}

    def put_many(self, rows: Iterable[CacheRow]) -> None:
        return None


class InMemoryResultCache:
    """Dict-backed impl for tests (and ad-hoc local profiling)."""

    def __init__(self) -> None:
        self.store: dict[bytes, Any] = {}

    def get_many(self, keys: Sequence[bytes]) -> dict[bytes, Any]:
        return {k: self.store[k] for k in keys if k in self.store}

    def put_many(self, rows: Iterable[CacheRow]) -> None:
        for row in rows:
            self.store.setdefault(row.key, row.output)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS romanization_cache (
    key_hash        BYTEA PRIMARY KEY,
    kind            TEXT NOT NULL,
    lang_code       TEXT NOT NULL,
    phonetic_system TEXT NOT NULL,
    mode            TEXT NOT NULL,
    engine_version  INT NOT NULL,
    input_text      TEXT NOT NULL,
    output_json     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


class PostgresResultCache:
    """Railway-Postgres impl.  psycopg is imported lazily so the desktop
    sidecar (requirements.txt, no psycopg) never pays for it; construction
    fails soft to NullResultCache in deps.get_result_cache() if the driver
    is missing.  All errors are swallowed → logged → 30s backoff."""

    _BACKOFF_SECONDS = 30.0

    def __init__(self, dsn: str) -> None:
        from .db import get_pool  # lazy: pool construction needs psycopg

        # Shared process-wide pool (min_size=0 — first use connects).
        self._pool = get_pool(dsn)
        self._backoff_until = 0.0
        self._ensure_schema()

    # -- internals ---------------------------------------------------------

    def _ensure_schema(self) -> None:
        try:
            with self._pool.connection(timeout=10) as conn:
                conn.execute(_SCHEMA)
        except Exception:
            logger.warning("result cache: schema init failed (fail-open)", exc_info=True)
            self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    def _down(self) -> bool:
        return time.monotonic() < self._backoff_until

    def _trip(self, op: str) -> None:
        logger.warning("result cache: %s failed (fail-open, %ss backoff)", op, self._BACKOFF_SECONDS, exc_info=True)
        self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    # -- ResultCache -------------------------------------------------------

    def get_many(self, keys: Sequence[bytes]) -> dict[bytes, Any]:
        if not keys or self._down():
            return {}
        try:
            with self._pool.connection(timeout=2.5) as conn:
                rows = conn.execute(
                    "SELECT key_hash, output_json FROM romanization_cache WHERE key_hash = ANY(%s)",
                    (list(keys),),
                ).fetchall()
            return {bytes(k): v for k, v in rows}
        except Exception:
            self._trip("get_many")
            return {}

    def put_many(self, rows: Iterable[CacheRow]) -> None:
        rows = list(rows)
        if not rows or self._down():
            return
        try:
            from psycopg.types.json import Json  # lazy: web-only dep

            with self._pool.connection(timeout=2.5) as conn:
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO romanization_cache"
                        " (key_hash, kind, lang_code, phonetic_system, mode, engine_version, input_text, output_json)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
                        " ON CONFLICT (key_hash) DO NOTHING",
                        [
                            (
                                r.key,
                                r.kind,
                                r.lang_code,
                                r.phonetic_system,
                                r.mode,
                                r.engine_version,
                                r.input_text,
                                Json(r.output),
                            )
                            for r in rows
                        ],
                    )
        except Exception:
            self._trip("put_many")


# ---------------------------------------------------------------------------
# Telemetry — the ROMANIZATION_CACHE.md §5 measurement
# ---------------------------------------------------------------------------
# One INFO line per batch: hit rate + which languages this worker has ever
# COMPUTED (i.e. which lazy dictionaries it has loaded) + current RSS.  RSS
# plotted against langs_computed over a worker's uptime is exactly the plot
# that decides whether cache+recycling (Option A) suffices or the
# compute/serve split (Option B) is warranted.

_langs_computed: set[str] = set()


def _rss_mb() -> float:
    try:
        with open("/proc/self/statm") as f:  # Linux (Railway) only
            pages = int(f.read().split()[1])
        import resource  # noqa: PLC0415 — stdlib, cheap

        return pages * resource.getpagesize() / (1024 * 1024)
    except Exception:
        return -1.0


def log_batch(kind: str, lang_code: str, *, total: int, unique: int, hits: int, misses: int) -> None:
    if misses:
        _langs_computed.add((lang_code or "").split("-")[0].lower())
    logger.info(
        "%s lang=%s total=%d unique=%d hits=%d misses=%d rss_mb=%.0f langs_computed=%s",
        kind,
        lang_code,
        total,
        unique,
        hits,
        misses,
        _rss_mb(),
        ",".join(sorted(_langs_computed)) or "-",
    )
