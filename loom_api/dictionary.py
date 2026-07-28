"""Bilingual dictionary lookup — backs the per-word vocab-lookup /define route.

See VOCAB_LOOKUP.md.  The ``dictionary_entry`` table is populated OUT OF BAND
by ``scripts/ingest_dictionaries.py`` (JMdict for Japanese, CC-CEDICT for
Chinese, both CC-BY-SA); this module is the READ side the API queries.

Two rules the ingest validation surfaced (VOCAB_LOOKUP.md §5.4), both handled
in ``_merge_rows``:

1. **Query headword OR reading.**  A kana-written Japanese word (たべる) lives
   in the ``reading`` column of the 食べる row, not ``headword`` — so a lemma
   the client hands us may hit either column.  Both are indexed.
2. **Multiple rows per (lang, headword)** — homographs, CC-CEDICT variant/
   cross-ref lines, JMdict multi-form words — are MERGED into one definition
   (sense lists concatenated, ``common`` rows first, duplicate glosses dropped).

Unlike the romanize/annotate result cache this is NOT cached: a lookup is one
indexed query, not expensive compute, and the batch endpoint already collapses
a whole paused line into a single query.  Same fail-open contract as the cache
and corpus stores though — a down DB degrades to "not found", never a 500.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol, Sequence

logger = logging.getLogger("loom.dictionary")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)
    logger.propagate = False


# --------------------------------------------------------------------------- #
# Result shape
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class DefinitionSense:
    gloss: tuple[str, ...]
    pos: tuple[str, ...] = ()
    misc: tuple[str, ...] = ()


@dataclass(frozen=True)
class Definition:
    word: str                       # the query word this answers (echoed back)
    lang: str
    reading: Optional[str]
    senses: tuple[DefinitionSense, ...]
    sources: tuple[str, ...]        # e.g. ("jmdict",) / ("cc-cedict",)
    # Dictionary-aware decomposition: when the word itself isn't a headword
    # (jieba over-grouped, e.g. number+measure-word 一顶 / 两个), the greedy
    # longest-match breakdown into sub-words that ARE headwords.  Empty for a
    # direct hit.  ``senses`` empty + ``parts`` non-empty = "no direct entry,
    # here's the breakdown".
    parts: tuple["Definition", ...] = ()


# A stored row as both impls hand it to the merge helper.
@dataclass(frozen=True)
class _Row:
    headword: str
    reading: Optional[str]
    senses: Any                     # list[dict]: [{"gloss":[...], "pos":[...], "misc":[...]}]
    common: bool
    source: str
    gloss_lang: str = "en"          # language the glosses are written in


# Universal fallback gloss language: when a word has no gloss in the user's
# requested language, English is served instead (always ingested).
DEFAULT_GLOSS_LANG = "en"


def _norm(word: str) -> str:
    """Query-side canonicalization.  NFC + strip so composition-form variants
    of the same CJK string match the ingested headword."""
    return unicodedata.normalize("NFC", word).strip()


# CC-CEDICT stores Pinyin with trailing tone NUMBERS ("ni3 hao3", "lu:4"); the
# card must show proper diacritics ("nǐ hǎo", "lǜ").  This converts one entry's
# reading, leaving anything that isn't a numbered syllable untouched.
_PINYIN_TONE_ROWS = {
    "a": "āáǎà", "e": "ēéěè", "i": "īíǐì",
    "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ",
}
_PINYIN_SYLLABLE_RE = re.compile(r"^([A-Za-züÜ:]+?)([1-5])$")


def _syllable_to_diacritic(syl: str) -> str:
    m = _PINYIN_SYLLABLE_RE.match(syl)
    if not m:
        return syl  # punctuation, latin, r5-less token, already-marked, etc.
    body, tone = m.group(1), int(m.group(2))
    # CC-CEDICT writes ü as "u:" or "v".
    body = (
        body.replace("u:", "ü").replace("U:", "Ü").replace("v", "ü").replace("V", "Ü")
    )
    if tone == 5:  # neutral tone — no mark
        return body
    low = body.lower()
    # Standard placement: a or e always take the mark; in "ou" it's the o;
    # otherwise the last vowel (handles iu→u, ui→i).
    if "a" in low:
        idx = low.index("a")
    elif "e" in low:
        idx = low.index("e")
    elif "ou" in low:
        idx = low.index("o")
    else:
        idx = next((i for i in range(len(low) - 1, -1, -1) if low[i] in "aeiouü"), None)
    if idx is None:
        return body
    marks = _PINYIN_TONE_ROWS.get(low[idx])
    if not marks:
        return body
    marked = marks[tone - 1]
    if body[idx].isupper():
        marked = marked.upper()
    return body[:idx] + marked + body[idx + 1 :]


def cedict_pinyin_to_diacritics(numbered: Optional[str]) -> Optional[str]:
    """Convert CC-CEDICT numbered Pinyin ("ni3 hao3") to tone-marked Pinyin
    ("nǐ hǎo").  Idempotent on already-marked or non-Pinyin input."""
    if not numbered:
        return numbered
    return " ".join(_syllable_to_diacritic(tok) for tok in numbered.split(" "))


# CC-CEDICT glosses embed cross-references as 漢字[pin1 yin1] / CL:个[ge4]; those
# bracketed readings carry the same numbered Pinyin and must be marked too.
_CEDICT_BRACKET_RE = re.compile(r"\[([^\[\]]*)\]")
_NUMBERED_PINYIN_RE = re.compile(r"^[A-Za-zü: ,]*[1-5][A-Za-zü:1-5 ,]*$")


def clean_gloss_pinyin(gloss: str) -> str:
    """Tone-mark any numbered-Pinyin cross-reference inside a gloss, e.g.
    'variant of 逼格[bi1 ge2]' -> 'variant of 逼格[bí gé]'.  Non-Pinyin brackets
    are left untouched."""
    def repl(m: "re.Match") -> str:
        inside = m.group(1)
        if _NUMBERED_PINYIN_RE.match(inside):
            return "[" + cedict_pinyin_to_diacritics(inside) + "]"
        return m.group(0)
    return _CEDICT_BRACKET_RE.sub(repl, gloss)


def _select_gloss_lang(rows: list[_Row], want: str) -> list[_Row]:
    """Keep rows whose glosses are in the requested language; if the word has
    none, fall back to English (always present); if not even that, keep all.
    This is what makes gloss language a per-word graceful preference rather than
    a hard filter — a word missing a French gloss still shows its English one."""
    want_rows = [r for r in rows if r.gloss_lang == want]
    if want_rows:
        return want_rows
    en_rows = [r for r in rows if r.gloss_lang == DEFAULT_GLOSS_LANG]
    return en_rows or rows


def _merge_rows(
    word: str, lang: str, rows: list[_Row], gloss_lang: str = DEFAULT_GLOSS_LANG,
) -> Optional[Definition]:
    """Collapse every row matching ``word`` into one Definition.

    Rows are first narrowed to the requested ``gloss_lang`` (English fallback,
    see _select_gloss_lang).  ``common`` rows sort first (ranking, not filtering
    — §5 "full coverage, common as a signal"); glosses that repeat across
    rows/sources are dropped so a word carried by both dictionaries doesn't
    double up.
    """
    if not rows:
        return None
    rows = _select_gloss_lang(rows, gloss_lang)
    ordered = sorted(rows, key=lambda r: (not r.common))  # common first, stable

    senses: list[DefinitionSense] = []
    seen_gloss: set[tuple[str, ...]] = set()
    sources: list[str] = []
    reading: Optional[str] = None

    for row in ordered:
        if reading is None and row.reading:
            reading = row.reading
        if row.source not in sources:
            sources.append(row.source)
        for s in row.senses or ():
            gloss = tuple(s.get("gloss", []))
            if not gloss or gloss in seen_gloss:
                continue
            seen_gloss.add(gloss)
            if lang == "zh":
                gloss = tuple(clean_gloss_pinyin(g) for g in gloss)
            senses.append(
                DefinitionSense(
                    gloss=gloss,
                    pos=tuple(s.get("pos", [])),
                    misc=tuple(s.get("misc", [])),
                )
            )
    if not senses:
        return None
    if lang == "zh":
        reading = cedict_pinyin_to_diacritics(reading)
    return Definition(
        word=word, lang=lang, reading=reading,
        senses=tuple(senses), sources=tuple(sources),
    )


def _decompose_zh(word: str, sub_defs: dict[str, Definition]) -> tuple[Definition, ...]:
    """Greedy longest-match segmentation of `word` against `sub_defs` (a map of
    its substrings → Definition).  Walks left→right taking the longest prefix
    that IS a headword; unknown characters are skipped.  Returns the component
    Definitions (empty if nothing matched)."""
    chars = list(word)
    n = len(chars)
    parts: list[Definition] = []
    i = 0
    while i < n:
        matched_j = None
        for j in range(n, i, -1):  # longest first
            if "".join(chars[i:j]) in sub_defs:
                parts.append(sub_defs["".join(chars[i:j])])
                matched_j = j
                break
        i = matched_j if matched_j is not None else i + 1
    return tuple(parts)


# Japanese honorific/title suffixes — a closed grammatical set, NOT lexical, so
# their gloss is hardcoded rather than looked up (the bare kana homophones are
# ambiguous in JMdict: さん→"acid", 様→"sorry state", くん→"native reading").
# suffix surface (kanji + kana forms) -> (reading, gloss).  When a token like
# 玉葉様 misses the dictionary as a whole, we peel a trailing honorific so the
# card still teaches "様 = honorific" instead of showing "no entry".
_JA_HONORIFICS: dict[str, tuple[str, str]] = {
    "さん": ("さん", "honorific suffix — Mr./Ms./Mrs. (neutral, polite)"),
    "様": ("さま", "honorific suffix — formal/respectful (Mr./Ms./Mrs.)"),
    "さま": ("さま", "honorific suffix — formal/respectful (Mr./Ms./Mrs.)"),
    "ちゃん": ("ちゃん", "affectionate suffix — for children & close friends"),
    "君": ("くん", "familiar suffix — typically for boys or juniors"),
    "くん": ("くん", "familiar suffix — typically for boys or juniors"),
    "殿": ("どの", "formal honorific suffix — official / archaic"),
    "氏": ("し", "honorific suffix for surnames — formal / written"),
    "坊": ("ぼう", "affectionate/diminutive suffix"),
}
# Longest suffix first so 様 doesn't shadow a longer future entry.
_JA_HONORIFIC_ORDER = sorted(_JA_HONORIFICS, key=len, reverse=True)


def _split_ja_honorific(word: str) -> Optional[tuple[str, str]]:
    """If *word* ends in a known honorific with a non-empty stem, return
    (stem, honorific_surface); else None."""
    for h in _JA_HONORIFIC_ORDER:
        if len(word) > len(h) and word.endswith(h):
            return word[: -len(h)], h
    return None


def _honorific_part(surface: str) -> Definition:
    """A synthetic one-sense Definition for an honorific suffix."""
    reading, gloss = _JA_HONORIFICS[surface]
    return Definition(
        word=surface, lang="ja", reading=reading,
        senses=(DefinitionSense(gloss=(gloss,), pos=("suffix",)),),
        sources=("honorific",),
    )


def _decompose_ja(word: str, stem_defs: dict[str, Definition]) -> tuple[Definition, ...]:
    """Peel a trailing honorific off *word* (玉葉様 → [玉葉?, 様]).  The stem is
    shown only if it's itself a dictionary word (``stem_defs``); the honorific
    always resolves via the hardcoded table.  Empty if no honorific suffix."""
    sp = _split_ja_honorific(word)
    if sp is None:
        return ()
    stem, h = sp
    parts: list[Definition] = []
    stem_def = stem_defs.get(_norm(stem))
    if stem_def is not None and stem_def.senses:
        parts.append(stem_def)
    parts.append(_honorific_part(h))
    return tuple(parts)


def _lookup_ja_decomposition(
    words: Sequence[str],
    exact: dict[str, Definition],
    exact_lookup,
) -> dict[str, Definition]:
    """Japanese honorific-peel fallback for missed words (see
    _lookup_with_decomposition).  Batches every stem into one extra query."""
    wanted = {_norm(w) for w in words if _norm(w)}
    missed = [w for w in wanted if w not in exact]
    stems: set[str] = set()
    splits: dict[str, str] = {}   # word -> stem (only those with a honorific)
    for w in missed:
        sp = _split_ja_honorific(w)
        if sp is not None:
            stem, _h = sp
            splits[w] = stem
            if stem:
                stems.add(stem)
    if not splits:
        return exact
    stem_defs = exact_lookup(sorted(stems)) if stems else {}
    for w in splits:
        parts = _decompose_ja(w, stem_defs)
        if parts:
            exact[w] = Definition(
                word=w, lang="ja", reading=None, senses=(), sources=(), parts=parts,
            )
    return exact


class _TTLMemo:
    """Single-value, time-bounded memo with stampede protection.

    For `capabilities()`, whose answer changes only when someone runs an
    ingest but whose query is a full scan of the ~8.5M-row / ~3GB
    `dictionary_entry` (no index covers `gloss_lang` — the composite one was
    dropped to free disk).  The extension calls it once per session, so before
    this every activation cost a heap scan while holding one of only FOUR pool
    connections; a handful at once starved the pool, which trips the result
    cache's 30-second breaker and turns a DB blip into a CPU stampede.

    A failed/empty computation is NOT cached: a down DB answers "no languages",
    and remembering that would leave every word un-clickable for the whole TTL
    after the DB came back.  The lock keeps N concurrent callers to ONE scan.
    """

    def __init__(self, ttl: float, clock=time.time):
        self._ttl = ttl
        self._clock = clock
        self._at = 0.0
        self._value = None
        self._lock = threading.Lock()

    def get(self, compute):
        now = self._clock()
        value = self._value
        if value is not None and (now - self._at) < self._ttl:
            return value
        with self._lock:
            # Re-check: another thread may have refreshed while we waited.
            now = self._clock()
            if self._value is not None and (now - self._at) < self._ttl:
                return self._value
            fresh = compute()
            if fresh:                      # never cache a failure
                self._value = fresh
                self._at = now
            return fresh

    def invalidate(self) -> None:
        with self._lock:
            self._value = None


# How long a capabilities() answer is reused. Env-tunable like the other caps;
# an ingest becomes visible within this window without a redeploy.
CAPABILITIES_TTL_SECONDS = float(os.environ.get("LOOM_CAPABILITIES_TTL", "900"))


# Decomposition cost caps (see _lookup_with_decomposition).  Both the word
# length and the word count are request-controlled, and substring generation is
# O(len²) per word, so these bound an otherwise unbounded allocation.
_ZH_DECOMPOSE_MAX_WORD_LEN = 12    # longest plausible CC-CEDICT phrase entry
_ZH_DECOMPOSE_MAX_SUBS = 5000      # total candidate substrings per request


def _lookup_with_decomposition(
    lang: str,
    words: Sequence[str],
    exact_lookup,
) -> dict[str, Definition]:
    """Exact lookup, then a decomposition fallback for words that aren't
    themselves headwords:

    - **Chinese** — jieba groups number+measure-word and other compounds
      (一顶 / 两个 / 一道) that CC-CEDICT only holds the pieces of → greedy
      longest-match breakdown.
    - **Japanese** — a name/noun glued to a trailing honorific (玉葉様 / 綾波君)
      that misses as a whole → peel the honorific (hardcoded gloss) and show
      the stem if it's a word.  Miss-gated, so lexicalized お...さん words
      (お母さん / 母さん / 赤ちゃん) that hit directly never decompose.

    ``exact_lookup(words) -> {word: Definition}`` is the store's direct-match."""
    exact = exact_lookup(words)
    if lang == "ja":
        return _lookup_ja_decomposition(words, exact, exact_lookup)
    if lang != "zh":
        return exact
    wanted = {_norm(w) for w in words if _norm(w)}
    missed = [w for w in wanted if w not in exact and len(w) >= 2]
    if not missed:
        return exact

    # Every substring of every missed word, minus the missed words themselves
    # (already known absent), in one batch query.
    #
    # BOUNDED DELIBERATELY.  This used to assume "words are short" — but both
    # the length and the count are REQUEST-controlled: /define/batch admits 200
    # words × (1 + 16 alt_keys) candidates of up to _MAX_WORD_LENGTH (64) chars,
    # and generation is O(len²) per word.  A ~2 MB body (well under the 10 MB
    # cap, costing one rate-limit slot) produced ~416k substrings in testing and
    # scales to millions — enough to OOM the single worker before the query even
    # ran.  The caps are far above real usage: a paused caption line is ~20
    # tokens, of which few miss, and CC-CEDICT's longest real entries are short
    # phrases — so legitimate decomposition is unaffected.
    subs: set[str] = set()
    skipped_long = 0
    for w in missed:
        if len(w) > _ZH_DECOMPOSE_MAX_WORD_LEN:
            skipped_long += 1          # not a word; nothing to decompose into
            continue
        chars = list(w)
        for a in range(len(chars)):
            for b in range(a + 1, len(chars) + 1):
                subs.add("".join(chars[a:b]))
        if len(subs) >= _ZH_DECOMPOSE_MAX_SUBS:
            break
    if skipped_long or len(subs) >= _ZH_DECOMPOSE_MAX_SUBS:
        # Never truncate silently — a quietly-capped result looks identical to
        # "the dictionary has no parts for this".
        logger.warning(
            "loom.dictionary zh decomposition capped: %d missed, %d over %d chars, "
            "%d candidate substrings (cap %d)",
            len(missed), skipped_long, _ZH_DECOMPOSE_MAX_WORD_LEN,
            len(subs), _ZH_DECOMPOSE_MAX_SUBS,
        )
    subs.difference_update(missed)
    sub_defs = exact_lookup(sorted(subs)) if subs else {}

    for w in missed:
        parts = _decompose_zh(w, sub_defs)
        if parts:
            exact[w] = Definition(
                word=w, lang=lang, reading=None, senses=(), sources=(), parts=parts,
            )
    return exact


