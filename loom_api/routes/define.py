"""POST /define/batch — per-word dictionary lookup (VOCAB_LOOKUP.md).

The extension calls this on a click (or to prefetch a paused line's tokens):
one request, a list of words in one language, back come merged definitions.
The words are LEMMAS/surface forms the client already has from the annotate
tokens — this endpoint does NOT tokenize or lemmatize; it looks up exactly the
strings given (matching the ``headword`` column, or for Japanese either the
``headword`` or ``reading`` column).  For the simplemma (Wiktextract)
languages it also reads the caption ``surfaces`` entry, because a wrong
lemma must not beat a correct surface (see _surface_choice).

Contract mirrors the batch endpoints:

- **Fail-soft.**  No dictionary configured / down DB → 200 with every word
  ``found=false``.  Lookup is an enhancement, never load-bearing.
- **Order + echo preserved.**  ``results`` is 1:1 with the request ``words``
  (same order, duplicates kept), each carrying its own ``found`` flag, so the
  client can zip them straight back onto the clicked tokens.
"""

import re
import unicodedata
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from loom_core.romanize import _ELISION_LEMMA, hepburn_from_kana, is_token_supported
from loom_core.styles import _normalize_lang_code
from loom_core.grammar import (
    analyze_grammar,
    extract_form_of_lemma,
    grammar_from_tags,
    grammar_supported,
)

from ..deps import get_dictionary_store
# Wire-format version of /define/capabilities.  Lives with the store (which
# also stamps it into its persisted copy) and is re-exported here.
from ..dictionary import CAPABILITIES_VERSION  # noqa: F401
from ..dictionary import DEFAULT_GLOSS_LANG

router = APIRouter(tags=["define"])

_MAX_WORDS = 200       # a paused line's worth of tokens, generously
_MAX_WORD_LENGTH = 64  # longest realistic dictionary headword; longer
                       # candidate keys are silently skipped in
                       # _candidates (fail-soft found=false, never 422)
