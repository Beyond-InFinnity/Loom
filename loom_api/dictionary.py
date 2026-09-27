"""Bilingual dictionary lookup — backs the per-word vocab-lookup /define route.

See VOCAB_LOOKUP.md.  The ``dictionary_entry`` table is populated OUT OF BAND
by ``scripts/ingest_dictionaries.py`` (JMdict for Japanese, CC-CEDICT for
Chinese, both CC-BY-SA); this module is the READ side the API queries.

Two rules the ingest validation surfaced (VOCAB_LOOKUP.md §5.4), both handled
in ``_merge_rows``:

1. **Query headword OR reading — JAPANESE ONLY.**  A kana-written Japanese
   word (たべる) lives in the ``reading`` column of the 食べる row, not
   ``headword`` — so a lemma the client hands us may hit either column.  Both
   are indexed.  Every other source stores something else there (KRDict: the
   hangul pronunciation; Wiktextract: bare IPA; CC-CEDICT: numbered pinyin),
   where a reading match merges HOMOPHONES — see _READING_MATCH_LANGS.
2. **Multiple rows per (lang, headword)** — homographs, CC-CEDICT variant/
   cross-ref lines, JMdict multi-form words — are MERGED into one definition
   (sense lists concatenated, ``common`` rows first, duplicate glosses dropped).

Unlike the romanize/annotate result cache this is NOT cached: a lookup is one
indexed query, not expensive compute, and the batch endpoint already collapses
a whole paused line into a single query.  Same fail-open contract as the cache
and corpus stores though — a down DB degrades to "not found", never a 500.
(``capabilities()`` IS memoized — it is a full-table scan; see _TTLMemo.)
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol, Sequence

# Pool contention vs. outage (PoolTimeout) — shared with the result cache,
# which borrows from the same process-wide pool.
from .result_cache import pool_is_saturated

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
    # Language the ``senses`` glosses are actually written in — the requested
    # gloss language, or English when this word fell back (_select_gloss_lang);
    # None if the served rows mix languages.  Internal (not on the wire): the
    # route only reads a surface's form-of relations out of English glosses.
    gloss_lang: Optional[str] = "en"


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

# Source languages whose `reading` column is a legitimate LOOKUP KEY (rule 1 in
# the module docstring).  Only JMdict's is: a kana-written word (たべる) must
# find the 食べる row through it.  Everywhere else a reading match merges
# homophones into the card — KRDict stores the hangul pronunciation (남우
# "actor" is read 나무, so 나무 "tree" also showed "actor"; 동물 "animal" showed
# 독물 "poison"), Wiktextract stores bare IPA (French des is /de/, so `de`
# absorbed the plural-article senses of des), CC-CEDICT numbered pinyin.
_READING_MATCH_LANGS = frozenset({"ja"})


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
    served_gloss_langs = {r.gloss_lang for r in rows}
    return Definition(
        word=word, lang=lang, reading=reading,
        senses=tuple(senses), sources=tuple(sources),
        gloss_lang=served_gloss_langs.pop() if len(served_gloss_langs) == 1 else None,
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


def _spawn_daemon(fn) -> None:
    threading.Thread(target=fn, name="loom-capabilities-refresh", daemon=True).start()


class _TTLMemo:
    """Single-value STALE-WHILE-REVALIDATE memo, for `capabilities()`.

    Its answer changes only when someone runs an ingest (dictionary growth is
    currently paused), but computing it is a full scan of the ~9M-row / ~3 GB
    `dictionary_entry` (no index covers `gloss_lang` — the composite one was
    dropped to free disk), measured at 30–48 s cold in prod.  And the extension
    AWAITS /define/capabilities before it fetches furigana, so a caller that
    waits on that scan waits with a blank caption line.  Hence:

    - **A cached value is always returned at once.**  Past the TTL it is still
      returned — stale — and ONE background refresh is started (single-flight:
      any number of stale callers launch one scan); the fresh answer replaces
      it when the scan finishes.  So the TTL only decides how often a scan runs
      in the BACKGROUND, never whether a user waits for one.
    - **A failed refresh keeps the stale value** (never degrade to nothing) and
      is retried no sooner than ``retry_seconds`` later, so a failing scan is
      not relaunched on every request.
    - **Only the very first compute, with nothing to serve, blocks** — single-
      flight under a lock, so N concurrent callers still cost ONE scan.  A
      failed first compute (None) is NOT cached for the TTL: remembering "no
      languages" would leave every word un-clickable for hours after the DB
      came back.  The caller gets None (the route turns that into a 503).
    - **…but a failed first compute is single-flight too.**  Callers that
      queued on the lock behind it — and any arriving within the pause after it
      — get None at once instead of each re-running the compute in turn.
      Before, every failure tripped the store's 30 s breaker, which did this
      implicitly; the scan's own statement_timeout and pool contention now
      deliberately DON'T trip, and without this the Nth queued caller waited
      N × (up to 180 s), each holding one of anyio's ~40 threadpool slots.  The
      pause is ``first_retry_seconds`` (30 s — the route's Retry-After and the
      breaker's backoff) or as long as the failed attempt took, whichever is
      longer, so a scan that died at its 180 s bound isn't relaunched
      back-to-back while a cheap failure (contention, a tripped breaker) is
      retried soon.

    ``spawn`` runs a refresh (default: a daemon thread; tests pass a queue).
    ``on_store(value, at)`` fires after every successful compute — the
    Postgres store persists the answer there so a recycled worker starts warm.
    """

    def __init__(self, ttl: float, clock=time.time, *, spawn=None, on_store=None,
                 retry_seconds: Optional[float] = None,
                 first_retry_seconds: float = 30.0):
        self._ttl = ttl
        self._clock = clock
        self._spawn = spawn or _spawn_daemon
        self._on_store = on_store
        self.retry_seconds = min(ttl, 300.0) if retry_seconds is None else retry_seconds
        self.first_retry_seconds = first_retry_seconds
        self._at = 0.0
        self._value = None
        self._lock = threading.Lock()     # the blocking first compute
        self._state = threading.Lock()    # background-refresh bookkeeping
        self._refreshing = False
        self._retry_at = 0.0
        self._first_retry_at = 0.0        # guarded by _lock

    def get(self, compute):
        value = self._value
        if value is not None:
            if self._clock() - self._at >= self._ttl:
                self._refresh_in_background(compute)
            return value
        with self._lock:
            if self._value is not None:   # filled while we waited for the lock
                return self._value
            started = self._clock()
            if started < self._first_retry_at:
                return None                # a compute just failed; share it
            try:
                fresh = compute()
            except Exception:
                logger.warning("dictionary: capabilities compute failed", exc_info=True)
                fresh = None
            if fresh is not None:          # never cache a failure
                self._store(fresh, started)
            else:
                finished = self._clock()
                self._first_retry_at = finished + max(
                    self.first_retry_seconds, finished - started)
            return fresh

    def seed(self, value, at: float) -> None:
        """Install a previously computed value as of *at* (a persisted copy);
        its age is honoured, so an old one is served stale and refreshed."""
        if value is not None:
            self._at = at
            self._value = value

    def invalidate(self) -> None:
        with self._lock:
            self._value = None
            self._first_retry_at = 0.0

    def _store(self, value, at: float) -> None:
        # _at before _value: get() reads _value first, so it can never pair the
        # new value with the old timestamp and launch a pointless refresh.
        self._at = at
        self._value = value
        if self._on_store is not None:
            try:
                self._on_store(value, at)
            except Exception:
                logger.warning("dictionary: capabilities on_store failed", exc_info=True)

    def _refresh_in_background(self, compute) -> None:
        with self._state:
            if self._refreshing or self._clock() < self._retry_at:
                return
            self._refreshing = True

        def run() -> None:
            started = self._clock()
            fresh = None
            try:
                fresh = compute()
                if fresh is not None:
                    self._store(fresh, started)
            except Exception:
                logger.warning("dictionary: capabilities refresh failed; still serving "
                               "the previous answer", exc_info=True)
            finally:
                with self._state:
                    if fresh is None:
                        self._retry_at = self._clock() + self.retry_seconds
                    self._refreshing = False

        try:
            self._spawn(run)
        except Exception:                  # e.g. "can't start new thread"
            logger.warning("dictionary: could not start capabilities refresh", exc_info=True)
            with self._state:
                self._refreshing = False


# How long a capabilities() answer counts as fresh.  With stale-while-revalidate
# this only sets how often the ~3 GB scan runs IN THE BACKGROUND (a request
# never waits on it once any answer exists), so it is long: 6 h.  An ingest
# becomes visible within this window without a redeploy.  Env-tunable like the
# other caps.
CAPABILITIES_TTL_SECONDS = float(os.environ.get("LOOM_CAPABILITIES_TTL", "21600"))

# Upper bound on the DISTINCT scan itself (SET LOCAL statement_timeout), so a
# stuck refresh can't pin one of the pool's FOUR connections indefinitely.
# Cold prod scans measured 30–48 s; 180 s is generous headroom.
CAPABILITIES_SCAN_TIMEOUT_SECONDS = float(
    os.environ.get("LOOM_CAPABILITIES_SCAN_TIMEOUT", "180"))

# Wire-format version of the /define/capabilities response.  Bumped if the
# response SHAPE changes; the client refetches per session so a new dictionary
# needs no bump.  Also stamped into the persisted capabilities file, so a file
# written by an older shape is ignored.  (Re-exported by routes/define.py.)
#   v2: added gloss_langs_by_source (per-source gloss availability for the
#       "Dictionary language" picker).
CAPABILITIES_VERSION = 2


def capabilities_cache_path() -> Optional[str]:
    """Where PostgresDictionaryStore persists its last good capabilities answer,
    or None when disabled (``LOOM_CAPABILITIES_CACHE_FILE=off``/``0``).

    Default: the system temp dir.  gunicorn recycles the worker every ~500
    requests (plus idle-recycle), and each fresh worker would otherwise start
    with nothing and run the scan again; the recycled worker lives in the SAME
    container, so /tmp survives it.  A new deploy is a new container and starts
    cold — the boot warm-up covers that."""
    raw = (os.environ.get("LOOM_CAPABILITIES_CACHE_FILE") or "").strip()
    if not raw:
        return os.path.join(tempfile.gettempdir(), "loom-capabilities.json")
    if raw.lower() in {"off", "0", "false"}:
        return None
    return raw


def _warm_capabilities(store) -> None:
    try:
        store.capabilities()
    except Exception:
        logger.warning("dictionary: capabilities warm-up failed (continuing)", exc_info=True)


def start_capabilities_warmup(store) -> bool:
    """Compute ``store.capabilities()`` once on a daemon thread at worker boot,
    so the first extension activation after a deploy doesn't pay the cold
    scan (with a persisted copy this is instant — or a background refresh if
    that copy is stale).  Never under pytest, like the idle recycler; never
    raises.  Returns True iff the thread was started."""
    if "PYTEST_CURRENT_TEST" in os.environ:
        return False
    try:
        threading.Thread(target=_warm_capabilities, args=(store,),
                         name="loom-capabilities-warm", daemon=True).start()
    except Exception:
        logger.warning("dictionary: could not start capabilities warm-up", exc_info=True)
        return False
    return True


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

    def capabilities(self) -> Optional[Capabilities]:
        """Which source + gloss languages currently have data — or None when
        the store has no answer at all right now (never computed, and the
        attempt failed).  None is NOT "no languages": the route answers 503
        rather than an authoritative empty list the client would cache."""


class NullDictionaryStore:
    """No dictionary configured (no DSN, or LOOM_DICTIONARY=off)."""

    def lookup(
        self, lang: str, words: Sequence[str], gloss_lang: str = DEFAULT_GLOSS_LANG,
    ) -> dict[str, Definition]:
        return {}

    def capabilities(self) -> Capabilities:
        # A real answer, not an outage: with no dictionary configured nothing
        # is definable, so this stays a 200 with empty lists (never None/503).
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
        by_reading = lang in _READING_MATCH_LANGS
        out: dict[str, Definition] = {}
        for w in wanted:
            matches = [
                _Row(r["headword"], r.get("reading"), r.get("senses"),
                     r.get("common", False), r["source"],
                     r.get("gloss_lang", DEFAULT_GLOSS_LANG))
                for r in self.rows
                if r["lang"] == lang
                and (r["headword"] == w or (by_reading and r.get("reading") == w))
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


# Postgres SQLSTATE for "canceling statement due to statement timeout".
_SQLSTATE_QUERY_CANCELED = "57014"


def _capabilities_to_json(caps: Capabilities, at: float, dsn_fingerprint: str) -> dict:
    return {
        "capabilities_version": CAPABILITIES_VERSION,
        "dsn_fingerprint": dsn_fingerprint,
        "computed_at": at,
        "source_langs": list(caps.source_langs),
        "gloss_langs": list(caps.gloss_langs),
        "gloss_langs_by_source": {
            lang: list(gl) for lang, gl in caps.gloss_langs_by_source.items()},
    }


def _capabilities_from_json(
    payload: Any, dsn_fingerprint: str,
) -> Optional[tuple[Capabilities, float]]:
    """(Capabilities, computed_at) from a persisted payload, or None when it was
    written for another database / response shape or is malformed in any way.
    Strict on purpose: a wrong file is ignored (one scan), never trusted."""
    if not isinstance(payload, dict):
        return None
    if (payload.get("capabilities_version") != CAPABILITIES_VERSION
            or payload.get("dsn_fingerprint") != dsn_fingerprint):
        return None
    at = payload.get("computed_at")
    src, gloss = payload.get("source_langs"), payload.get("gloss_langs")
    by_source = payload.get("gloss_langs_by_source")

    def strs(v) -> bool:
        return isinstance(v, list) and all(isinstance(x, str) for x in v)

    if (isinstance(at, bool) or not isinstance(at, (int, float))
            or not strs(src) or not strs(gloss) or not isinstance(by_source, dict)
            or not all(isinstance(k, str) and strs(v) for k, v in by_source.items())):
        return None
    caps = Capabilities(
        source_langs=tuple(src), gloss_langs=tuple(gloss),
        gloss_langs_by_source={k: tuple(v) for k, v in by_source.items()},
    )
    return caps, float(at)


class PostgresDictionaryStore:
    """Railway-Postgres impl.  Same fail-open + backoff shape as
    PostgresResultCache / PostgresCorpusStore; shares the process pool."""

    _BACKOFF_SECONDS = 30.0

    def __init__(self, dsn: str) -> None:
        from .db import get_pool  # lazy: pool construction needs psycopg
        from .result_cache import pool_timeout_types

        self._pool = get_pool(dsn)
        self._pool_timeout = pool_timeout_types()
        self._backoff_until = 0.0
        # The persisted capabilities copy is keyed to THIS database by a hash
        # of the DSN (never the DSN itself — it carries the password), so
        # repointing LOOM_DICTIONARY_URL at another store can't serve a stale
        # language list from the old one.
        self._caps_path = capabilities_cache_path()
        self._dsn_fingerprint = hashlib.sha256(dsn.encode("utf-8")).hexdigest()[:16]
        self._caps_memo = _TTLMemo(CAPABILITIES_TTL_SECONDS,
                                   on_store=self._persist_capabilities)
        self._load_persisted_capabilities()
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

    def _pool_timed_out(self, op: str) -> None:
        """PoolTimeout: when every pooled connection is busy it is CONTENTION —
        degrade only this request (found:false / no capabilities this once).
        Tripping would blank EVERY definition for 30 s, long after the pool
        freed up.  A timeout because the database can't even be reached is an
        outage and still trips.  See result_cache.pool_is_saturated."""
        if pool_is_saturated(self._pool):
            logger.warning(
                "dictionary: %s gave up waiting for a pooled connection — pool "
                "CONTENDED (every connection busy); degrading this request only, no backoff",
                op,
            )
        else:
            self._trip(op)

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
        # The reading column is a lookup key for Japanese only (docstring rule
        # 1 / _READING_MATCH_LANGS); elsewhere it would merge homophones.
        by_reading = lang in _READING_MATCH_LANGS
        if by_reading:
            match, params = "(headword = ANY(%s) OR reading = ANY(%s))", (lang, want_glosses, wanted, wanted)
        else:
            match, params = "headword = ANY(%s)", (lang, want_glosses, wanted)
        try:
            with self._pool.connection(timeout=2.5) as conn:
                rows = conn.execute(
                    "SELECT headword, reading, senses, common, source, gloss_lang"
                    " FROM dictionary_entry"
                    " WHERE lang = %s AND gloss_lang = ANY(%s)"
                    " AND " + match,
                    params,
                ).fetchall()
        except self._pool_timeout:
            self._pool_timed_out("lookup")
            return {}
        except Exception:
            self._trip("lookup")
            return {}

        # Bucket each row under every query word it satisfies (a Japanese row
        # can match by headword for one word and by reading for another).
        wset = set(wanted)
        buckets: dict[str, list[_Row]] = {w: [] for w in wanted}
        for headword, reading, senses, common, source, g_lang in rows:
            row = _Row(headword, reading, senses, common, source, g_lang)
            if headword in wset:
                buckets[headword].append(row)
            if by_reading and reading in wset and reading != headword:
                buckets[reading].append(row)

        out: dict[str, Definition] = {}
        for w, rws in buckets.items():
            merged = _merge_rows(w, lang, rws, gloss_lang)
            if merged is not None:
                out[w] = merged
        return out

    def capabilities(self) -> Optional[Capabilities]:
        # Memoized stale-while-revalidate (see _TTLMemo): this is a full heap
        # scan of ~9M rows (no index covers gloss_lang) measured at 30–48 s
        # cold, and the extension awaits it before fetching furigana.  Once any
        # answer exists — computed, or loaded from the persisted file — no
        # request waits on the scan again.  None = nothing available at all;
        # the route answers 503, never an authoritative empty list.
        return self._caps_memo.get(self._compute_capabilities)

    def _load_persisted_capabilities(self) -> None:
        if not self._caps_path:
            return
        try:
            with open(self._caps_path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except FileNotFoundError:
            return
        except Exception:
            logger.warning("dictionary: unreadable capabilities cache %s (ignored)",
                           self._caps_path, exc_info=True)
            return
        loaded = _capabilities_from_json(payload, self._dsn_fingerprint)
        if loaded is not None:
            self._caps_memo.seed(*loaded)

    def _persist_capabilities(self, caps: Capabilities, at: float) -> None:
        """Atomically write the last good answer (temp file in the same dir +
        os.replace), so a reader never sees a half-written file.  Best effort:
        a failed write only costs the next worker one scan."""
        if not self._caps_path:
            return
        payload = _capabilities_to_json(caps, at, self._dsn_fingerprint)
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(
                prefix=".loom-capabilities.", suffix=".tmp",
                dir=os.path.dirname(os.path.abspath(self._caps_path)))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            os.replace(tmp, self._caps_path)
            tmp = None
        except Exception:
            logger.warning("dictionary: could not persist capabilities to %s",
                           self._caps_path, exc_info=True)
        finally:
            if tmp is not None:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)

    def _compute_capabilities(self) -> Optional[Capabilities]:
        if self._down():
            return None
        try:
            with self._pool.connection(timeout=2.5) as conn:
                # SET LOCAL is transaction-scoped: it bounds this scan and ends
                # with the transaction, so it can't leak onto whoever borrows
                # the pooled connection next.
                with conn.transaction():
                    conn.execute("SET LOCAL statement_timeout = %d"
                                 % int(CAPABILITIES_SCAN_TIMEOUT_SECONDS * 1000))
                    # One DISTINCT (lang, gloss_lang) scan gives all three views:
                    # the source set, the gloss set, and the per-source gloss map.
                    pairs = conn.execute(
                        "SELECT DISTINCT lang, gloss_lang FROM dictionary_entry "
                        "ORDER BY lang, gloss_lang").fetchall()
        except self._pool_timeout:
            self._pool_timed_out("capabilities")
            return None
        except Exception as exc:
            if getattr(exc, "sqlstate", None) == _SQLSTATE_QUERY_CANCELED:
                # Our own bound fired: the scan was slow, the DB isn't down.
                # Tripping would blank every definition for 30 s over it.
                logger.warning(
                    "dictionary: capabilities scan exceeded its %.0fs statement_timeout "
                    "(no backoff; the previous answer, if any, keeps being served)",
                    CAPABILITIES_SCAN_TIMEOUT_SECONDS)
            else:
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
