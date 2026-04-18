from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import Resolution, StyleConfig, TimingOffsets
from loom_core.styles import get_lang_config
from loom_core.subs.preview import generate_unified_preview, get_lines_at_timestamp

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(tags=["preview"])


class PreviewRequest(BaseModel):
    native_file_id: str
    target_file_id: str
    target_lang_code: str
    timestamp_seconds: float
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    source_resolution: Resolution = Resolution()
    preview_mode: str = "ass"


class PreviewResponse(BaseModel):
    html: str
    native_text: str
    target_text: str
    romanized_text: str


@router.post("/preview", response_model=PreviewResponse)
def render_preview(
    req: PreviewRequest,
    storage: FileStorage = Depends(get_storage),
) -> PreviewResponse:
    """Render the composite preview HTML at a single timestamp.

    Returns the surrounding HTML document the Streamlit iframe consumes
    today, plus the raw text fields for clients that want to render their
    own UI. Annotations and preserved-style overlays are deferred to a
    follow-up turn — this is the minimum viable preview path.
    """
    try:
        native_path = storage.path(req.native_file_id)
        target_path = storage.path(req.target_file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")

    lines = get_lines_at_timestamp(
        str(native_path),
        str(target_path),
        req.timestamp_seconds,
        native_offset_ms=req.offsets.bottom_ms,
        target_offset_ms=req.offsets.top_ms,
    )

    lang_cfg = get_lang_config(req.target_lang_code)
    romanize_func = lang_cfg.get("romanize_func")
    romanized = romanize_func(lines["target"]) if romanize_func and lines["target"] else ""

    html = generate_unified_preview(
        styles=req.styles.to_engine_dict(),
        native_text=lines["native"],
        target_text=lines["target"],
        pinyin_text=romanized,
        resolution=(req.source_resolution.width, req.source_resolution.height),
        preview_mode=req.preview_mode,
        annotation_render_mode=lang_cfg.get("annotation_render_mode", "ruby"),
        preserved_html=lines.get("preserved_html", ""),
    )

    return PreviewResponse(
        html=html,
        native_text=lines["native"],
        target_text=lines["target"],
        romanized_text=romanized,
    )
