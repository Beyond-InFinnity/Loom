"""POST /define/batch — per-word dictionary lookup (VOCAB_LOOKUP.md).

The extension calls this on a click (or to prefetch a paused line's tokens):
one request, a list of words in one language, back come merged definitions.
The words are LEMMAS/surface forms the client already has from the annotate
tokens — this endpoint does NOT tokenize or lemmatize; it looks up exactly the
strings given (matching either the ``headword`` or ``reading`` column).

Contract mirrors the batch endpoints:

- **Fail-soft.**  No dictionary configured / down DB → 200 with every word
  ``found=false``.  Lookup is an enhancement, never load-bearing.
- **Order + echo preserved.**  ``results`` is 1:1 with the request ``words``
  (same order, duplicates kept), each carrying its own ``found`` flag, so the
  client can zip them straight back onto the clicked tokens.
"""

import unicodedata
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from loom_core.romanize import hepburn_from_kana

from ..deps import get_dictionary_store

router = APIRouter(tags=["define"])

_MAX_WORDS = 200       # a paused line's worth of tokens, generously
_MAX_WORD_LENGTH = 64  # longest realistic dictionary headword


class DefineRequest(BaseModel):
    lang: str = Field(..., max_length=35, description="Base language of the words: 'ja' | 'zh'.")
    words: List[str] = Field(
        ..., max_length=_MAX_WORDS,
        description=(
            "Primary keys to define (from the annotate tokens) — usually the "
            "lemma.  Each is tried first, then its `alt_keys`; the first that "
            "hits wins.  Echoed back verbatim as the result `word`."
        ),
    )
    alt_keys: Optional[List[List[str]]] = Field(
        None,
        description=(
            "Optional per-word fallback keys, aligned to `words` by index — "
            "e.g. the token's surface form so 黒曜石 resolves when MeCab's lemma "
            "(黒曜) doesn't.  Tried in order after the primary key."
        ),
    )
    readings: Optional[List[str]] = Field(
        None,
        description=(
            "Optional per-word contextual kana readings, aligned to `words` — "
            "the reading the card DISPLAYS (e.g. は→わ, the inflected 見た).  "
            "For Japanese, the returned `romaji`/`romaji_alt` are computed from "
            "this (falling back to the dictionary reading) so the Hepburn "
            "matches the shown furigana."
        ),
    )


class DefineSense(BaseModel):
    gloss: List[str] = Field(..., description="Glosses for this sense (synonyms kept as given).")
    pos: List[str] = Field(default_factory=list, description="Part-of-speech tags (JMdict; empty for CC-CEDICT).")
    misc: List[str] = Field(default_factory=list, description="Misc/usage tags (e.g. 'usually kana').")


class DefinePart(BaseModel):
    """One component of a decomposed word — a Chinese sub-word (jieba grouped
    number+measure-word etc.) or a Japanese honorific peeled off a name."""

    word: str
    reading: Optional[str] = None
    romaji: Optional[str] = Field(None, description="Hepburn (macrons), Japanese only.")
    romaji_alt: Optional[str] = Field(None, description="Hepburn (doubled vowels), Japanese only.")
    senses: List[DefineSense] = Field(default_factory=list)


class DefineResult(BaseModel):
    word: str = Field(..., description="The requested word, echoed back.")
    found: bool = Field(..., description="True iff the word itself has a direct dictionary entry.")
    reading: Optional[str] = Field(None, description="Reading/pronunciation (kana / numbered pinyin).")
    romaji: Optional[str] = Field(
        None, description="Hepburn romanization with macrons (Tōkyō), Japanese only.")
    romaji_alt: Optional[str] = Field(
        None, description="Hepburn with doubled long vowels (Toukyou), Japanese only; "
                          "omitted/equal to `romaji` when there's no long vowel.")
    senses: List[DefineSense] = Field(default_factory=list)
    sources: List[str] = Field(default_factory=list, description="e.g. ['jmdict'] / ['cc-cedict'].")
    parts: List[DefinePart] = Field(
        default_factory=list,
        description=(
            "Decomposition breakdown when `found` is false but the word splits "
            "into known sub-words (e.g. 一顶 → 一 + 顶, or 玉葉様 → 様).  Empty on "
            "a direct hit."
        ),
    )


