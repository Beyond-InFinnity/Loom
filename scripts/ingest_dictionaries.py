#!/usr/bin/env python3
"""Ingest open bilingual dictionaries into Loom's ``dictionary_entry`` table.

Backs the per-word vocabulary-lookup feature (see ``VOCAB_LOOKUP.md``).  Three
sources, normalized into ONE row shape so ``/define`` can query any uniformly:

* **CC-CEDICT** (Chinese)  — ``繁 简 [pin1 yin1] /sense/sense/`` plain text.
  License: CC-BY-SA 4.0 (MDBG).  ~124k entries.  gloss_lang=en.
* **JMdict-simplified** (Japanese) — pre-parsed JSON of EDRDG JMdict.
  License: CC-BY-SA 4.0 (EDRDG).  ~200k entries (full ``jmdict-eng``).  gloss_lang=en.
* **KRDict / NIKL 한국어기초사전** (Korean → 11 languages) — LMF XML.
  License: CC-BY-SA 2.0 KR ("한국어기초사전 - 국립국어원 제공").  ~50k headwords,
  each glossed in en/ja/zh/fr/es/ar/mn/vi/th/id/ru → one row per (word, gloss_lang).

The PARSE layer (``parse_cedict`` / ``parse_jmdict``) is pure and DB-free so it
can be validated without Postgres::

    python scripts/ingest_dictionaries.py validate \
        --cedict <cedict.txt> --jmdict <jmdict-eng.json>

The LOAD layer (``load_to_postgres``) upserts the normalized rows and is only
reached in ``ingest`` mode with a ``DATABASE_URL``.

Normalized row (mirrors ``VOCAB_LOOKUP.md`` §5.3)::

    {
      "lang": "ja" | "zh",
      "headword": str,            # 食べる / 你好   (lookup key)
      "reading": str | None,      # たべる / "ni3 hao3"
      "senses": [ {"pos": [str], "gloss": [str], "misc": [str], "field": [str]} ],
      "common": bool,             # ranking signal, NOT a filter
      "source": "jmdict" | "cc-cedict",
      "source_version": str,
    }
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Iterable, Iterator, Optional


# --------------------------------------------------------------------------- #
# Normalized entry
# --------------------------------------------------------------------------- #

@dataclass
class Sense:
    gloss: list[str] = field(default_factory=list)
    pos: list[str] = field(default_factory=list)
    misc: list[str] = field(default_factory=list)
    field_: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        d: dict = {"gloss": self.gloss}
        if self.pos:
            d["pos"] = self.pos
        if self.misc:
            d["misc"] = self.misc
        if self.field_:
            d["field"] = self.field_
        return d


@dataclass
class DictEntry:
    lang: str
    headword: str
    reading: Optional[str]
    senses: list[Sense]
    common: bool
    source: str
    source_version: str
    gloss_lang: str = "en"   # language the senses are written in (KRDict → 11 langs)

    def to_json(self) -> dict:
        return {
            "lang": self.lang,
            "headword": self.headword,
            "reading": self.reading,
            "senses": [s.to_json() for s in self.senses],
            "common": self.common,
            "source": self.source,
            "source_version": self.source_version,
            "gloss_lang": self.gloss_lang,
        }


# --------------------------------------------------------------------------- #
# CC-CEDICT  (Chinese)
# --------------------------------------------------------------------------- #

# `繁體 简体 [pin1 yin1] /sense one; syn/sense two/`
_CEDICT_RE = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/\s*$")


def _cedict_version(path: str) -> str:
    """CC-CEDICT stamps its build date in a header comment line."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if not line.startswith("#"):
                    break
                # e.g. "#! date=2026-07-06T07:14:07Z"
                if "date=" in line:
                    return "cc-cedict@" + line.split("date=", 1)[1].strip()
    except OSError:
        pass
    return "cc-cedict@unknown"


