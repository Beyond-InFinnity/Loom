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

from loom_core.romanize import build_annotation_html, build_word_tokens, engine_version
from loom_core.styles import get_lang_config

from ..deps import get_result_cache
from ..result_cache import CacheRow, cache_key, log_batch, normalize_text

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


class AnnotateToken(BaseModel):
    """Word-level grouping over `spans` for per-word vocab lookup
    (VOCAB_LOOKUP.md Phase 0).  `spans[start:start+length]` compose the word.
    Only Japanese + Chinese populate this; other languages return []."""

    word: str = Field(..., description="The clickable word surface form.")
    lemma: Optional[str] = Field(None, description="Dictionary form for /define (JA); null → use word.")
    pos: list[str] = Field(default_factory=list, description="Part-of-speech tags (JA); [] for ZH.")
    reading: Optional[str] = Field(
        None,
        description=(
            "Contextual kana reading of the surface (JA; topic particle は → わ). "
            "null → the card falls back to the dictionary reading."
        ),
    )
    start: int = Field(..., description="Index into `spans` where this word begins.")
    length: int = Field(..., description="Number of spans this word covers.")


def _tokens_to_cache(raw_tokens: list) -> list:
    """Serialize (word, lemma, pos, reading, start, length) tuples for cache JSON."""
    return [
        [w, lemma, list(pos), reading, start, length]
        for (w, lemma, pos, reading, start, length) in raw_tokens
    ]


def _tokens_from_cache(val) -> list:
    """Parse cached token rows back to tuples; tolerant of malformed entries."""
    if not isinstance(val, list):
        return []
    out = []
    for t in val:
        try:
            w, lemma, pos, reading, start, length = t
            out.append((w, lemma, list(pos) if pos else [], reading, int(start), int(length)))
        except (ValueError, TypeError):
            continue
    return out


def _to_tokens(raw_tokens: list) -> list:
    return [
        AnnotateToken(word=w, lemma=lemma, pos=pos, reading=reading, start=start, length=length)
        for (w, lemma, pos, reading, start, length) in raw_tokens
    ]


class AnnotateResponse(BaseModel):
    spans: list[AnnotateSpan]
    tokens: list[AnnotateToken] = Field(default_factory=list)
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

    # Same spans-only read-through cache as /annotate/batch (html is
    # re-rendered per request so render_mode stays out of the key).
    cache = get_result_cache()
    system_name = cfg.get("annotation_system_name", "Annotation")
    eng_ver = engine_version(req.lang_code)
    norm = normalize_text(req.text)
    key = cache_key("annotate", req.lang_code, system_name, "-", eng_ver, norm)

    hit = cache.get_many([key]).get(key)
    if isinstance(hit, dict) and isinstance(hit.get("spans"), list):
        raw_spans = [(s[0], s[1]) for s in hit["spans"]]
        raw_tokens = _tokens_from_cache(hit.get("tokens"))
    else:
        raw_spans = annotation_func(norm)
        raw_tokens = build_word_tokens(norm, req.lang_code, raw_spans, annotation_func)
        cache.put_many(
            [
                CacheRow(
                    key=key,
                    kind="annotate",
                    lang_code=req.lang_code,
                    phonetic_system=system_name,
                    mode="-",
                    engine_version=eng_ver,
                    input_text=norm,
                    output={
                        "spans": [[base, reading] for base, reading in raw_spans],
                        "tokens": _tokens_to_cache(raw_tokens),
                    },
                )
            ]
        )
    spans = [AnnotateSpan(base=base, reading=reading) for base, reading in raw_spans]
    html = build_annotation_html(raw_spans, mode=mode)

    return AnnotateResponse(
        spans=spans,
        tokens=_to_tokens(raw_tokens),
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
    tokens: list[AnnotateToken] = Field(default_factory=list)
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

    def _computable(text: str) -> bool:
        # Per-text defensive cap.  Texts longer than _BATCH_MAX_TEXT_LENGTH
        # are zeroed out rather than rejecting the whole batch — keeps
        # positional alignment with the request guaranteed.
        return bool(annotation_func and text and text.strip() and len(text) <= _BATCH_MAX_TEXT_LENGTH)

    # Read-through/write-back result cache (ROMANIZATION_CACHE.md Layer 1).
    # Caches the SPANS only — the expensive MeCab/jieba/aksharamukha pass —
    # not the HTML: build_annotation_html is a cheap pure renderer re-run
    # per request, which keeps render_mode out of the key (×3 less
    # cardinality).  Keyed on the resolved annotation system name so
    # phonetic_system=None and an explicit default share entries.
    cache = get_result_cache()
    system_name = cfg.get("annotation_system_name", "Annotation")
    eng_ver = engine_version(req.lang_code)

    unique: dict[str, bytes] = {}  # normalized text -> cache key
    for text in req.texts:
        if _computable(text):
            norm = normalize_text(text)
            if norm not in unique:
                unique[norm] = cache_key("annotate", req.lang_code, system_name, "-", eng_ver, norm)

    found = cache.get_many(list(unique.values())) if unique else {}
    # normalized text -> (raw spans [(base, reading), ...], raw tokens)
    computed: dict[str, tuple[list, list]] = {}
    new_rows: list[CacheRow] = []
    for norm, key in unique.items():
        hit = found.get(key)
        if isinstance(hit, dict) and isinstance(hit.get("spans"), list):
            computed[norm] = (
                [(s[0], s[1]) for s in hit["spans"]],
                _tokens_from_cache(hit.get("tokens")),
            )
            continue
        raw_spans = annotation_func(norm)
        raw_tokens = build_word_tokens(norm, req.lang_code, raw_spans, annotation_func)
        computed[norm] = (raw_spans, raw_tokens)
        new_rows.append(
            CacheRow(
                key=key,
                kind="annotate",
                lang_code=req.lang_code,
                phonetic_system=system_name,
                mode="-",
                engine_version=eng_ver,
                input_text=norm,
                output={
                    "spans": [[base, reading] for base, reading in raw_spans],
                    "tokens": _tokens_to_cache(raw_tokens),
                },
            )
        )
    if new_rows:
        cache.put_many(new_rows)
    if unique:
        log_batch(
            "annotate",
            req.lang_code,
            total=len(req.texts),
            unique=len(unique),
            hits=len(unique) - len(new_rows),
            misses=len(new_rows),
        )

    results: list[AnnotateBatchItem] = []
    for text in req.texts:
        if not _computable(text):
            results.append(AnnotateBatchItem(spans=[], html="", tokens=[]))
            continue

        raw_spans, raw_tokens = computed[normalize_text(text)]
        spans = [AnnotateSpan(base=base, reading=reading) for base, reading in raw_spans]
        html = build_annotation_html(raw_spans, mode=mode)
        results.append(AnnotateBatchItem(spans=spans, html=html, tokens=_to_tokens(raw_tokens)))

    return AnnotateBatchResponse(
        results=results,
        lang_code=req.lang_code,
        annotation_system_name=cfg.get("annotation_system_name", "Annotation"),
        render_mode=mode,
    )
