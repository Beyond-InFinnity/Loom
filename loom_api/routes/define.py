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


class DefineSense(BaseModel):
    gloss: List[str] = Field(..., description="Glosses for this sense (synonyms kept as given).")
    pos: List[str] = Field(default_factory=list, description="Part-of-speech tags (JMdict; empty for CC-CEDICT).")
    misc: List[str] = Field(default_factory=list, description="Misc/usage tags (e.g. 'usually kana').")


class DefinePart(BaseModel):
    """One component of a decomposed word (Chinese only) — when the word
    itself isn't a headword (jieba grouped number+measure-word etc.), this is
    a sub-word that IS in the dictionary."""

    word: str
    reading: Optional[str] = None
    senses: List[DefineSense] = Field(default_factory=list)


class DefineResult(BaseModel):
    word: str = Field(..., description="The requested word, echoed back.")
    found: bool = Field(..., description="True iff the word itself has a direct dictionary entry.")
    reading: Optional[str] = Field(None, description="Reading/pronunciation (kana / numbered pinyin).")
    senses: List[DefineSense] = Field(default_factory=list)
    sources: List[str] = Field(default_factory=list, description="e.g. ['jmdict'] / ['cc-cedict'].")
    parts: List[DefinePart] = Field(
        default_factory=list,
        description=(
            "Decomposition breakdown when `found` is false but the word splits "
            "into known sub-words (e.g. 一顶 → 一 + 顶).  Empty on a direct hit."
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
    for w, cands in zip(req.words, cand_lists):
        # Prefer a direct hit (has senses); fall back to a decomposition-only
        # entry (parts but no senses); try the primary key before its alts.
        direct = next((found[c] for c in cands if found.get(c) and found[c].senses), None)
        chosen = direct or next(
            (found[c] for c in cands if found.get(c) and found[c].parts), None
        )
        if chosen is None:
            results.append(DefineResult(word=w, found=False))
        else:
            results.append(
                DefineResult(
                    word=w,
                    found=bool(chosen.senses),  # direct hit vs decomposition-only
                    reading=chosen.reading,
                    senses=_senses(chosen.senses),
                    sources=list(chosen.sources),
                    parts=[
                        DefinePart(word=p.word, reading=p.reading, senses=_senses(p.senses))
                        for p in chosen.parts
                    ],
                )
            )
    return DefineResponse(lang=lang, results=results)
