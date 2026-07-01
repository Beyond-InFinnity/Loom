"""Shared Postgres connection pooling for loom_api.

One ConnectionPool per DSN per process, shared by every Postgres-backed
component (result cache, corpus store).  Two consumers each opening their
own pool would double idle connections against Railway Postgres's modest
connection ceiling for zero benefit — both workloads are tiny indexed
reads/writes on the same database.

psycopg is imported lazily so environments without it (desktop sidecar's
requirements.txt) can import this module freely; only actually *building*
a pool requires the driver.
"""

from __future__ import annotations

import threading

_pools: dict[str, object] = {}
_lock = threading.Lock()


def get_pool(dsn: str):
    """Return the process-wide ConnectionPool for *dsn*, creating it on
    first use.  Raises if psycopg/psycopg_pool is unavailable — callers
    (which are all fail-open) catch and degrade."""
    with _lock:
        pool = _pools.get(dsn)
        if pool is None:
            from psycopg_pool import ConnectionPool  # lazy: web-only dep

            pool = ConnectionPool(dsn, min_size=0, max_size=4, open=True, name="loom-db")
            _pools[dsn] = pool
        return pool
