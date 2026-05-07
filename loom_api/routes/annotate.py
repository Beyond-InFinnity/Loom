"""POST /annotate — text-in / spans+HTML out annotation.

Public surface for the lean web API (Step 4e-1).  Wraps
``get_annotation_func`` + ``build_annotation_html`` from ``loom_core``:
the caller gets back both the structured span list (for custom client-side
rendering) and the pre-rendered HTML in the requested mode.

Annotations cover Japanese furigana, Mandarin pinyin, Cantonese jyutping,
Taiwanese zhuyin, Korean per-syllable RR, Indic per-akshara IAST, and the
RTL family — every script ``loom_core.romanize.get_annotation_func``
supports.  When the language has no annotation function, returns an empty
spans list rather than 404 (the caller can decide whether to retry as
plain romanize).
"""

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from loom_core.romanize import build_annotation_html
from loom_core.styles import get_lang_config

router = APIRouter(tags=["text"])


_VALID_RENDER_MODES = {"ruby", "interlinear", "inline"}


class AnnotateRequest(BaseModel):
    # See romanize.py for the 5000-char rationale — same defensive cap.
    text: str = Field(..., max_length=5000, description="UTF-8 source text to annotate (≤5000 chars).")
    lang_code: str = Field(..., description="BCP-47 language tag (ja, zh-Hans, zh-Hant, yue, ko, th, hi, ...).")
    phonetic_system: Optional[str] = Field(
        None,
        description=(
            "Per-language phonetic-system override.  Same values as POST /romanize.  "
            "Drives which annotation system is selected for languages that support multiple "
            "(Mandarin pinyin vs zhuyin, Cantonese jyutping, Thai paiboon/rtgs/ipa, etc.)."
        ),
    )
    render_mode: Optional[str] = Field(
        None,
        description=(
            "How to render the resulting HTML: 'ruby' (default for CJK; <ruby>+<rt>), "
            "'interlinear' (two-row inline-block stack; better for long alphabetic readings), "
            "or 'inline' (parenthetical fallback: 'base(reading)').  When omitted, falls back "
            "to the language's default annotation_render_mode."
        ),
    )
    opt_in_training: bool = Field(
        False,
        description="See POST /romanize.  No-op until the OCR archival pipeline lands (Step 5+).",
    )


class AnnotateSpan(BaseModel):
    base: str
    reading: Optional[str] = None


class AnnotateResponse(BaseModel):
    spans: list[AnnotateSpan]
    html: str
    render_mode: str
    annotation_system_name: str
    lang_code: str


@router.post("/annotate", response_model=AnnotateResponse)
def annotate(req: AnnotateRequest) -> AnnotateResponse:
    cfg = get_lang_config(req.lang_code, phonetic_system=req.phonetic_system)
    annotation_func = cfg.get("annotation_func")
    default_render_mode = cfg.get("annotation_render_mode", "ruby")

    mode = req.render_mode or default_render_mode
    if mode not in _VALID_RENDER_MODES:
        # Soft fallback rather than 422 — keeps the wire protocol forgiving for
        # client typos without leaking malformed HTML downstream.
        mode = default_render_mode

    if not annotation_func or not req.text.strip():
        return AnnotateResponse(
            spans=[],
            html="",
            render_mode=mode,
            annotation_system_name=cfg.get("annotation_system_name", "Annotation"),
            lang_code=req.lang_code,
        )

    raw_spans = annotation_func(req.text)
    spans = [AnnotateSpan(base=base, reading=reading) for base, reading in raw_spans]
    html = build_annotation_html(raw_spans, mode=mode)

    return AnnotateResponse(
        spans=spans,
        html=html,
        render_mode=mode,
        annotation_system_name=cfg.get("annotation_system_name", "Annotation"),
        lang_code=req.lang_code,
    )
