import asyncio
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import JobAccepted, JobStatus, Resolution, StyleConfig, TimingOffsets
from loom_core.styles import get_lang_config
from loom_core.subs.processing import build_output_filename, generate_ass_file, generate_pgs_file
from loom_core.video.mkv_handler import get_video_metadata

from ..corpus_forward import forward_generate_capture
from ..deps import get_jobs, get_storage
from ..jobs import JobManager
from ..storage import Storage
from ..style_mapping import auto_style_mapping

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
        native_style_mapping=auto_style_mapping(native_path),
        target_style_mapping=auto_style_mapping(target_path),
        native_offset_ms=req.offsets.bottom_ms,
        target_offset_ms=req.offsets.top_ms,
    )
    if result_path is None:
        raise HTTPException(status_code=500, detail="ASS generation failed (see server logs)")

    # opt_in_training finally does something here (the step-2c contract):
    # forward both input tracks (events + ASS styles) to the production
    # corpus.  Fire-and-forget daemon thread — generation latency and
    # failure behavior are untouched (loom_api/corpus_forward.py).
    if req.opt_in_training:
        forward_generate_capture(
            native_path=native_path,
            target_path=target_path,
            target_lang_code=req.target_lang_code,
        )

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
    native_mapping = auto_style_mapping(native_path)
    target_mapping = auto_style_mapping(target_path)

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
            native_style_mapping=native_mapping,
            target_style_mapping=target_mapping,
            native_offset_ms=req.offsets.bottom_ms,
            target_offset_ms=req.offsets.top_ms,
        )
        if result_path is None:
            raise RuntimeError("PGS generation returned None (engine logged details)")
        status.result_file_id = storage.register_path(Path(result_path))

    return jobs.submit("pgs", worker)


class SuggestFilenameRequest(BaseModel):
    """Request a sanitized, metadata-aware default filename for a Save
    dialog. All inputs are optional — missing fields just get skipped.

    Mirrors the Streamlit flow (loom_app.py:1252): pulls media title +
    year from the video (when a ``video_file_id`` is supplied) and folds
    in the native/target language codes plus annotation / romanization
    system names.
    """

    ext: str
    video_file_id: Optional[str] = None
    native_lang_code: Optional[str] = None
    target_lang_code: Optional[str] = None
    phonetic_system: Optional[str] = None
    include_annotations: bool = False
    include_romanization: bool = True


class SuggestFilenameResponse(BaseModel):
    filename: str


@router.post("/suggest-filename", response_model=SuggestFilenameResponse)
def suggest_filename(
    req: SuggestFilenameRequest,
    storage: Storage = Depends(get_storage),
) -> SuggestFilenameResponse:
    media_title: Optional[str] = None
    year: Optional[str] = None
    if req.video_file_id:
        try:
            video_path = storage.path(req.video_file_id)
        except KeyError:
            video_path = None
        if video_path:
            meta, _ = get_video_metadata(str(video_path))
            media_title = meta.get("title")
            yr = meta.get("year")
            year = str(yr) if yr else None

    annotation_system = None
    romanization_system = None
    if req.target_lang_code:
        cfg = get_lang_config(req.target_lang_code, phonetic_system=req.phonetic_system)
        if req.include_annotations and cfg.get("annotation_func"):
            name = cfg.get("annotation_system_name", "")
            if name:
                annotation_system = name.lower()
        if req.include_romanization and cfg.get("romanize_func"):
            rom = cfg.get("romanization_name", "")
            if rom and rom.upper() != "N/A":
                romanization_system = rom.lower()

    filename = build_output_filename(
        media_title=media_title,
        year=year,
        native_lang=req.native_lang_code,
        target_lang=req.target_lang_code,
        annotation_system=annotation_system,
        romanization_system=romanization_system,
        ext=req.ext.lstrip("."),
    )
    return SuggestFilenameResponse(filename=filename)
