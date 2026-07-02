"""POST /corpus/capture — opt-in media-identity subtitle capture (Layer 2).

The extension calls this ONCE per (media, track) activation, only when the
user's ``opt_in_training`` setting is on, sending the full ordered timed
event list plus media/track identity.  This is the long-owed wire-up of the
``opt_in_training`` flag that has been a documented no-op on the romanize/
annotate models since step 2c — provenance capture lives HERE, on its own
endpoint, rather than piggybacking on the batch calls, because the batch
payloads are deduplicated and untimed (ordering/timing are destroyed
client-side before they're sent — ROMANIZATION_CACHE.md Layer 1 vs 2).

Contract mirrors the batch endpoints' philosophy:

- **Fail-soft, never 500 the extension.**  Missing opt-in, disabled corpus,
  or a down DB all return 200 with ``stored=false`` + a reason.  Capture is
  opportunistic by design; the extension must never care whether it worked.
- **Idempotent.**  Re-capturing identical track content (a rewatch) dedups
  server-side via the content hash — the response says ``deduped=true``.
- **No user identity.**  The payload carries media/track/lines only.  Do
  not add install ids, session ids, or user agents to this model.

Texts are normalized server-side with the same normalize_text() as the
result cache so the export job's corpus↔cache joins are exact-match.
"""

from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..corpus_store import CorpusCapture, normalize_capture_lines
from ..deps import get_corpus_store

router = APIRouter(tags=["corpus"])

_MAX_LINES = 10000          # generous: a 2h film is ~2-3k events
_MAX_TEXT_LENGTH = 5000     # same defensive cap as the batch endpoints


class CaptureLine(BaseModel):
    seq: int = Field(..., ge=0, description="0-based position in the track's event order.")
    start_ms: Optional[int] = Field(None, ge=0, description="Event start, milliseconds.")
    end_ms: Optional[int] = Field(None, ge=0, description="Event end, milliseconds.")
    text: str = Field(..., max_length=_MAX_TEXT_LENGTH)
    style: Optional[str] = Field(
        None,
        max_length=128,
        description=(
            "ASS style name for this event (file sources: web upload / "
            "desktop / player).  Streaming platforms have no style "
            "visibility and omit it."
        ),
    )


class CorpusCaptureRequest(BaseModel):
    opt_in_training: bool = Field(
        False,
        description=(
            "Must be true for anything to be stored.  The extension sends "
            "this from the user's opt-in setting; false → 200 stored=false."
        ),
    )
    platform: str = Field(..., max_length=32, description="youtube | netflix | iqiyi | wetv | ...")
    media_id: str = Field(..., max_length=256, description="Platform-native media id (videoId / movieId / ...).")
    title: Optional[str] = Field(None, max_length=512, description="Best-effort human-readable title.")
    origin_lang: Optional[str] = Field(None, max_length=35, description="Media's origin/audio language, if known.")
    track_id: str = Field(..., max_length=256, description="Platform-native track id (vssId / trackId / ...).")
    track_lang: str = Field(..., max_length=35, description="BCP-47 language tag of the captured track.")
    is_cc: bool = Field(False, description="True for closed-captions/SDH tracks.")
    track_kind: Optional[str] = Field(None, max_length=32, description="e.g. manual | asr.")
    lines: List[CaptureLine] = Field(..., max_length=_MAX_LINES, description="Full ordered timed event list.")
    styles: Optional[dict] = Field(
        None,
        description=(
            "Style DEFINITIONS for the style names referenced by lines — "
            "an opaque JSON map {style_name: {fontname, fontsize, colors, "
            "...}} exactly as the client parsed it.  File sources only; "
            "the (text, style, language) tuples for Step 6 OCR training."
        ),
    )


class CorpusCaptureResponse(BaseModel):
    stored: bool
    deduped: bool = Field(False, description="True when this exact track content was already captured.")
    lines: int = Field(0, description="Line rows written (0 on no-op/dedup).")
    reason: str = Field("", description="Human-readable no-op explanation when stored=false.")


@router.post("/corpus/capture", response_model=CorpusCaptureResponse)
def corpus_capture(req: CorpusCaptureRequest) -> CorpusCaptureResponse:
    if not req.opt_in_training:
        return CorpusCaptureResponse(stored=False, reason="opt_in_training not set")

    lines = normalize_capture_lines(
        [(ln.seq, ln.start_ms, ln.end_ms, ln.text, ln.style) for ln in req.lines]
    )
    if not lines:
        return CorpusCaptureResponse(stored=False, reason="no non-empty lines")

    result = get_corpus_store().capture(
        CorpusCapture(
            platform=req.platform.strip().lower(),
            platform_media_id=req.media_id,
            platform_track_id=req.track_id,
            track_lang=req.track_lang,
            lines=lines,
            title=req.title,
            origin_lang=req.origin_lang,
            is_cc=req.is_cc,
            track_kind=req.track_kind,
            styles=req.styles,
        )
    )
    return CorpusCaptureResponse(
        stored=result.stored, deduped=result.deduped, lines=result.lines, reason=result.reason
    )
