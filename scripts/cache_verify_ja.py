#!/usr/bin/env python3
"""Find (and optionally purge) Japanese cache rows corrupted by the MeCab race.

Until 2026-07-27 one process-wide fugashi Tagger was shared across FastAPI's
~40-thread pool.  MeCab is not reentrant and fugashi Nodes are VIEWS over its
lattice, so a thread reading `.feature` after another thread re-parsed got the
OTHER parse's data: measured at 20/6000 concurrent parses, e.g. 今日 coming back
as おみな instead of きょう.

The race is fixed (romanize.borrow_ja_tagger), but the damage PERSISTS: every
corrupted reading was written into `romanization_cache`, and the fix changed no
output semantics so there was no ENGINE_VERSIONS bump to flush it.  Those rows
are still served — and because /annotate's `tokens` feed /define, a corrupted
lemma also means a wrong or empty definition card.

Detection is a recompute-and-compare: with the lock in place and this script
single-threaded, recomputing a row's spans/tokens from its own `input_text` is
deterministic, so ANY mismatch against the stored value is a row written by a
racing parse.  Rows are compared only within their own engine_version, so a
legitimate version bump is never mistaken for corruption.

Purging is safe by construction: the cache is fail-open, so a deleted row is
simply recomputed — correctly — on the next request.

Usage (read-only by default; --apply is the only thing that writes):
    railway run -s loom-corpus -- python scripts/cache_verify_ja.py
    railway run -s loom-corpus -- python scripts/cache_verify_ja.py --apply
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from loom_core.romanize import (  # noqa: E402
    build_word_tokens, engine_version, get_annotation_func, get_romanizer,
)


def _spans_of(text: str, fn) -> list[list]:
    return [[b, r] for b, r in (fn(text) or [])]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="DELETE the corrupted rows (default: report only)")
    ap.add_argument("--limit", type=int, default=0, help="check at most N rows")
    ap.add_argument("--lang", default="ja", help="cache lang_code to verify")
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--kind", default="annotate", choices=("annotate", "romanize"),
                    help="which cached output to verify (romaji derives from the "
                         "SAME MeCab parse, so it is damaged by the same race)")
    args = ap.parse_args(argv)

    try:
        import psycopg
    except ImportError:
        print("psycopg not installed", file=sys.stderr)
        return 2
    dsn = os.environ.get("DATABASE_PUBLIC_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        print("no DSN in env — run via `railway run`", file=sys.stderr)
        return 2

    fn = get_annotation_func(args.lang)
    romanizer = get_romanizer(args.lang)
    if fn is None:
        print(f"no annotation function for {args.lang}", file=sys.stderr)
        return 2
    current_ev = engine_version(args.lang)

    # Only CURRENT-version rows are reachable (the version is part of the
    # key), so older rows are dead weight, not served corruption — filter them
    # out in SQL rather than fetching tens of thousands of unreachable rows.
    sql = ("SELECT key_hash, input_text, output_json, engine_version "
           "FROM romanization_cache WHERE kind = %s AND lang_code = %s "
           "AND engine_version = %s")
    params: list = [args.kind, args.lang, current_ev]
    if args.limit:
        sql += " LIMIT %s"
        params.append(args.limit)

    bad: list[tuple] = []
    checked = skipped_old = 0
    with psycopg.connect(dsn, connect_timeout=30) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        print(f"{len(rows)} '{args.lang}' {args.kind} rows in cache "
              f"(current engine_version={current_ev})")
        for key_hash, text, out, ev in rows:
            if ev != current_ev:
                skipped_old += 1     # unreachable anyway: version is in the key
                continue
            checked += 1
            try:
                if args.kind == "romanize":
                    stored_val = [(out or {}).get("romanized")]
                    fresh_val = [romanizer(text)]
                else:
                    stored_val = (out or {}).get("spans") or []
                    fresh_spans = _spans_of(text, fn)
                    fresh_val = fresh_spans
                    # token COUNT is a cheap proxy for lemma corruption
                    if len((out or {}).get("tokens") or []) != len(
                        build_word_tokens(text, args.lang,
                                          [tuple(s) for s in fresh_spans], fn)):
                        bad.append((key_hash, text, stored_val, fresh_val))
                        continue
            except Exception as exc:                    # pragma: no cover
                print(f"  ! recompute failed for {text[:20]!r}: {exc}")
                continue
            if stored_val != fresh_val:
                bad.append((key_hash, text, stored_val, fresh_val))

        pct = 100 * len(bad) / max(checked, 1)
        print(f"checked {checked} (skipped {skipped_old} at an older version) — "
              f"CORRUPTED: {len(bad)} ({pct:.2f}%)")
        for _k, text, stored, fresh in bad[: args.samples]:
            diff = [(s, f) for s, f in zip(stored, fresh) if s != f][:3]
            print(f"   {text[:34]!r}")
            for s, f in diff:
                print(f"      stored {s} -> correct {f}")

        if bad and args.apply:
            with conn.cursor() as cur:
                cur.executemany(
                    "DELETE FROM romanization_cache WHERE key_hash = %s",
                    [(k,) for k, _t, _s, _f in bad],
                )
            conn.commit()
            print(f"\nDELETED {len(bad)} corrupted rows — each recomputes "
                  f"correctly on its next request.")
        elif bad:
            print("\n(dry run — re-run with --apply to delete these rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
