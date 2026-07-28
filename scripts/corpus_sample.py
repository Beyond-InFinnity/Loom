#!/usr/bin/env python3
"""Dump a reproducible sample of REAL caption lines from the corpus.

Companion to scripts/dict_pipeline_audit.py: that harness measures the live
per-word definition pipeline, and this is what feeds it real input.  Kept as
two scripts so the (slow, credentialed) DB read happens once and the audit can
be re-run offline against a frozen sample — the same sample can then be
re-measured after a change to see whether the change actually helped.

Read-only.  Never writes to the corpus.

Credentials: do NOT paste a DSN on the command line.  Run it through Railway so
the connection string is injected as an env var and never transits a shell:

    railway run -s loom-corpus -- python scripts/corpus_sample.py --out sample.json

Sampling is deterministic (ORDER BY hashtext(text) with a fixed seed) so a
re-run returns the SAME lines — otherwise before/after comparisons measure
sample noise instead of the change.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Language-code variants that are the SAME romanizer/dictionary language.  The
# corpus stores whatever the platform reported (ja / ja-jp / zh-Hans / zh-hans
# / zh-CN …); group them so a sample of "ja" isn't split across three buckets.
GROUPS = {
    "ja": ("ja", "ja-jp", "ja-JP", "jpn"),
    "ko": ("ko", "ko-kr", "ko-KR"),
    "zh-Hans": ("zh-Hans", "zh-hans", "zh-CN", "zh", "cmn"),
    "zh-Hant": ("zh-Hant", "zh-hant", "zh-TW", "zh-HK"),
    "en": ("en", "en-us", "en-US", "en-GB"),
    "hi": ("hi", "hi-in", "hi-IN"),
    "es": ("es", "es-ES", "es-419", "es-MX"),
    "de": ("de", "de-de", "de-DE"),
    "fr": ("fr", "fr-fr", "fr-FR"),
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="output JSON path")
    ap.add_argument("--per-lang", type=int, default=400, help="lines per language")
    ap.add_argument("--langs", default=",".join(GROUPS), help="comma-separated group keys")
    args = ap.parse_args(argv)

    try:
        import psycopg
    except ImportError:
        print("psycopg not installed (pip install 'psycopg[binary]')", file=sys.stderr)
        return 2

    dsn = os.environ.get("DATABASE_PUBLIC_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        print("no DATABASE_PUBLIC_URL/DATABASE_URL in env — run via `railway run`", file=sys.stderr)
        return 2

    wanted = [g.strip() for g in args.langs.split(",") if g.strip() in GROUPS]
    out: dict[str, list[dict]] = {}

    with psycopg.connect(dsn, connect_timeout=30) as conn, conn.cursor() as cur:
        for group in wanted:
            codes = list(GROUPS[group])
            # Real dialogue only: skip blank lines and lines that are pure
            # markup/punctuation, which would inflate "untokenizable" counts
            # without telling us anything about the dictionary.
            cur.execute(
                """
                SELECT l.text, t.lang_code, m.title, m.platform
                  FROM corpus_line l
                  JOIN corpus_track t ON l.track_id = t.id
                  JOIN corpus_media m ON t.media_id = m.id
                 WHERE t.lang_code = ANY(%s)
                   AND length(btrim(l.text)) > 1
                 ORDER BY hashtext(l.text || %s)
                 LIMIT %s
                """,
                (codes, group, args.per_lang),
            )
            rows = cur.fetchall()
            out[group] = [
                {"text": r[0], "lang_code": r[1], "title": r[2], "platform": r[3]} for r in rows
            ]
            print(f"  {group:8s} {len(rows):>5} lines")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"\nwrote {args.out} ({sum(len(v) for v in out.values())} lines total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
