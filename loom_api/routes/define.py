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
from typing import Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from loom_core.romanize import hepburn_from_kana, is_token_supported
from loom_core.grammar import analyze_grammar, grammar_supported

from ..deps import get_dictionary_store

# Bumped if the capabilities response SHAPE changes; the client refetches per
# session so a new dictionary needs no bump — this is only for wire-format.
#   v2: added gloss_langs_by_source (per-source gloss availability for the
#       "Dictionary language" picker).
CAPABILITIES_VERSION = 2

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
    gloss_lang: Optional[str] = Field(
        None, max_length=35,
        description=(
            "Language the definitions should be written in (the user's language; "
            "usually the browser locale).  Falls back to English per-word when a "
            "word has no gloss in this language.  Defaults to English."
        ),
    )
    surfaces: Optional[List[str]] = Field(
        None,
        description=(
            "Optional per-word INFLECTED surface forms, aligned to `words` — the "
            "word as it appears in the caption (食べさせられた) vs its dictionary lemma "
            "(食べる).  Used to compute the `grammar` breakdown; when absent the "
            "primary key is analyzed instead."
        ),
    )
    surface_continuations: Optional[List[str]] = Field(
        None,
        description=(
            "Optional per-word continuation text, aligned to `words` — the lead of "
            "the NEXT subtitle cue, for a predicate split across events (利用し | "
            "てタム… → 利用して).  Stitched onto `surfaces` for the grammar breakdown "
            "so a split verb recovers its true inflection.  Japanese only; harmless "
            "when the word is already complete."
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


class GrammarFeature(BaseModel):
    """One step in a word's inflection chain (Japanese)."""
    code: str = Field(..., description="Stable feature id for client localization, e.g. 'causative'.")
    display: str = Field(..., description="English label, shown when the client has no localization for `code`.")
    surface: str = Field("", description="The morpheme(s) carrying this feature, e.g. 'させ'.")


class GrammarBreakdown(BaseModel):
    """A word's dictionary form + the grammar features stacked onto it,
    inner→outer (食べる → causative → passive → past)."""
    dict_form: str = Field(..., description="Dictionary/plain form of the word.")
    features: List[GrammarFeature] = Field(default_factory=list)


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
    grammar: Optional[GrammarBreakdown] = Field(
        None,
        description=(
            "Grammar breakdown of the inflected SURFACE form (Japanese): its "
            "dictionary form + the ordered inflection features (causative / "
            "passive / past …).  Present only when the surface actually carries "
            "inflection to explain; null for a plain dictionary form or a "
            "language with no grammar analyzer."
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
    key first, then its alternates (surface form, etc.), then a lowercased
    fallback for each.  Blank keys dropped.

    The lowercase fallback rescues sentence-initial capitalization: the FIRST
    word of every subtitle line is capitalized (Polish "Koty", Russian "Кошки")
    but most Wiktextract dictionaries hold lowercase headwords.  The exact form
    is always tried FIRST, so case-bearing dictionaries — German, whose nouns are
    capitalized (Kinder, Brot) — still hit as-is and never fall through.  For
    caseless scripts (CJK/Korean) .lower() is a no-op, so this is inert there.
    (Turkish İ→i̇ is NOT solved by plain .lower(); it needs a locale casefold —
    tracked as a known limitation.)"""
    out: List[str] = []
    for k in [word, *(alts or [])]:
        nk = key(k)
        if nk and nk not in out:
            out.append(nk)
    for k in list(out):
        lk = k.lower()
        if lk != k and lk not in out:
            out.append(lk)
    return out


class DefineCapabilities(BaseModel):
    source_langs: List[str] = Field(
        ..., description="Languages with a dictionary AND a word tokenizer — the "
        "video-track languages Loom can offer per-word lookup for.")
    gloss_langs: List[str] = Field(
        ..., description="Languages definitions can be written in (English always).")
    gloss_langs_by_source: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="Per source language, which gloss languages actually have "
        "entries — drives the client's per-video 'Dictionary language' picker so "
        "it offers only languages a definition can really be written in.")
    version: int = Field(..., description="Wire-format version of this response.")


@router.get("/define/capabilities", response_model=DefineCapabilities)
def define_capabilities() -> DefineCapabilities:
    """What the dictionary can answer right now.  The extension reads this at
    runtime to decide which tracks get clickable words and which gloss languages
    to offer — so a NEW dictionary is a pure server change, no extension update.
    A source language is included only if it has both data AND a tokenizer."""
    caps = get_dictionary_store().capabilities()
    supported = {l for l in caps.source_langs if is_token_supported(l)}
    return DefineCapabilities(
        source_langs=sorted(supported),
        gloss_langs=list(caps.gloss_langs) or ["en"],
        gloss_langs_by_source={
            lang: list(gl)
            for lang, gl in caps.gloss_langs_by_source.items()
            if lang in supported
        },
        version=CAPABILITIES_VERSION,
    )


@router.post("/define/batch", response_model=DefineResponse)
def define_batch(req: DefineRequest) -> DefineResponse:
    lang = req.lang.strip().lower()
    gloss_lang = (req.gloss_lang or "en").strip().lower().split("-")[0].split("_")[0] or "en"

    # Per-word candidate keys (primary + alternates), then ONE batched lookup
    # over their union so multi-key costs no extra round-trips.
    cand_lists = [
        _candidates(w, req.alt_keys[i] if req.alt_keys and i < len(req.alt_keys) else None)
        for i, w in enumerate(req.words)
    ]
    union = sorted({c for cands in cand_lists for c in cands})
    found = get_dictionary_store().lookup(lang, union, gloss_lang) if union else {}

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

        # Grammar breakdown of the inflected SURFACE (the caption word), not the
        # lemma — independent of whether the dictionary hit.  A continuation (the
        # next cue's lead) recovers a predicate split across events (finding ③).
        surface = req.surfaces[i] if req.surfaces and i < len(req.surfaces) and req.surfaces[i] else w
        cont = req.surface_continuations[i] if (
            req.surface_continuations and i < len(req.surface_continuations)
        ) else ""
        grammar = _grammar_model(surface, lang, cont)

        if chosen is None:
            # Even a miss shows the reading + its Hepburn in the header.
            results.append(
                DefineResult(word=w, found=False, romaji=romaji, romaji_alt=romaji_alt,
                             grammar=grammar)
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
                    grammar=grammar,
                )
            )
    return DefineResponse(lang=lang, results=results)


def _grammar_model(
    surface: str, lang: str, continuation: str = ""
) -> Optional[GrammarBreakdown]:
    """Grammar breakdown of *surface* for *lang*, or None.  Only returned when
    there's inflection to explain (a plain dictionary form → None) so the card
    shows a grammar section only when it adds something.  *continuation* stitches
    the next cue's lead for a split predicate (finding ③).  Fail-soft — a MeCab
    hiccup never breaks a definition lookup."""
    if not grammar_supported(lang):
        return None
    try:
        gb = analyze_grammar(surface, lang, continuation)
    except Exception:
        return None
    if gb is None or not gb.features:
        return None
    return GrammarBreakdown(
        dict_form=gb.dict_form,
        features=[
            GrammarFeature(code=f.code, display=f.display, surface=f.surface)
            for f in gb.features
        ],
    )