_MAX_ALT_KEYS = 16       # alternates considered per word (client sends 1)
_MAX_SURFACE_LENGTH = 500   # longest surface/continuation fed to MeCab/kiwi
_MAX_READING_LENGTH = 256   # longest kana reading fed to hepburn_from_kana


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
        max_length=_MAX_WORDS,
        description=(
            "Optional per-word fallback keys, aligned to `words` by index — "
            "e.g. the token's surface form so 黒曜石 resolves when MeCab's lemma "
            "(黒曜) doesn't.  Tried in order after the primary key."
        ),
    )
    readings: Optional[List[str]] = Field(
        None,
        max_length=_MAX_WORDS,
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
        max_length=_MAX_WORDS,
        description=(
            "Optional per-word INFLECTED surface forms, aligned to `words` — the "
            "word as it appears in the caption (食べさせられた) vs its dictionary lemma "
            "(食べる).  Used to compute the `grammar` breakdown; when absent the "
            "primary key is analyzed instead."
        ),
    )
    surface_continuations: Optional[List[str]] = Field(
        None,
        max_length=_MAX_WORDS,
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
    if lang != "ja" or not kana or len(kana) > _MAX_READING_LENGTH:
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
    tracked as a known limitation.)

    Cost guards (2026-07 hardening): keys longer than _MAX_WORD_LENGTH are
    skipped — an oversized "word" thus yields zero candidates → no lookup →
    found=false, matching the batch routes' fail-soft philosophy (never 422 a
    positional batch for one bad item).  Accepted tradeoff: a handful of
    joke-length Wiktionary headwords (the 79-char Donaudampfschiffahrts…
    entry) become unresolvable; the longest real German compound (63 chars)
    still fits.  Skips are PER-KEY, so an oversized primary with a sane
    alternate still resolves via the alternate.  Only the first
    _MAX_ALT_KEYS alternates are considered (clients send 1)."""
    out: List[str] = []
    for k in [word, *((alts or [])[:_MAX_ALT_KEYS])]:
        nk = key(k)
        if nk and len(nk) <= _MAX_WORD_LENGTH and nk not in out:
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
    if caps is None:
        # No answer at all: never computed (fresh container, no persisted copy)
        # and this attempt failed — or one failed within the last ~30 s, whose
        # failure is shared rather than re-run per caller (_TTLMemo).
        # Deliberately NOT a 200 with empty lists:
        # the live 0.5.1 client (packages/player-ui/src/annotate/
        # capabilities.ts) caches whatever array a 200 carries for the WHOLE
        # tab session, so an "authoritative" [] during a DB blip left every
        # Latin-script video with no clickable words until reload.  On any
        # non-2xx, openapi-fetch resolves {error} with no `data`, so
        # fetchCapabilities() falls through to its build-time FALLBACK —
        # sourceLangs {ja, zh}, glossLangs ["en"] — exactly what it does when
        # the server is unreachable.  HTTPException (not a bare Response) so
        # the error still exits through CORSMiddleware: a Chrome-MV3 content
        # script sees a real 503 instead of an opaque CORS failure.
        raise HTTPException(
            status_code=503,
            detail="dictionary capabilities temporarily unavailable",
            headers={"Retry-After": "30"},
        )
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


def dictionary_lang(code: str) -> str:
    """Canonical `dictionary_entry.lang` for a requested language code.

    Every other route canonicalizes; this one used to do `.strip().lower()` and
    pass the result straight into `WHERE lang = %s`.  Rows are stored under
    'ja' / 'zh' / 'ko', so `ja-JP`, `jpn` or `zh-Hant` matched NOTHING and the
    caller got 200 OK with every word `found:false` — indistinguishable from
    "not in the dictionary" — and silently lost the lang-gated branches too (ZH
    decomposition, JA honorific peel).  The extension normalizes client-side
    (define-lang.ts), so it was latent there but live for the Loom Player, the
    web app, and any direct caller.

    Mirrors the client: alias-normalize, take the primary subtag, and collapse
    every Chinese variant (including yue) onto 'zh', which is how the CC-CEDICT
    rows are stored.
    """
    normalized = _normalize_lang_code((code or "").strip())
    primary = normalized.split("-")[0].split("_")[0].lower()
    if primary in ("zh", "yue", "cmn", "wuu", "nan", "hak"):
        return "zh"
    return primary


# Languages whose lemma comes from a real morphological analyzer (MeCab /
# jieba / kiwipiepy) and whose dictionaries (JMdict / CC-CEDICT / KRDict) carry
# no Wiktionary form-of links: their lemma is trusted outright.  Every other
# definable language is a Wiktextract language lemmatized by simplemma — a
# context-free lookup table that is sometimes simply wrong (see _surface_choice).
_ANALYZER_LEMMA_LANGS = frozenset({"ja", "zh", "ko"})


@router.post("/define/batch", response_model=DefineResponse)
def define_batch(req: DefineRequest) -> DefineResponse:
    lang = dictionary_lang(req.lang)
    gloss_lang = (req.gloss_lang or "en").strip().lower().split("-")[0].split("_")[0] or "en"

    # Per-word candidate keys (primary + alternates), then ONE batched lookup
    # over their union so multi-key costs no extra round-trips.
    cand_lists = [
        _candidates(w, req.alt_keys[i] if req.alt_keys and i < len(req.alt_keys) else None)
        for i, w in enumerate(req.words)
    ]
    # For a simplemma language whose caption SURFACE differs from the lemma, the
    # surface's own entry is consulted too (_surface_choice) — its keys (exact,
    # then the lowercase fallback) ride the same batched lookup.
    surface_cands = [
        _candidates(req.surfaces[i], None)
        if (req.surfaces and i < len(req.surfaces)
            and _surface_may_override(lang, req.surfaces[i], w))
        else []
        for i, w in enumerate(req.words)
    ]
    union = sorted({c for cands in (*cand_lists, *surface_cands) for c in cands})
    store = get_dictionary_store()
    found = store.lookup(lang, union, gloss_lang) if union else {}

    # Form-of resolution (Wiktextract inflected forms): a chosen entry that is
    # only an "inflection of LEMMA" carries the meaning one hop away.  Collect the
    # target lemmas and do ONE more batched lookup so the card can show the real
    # definition + a grammar breakdown built from the entry's tags — this is how
    # Hindi / Spanish / French / German / Russian / … inflected words get handled.
    chosens: list = []
    fo_targets: list = []  # per word: (lemma, tags) or None
    links: list = []       # per word: the surface's form-of sense naming the lemma, or None
    lemma_keys: set = set()
    for w, cands, s_cands in zip(req.words, cand_lists, surface_cands):
        direct = next((found[c] for c in cands if found.get(c) and found[c].senses), None)
        chosen = direct or next(
            (found[c] for c in cands if found.get(c) and found[c].parts), None
        )
        surface_defn, link = _surface_choice(
            [found[c] for c in s_cands if found.get(c) and found[c].senses], w)
        use_surface = surface_defn is not None
        if use_surface:
            chosen = surface_defn
        links.append(link)
        chosens.append(chosen)
        fo = _form_of(chosen, strict=use_surface)
        if fo and use_surface:
            # The override path is new behaviour, so it shows only the grammar
            # every sense naming this target agrees on (_shared_link).  The
            # ordinary path keeps its first-sense tags, unchanged from HEAD.
            fo = _shared_link(chosen.senses, key(fo[0]).casefold()) or fo
        fo_targets.append(fo)
        if fo:
            lemma_keys.add(key(fo[0]))
    lemma_found = (
        store.lookup(lang, sorted(lemma_keys), gloss_lang) if lemma_keys else {}
    )

    results: List[DefineResult] = []
    for i, (w, cands) in enumerate(zip(req.words, cand_lists)):
        chosen = chosens[i]
        # Romaji tracks the DISPLAYED reading: the client's contextual reading
        # (は→わ, inflected 見た) if it sent one, else the dictionary reading.
        ctx_reading = req.readings[i] if req.readings and i < len(req.readings) else None
        disp_reading = ctx_reading or (chosen.reading if chosen else None)
        romaji, romaji_alt = _romaji_pair(lang, disp_reading)

        # Grammar breakdown.  Two sources, in priority order:
        #  1. Wiktextract form-of: the clicked word is an inflected form; follow it
        #     to the lemma for the REAL senses and build grammar from its tags.
        #  2. Surface morphology (ja/ko): analyze the caption word directly; a
        #     continuation (next cue's lead) recovers a split predicate (finding ③).
        fo = fo_targets[i]
        resolved = lemma_found.get(key(fo[0])) if fo else None
        if fo and resolved and resolved.senses:
            lemma, tags = fo
            grammar = _to_grammar_model(grammar_from_tags(tags, lemma))
            results.append(
                DefineResult(
                    word=w,
                    found=True,          # meaning recovered via the lemma
                    reading=chosen.reading if chosen else None,
                    romaji=romaji,
                    romaji_alt=romaji_alt,
                    senses=_senses(resolved.senses),
                    sources=list(resolved.sources),
                    grammar=grammar,
                )
            )
            continue

        surface = req.surfaces[i] if req.surfaces and i < len(req.surfaces) and req.surfaces[i] else w
        cont = req.surface_continuations[i] if (
            req.surface_continuations and i < len(req.surface_continuations)
        ) else ""
        grammar = _grammar_model(surface, lang, cont)
        if grammar is None and links[i] is not None:
            # The lemma was kept because the surface's own entry names it
            # (fr est → "3rd-person singular present indicative of être"); that
            # sense's tags ARE the surface's grammar.
            target, tags = links[i]
            grammar = _to_grammar_model(grammar_from_tags(tags, target))

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


def _form_of(defn, *, strict: bool = False) -> Optional[tuple]:
    """If *defn*'s first sense is a Wiktionary inflected form ("form-of"), return
    (lemma, tags) so the route can resolve the real definition + grammar; else
    None.  Guards against a form-of entry whose lemma can't be parsed.

    ``strict`` parses the target with _form_of_target instead of the raw
    extract_form_of_lemma.  It is used exactly where the route now DEPARTS
    from the lemma the client sent (_surface_choice): a wrong hop there is a
    confidently wrong answer the old code never gave.  The ordinary path keeps
    its long-standing parse on purpose — applying the stricter one everywhere
    also changes cards for words simplemma leaves unchanged, e.g. de "Essen"
    ("gerund of essen; eating" would resolve to essen "to eat" and drop its own
    "meal / food" senses), which is a separate decision from H-9."""
    if defn is None or not defn.senses:
        return None
    return _form_of_sense(defn.senses[0], strict=strict)


def _is_form_of_sense(sense) -> bool:
    misc = [m.lower() for m in (sense.misc or [])]
    return "form-of" in misc or "form of" in misc


def _form_of_sense(sense, *, strict: bool = False) -> Optional[tuple]:
    """(target lemma, tags) if *sense* is a form-of sense with a parseable
    target (a trustworthy one when ``strict``), else None."""
    if not _is_form_of_sense(sense):
        return None
    gloss = sense.gloss[0] if sense.gloss else ""
    lemma = _form_of_target(gloss) if strict else extract_form_of_lemma(gloss)
    if not lemma:
        return None
    return (lemma, sense.misc)


# Mirrors loom_core.grammar's split: the target follows the LAST "of".
_FORM_OF_OF = re.compile(r"\bof\s+", re.IGNORECASE)
_LEADING_PAREN = re.compile(r"^\s*\([^)]*\)")


def _form_of_target(gloss: str) -> Optional[str]:
    """The lemma a form-of gloss points at, or None when it can't be trusted.

    extract_form_of_lemma takes the FIRST word when the text after the last
    "of" runs on, and that word is only the target when the gloss marks where
    the target ends (all shapes measured on real kaikki rows):

      "… of ser; you are" · "plural of notre; our" · "… of der: the"
          → the delimiter is kept on the word ("ser;") and never matched a
            headword, so the lemma hop silently missed — strip it;
      "… of avere and (obsolete) havere" · "… of un (“a / an”), the …"
          → a conjunction, or a parenthetical then punctuation — trusted;
      "form of the article i (“the”) used before a vowel, …"   (it: gli)
          → prose: the "target" is the English word "the", which resolved to
            Italian "the" = "misspelling of tè".  Rejected (the surface entry
            is shown instead of a confidently wrong one);
      "plural of de la (“some”, …)"
          → a multi-word lemma; its first word alone is wrong — rejected."""
    raw = extract_form_of_lemma(gloss)
    if not raw:
        return None
    target = raw.rstrip(":;,.").strip()
    if not target:
        return None
    if target != raw:
        return target                  # the gloss delimits it: "ser;" / "der:"
    tail = _FORM_OF_OF.split(gloss)[-1].strip()
    # extract_form_of_lemma drops pedagogical stress marks (чита́ть → читать).
    bare = tail.replace("\u0301", "").replace("\u0300", "")
    if not bare.startswith(raw):
        return target                  # can't locate it; keep prior behaviour
    rest = _LEADING_PAREN.sub("", bare[len(raw):]).strip()
    if not rest or rest[0] in ":;,." or rest.split()[0].lower() in ("and", "or"):
        return target
    return None


def _surface_may_override(lang: str, surface: Optional[str], lemma: str) -> bool:
    """Is *lemma* one whose caption SURFACE entry gets a say (_surface_choice)?

    Only where the lemma came from simplemma's context-free lookup table — so
    never for ja/zh/ko (a real analyzer), and not for two kinds of token whose
    lemma is right by construction and whose surface entry is a trap:

    - **Same word up to case.**  The first word of every subtitle line is
      capitalized; simplemma lowercases it (May → may) but the card sends the
      capitalized surface, and Wiktextract is full of capitalized homographs —
      months, surnames, villages, abbreviations, "honorific alternative
      letter-case form of …".  Letting them in turned 27 of 60 common English
      line-initial words wrong ("May I come in?" → "The fifth month …",
      "Can you …" → a river in Essex), and fr On/Le, de Ich/Er/Es/So, pt Eu/Ele
      likewise.  Case-only differences are orthography, not a different word.
    - **A peeled elision clitic** (fr l' qu' d' j' c' n' m' t' s', it l' d' c'
      un').  Its lemma is the curated full form from _ELISION_LEMMA (012dfb1),
      and its surface is a bare letter whose own entry — "The twelfth letter of
      the French alphabet", "alternative spelling of ku" — is exactly the wrong
      answer 012dfb1 removed from 7.4% of French tokens.  Membership, not
      equality with the table value: fr s' is `si` before il/ils."""
    if lang in _ANALYZER_LEMMA_LANGS or not surface:
        return False
    s = key(surface).casefold()
    if not s or s == key(lemma).casefold():
        return False
    return s not in _ELISION_LEMMA.get(lang, {})


def _surface_relation(surface_defn, lemma: str) -> tuple[str, Optional[tuple]]:
    """How Wiktionary relates one SURFACE entry to the client's lemma:

    ("links", fo)    a form-of sense names the lemma — fo is its (target, tags);
    ("other", None)  it inflects a DIFFERENT word, or it is a standalone
                     headword Wiktionary doesn't tie to the lemma;
    ("unknown", None) its relations can't be read, so nothing can be concluded.

    Rules, in order (all measured on real kaikki rows):

    1. Not English glosses → unknown.  Form-of targets are read by parsing the
       English " … of X" shape.  A native-edition column (gloss_lang=es is
       live) writes "Tercera persona del plural … de comer." — tagged form-of
       or not, it can't be parsed, and treating it as a standalone headword put
       that pointer text on the card in place of the lemma's meaning.
    2. The FIRST sense is a form-of: naming the lemma → links (comieron → comer
       + its tags as grammar); naming another word → other (eres → ser).  Its
       target can't be read → unknown.
    3. A LATER form-of sense names the lemma → links (fr est: "east" first,
       then "… of être").  A later form-of whose target can't be read →
       unknown (it may be the one naming the lemma).
    4. Otherwise → other (fr te → "you", notre → "our", es se → reflexive).

    The first sense decides BEFORE "any sense names the lemma" — measured, not
    arbitrary: es "eres" has "second-person … of ser" first and "plural of ere"
    (the letter R) second, and letting any-sense win answered "the letter R"
    again.  The accepted cost is a surface whose first sense inflects another
    word while simplemma's lemma was a correct later one — en "leaves" (plural
    of leaf / 3sg of leave) now reads as leaf.  That one is genuinely ambiguous
    without context (right either way about half the time); eres→ere is wrong
    every time, and "eres" is among the most frequent words in Spanish
    dialogue."""
    if surface_defn.gloss_lang != DEFAULT_GLOSS_LANG:
        return "unknown", None
    want = key(lemma).casefold()
    senses = surface_defn.senses
    if _is_form_of_sense(senses[0]):
        first = _form_of_sense(senses[0], strict=True)
        if first is None:
            return "unknown", None
        if key(first[0]).casefold() == want:
            return "links", _shared_link(senses, want)
        # The first sense inflects ANOTHER word.  If a later VERB sense inflects
        # the lemma while the first isn't a verb, the surface is a noun/verb
        # homograph (en "leaves": plural of leaf / 3sg of leave) and nothing
        # without context can pick; keep the lemma, i.e. exactly HEAD's answer.
        # es "eres" still overrides: its first sense (… of ser) IS the verb, and
        # the later sense naming the lemma ("plural of ere") is the noun.
        if not _is_verb_sense(senses[0]) and any(
            _is_verb_sense(s) and _names(s, want) for s in senses[1:]
        ):
            return "links", _shared_link(senses, want)
        return "other", None
    unreadable = False
    for sense in senses[1:]:
        if not _is_form_of_sense(sense):
            continue
        fo = _form_of_sense(sense, strict=True)
        if fo is None:
            unreadable = True
        elif key(fo[0]).casefold() == want:
            return "links", _shared_link(senses, want)
    return ("unknown", None) if unreadable else ("other", None)


def _is_verb_sense(sense) -> bool:
    return any((p or "").lower() == "verb" for p in (sense.pos or ()))


def _names(sense, want: str) -> bool:
    """Is *sense* a readable form-of whose target is *want* (casefolded)?"""
    fo = _form_of_sense(sense, strict=True)
    return fo is not None and key(fo[0]).casefold() == want


def _shared_link(senses, want: str) -> Optional[tuple]:
    """(target, tags) for the form-of senses in *senses* that name *want*, where
    tags keeps ONLY the grammar every such sense agrees on.

    The grammar pill is context-free: taking the first matching sense's tags
    put "second-person · singular" on "They were" and "plural" (the noun) on
    "It flies away".  A surface that inflects the lemma several ways (were =
    2sg past / plural past; flies = noun plural / verb 3sg) is only certain
    about what those readings share (were → past · indicative; flies →
    nothing), so show that and nothing more — a missing pill is fine, a wrong
    one is not.  A sense with no recognised grammar tags asserts nothing and is
    left out rather than emptying the intersection."""
    target, feats = None, []
    for sense in senses:
        fo = _form_of_sense(sense, strict=True)
        if fo is None or key(fo[0]).casefold() != want:
            continue
        target = target or fo[0]
        gb = grammar_from_tags(fo[1], fo[0])
        if gb is not None:
            feats.append([f.code for f in gb.features])
    if target is None:
        return None
    shared = [c for c in feats[0] if all(c in f for f in feats[1:])] if feats else []
    return (target, shared)


def _surface_choice(surface_defns: list, lemma: str) -> tuple:
    """Should a simplemma language's SURFACE entry beat its lemma?  (H-9)

    The card sends words=[lemma], alt_keys=[[surface]], and the first key that
    hits wins — so a wrong simplemma lemma used to win outright whenever it
    happened to be a headword: es eres→ere "the name of the letter R", fr
    te/me→le "the", fr notre/votre/nos/vos/leur/mes/ses→son "sound", es se→él
    "he".  Wiktionary itself says how a surface relates to its lemma — a
    form-of sense names the word it inflects — so read the surface's entries
    (*surface_defns*: the exact form, then its lowercase fallback) with
    _surface_relation.  The surface overrides the lemma ONLY on positive,
    readable evidence; anything short of that keeps today's lemma path:

    - any entry "unknown" → keep the lemma;
    - any entry "links" → keep the lemma, and hand back that sense so its tags
      supply the grammar (fr est → être · present …; en "Is" → be, where the
      capitalized "Is" is "plural of I" but lowercase "is" names be);
    - every entry "other" → use the surface, whose form-of the route then
      resolves as usual (eres → ser + grammar).  When the surface is
      capitalized and its lowercase form has an entry too, the LOWERCASE one
      is used: simplemma already changed this word beyond case, so the capital
      is line-initial orthography, and the capitalized headword is the proper
      noun / "alternative letter-case form" entry (it "La" → "alternative
      letter-case form of la (“you”)" vs la's own article sense).  Lexically
      capitalized words — German nouns — reach here with no lowercase entry, or
      are settled earlier by a "links" (Häuser → plural of Haus).

    Returns (surface_defn or None, link) — link is the (target, tags) of the
    sense that tied the surface to the lemma.  No entries → (None, None): the
    lemma path is used unchanged."""
    relations = [(d, *_surface_relation(d, lemma)) for d in surface_defns]
    if not relations or any(kind == "unknown" for _, kind, _ in relations):
        return None, None
    links = [fo for _, kind, fo in relations if kind == "links" and fo]
    if links:
        # Same rule as _shared_link, across the surface's entries (exact form
        # and its lowercase fallback): only grammar they all agree on.
        shared = [c for c in links[0][1] if all(c in tags for _, tags in links[1:])]
        return None, (links[0][0], shared)
    return next((d for d, _, _ in relations if d.word == d.word.lower()),
                relations[0][0]), None


def _to_grammar_model(gb) -> Optional[GrammarBreakdown]:
    """Convert a loom_core.grammar.GrammarBreakdown (dataclass) to the wire model,
    or None when there's nothing to show (no breakdown / no features)."""
    if gb is None or not gb.features:
        return None
    return GrammarBreakdown(
        dict_form=gb.dict_form,
        features=[
            GrammarFeature(code=f.code, display=f.display, surface=f.surface)
            for f in gb.features
        ],
    )


def _grammar_model(
    surface: str, lang: str, continuation: str = ""
) -> Optional[GrammarBreakdown]:
    """Grammar breakdown of *surface* for *lang*, or None.  Only returned when
    there's inflection to explain (a plain dictionary form → None) so the card
    shows a grammar section only when it adds something.  *continuation* stitches
    the next cue's lead for a split predicate (finding ③).  Fail-soft — a MeCab
    hiccup never breaks a definition lookup.

    Cost guards (2026-07 hardening): an implausibly long surface (no caption
    word approaches 500 chars) skips analysis instead of feeding MeCab/kiwi an
    arbitrary-length string; the continuation is sliced — harmless, the suffix
    walk stops at the first content word anyway."""
    if not grammar_supported(lang):
        return None
    if not surface or len(surface) > _MAX_SURFACE_LENGTH:
        return None
    continuation = (continuation or "")[:_MAX_SURFACE_LENGTH]
    try:
        gb = analyze_grammar(surface, lang, continuation)
    except Exception:
        return None
    return _to_grammar_model(gb)
