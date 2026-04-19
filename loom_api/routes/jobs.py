from fastapi import APIRouter, Depends, HTTPException

from loom_core.models import JobStatus

from ..deps import get_jobs
from ..jobs import JobManager

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobStatus)
def get_job(job_id: str, jobs: JobManager = Depends(get_jobs)) -> JobStatus:
    status = jobs.get(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return status
