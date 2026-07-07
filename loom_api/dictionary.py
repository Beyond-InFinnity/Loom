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
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Optional, Protocol, Sequence

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


# A stored row as both impls hand it to the merge helper.
@dataclass(frozen=True)
class _Row:
    headword: str
    reading: Optional[str]
    senses: Any                     # list[dict]: [{"gloss":[...], "pos":[...], "misc":[...]}]
    common: bool
    source: str


def _norm(word: str) -> str:
    """Query-side canonicalization.  NFC + strip so composition-form variants
    of the same CJK string match the ingested headword."""
    return unicodedata.normalize("NFC", word).strip()


def _merge_rows(word: str, lang: str, rows: list[_Row]) -> Optional[Definition]:
    """Collapse every row matching ``word`` into one Definition.

    ``common`` rows sort first (ranking, not filtering — §5 "full coverage,
    common as a signal"); glosses that repeat across rows/sources are dropped
    so a word carried by both dictionaries doesn't double up.
    """
    if not rows:
        return None
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
            senses.append(
                DefinitionSense(
                    gloss=gloss,
                    pos=tuple(s.get("pos", [])),
                    misc=tuple(s.get("misc", [])),
                )
            )
    if not senses:
        return None
    return Definition(
        word=word, lang=lang, reading=reading,
        senses=tuple(senses), sources=tuple(sources),
    )


# --------------------------------------------------------------------------- #
# Store protocol + impls
# --------------------------------------------------------------------------- #

class DictionaryStore(Protocol):
    """Read-only lookup seam.  Fail-open: trouble yields fewer/no results,
    never an exception into the request path."""

    def lookup(self, lang: str, words: Sequence[str]) -> dict[str, Definition]:
        """Map each input word that has an entry → its merged Definition.
        Words with no entry are simply absent from the returned dict."""


class NullDictionaryStore:
    """No dictionary configured (no DSN, or LOOM_DICTIONARY=off)."""

    def lookup(self, lang: str, words: Sequence[str]) -> dict[str, Definition]:
        return {}


class InMemoryDictionaryStore:
    """List-backed impl for tests.  Mirrors the Postgres query + merge exactly."""

    def __init__(self, rows: Sequence[dict] | None = None) -> None:
        # each dict: {lang, headword, reading, senses, common, source}
        self.rows: list[dict] = list(rows or [])

    def add(self, lang: str, headword: str, reading: Optional[str], senses: list[dict],
            *, common: bool = False, source: str = "test") -> None:
        self.rows.append({
            "lang": lang, "headword": headword, "reading": reading,
            "senses": senses, "common": common, "source": source,
        })

    def lookup(self, lang: str, words: Sequence[str]) -> dict[str, Definition]:
        wanted = {_norm(w) for w in words if _norm(w)}
        if not wanted:
            return {}
        out: dict[str, Definition] = {}
        for w in wanted:
            matches = [
                _Row(r["headword"], r.get("reading"), r.get("senses"), r.get("common", False), r["source"])
                for r in self.rows
                if r["lang"] == lang and (r["headword"] == w or r.get("reading") == w)
            ]
            merged = _merge_rows(w, lang, matches)
            if merged is not None:
                out[w] = merged
        return out


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
    source_version text NOT NULL
);
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

    def lookup(self, lang: str, words: Sequence[str]) -> dict[str, Definition]:
        wanted = sorted({_norm(w) for w in words if _norm(w)})
        if not wanted or self._down():
            return {}
        try:
            with self._pool.connection(timeout=2.5) as conn:
                rows = conn.execute(
                    "SELECT headword, reading, senses, common, source"
                    " FROM dictionary_entry"
                    " WHERE lang = %s AND (headword = ANY(%s) OR reading = ANY(%s))",
                    (lang, wanted, wanted),
                ).fetchall()
        except Exception:
            self._trip("lookup")
            return {}

        # Bucket each row under every query word it satisfies (a row can match
        # by headword for one word and by reading for another).
        wset = set(wanted)
        buckets: dict[str, list[_Row]] = {w: [] for w in wanted}
        for headword, reading, senses, common, source in rows:
            row = _Row(headword, reading, senses, common, source)
            if headword in wset:
                buckets[headword].append(row)
            if reading in wset and reading != headword:
                buckets[reading].append(row)

        out: dict[str, Definition] = {}
        for w, rws in buckets.items():
            merged = _merge_rows(w, lang, rws)
            if merged is not None:
                out[w] = merged
        return out