# --------------------------------------------------------------------------- #
# Store protocol + impls
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Capabilities:
    """What the dictionary can currently answer — served to the client so it
    can drive definability off the SERVER, not a hardcoded allowlist.  Adding a
    dictionary changes only this (and the data), never the extension."""
    source_langs: tuple[str, ...]   # languages with entries (e.g. ("ja", "zh"))
    gloss_langs: tuple[str, ...]    # languages glosses are written in (e.g. ("en",))
    # Per-source-language gloss availability: which gloss languages actually have
    # entries for each source language (e.g. {"ja": ("en","de","ru"), "es":
    # ("en","es")}).  Lets the client offer a "Dictionary language" picker that
    # lists only the languages a definition can really be written in for the
    # video's language — not the global union.  Empty tuple/dict is a safe
    # degrade (client falls back to the global gloss_langs).
    gloss_langs_by_source: Mapping[str, tuple[str, ...]] = field(
        default_factory=dict)


class DictionaryStore(Protocol):
    """Read-only lookup seam.  Fail-open: trouble yields fewer/no results,
    never an exception into the request path."""

    def lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str = DEFAULT_GLOSS_LANG,
    ) -> dict[str, Definition]:
        """Map each input word that has an entry → its merged Definition, with
        glosses in ``gloss_lang`` where available (English fallback).  Words with
        no entry are simply absent from the returned dict."""

    def capabilities(self) -> Capabilities:
        """Which source + gloss languages currently have data."""


