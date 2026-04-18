from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.language import code_to_name, detect_language
from loom_core.models import StyleInfo
from loom_core.subs.processing import detect_ass_styles

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(prefix="/subs", tags=["subs"])


class FileIdRequest(BaseModel):
    file_id: str


class DetectLanguageResponse(BaseModel):
    code: Optional[str]
    name: Optional[str]


class DetectStylesResponse(BaseModel):
    styles: Optional[List[StyleInfo]]


@router.post("/detect-language", response_model=DetectLanguageResponse)
def detect_subtitle_language(
    req: FileIdRequest,
    storage: FileStorage = Depends(get_storage),
) -> DetectLanguageResponse:
    try:
        path = storage.path(req.file_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown file: {req.file_id}")
    code = detect_language(str(path))
    return DetectLanguageResponse(code=code, name=code_to_name(code) if code else None)


@router.post("/detect-styles", response_model=DetectStylesResponse)
def detect_subtitle_styles(
    req: FileIdRequest,
    storage: FileStorage = Depends(get_storage),
) -> DetectStylesResponse:
    """Returns the named-style breakdown for an ASS/SSA file with multiple
    styles. SRT files and single-style ASS files return ``styles=None`` —
    they have no meaningful style breakdown.
    """
    try:
        path = storage.path(req.file_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown file: {req.file_id}")

    raw = detect_ass_styles(str(path))
    if raw is None:
        return DetectStylesResponse(styles=None)

    styles = [
        StyleInfo(
            name=name,
            event_count=info["event_count"],
            has_animation=info.get("has_animation", False),
            role=info["role"],
            sample_text=info.get("sample_text", ""),
        )
        for name, info in raw.items()
    ]
    return DetectStylesResponse(styles=styles)
