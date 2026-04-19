import asyncio
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import JobAccepted, JobStatus, Resolution, StyleConfig, TimingOffsets
from loom_core.subs.processing import generate_ass_file, generate_pgs_file

from ..deps import get_jobs, get_storage
from ..jobs import JobManager
from ..storage import Storage

router = APIRouter(prefix="/generate", tags=["generate"])


class GenerateAssRequest(BaseModel):
    """Client → server request for ASS generation.

    File handles cross the wire as IDs (returned by POST /files), not paths.
    The server resolves IDs → on-disk paths just before calling the engine.

    ``opt_in_training``: when true, the server is permitted to archive
    ``(input_text, style_config, output, lang_code)`` for OCR training data.
    Defaults to false. No archival code wired in step 2c — the field is
    baked into the contract so consumers don't need to upgrade their
    request shapes when archival turns on later.
    """

    native_file_id: str
    target_file_id: str
    target_lang_code: str
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    source_resolution: Resolution = Resolution()
    output_resolution: Optional[Resolution] = None
    include_annotations: bool = False
    opt_in_training: bool = False


class GeneratePgsRequest(BaseModel):
    """Client → server request for PGS generation. Async — returns a job ID.

    PGS rasterization takes 30s–10min depending on event count and
    canvas resolution. Poll GET /jobs/{id} for progress. When ``state``
    transitions to ``completed``, ``result_file_id`` resolves to the
    generated .sup via GET /files/{id}.
    """

    native_file_id: str
    target_file_id: str
    target_lang_code: str
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    source_resolution: Resolution = Resolution()
    output_resolution: Optional[Resolution] = None
    opt_in_training: bool = False


class GenerateAssResponse(BaseModel):
    file_id: str


@router.post("/ass", response_model=GenerateAssResponse)
def generate_ass(
    req: GenerateAssRequest,
    storage: Storage = Depends(get_storage),
) -> GenerateAssResponse:
    try:
        native_path = storage.path(req.native_file_id)
        target_path = storage.path(req.target_file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")

    src_res = (req.source_resolution.width, req.source_resolution.height)
    out_res = (
        (req.output_resolution.width, req.output_resolution.height)
        if req.output_resolution is not None
        else None
    )

    result_path = generate_ass_file(
        native_file=str(native_path),
        target_file=str(target_path),
        styles=req.styles.to_engine_dict(),
        target_lang_code=req.target_lang_code,
        resolution=src_res,
        output_playres=out_res,
        include_annotations=req.include_annotations,
        native_offset_ms=req.offsets.bottom_ms,
        target_offset_ms=req.offsets.top_ms,
    )
    if result_path is None:
        raise HTTPException(status_code=500, detail="ASS generation failed (see server logs)")

    file_id = storage.register_path(Path(result_path))
    return GenerateAssResponse(file_id=file_id)


@router.post("/pgs", response_model=JobAccepted)
async def generate_pgs(
    req: GeneratePgsRequest,
    storage: Storage = Depends(get_storage),
    jobs: JobManager = Depends(get_jobs),
) -> JobAccepted:
    try:
        native_path = storage.path(req.native_file_id)
        target_path = storage.path(req.target_file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")

    src_res = (req.source_resolution.width, req.source_resolution.height)
    out_res = (
        (req.output_resolution.width, req.output_resolution.height)
        if req.output_resolution is not None
        else None
    )
    styles_dict = req.styles.to_engine_dict()

    async def worker(status: JobStatus) -> None:
        def progress(completed: int, total: int) -> None:
            if total > 0:
                status.progress = min(0.99, completed / total)
                status.phase = f"rendering {completed}/{total}"

        result_path = await asyncio.to_thread(
            generate_pgs_file,
            native_file=str(native_path),
            target_file=str(target_path),
            styles=styles_dict,
            target_lang_code=req.target_lang_code,
            resolution=src_res,
            output_resolution=out_res,
            progress_callback=progress,
            native_offset_ms=req.offsets.bottom_ms,
            target_offset_ms=req.offsets.top_ms,
        )
        if result_path is None:
            raise RuntimeError("PGS generation returned None (engine logged details)")
        status.result_file_id = storage.register_path(Path(result_path))

    return jobs.submit("pgs", worker)
