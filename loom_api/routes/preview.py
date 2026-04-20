import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import Resolution, StyleConfig, TimingOffsets
from loom_core.styles import get_lang_config
from loom_core.subs.preview import generate_unified_preview, get_lines_at_timestamp
from loom_core.video.mkv_handler import extract_frame

from ..deps import get_storage
from ..storage import Storage
from ..style_mapping import auto_style_mapping

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
    video_file_id: Optional[str] = None


class PreviewResponse(BaseModel):
    html: str
    native_text: str
    target_text: str
    romanized_text: str


# Module-level frame cache keyed by (video_path, int_ts). The sidecar is
# single-user (Tauri) or short-lived (dev), so bounded growth isn't a concern
# for now; revisit if this ever runs behind a shared web service.
_FRAME_DIR = Path(tempfile.gettempdir()) / "loom_preview_frames"
_FRAME_DIR.mkdir(parents=True, exist_ok=True)
_FRAME_CACHE: dict[tuple[str, int], str] = {}


def _cached_frame(video_path: str, ts: int) -> Optional[str]:
    key = (video_path, ts)
    cached = _FRAME_CACHE.get(key)
    if cached and Path(cached).exists():
        return cached
    # Stable filename so re-extraction after cache eviction is idempotent
    # and ffmpeg's `overwrite_output=True` keeps disk usage bounded per file.
    safe = abs(hash(video_path))
    out = _FRAME_DIR / f"{safe:x}_{ts}.jpg"
    if extract_frame(video_path, ts, str(out)) and out.exists():
        _FRAME_CACHE[key] = str(out)
        return str(out)
    return None


@router.post("/preview", response_model=PreviewResponse)
def render_preview(
    req: PreviewRequest,
    storage: Storage = Depends(get_storage),
) -> PreviewResponse:
    """Render the composite preview HTML at a single timestamp.

    Mirrors the Streamlit preview wiring: computes annotation spans when
    the Annotation layer is enabled, runs the Japanese ``spans_to_romaji``
    pipeline with the user's ``long_vowel_mode`` (reusing spans when
    annotation is already computed), and — when ``video_file_id`` is
    supplied — inlines a cached frame screenshot as the preview
    background.
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
        native_style_mapping=auto_style_mapping(native_path),
        target_style_mapping=auto_style_mapping(target_path),
        native_offset_ms=req.offsets.bottom_ms,
        target_offset_ms=req.offsets.top_ms,
    )

    native_text = lines["native"]
    target_text = lines["target"]
    preserved_html = lines.get("preserved_html", "")

    lang_cfg = get_lang_config(
        req.target_lang_code,
        phonetic_system=req.styles.annotation.phonetic_system,
    )
    annotation_func = lang_cfg.get("annotation_func")
    spans_to_romaji_func = lang_cfg.get("spans_to_romaji_func")
    romanize_func = lang_cfg.get("romanize_func")
    annotation_render_mode = lang_cfg.get("annotation_render_mode", "ruby")

    # Annotation spans (furigana/bopomofo/jyutping/etc). Only computed when
    # the Annotation layer is on — matches Streamlit gating.
    annotation_spans = None
    if annotation_func and target_text and req.styles.annotation.enabled:
        annotation_spans = annotation_func(target_text)

    # Romanized line. Japanese is special-cased so the user's
    # long_vowel_mode is respected; spans are reused when annotation is on
    # to avoid a second MeCab pass.
    romanized = ""
    if target_text and req.styles.romanized.enabled:
        long_vowel_mode = req.styles.romanized.long_vowel_mode
        if spans_to_romaji_func and annotation_spans is not None:
            romanized = spans_to_romaji_func(annotation_spans, long_vowel_mode)
        elif spans_to_romaji_func and annotation_func:
            romanized = spans_to_romaji_func(annotation_func(target_text), long_vowel_mode)
        elif romanize_func:
            romanized = romanize_func(target_text)

    bg_path = None
    if req.video_file_id:
        try:
            video_path = storage.path(req.video_file_id)
        except KeyError:
            video_path = None
        if video_path:
            bg_path = _cached_frame(str(video_path), int(req.timestamp_seconds))

    html = generate_unified_preview(
        styles=req.styles.to_engine_dict(),
        native_text=native_text,
        target_text=target_text,
        pinyin_text=romanized,
        resolution=(req.source_resolution.width, req.source_resolution.height),
        background_image_path=bg_path,
        annotation_spans=annotation_spans,
        preview_mode=req.preview_mode,
        annotation_render_mode=annotation_render_mode,
        preserved_html=preserved_html,
    )

    return PreviewResponse(
        html=html,
        native_text=native_text,
        target_text=target_text,
        romanized_text=romanized,
    )
