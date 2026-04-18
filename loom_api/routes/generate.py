from pathlib import Path
from typing import Any, Optional

import pysubs2
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import Resolution, TimingOffsets
from loom_core.subs.processing import generate_ass_file

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(prefix="/generate", tags=["generate"])


_COLOR_KEYS = ("primarycolor", "outlinecolor", "backcolor")


def _hex_to_color(hex_str: str) -> pysubs2.Color:
    s = hex_str.lstrip("#")
    return pysubs2.Color(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 0)


def _adapt_styles(styles: dict[str, Any]) -> dict[str, Any]:
    """Convert wire styles → engine-shaped dict.

    Color fields cross the wire as ``#RRGGBB`` hex strings; the engine
    wants ``pysubs2.Color`` objects. Everything else passes through.

    Step-2 concession: the wire shape is currently the engine's pysubs2-aligned
    dict (``fontname``, ``fontsize``, ``marginv``, ``alignment``, etc.) with
    hex strings for colors. A proper typed ``StyleConfig`` that decouples the
    wire from pysubs2 conventions is deferred to step 2b.
    """
    result: dict[str, Any] = {}
    for key, val in styles.items():
        if not isinstance(val, dict):
            result[key] = val
            continue
        converted = dict(val)
        for color_key in _COLOR_KEYS:
            v = converted.get(color_key)
            if isinstance(v, str):
                converted[color_key] = _hex_to_color(v)
        result[key] = converted
    return result


class GenerateAssRequest(BaseModel):
    """Client → server request for ASS generation.

    File handles cross the wire as IDs (returned by POST /files), not paths.
    The server resolves IDs → on-disk paths just before calling the engine.

    ``styles`` is currently a free-form dict (engine's pysubs2-aligned shape
    with hex color strings). Will be tightened to a typed model in step 2b
    after the engine's full dict surface is audited.
    """

    native_file_id: str
    target_file_id: str
    target_lang_code: str
    styles: dict[str, Any]
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

    styles_dict = _adapt_styles(req.styles)
    src_res = (req.source_resolution.width, req.source_resolution.height)
    out_res = (
        (req.output_resolution.width, req.output_resolution.height)
        if req.output_resolution is not None
        else None
    )

    result_path = generate_ass_file(
        native_file=str(native_path),
        target_file=str(target_path),
        styles=styles_dict,
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
