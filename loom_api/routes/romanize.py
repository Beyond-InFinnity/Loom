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
from pydantic import BaseModel, Field, field_validator

from loom_core.romanize import engine_version, strip_speaker_markup
from loom_core.styles import get_lang_config

from .. import limits
from ..deps import get_result_cache
from ..result_cache import CacheRow, cache_key, log_batch, normalize_text

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
    has_japanese_path = bool(spans_to_romaji_func and annotation_func)
    if not has_japanese_path and not romanize_func:
        raise HTTPException(
            status_code=500,
            detail=f"Lang {req.lang_code!r} reports has_phonetic_layer=True but no callable",
        )

    # Same read-through cache as /romanize/batch — the web app's generation
    # flow fans out singles, and without this it bypasses Layer 1 entirely.
    cache = get_result_cache()
    system_name = cfg.get("romanization_name", "N/A")
    mode = req.long_vowel_mode if has_japanese_path else "-"
    eng_ver = engine_version(req.lang_code)
    # Strip speaker markup (（名） labels + multi-speaker dashes) before romanizing
    # — the phonetic line shouldn't spell out a proper noun or a turn dash.  It's
    # a separate display line, so this can't misalign per-char ruby.  Key on the
    # stripped text so labelled and unlabelled copies of a line share one entry.
    norm = strip_speaker_markup(normalize_text(req.text))
    key = cache_key("romanize", req.lang_code, system_name, mode, eng_ver, norm)

    hit = cache.get_many([key]).get(key)
    if isinstance(hit, dict) and isinstance(hit.get("romanized"), str):
        romanized = hit["romanized"]
    else:
        if has_japanese_path:
            spans = annotation_func(norm)
            romanized = spans_to_romaji_func(spans, req.long_vowel_mode)
        else:
            romanized = romanize_func(norm)
        cache.put_many(
            [
                CacheRow(
                    key=key,
                    kind="romanize",
                    lang_code=req.lang_code,
                    phonetic_system=system_name,
                    mode=mode,
                    engine_version=eng_ver,
                    input_text=norm,
                    output={"romanized": romanized},
                )
            ]
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

    @field_validator("texts")
    @classmethod
    def _cap_total_chars(cls, texts: List[str]) -> List[str]:
        # Cost cap, not a correctness cap: bounds the CPU one request can
        # demand.  A single OVERSIZED item stays fail-soft (_computable
        # zeroes it, positional alignment preserved), but the SUM across
        # the batch is what bounds worst-case work, so it hard-rejects
        # (422).  Legit worst case ≈ 1M chars (web app 2000-text chunk);
        # cap default 2M — see loom_api/limits.py.
        cap = limits.BATCH_MAX_TOTAL_CHARS
        total = sum(len(t) for t in texts)
        if cap and total > cap:
            raise ValueError(
                f"total batch text size {total} chars exceeds the "
                f"{cap}-char limit; split into smaller batches"
            )
        return texts

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

    def _computable(text: str) -> bool:
        return bool(has_callable and text and text.strip() and len(text) <= _BATCH_MAX_TEXT_LENGTH)

    # Read-through/write-back result cache (ROMANIZATION_CACHE.md Layer 1).
    # Keyed on the RESOLVED system name (so phonetic_system=None and an
    # explicit default share entries) + engine/normalization versions.
    # long_vowel_mode only affects output on the Japanese path — hash it as
    # a constant elsewhere so it can't fragment e.g. the Chinese cache.
    # Deduping by normalized text also collapses repeated subtitle lines
    # ("はい！" ×30/episode) into one computation even on a full cache miss.
    cache = get_result_cache()
    system_name = cfg.get("romanization_name", "N/A")
    mode = req.long_vowel_mode if has_japanese_path else "-"
    eng_ver = engine_version(req.lang_code)

    # Strip speaker markup (labels + multi-speaker dashes) before romanizing (see
    # /romanize).  Keying on the stripped text dedups "（A）行くよ"/"（B）行くよ"/"行くよ".
    def _romaji_input(text: str) -> str:
        return strip_speaker_markup(normalize_text(text))

    unique: dict[str, bytes] = {}  # romaji-input text -> cache key
    for text in req.texts:
        if _computable(text):
            norm = _romaji_input(text)
            if norm not in unique:
                unique[norm] = cache_key("romanize", req.lang_code, system_name, mode, eng_ver, norm)

    found = cache.get_many(list(unique.values())) if unique else {}
    values: dict[str, str] = {}
    new_rows: list[CacheRow] = []
    for norm, key in unique.items():
        hit = found.get(key)
        if isinstance(hit, dict) and isinstance(hit.get("romanized"), str):
            values[norm] = hit["romanized"]
            continue
        if has_japanese_path:
            spans = annotation_func(norm)
            romanized = spans_to_romaji_func(spans, req.long_vowel_mode)
        else:
            romanized = romanize_func(norm)
        values[norm] = romanized
        new_rows.append(
            CacheRow(
                key=key,
                kind="romanize",
                lang_code=req.lang_code,
                phonetic_system=system_name,
                mode=mode,
                engine_version=eng_ver,
                input_text=norm,
                output={"romanized": romanized},
            )
        )
    if new_rows:
        cache.put_many(new_rows)
    if unique:
        log_batch(
            "romanize",
            req.lang_code,
            total=len(req.texts),
            unique=len(unique),
            hits=len(unique) - len(new_rows),
            misses=len(new_rows),
        )

    results: list[RomanizeBatchItem] = []
    for text in req.texts:
        if not _computable(text):
            results.append(RomanizeBatchItem(romanized=""))
            continue
        results.append(RomanizeBatchItem(romanized=values[_romaji_input(text)]))

    return RomanizeBatchResponse(
        results=results,
        lang_code=req.lang_code,
        romanization_name=cfg.get("romanization_name", "N/A"),
        has_phonetic_layer=has_phonetic_layer,
    )