def parse_cedict_line(line: str, version: str = "cc-cedict") -> list[DictEntry]:
    """Parse ONE CC-CEDICT line → normalized entries (pure; unit-testable).

    Emits one row per script form (Traditional + Simplified); when the two are
    identical (common for single chars) only one row.  ``/`` splits distinct
    senses; ``;`` inside a sense is kept verbatim (synonyms).  Comments, blanks,
    and non-matching lines → ``[]``.
    """
    if line.startswith("#") or not line.strip():
        return []
    m = _CEDICT_RE.match(line.rstrip("\n"))
    if not m:
        return []
    trad, simp, pinyin, sense_blob = m.groups()
    glosses = [g for g in sense_blob.split("/") if g]
    if not glosses:
        return []
    senses = [Sense(gloss=[g]) for g in glosses]
    forms = [trad] if trad == simp else [trad, simp]
    return [
        DictEntry(
            lang="zh",
            headword=hw,
            reading=pinyin,
            senses=senses,
            common=False,  # CC-CEDICT carries no common flag
            source="cc-cedict",
            source_version=version,
        )
        for hw in forms
    ]


def parse_cedict(path: str) -> Iterator[DictEntry]:
    """Yield normalized entries from a CC-CEDICT text file."""
    version = _cedict_version(path)
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            yield from parse_cedict_line(line, version)


# --------------------------------------------------------------------------- #
# JMdict-simplified  (Japanese)
# --------------------------------------------------------------------------- #