class NullDictionaryStore:
    """No dictionary configured (no DSN, or LOOM_DICTIONARY=off)."""

    def lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str = DEFAULT_GLOSS_LANG,
    ) -> dict[str, Definition]:
        return {}

    def capabilities(self) -> Capabilities:
        return Capabilities(source_langs=(), gloss_langs=())


class InMemoryDictionaryStore:
    """List-backed impl for tests.  Mirrors the Postgres query + merge exactly."""

    def __init__(self, rows: Sequence[dict] | None = None) -> None:
        # each dict: {lang, headword, reading, senses, common, source, gloss_lang}
        self.rows: list[dict] = list(rows or [])

    def add(self, lang: str, headword: str, reading: Optional[str], senses: list[dict],
            *, common: bool = False, source: str = "test",
            gloss_lang: str = DEFAULT_GLOSS_LANG) -> None:
        self.rows.append({
            "lang": lang, "headword": headword, "reading": reading,
            "senses": senses, "common": common, "source": source,
            "gloss_lang": gloss_lang,
        })

    def lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str = DEFAULT_GLOSS_LANG,
    ) -> dict[str, Definition]:
        return _lookup_with_decomposition(
            lang, words, lambda ws: self._exact_lookup(lang, ws, gloss_lang)
        )

    def _exact_lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str,
    ) -> dict[str, Definition]:
        wanted = {_norm(w) for w in words if _norm(w)}
        if not wanted:
            return {}
        out: dict[str, Definition] = {}
        for w in wanted:
            matches = [
                _Row(r["headword"], r.get("reading"), r.get("senses"),
                     r.get("common", False), r["source"],
                     r.get("gloss_lang", DEFAULT_GLOSS_LANG))
                for r in self.rows
                if r["lang"] == lang and (r["headword"] == w or r.get("reading") == w)
            ]
            merged = _merge_rows(w, lang, matches, gloss_lang)
            if merged is not None:
                out[w] = merged
        return out

    def capabilities(self) -> Capabilities:
        by_source: dict[str, set[str]] = {}
        for r in self.rows:
            by_source.setdefault(r["lang"], set()).add(
                r.get("gloss_lang", DEFAULT_GLOSS_LANG))
        return Capabilities(
            source_langs=tuple(sorted({r["lang"] for r in self.rows})),
            gloss_langs=tuple(sorted({r.get("gloss_lang", DEFAULT_GLOSS_LANG) for r in self.rows})),
            gloss_langs_by_source={
                lang: tuple(sorted(gl)) for lang, gl in by_source.items()},
        )