class DefineResponse(BaseModel):
    lang: str
    results: List[DefineResult]


def _senses(defn_senses) -> List[DefineSense]:
    return [
        DefineSense(gloss=list(s.gloss), pos=list(s.pos), misc=list(s.misc))
        for s in defn_senses
    ]


def _romaji_pair(lang: str, kana: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """(romaji_macron, romaji_doubled) for a Japanese kana reading; (None, None)
    for other languages or blank input.  The doubled form is returned as None
    when it equals the macron form (no long vowel) so the client won't render a
    redundant parenthetical."""
    if lang != "ja" or not kana:
        return (None, None)
    macron, doubled = hepburn_from_kana(kana)
    if not macron:
        return (None, None)
    return (macron, doubled if doubled != macron else None)


def _part_model(lang: str, p) -> "DefinePart":
    romaji, romaji_alt = _romaji_pair(lang, p.reading)
    return DefinePart(
        word=p.word, reading=p.reading,
        romaji=romaji, romaji_alt=romaji_alt, senses=_senses(p.senses),
    )


def key(w: str) -> str:
    return unicodedata.normalize("NFC", w).strip()


def _candidates(word: str, alts: Optional[List[str]]) -> List[str]:
    """Ordered, de-duplicated lookup keys for one requested word: the primary
    key first, then its alternates (surface form, etc.).  Blank keys dropped."""
    out: List[str] = []
    for k in [word, *(alts or [])]:
        nk = key(k)
        if nk and nk not in out:
            out.append(nk)
    return out


@router.post("/define/batch", response_model=DefineResponse)
def define_batch(req: DefineRequest) -> DefineResponse:
    lang = req.lang.strip().lower()

    # Per-word candidate keys (primary + alternates), then ONE batched lookup
    # over their union so multi-key costs no extra round-trips.
    cand_lists = [
        _candidates(w, req.alt_keys[i] if req.alt_keys and i < len(req.alt_keys) else None)
        for i, w in enumerate(req.words)
    ]
    union = sorted({c for cands in cand_lists for c in cands})
    found = get_dictionary_store().lookup(lang, union) if union else {}

    results: List[DefineResult] = []
    for i, (w, cands) in enumerate(zip(req.words, cand_lists)):
        # Prefer a direct hit (has senses); fall back to a decomposition-only
        # entry (parts but no senses); try the primary key before its alts.
        direct = next((found[c] for c in cands if found.get(c) and found[c].senses), None)
        chosen = direct or next(
            (found[c] for c in cands if found.get(c) and found[c].parts), None
        )
        # Romaji tracks the DISPLAYED reading: the client's contextual reading
        # (は→わ, inflected 見た) if it sent one, else the dictionary reading.
        ctx_reading = req.readings[i] if req.readings and i < len(req.readings) else None
        disp_reading = ctx_reading or (chosen.reading if chosen else None)
        romaji, romaji_alt = _romaji_pair(lang, disp_reading)

        if chosen is None:
            # Even a miss shows the reading + its Hepburn in the header.
            results.append(
                DefineResult(word=w, found=False, romaji=romaji, romaji_alt=romaji_alt)
            )
        else:
            results.append(
                DefineResult(
                    word=w,
                    found=bool(chosen.senses),  # direct hit vs decomposition-only
                    reading=chosen.reading,
                    romaji=romaji,
                    romaji_alt=romaji_alt,
                    senses=_senses(chosen.senses),
                    sources=list(chosen.sources),
                    parts=[_part_model(lang, p) for p in chosen.parts],
                )
            )
    return DefineResponse(lang=lang, results=results)
