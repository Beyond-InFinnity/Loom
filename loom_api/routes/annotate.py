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

POST /annotate/batch (5d-perf): one request with a list of texts that
all share the same lang/system.  Cuts network volume on the browser
extension's annotation flow from N requests to 1 — and burns one slot
of the slowapi 100/min budget instead of N.  Used by the per-tab
activation flow to fetch a whole episode's annotations in one shot.
"""

from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from loom_core.romanize import build_annotation_html
from loom_core.styles import get_lang_config

router = APIRouter(tags=["text"])


_VALID_RENDER_MODES = {"ruby", "interlinear", "inline"}
_BATCH_MAX_TEXTS = 2000
_BATCH_MAX_TEXT_LENGTH = 5000


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


# ---- POST /annotate/batch ---------------------------------------------------
#
# Browser extension consumer: per-tab activation flow needs to fetch
# annotations for an entire episode's worth of texts (~500-1000 unique
# strings on a long video).  Doing N separate /annotate POSTs burns
# the slowapi 100/min budget on the first request and produces a
# constant trickle of network traffic across the whole video.  Batch
# endpoint solves both: one HTTP request, one rate-limit slot, all
# spans returned together.
#
# Shape: shared lang/system per request.  If the caller has multiple
# langs (target + native), they call /annotate/batch twice — once
# per (lang, phonetic_system) tuple.  Keeps the route shape simple
# without per-text lang overrides.


class AnnotateBatchRequest(BaseModel):
    texts: List[str] = Field(
        ...,
        description=(
            "UTF-8 source texts to annotate.  All texts share the "
            "lang/phonetic_system specified at the request level.  "
            f"Hard caps: ≤{_BATCH_MAX_TEXTS} entries, each ≤"
            f"{_BATCH_MAX_TEXT_LENGTH} chars."
        ),
        max_length=_BATCH_MAX_TEXTS,
    )
    lang_code: str = Field(..., description="See POST /annotate.")
    phonetic_system: Optional[str] = Field(
        None,
        description="See POST /annotate.",
    )
    render_mode: Optional[str] = Field(
        None,
        description="See POST /annotate.",
    )
    opt_in_training: bool = Field(
        False,
        description="See POST /annotate.",
    )


class AnnotateBatchItem(BaseModel):
    """One result entry — same shape as the spans+html fields of
    AnnotateResponse, minus the per-call metadata (lang_code,
    annotation_system_name, render_mode) which is constant across the
    batch and lives at the response root."""

    spans: list[AnnotateSpan]
    html: str


class AnnotateBatchResponse(BaseModel):
    results: list[AnnotateBatchItem] = Field(
        ...,
        description=(
            "One entry per input text, same order as the request.  "
            "Empty/oversized texts produce {spans: [], html: ''} "
            "instead of being dropped, so positional alignment with "
            "the request is preserved."
        ),
    )
    lang_code: str
    annotation_system_name: str
    render_mode: str


@router.post("/annotate/batch", response_model=AnnotateBatchResponse)
def annotate_batch(req: AnnotateBatchRequest) -> AnnotateBatchResponse:
    cfg = get_lang_config(req.lang_code, phonetic_system=req.phonetic_system)
    annotation_func = cfg.get("annotation_func")
    default_render_mode = cfg.get("annotation_render_mode", "ruby")

    mode = req.render_mode or default_render_mode
    if mode not in _VALID_RENDER_MODES:
        mode = default_render_mode

    results: list[AnnotateBatchItem] = []
    for text in req.texts:
        # Per-text defensive cap.  Texts longer than _BATCH_MAX_TEXT_LENGTH
        # are zeroed out rather than rejecting the whole batch — keeps
        # positional alignment with the request guaranteed.
        if (
            not annotation_func
            or not text
            or not text.strip()
            or len(text) > _BATCH_MAX_TEXT_LENGTH
        ):
            results.append(AnnotateBatchItem(spans=[], html=""))
            continue

        raw_spans = annotation_func(text)
        spans = [AnnotateSpan(base=base, reading=reading) for base, reading in raw_spans]
        html = build_annotation_html(raw_spans, mode=mode)
        results.append(AnnotateBatchItem(spans=spans, html=html))

    return AnnotateBatchResponse(
        results=results,
        lang_code=req.lang_code,
        annotation_system_name=cfg.get("annotation_system_name", "Annotation"),
        render_mode=mode,
    )
