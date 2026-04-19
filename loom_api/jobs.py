"""In-process job manager.

Step-2c implementation: module-level dict mapping UUIDs to ``JobStatus``
instances, workers run as ``asyncio.Task``s in the same process. Lost on
server restart — fine for the Tauri sidecar (dies with the app) and for
early single-process web deployment.

When horizontal scaling becomes a real need (web traffic outgrows one
uvicorn worker), swap ``JobManager`` for an arq/Redis-backed
implementation behind the same ``submit`` / ``get`` interface — routes
won't change.

Worker contract: an ``async def worker(status: JobStatus) -> None`` that
mutates ``status.progress`` / ``status.phase`` / ``status.result_file_id``
in place. ``JobManager`` handles state transitions
(``pending`` → ``running`` → ``completed`` / ``failed``) and exception
capture.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Awaitable, Callable, Optional

from loom_core.models import JobAccepted, JobKind, JobStatus

logger = logging.getLogger(__name__)

Worker = Callable[[JobStatus], Awaitable[None]]


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, JobStatus] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def submit(self, kind: JobKind, worker: Worker) -> JobAccepted:
        job_id = uuid.uuid4().hex
        status = JobStatus(id=job_id, kind=kind, state="pending", progress=0.0)
        self._jobs[job_id] = status
        self._tasks[job_id] = asyncio.create_task(self._run(status, worker))
        return JobAccepted(id=job_id, kind=kind)

    def get(self, job_id: str) -> Optional[JobStatus]:
        return self._jobs.get(job_id)

    async def _run(self, status: JobStatus, worker: Worker) -> None:
        status.state = "running"
        try:
            await worker(status)
            if status.state == "running":
                status.state = "completed"
                status.progress = 1.0
        except Exception as exc:
            logger.exception("Job %s (%s) failed", status.id, status.kind)
            status.state = "failed"
            status.error = f"{type(exc).__name__}: {exc}"
