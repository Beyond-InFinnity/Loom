"""POST /romanize — text-in / text-out romanization.

Public surface for the lean web API (Step 4e-1).  Mirrors the wiring
inside ``loom_api.routes.preview`` but stripped of subtitle-file plumbing:
the caller passes a single string + a language code, and the response is
the romanized string.

Japanese is special-cased so the user-supplied ``long_vowel_mode`` is
honored — the default ``romanize_func`` from ``get_lang_config`` bakes in
the macron mode, so we re-route through ``annotation_func`` +
``spans_to_romaji_func`` whenever both are available.

POST /romanize/batch (5e): one request with a list of texts that all
share the same lang/system/long_vowel_mode.  Same motivation as
/annotate/batch — the browser-extension activation flow needs an
entire episode's romanizations up-front and a single request burns
one slowapi slot instead of N.
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from loom_core.styles import get_lang_config

router = APIRouter(tags=["text"])


_BATCH_MAX_TEXTS = 2000
_BATCH_MAX_TEXT_LENGTH = 5000


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


# ---- POST /romanize/batch ---------------------------------------------------
#
# Browser extension consumer: paired with /annotate/batch in the
# per-tab activation flow.  Annotation gives per-character ruby for
# CJK + Korean (5d); romanization gives the full-utterance phonetic
# line above the foreign text (5e) and is the entire phonetic surface
# for non-CJK families (Cyrillic / Thai / Indic / Hebrew / Arabic-
# Persian-Urdu).  Same shape contract as /annotate/batch: one shared
# (lang, phonetic_system, long_vowel_mode) per request, positional
# results, empty/oversized texts produce empty results rather than
# being dropped (so result[i] always pairs with request.texts[i]).
#
# Fail-soft on unsupported languages: where /romanize raises 400 on
# has_phonetic_layer=False, /romanize/batch returns all-empty results
# with has_phonetic_layer=False at the response root.  This matches
# /annotate/batch's philosophy — the extension's activation flow
# benefits from never having to special-case a 400 mid-batch, and
# clients can still detect the situation by inspecting the root
# has_phonetic_layer flag.


class RomanizeBatchRequest(BaseModel):
    texts: List[str] = Field(
        ...,
        description=(
            "UTF-8 source texts to romanize.  All texts share the "
            "lang/phonetic_system/long_vowel_mode specified at the "
            "request level.  Hard caps: "
            f"≤{_BATCH_MAX_TEXTS} entries, each ≤"
            f"{_BATCH_MAX_TEXT_LENGTH} chars."
        ),
        max_length=_BATCH_MAX_TEXTS,
    )
    lang_code: str = Field(..., description="See POST /romanize.")
    phonetic_system: Optional[str] = Field(
        None,
        description="See POST /romanize.",
    )
    long_vowel_mode: str = Field(
        "macrons",
        description="See POST /romanize.",
    )
    opt_in_training: bool = Field(
        False,
        description="See POST /romanize.",
    )


class RomanizeBatchItem(BaseModel):
    """One result entry — just the romanized string.  Per-call
    metadata (lang_code, romanization_name, has_phonetic_layer) is
    constant across the batch and lives at the response root."""

    romanized: str


class RomanizeBatchResponse(BaseModel):
    results: list[RomanizeBatchItem] = Field(
        ...,
        description=(
            "One entry per input text, same order as the request.  "
            "Empty/oversized texts and unsupported languages produce "
            "{romanized: ''} instead of being dropped, so positional "
            "alignment with the request is preserved."
        ),
    )
    lang_code: str
    romanization_name: str
    has_phonetic_layer: bool


@router.post("/romanize/batch", response_model=RomanizeBatchResponse)
def romanize_batch(req: RomanizeBatchRequest) -> RomanizeBatchResponse:
    cfg = get_lang_config(req.lang_code, phonetic_system=req.phonetic_system)
    romanize_func = cfg.get("romanize_func")
    annotation_func = cfg.get("annotation_func")
    spans_to_romaji_func = cfg.get("spans_to_romaji_func")
    has_phonetic_layer = bool(cfg.get("has_phonetic_layer"))

    # Fail-soft: a lang without a phonetic layer (or that claims one but
    # is missing both callables) returns all-empty.  Caller learns this
    # from the response-root has_phonetic_layer flag.
    has_japanese_path = bool(spans_to_romaji_func and annotation_func)
    has_callable = has_phonetic_layer and (has_japanese_path or romanize_func)

    results: list[RomanizeBatchItem] = []
    for text in req.texts:
        if not has_callable or not text or not text.strip() or len(text) > _BATCH_MAX_TEXT_LENGTH:
            results.append(RomanizeBatchItem(romanized=""))
            continue

        if has_japanese_path:
            spans = annotation_func(text)
            romanized = spans_to_romaji_func(spans, req.long_vowel_mode)
        else:
            romanized = romanize_func(text)
        results.append(RomanizeBatchItem(romanized=romanized))

    return RomanizeBatchResponse(
        results=results,
        lang_code=req.lang_code,
        romanization_name=cfg.get("romanization_name", "N/A"),
        has_phonetic_layer=has_phonetic_layer,
    )
