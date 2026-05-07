"""POST /romanize — text-in / text-out romanization.

Public surface for the lean web API (Step 4e-1).  Mirrors the wiring
inside ``loom_api.routes.preview`` but stripped of subtitle-file plumbing:
the caller passes a single string + a language code, and the response is
the romanized string.

Japanese is special-cased so the user-supplied ``long_vowel_mode`` is
honored — the default ``romanize_func`` from ``get_lang_config`` bakes in
the macron mode, so we re-route through ``annotation_func`` +
``spans_to_romaji_func`` whenever both are available.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from loom_core.styles import get_lang_config

router = APIRouter(tags=["text"])


class RomanizeRequest(BaseModel):
    # 5000-char ceiling chosen as defensive cap, not a real limit:
    # average subtitle event is 50–100 chars, longest plausible monologue
    # is ~500.  5000 is the "you're trying to abuse this" threshold —
    # anyone batching paragraphs through a per-event endpoint should
    # split on the client side instead.  Cap rejects at the FastAPI
    # validation boundary before the request reaches loom_core.
    text: str = Field(..., max_length=5000, description="UTF-8 source text to romanize (≤5000 chars).")
    lang_code: str = Field(..., description="BCP-47 language tag (ja, zh-Hans, zh-Hant, yue, ko, th, ru, hi, he, ar, fa, ur, ...).")
    phonetic_system: Optional[str] = Field(
        None,
        description=(
            "Per-language phonetic-system override.  Thai: paiboon|rtgs|ipa.  "
            "Arabic: learner|din|loose.  Persian: learner|dmg.  Urdu: learner|ala-lc.  "
            "Chinese: pinyin|zhuyin|jyutping (typically auto-derived from lang_code).  "
            "When omitted, falls back to the language's default."
        ),
    )
    long_vowel_mode: str = Field(
        "macrons",
        description="Japanese-only.  One of macrons|doubled|unmarked.  Ignored for other languages.",
    )
    opt_in_training: bool = Field(
        False,
        description="When true, the (text, lang, romanized) tuple may be archived for OCR training data (Step 5+).  No-op until the pipeline lands.",
    )


class RomanizeResponse(BaseModel):
    romanized: str
    lang_code: str
    romanization_name: str
    has_phonetic_layer: bool


@router.post("/romanize", response_model=RomanizeResponse)
def romanize(req: RomanizeRequest) -> RomanizeResponse:
    cfg = get_lang_config(req.lang_code, phonetic_system=req.phonetic_system)
    romanize_func = cfg.get("romanize_func")
    annotation_func = cfg.get("annotation_func")
    spans_to_romaji_func = cfg.get("spans_to_romaji_func")

    if not cfg.get("has_phonetic_layer"):
        raise HTTPException(
            status_code=400,
            detail=f"No romanization available for lang_code={req.lang_code!r}",
        )

    if not req.text.strip():
        return RomanizeResponse(
            romanized="",
            lang_code=req.lang_code,
            romanization_name=cfg.get("romanization_name", "N/A"),
            has_phonetic_layer=True,
        )

    # Japanese path: route through annotation_func + spans_to_romaji_func so
    # the caller's long_vowel_mode is honored (the default romanize_func bakes
    # in macrons).  Other languages use romanize_func directly.
    if spans_to_romaji_func and annotation_func:
        spans = annotation_func(req.text)
        romanized = spans_to_romaji_func(spans, req.long_vowel_mode)
    elif romanize_func:
        romanized = romanize_func(req.text)
    else:
        raise HTTPException(
            status_code=500,
            detail=f"Lang {req.lang_code!r} reports has_phonetic_layer=True but no callable",
        )

    return RomanizeResponse(
        romanized=romanized,
        lang_code=req.lang_code,
        romanization_name=cfg.get("romanization_name", "N/A"),
        has_phonetic_layer=True,
    )
