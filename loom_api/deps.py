"""FastAPI dependency providers.

Each provider returns the ``Protocol``-typed dependency, not a concrete
class — routes type-hint the protocol, so swapping ``LocalFileStorage``
for ``S3FileStorage`` (step 4) requires no changes outside this file.
"""

import logging
import os

from .jobs import JobManager
from .result_cache import NullResultCache, ResultCache
from .storage import LocalFileStorage, Storage

_storage: Storage | None = None
_jobs: JobManager | None = None
_result_cache: ResultCache | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = LocalFileStorage()
    return _storage


def get_jobs() -> JobManager:
    global _jobs
    if _jobs is None:
        _jobs = JobManager()
    return _jobs


def get_result_cache() -> ResultCache:
    """Content-addressed romanize/annotate result cache (Layer 1).

    Enabled iff a Postgres DSN is present: ``LOOM_RESULT_CACHE_URL`` wins,
    else Railway's injected ``DATABASE_URL``.  ``LOOM_RESULT_CACHE=off``
    force-disables without unsetting the DSN.  Anything short of a healthy
    configuration degrades to NullResultCache — the compute path must work
    with zero cache config (desktop sidecar, local dev, CI).

    Called from handler bodies rather than FastAPI ``Depends`` so tests can
    keep invoking handlers directly with Pydantic models (the established
    idiom in tests/test_romanize_batch.py); tests swap impls via
    ``set_result_cache()``.
    """
    global _result_cache
    if _result_cache is None:
        _result_cache = _build_result_cache()
    return _result_cache


def set_result_cache(cache: ResultCache | None) -> None:
    """Test seam (mirrors loom_core.fonts.set_default_scanner).  ``None``
    resets to lazy env-driven construction."""
    global _result_cache
    _result_cache = cache


def _build_result_cache() -> ResultCache:
    if os.environ.get("LOOM_RESULT_CACHE", "").strip().lower() in {"off", "0", "false"}:
        return NullResultCache()
    dsn = os.environ.get("LOOM_RESULT_CACHE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        return NullResultCache()
    try:
        from .result_cache import PostgresResultCache

        return PostgresResultCache(dsn)
    except Exception:
        # Missing psycopg (desktop requirements.txt) or bad DSN — fail open.
        logging.getLogger("loom.cache").warning(
            "result cache: Postgres init failed; running uncached", exc_info=True
        )
        return NullResultCache()
