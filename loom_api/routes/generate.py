from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import Resolution, StyleConfig, TimingOffsets
from loom_core.subs.processing import generate_ass_file

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(prefix="/generate", tags=["generate"])


class GenerateAssRequest(BaseModel):
    """Client → server request for ASS generation.

    File handles cross the wire as IDs (returned by POST /files), not paths.
    The server resolves IDs → on-disk paths just before calling the engine.
    """

    native_file_id: str
    target_file_id: str
    target_lang_code: str
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    source_resolution: Resolution = Resolution()
    output_resolution: Optional[Resolution] = None
    include_annotations: bool = False


class GenerateResponse(BaseModel):
    file_id: str


@router.post("/ass", response_model=GenerateResponse)
def generate_ass(
    req: GenerateAssRequest,
    storage: FileStorage = Depends(get_storage),
) -> GenerateResponse:
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
    return GenerateResponse(file_id=file_id)