# Kept identical to scripts/ingest_dictionaries.py::_SCHEMA — ingestion owns
# population, but the store ensures the table/indexes exist so a query never
# faults on a fresh DB (it just returns no rows until an ingest runs).
_SCHEMA = """
CREATE TABLE IF NOT EXISTS dictionary_entry (
    id             bigserial PRIMARY KEY,
    lang           text NOT NULL,
    headword       text NOT NULL,
    reading        text,
    senses         jsonb NOT NULL,
    common         boolean NOT NULL DEFAULT false,
    source         text NOT NULL,
    source_version text NOT NULL,
    gloss_lang     text NOT NULL DEFAULT 'en'
);
-- Additive migration for DBs created before the multilingual gloss axis.
ALTER TABLE dictionary_entry ADD COLUMN IF NOT EXISTS gloss_lang text NOT NULL DEFAULT 'en';
CREATE INDEX IF NOT EXISTS dictionary_entry_lang_headword ON dictionary_entry (lang, headword);
CREATE INDEX IF NOT EXISTS dictionary_entry_lang_reading ON dictionary_entry (lang, reading);
"""


class PostgresDictionaryStore:
    """Railway-Postgres impl.  Same fail-open + backoff shape as
    PostgresResultCache / PostgresCorpusStore; shares the process pool."""

    _BACKOFF_SECONDS = 30.0

    def __init__(self, dsn: str) -> None:
        from .db import get_pool  # lazy: pool construction needs psycopg

        self._pool = get_pool(dsn)
        self._backoff_until = 0.0
        self._caps_memo = _TTLMemo(CAPABILITIES_TTL_SECONDS)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        try:
            with self._pool.connection(timeout=10) as conn:
                conn.execute(_SCHEMA)
        except Exception:
            logger.warning("dictionary: schema init failed (fail-open)", exc_info=True)
            self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    def _down(self) -> bool:
        return time.monotonic() < self._backoff_until

    def _trip(self, op: str) -> None:
        logger.warning("dictionary: %s failed (fail-open, %ss backoff)", op, self._BACKOFF_SECONDS, exc_info=True)
        self._backoff_until = time.monotonic() + self._BACKOFF_SECONDS

    def lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str = DEFAULT_GLOSS_LANG,
    ) -> dict[str, Definition]:
        return _lookup_with_decomposition(
            lang, words, lambda ws: self._exact_lookup(lang, ws, gloss_lang)
        )

    def _exact_lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str,
    ) -> dict[str, Definition]:
        wanted = sorted({_norm(w) for w in words if _norm(w)})
        if not wanted or self._down():
            return {}
        # Fetch the requested gloss language AND the English fallback in one
        # query; _merge_rows narrows per-word (a word missing the requested
        # gloss still shows English).  When gloss_lang IS English this is just
        # the one language.
        want_glosses = [gloss_lang] if gloss_lang == DEFAULT_GLOSS_LANG else [gloss_lang, DEFAULT_GLOSS_LANG]
        try:
            with self._pool.connection(timeout=2.5) as conn:
                rows = conn.execute(
                    "SELECT headword, reading, senses, common, source, gloss_lang"
                    " FROM dictionary_entry"
                    " WHERE lang = %s AND gloss_lang = ANY(%s)"
                    " AND (headword = ANY(%s) OR reading = ANY(%s))",
                    (lang, want_glosses, wanted, wanted),
                ).fetchall()
        except Exception:
            self._trip("lookup")
            return {}

        # Bucket each row under every query word it satisfies (a row can match
        # by headword for one word and by reading for another).
        wset = set(wanted)
        buckets: dict[str, list[_Row]] = {w: [] for w in wanted}
        for headword, reading, senses, common, source, g_lang in rows:
            row = _Row(headword, reading, senses, common, source, g_lang)
            if headword in wset:
                buckets[headword].append(row)
            if reading in wset and reading != headword:
                buckets[reading].append(row)

        out: dict[str, Definition] = {}
        for w, rws in buckets.items():
            merged = _merge_rows(w, lang, rws, gloss_lang)
            if merged is not None:
                out[w] = merged
        return out

    def capabilities(self) -> Capabilities:
        # Memoized: this is a full heap scan of ~8.5M rows (no index covers
        # gloss_lang) and the extension calls it once per session, so an
        # un-cached version burned a scan + one of four pool connections per
        # activation.  The answer only changes on an ingest.  See _TTLMemo —
        # failures aren't cached, so a DB blip doesn't blank capabilities for
        # the whole TTL.
        cached = self._caps_memo.get(self._compute_capabilities)
        return cached or Capabilities(source_langs=(), gloss_langs=())

    def _compute_capabilities(self) -> Optional[Capabilities]:
        if self._down():
            return None
        try:
            with self._pool.connection(timeout=2.5) as conn:
                # One DISTINCT (lang, gloss_lang) scan gives all three views:
                # the source set, the gloss set, and the per-source gloss map.
                pairs = conn.execute(
                    "SELECT DISTINCT lang, gloss_lang FROM dictionary_entry "
                    "ORDER BY lang, gloss_lang").fetchall()
        except Exception:
            self._trip("capabilities")
            return None
        by_source: dict[str, list[str]] = {}
        glosses: list[str] = []
        for lang, gloss in pairs:
            by_source.setdefault(lang, []).append(gloss)
            if gloss not in glosses:
                glosses.append(gloss)
        return Capabilities(
            source_langs=tuple(by_source.keys()),
            gloss_langs=tuple(sorted(glosses)),
            gloss_langs_by_source={
                lang: tuple(gl) for lang, gl in by_source.items()},
        )