def _load_jmdict(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def parse_jmdict_word(w: dict, tags: dict, version: str = "jmdict") -> list[DictEntry]:
    """Parse ONE JMdict-simplified word entry → normalized rows (pure).

    POS/misc/field tag codes are expanded to human text via the ``tags`` map.
    One row per kanji surface form (reading = primary kana); kana-only words
    emit one row per kana form.  All senses attach to every form of the word
    (JMdict ``appliesTo*`` is ``*`` in the overwhelming majority of entries;
    per-form sense restriction is a documented refinement).
    """
    def expand(codes: list[str]) -> list[str]:
        return [tags.get(c, c) for c in codes]

    kana_forms = w.get("kana", [])
    kanji_forms = w.get("kanji", [])
    primary_reading = kana_forms[0]["text"] if kana_forms else None

    senses: list[Sense] = []
    for s in w.get("sense", []):
        glosses = [g["text"] for g in s.get("gloss", []) if g.get("text")]
        if not glosses:
            continue
        senses.append(
            Sense(
                gloss=glosses,
                pos=expand(s.get("partOfSpeech", [])),
                misc=expand(s.get("misc", [])),
                field_=expand(s.get("field", [])),
            )
        )
    if not senses:
        return []

    if kanji_forms:
        return [
            DictEntry(
                lang="ja", headword=k["text"], reading=primary_reading, senses=senses,
                common=bool(k.get("common")), source="jmdict", source_version=version,
            )
            for k in kanji_forms
        ]
    # kana-only word: the kana IS the headword
    return [
        DictEntry(
            lang="ja", headword=r["text"], reading=r["text"], senses=senses,
            common=bool(r.get("common")), source="jmdict", source_version=version,
        )
        for r in kana_forms
    ]


def parse_jmdict(path: str) -> Iterator[DictEntry]:
    """Yield normalized entries from a JMdict-simplified JSON file."""
    data = _load_jmdict(path)
    tags: dict[str, str] = data.get("tags", {})
    version = "jmdict@" + str(data.get("version", "unknown"))
    for w in data["words"]:
        yield from parse_jmdict_word(w, tags, version)


# --------------------------------------------------------------------------- #
# KRDict / NIKL 한국어기초사전  (Korean → 11 languages)
# --------------------------------------------------------------------------- #
#
# Source format is NIKL's LMF XML (DTD_LMF_REV_16): an attribute/value tree of
# `<feat att="…" val="…"/>` under nested elements.  Multilingual glosses live in
# `<Equivalent>` blocks whose target language is a KOREAN-LANGUAGE NAME string
# (영어 / 일본어 / …), NOT an ISO code.  Files are large (tens of MB); parsed with
# iterparse so a chunk streams in constant memory.  License: CC-BY-SA 2.0 KR;
# attribution "한국어기초사전 - 국립국어원 제공".  Media/audio URLs are NOT
# redistributable and are deliberately never read.

# `<Equivalent>` language name (as it appears in the data) → BCP-47 gloss code.
_KRDICT_LANG = {
    "영어": "en", "일본어": "ja", "중국어": "zh", "프랑스어": "fr",
    "스페인어": "es", "아랍어": "ar", "몽골어": "mn", "베트남어": "vi",
    "타이어": "th", "인도네시아어": "id", "러시아어": "ru",
}

# Korean partOfSpeech name → an English POS tag for the card (falls back to the
# Korean label when unmapped; empty → no tag).
_KRDICT_POS = {
    "명사": "noun", "동사": "verb", "형용사": "adjective", "부사": "adverb",
    "대명사": "pronoun", "관형사": "determiner", "감탄사": "interjection",
    "조사": "particle", "수사": "numeral", "의존 명사": "bound noun",
    "보조 동사": "auxiliary verb", "보조 형용사": "auxiliary adjective",
    "어미": "ending", "접사": "affix", "품사 없음": "",
}

# vocabularyLevel values that mark a word as "common" (ranking signal only).
_KRDICT_COMMON_LEVELS = {"초급", "중급"}


def _krdict_pos(korean_pos: Optional[str]) -> list[str]:
    p = (korean_pos or "").strip()
    if not p:
        return []
    mapped = _KRDICT_POS.get(p, p)
    return [mapped] if mapped else []


def parse_krdict(path: str, version: str = "krdict") -> Iterator[DictEntry]:
    """Yield normalized entries from ONE KRDict LMF XML file (a chunk).

    Emits one row per (headword, gloss language): a Korean headword with its
    pronunciation as ``reading`` and, for each `<Equivalent>` language, the
    translated word + translated definition as that gloss-language's senses.
    Korean-only monolingual definitions are skipped (learners read the glosses,
    not the Korean definition).
    """
    import xml.etree.ElementTree as ET

    def fv(parent, xpath: str) -> str:
        """`val` of the first matching `<feat>` under *parent*, or "" (a feat can
        exist with no `val` attribute → .get returns None)."""
        el = parent.find(xpath)
        return (el.get("val") or "").strip() if el is not None else ""

    for _evt, le in ET.iterparse(path, events=("end",)):
        if le.tag != "LexicalEntry":
            continue
        headword = fv(le, "Lemma/feat[@att='writtenForm']")
        if not headword:
            le.clear()
            continue
        pos = _krdict_pos(fv(le, "feat[@att='partOfSpeech']"))
        reading = fv(le, "WordForm/feat[@att='pronunciation']") or None
        common = fv(le, "feat[@att='vocabularyLevel']") in _KRDICT_COMMON_LEVELS

        # Group each sense's foreign equivalents by gloss language.
        per_lang: dict[str, list[Sense]] = {}
        for sense in le.findall("Sense"):
            for eq in sense.findall("Equivalent"):
                iso = _KRDICT_LANG.get(fv(eq, "feat[@att='language']"))
                if not iso:
                    continue
                w = fv(eq, "feat[@att='lemma']")
                d = fv(eq, "feat[@att='definition']")
                gloss = [g for g in (w, d) if g]
                if gloss:
                    per_lang.setdefault(iso, []).append(Sense(gloss=gloss, pos=pos))

        for iso, senses in per_lang.items():
            yield DictEntry(
                lang="ko", headword=headword, reading=reading, senses=senses,
                common=common, source="krdict", source_version=version, gloss_lang=iso,
            )
        le.clear()


# --------------------------------------------------------------------------- #
# Postgres load  (only reached in `ingest` mode)
# --------------------------------------------------------------------------- #

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
ALTER TABLE dictionary_entry ADD COLUMN IF NOT EXISTS gloss_lang text NOT NULL DEFAULT 'en';
CREATE INDEX IF NOT EXISTS dictionary_entry_lang_headword
    ON dictionary_entry (lang, headword);
CREATE INDEX IF NOT EXISTS dictionary_entry_lang_reading
    ON dictionary_entry (lang, reading);
"""


def load_to_postgres(entries: Iterable[DictEntry], dsn: str, *, batch: int = 5000) -> int:
    """Create the table (if needed) and bulk-insert entries.  Returns row count.

    Replaces rows for each (source) wholesale: deletes the source's existing
    rows first so re-ingest is idempotent.  Requires ``psycopg`` (v3).
    """
    import psycopg  # lazy — only needed for actual load

    written = 0
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(_SCHEMA)
        sources_cleared: set[str] = set()
        buf: list[DictEntry] = []

        def flush(rows: list[DictEntry]) -> None:
            nonlocal written
            if not rows:
                return
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO dictionary_entry "
                    "(lang, headword, reading, senses, common, source, source_version, gloss_lang) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        (
                            e.lang, e.headword, e.reading,
                            json.dumps([s.to_json() for s in e.senses], ensure_ascii=False),
                            e.common, e.source, e.source_version, e.gloss_lang,
                        )
                        for e in rows
                    ],
                )
            written += len(rows)

        for e in entries:
            if e.source not in sources_cleared:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM dictionary_entry WHERE source = %s", (e.source,))
                sources_cleared.add(e.source)
            buf.append(e)
            if len(buf) >= batch:
                flush(buf)
                buf = []
        flush(buf)
        conn.commit()
    return written


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _expand_paths(paths: Optional[list[str]]) -> list[str]:
    """Expand a list of file / directory / glob args into concrete files.  A
    directory yields its *.xml children (KRDict ships as many numbered chunks)."""
    import glob
    import os
    out: list[str] = []
    for p in paths or []:
        if os.path.isdir(p):
            out.extend(sorted(glob.glob(os.path.join(p, "*.xml"))))
        elif any(ch in p for ch in "*?["):
            out.extend(sorted(glob.glob(p)))
        else:
            out.append(p)
    return out


def _iter_all(
    cedict: Optional[str],
    jmdict: Optional[str],
    krdict: Optional[list[str]] = None,
) -> Iterator[DictEntry]:
    if cedict:
        yield from parse_cedict(cedict)
    if jmdict:
        yield from parse_jmdict(jmdict)
    for path in _expand_paths(krdict):
        yield from parse_krdict(path)


def _cmd_validate(args: argparse.Namespace) -> int:
    """Parse all sources, print stats + sample entries for spot words."""
    samples = args.sample or ["食べる", "たべる", "你好", "喜歡", "喜欢", "吃", "사람", "먹다"]
    wanted = set(samples)
    hits: dict[str, list[DictEntry]] = {w: [] for w in wanted}

    counts: dict[str, int] = {}
    gloss_counts: dict[str, int] = {}
    total = 0
    for e in _iter_all(args.cedict, args.jmdict, args.krdict):
        total += 1
        counts[e.lang] = counts.get(e.lang, 0) + 1
        gloss_counts[e.gloss_lang] = gloss_counts.get(e.gloss_lang, 0) + 1
        if e.headword in wanted:
            hits[e.headword].append(e)

    langs = "  ".join(f"{k}={v}" for k, v in sorted(counts.items()))
    glosses = "  ".join(f"{k}={v}" for k, v in sorted(gloss_counts.items()))
    print(f"=== parsed {total} rows ===\n  by source-lang: {langs}\n  by gloss-lang:  {glosses}\n")
    for w in samples:
        rows = hits.get(w, [])
        print(f"--- {w!r}: {len(rows)} row(s) ---")
        for e in rows[:3]:  # a few rows (e.g. trad+simp, or several gloss langs)
            print(json.dumps(e.to_json(), ensure_ascii=False, indent=1))
        print()
    return 0


def _cmd_ingest(args: argparse.Namespace) -> int:
    import os
    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        print("ingest requires --dsn or DATABASE_URL", file=sys.stderr)
        return 2
    n = load_to_postgres(_iter_all(args.cedict, args.jmdict, args.krdict), dsn)
    print(f"loaded {n} rows into dictionary_entry")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--cedict", help="path to cedict_*.txt (CC-CEDICT)")
    common.add_argument("--jmdict", help="path to jmdict-eng-*.json (JMdict-simplified)")
    common.add_argument(
        "--krdict", action="append",
        help="KRDict LMF XML file, directory of chunks, or glob (repeatable)",
    )

    pv = sub.add_parser("validate", parents=[common], help="parse + print stats/samples, no DB")
    pv.add_argument("--sample", action="append", help="headword to dump (repeatable)")
    pv.set_defaults(func=_cmd_validate)

    pi = sub.add_parser("ingest", parents=[common], help="parse + upsert into Postgres")
    pi.add_argument("--dsn", help="Postgres DSN (else DATABASE_URL)")
    pi.set_defaults(func=_cmd_ingest)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
