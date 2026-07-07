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
        description="Lemmas/surface forms to define (from the annotate tokens).",
    )


class DefineSense(BaseModel):
    gloss: List[str] = Field(..., description="Glosses for this sense (synonyms kept as given).")
    pos: List[str] = Field(default_factory=list, description="Part-of-speech tags (JMdict; empty for CC-CEDICT).")
    misc: List[str] = Field(default_factory=list, description="Misc/usage tags (e.g. 'usually kana').")


class DefineResult(BaseModel):
    word: str = Field(..., description="The requested word, echoed back.")
    found: bool
    reading: Optional[str] = Field(None, description="Reading/pronunciation (kana / numbered pinyin).")
    senses: List[DefineSense] = Field(default_factory=list)
    sources: List[str] = Field(default_factory=list, description="e.g. ['jmdict'] / ['cc-cedict'].")


class DefineResponse(BaseModel):
    lang: str
    results: List[DefineResult]


@router.post("/define/batch", response_model=DefineResponse)
def define_batch(req: DefineRequest) -> DefineResponse:
    lang = req.lang.strip().lower()
    # the store normalizes (NFC+strip) internally and keys results by that form
    found = get_dictionary_store().lookup(lang, req.words)

    def key(w: str) -> str:
        return unicodedata.normalize("NFC", w).strip()

    results: List[DefineResult] = []
    for w in req.words:  # preserve request order + duplicates
        d = found.get(key(w))
        if d is None:
            results.append(DefineResult(word=w, found=False))
        else:
            results.append(
                DefineResult(
                    word=w,
                    found=True,
                    reading=d.reading,
                    senses=[DefineSense(gloss=list(s.gloss), pos=list(s.pos), misc=list(s.misc)) for s in d.senses],
                    sources=list(d.sources),
                )
            )
    return DefineResponse(lang=lang, results=results)
