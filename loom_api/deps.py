"""FastAPI dependency providers.

Each provider returns the ``Protocol``-typed dependency, not a concrete
class — routes type-hint the protocol, so swapping ``LocalFileStorage``
for ``S3FileStorage`` (step 4) requires no changes outside this file.
"""

from .jobs import JobManager
from .storage import LocalFileStorage, Storage

_storage: Storage | None = None
_jobs: JobManager | None = None


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
