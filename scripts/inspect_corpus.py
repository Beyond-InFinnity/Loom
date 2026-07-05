#!/usr/bin/env python3
"""Read-only usability inspection of the exported corpus Parquet on R2.

Queries the R2 bucket DIRECTLY via DuckDB (no download, no server) — this
doubles as the "SQL frontend" for the corpus: everything here is just DuckDB
over `read_parquet('s3://…/**/*.parquet')`, and you can drop into an
interactive `duckdb` session with the same SET lines to run ad-hoc queries.

Env (same vars the export used — set in the shell that ran export_corpus.py):
    LOOM_CORPUS_BUCKET        e.g. loom-corpus
    LOOM_CORPUS_S3_ENDPOINT   https://<account_id>.r2.cloudflarestorage.com
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   the R2 token pair

Usage:
    pip install duckdb            # once, in the venv
    python scripts/inspect_corpus.py

Checks, in order of what actually matters:
  1. Schema (columns + types) — confirms the 18-col contract.
  2. Row counts per (platform, lang) — should match corpus_export_manifest.
  3. ENRICH HEALTH — % of rows whose romanizations_json / annotations_json is
     non-empty.  THE load-bearing check: empty ⇒ the enrich join silently
     missed and the corpus is raw text only.
  4. Text sanity — null/empty text, whitespace-padded text, length range.
  5. Style coverage — % rows carrying a style name (streaming ≈ none; that's
     expected — styles are a file-source feature).
  6. Sample rows — eyeball a few ja rows: text + its romanizations.
"""
from __future__ import annotations

import os
import sys


def main() -> int:
    try:
        import duckdb
    except ImportError:
        print("duckdb not installed — run:  pip install duckdb", file=sys.stderr)
        return 1

    bucket = os.environ.get("LOOM_CORPUS_BUCKET")
    endpoint = os.environ.get("LOOM_CORPUS_S3_ENDPOINT", "")
    akid = os.environ.get("AWS_ACCESS_KEY_ID")
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not (bucket and endpoint and akid and secret):
        print(
            "Missing env: need LOOM_CORPUS_BUCKET, LOOM_CORPUS_S3_ENDPOINT, "
            "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.\n"
            "Run this in the same shell that ran export_corpus.py, or re-set them.",
            file=sys.stderr,
        )
        return 1

    # R2 wants the bare host (no scheme) + path-style addressing.
    host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
    glob = f"s3://{bucket}/corpus/**/*.parquet"

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET s3_endpoint='{host}';")
    con.execute(f"SET s3_access_key_id='{akid}';")
    con.execute(f"SET s3_secret_access_key='{secret}';")
    con.execute("SET s3_region='auto';")
    con.execute("SET s3_url_style='path';")
    con.execute("SET s3_use_ssl=true;")

    # Materialize once so every query hits a local view (and fails fast if the
    # creds/endpoint are wrong).
    try:
        con.execute(
            f"CREATE VIEW c AS SELECT * FROM read_parquet('{glob}', "
            "hive_partitioning=true);"
        )
    except Exception as e:  # noqa: BLE001
        print(f"Failed to read {glob}\n{e}", file=sys.stderr)
        return 1

    def show(title: str, sql: str) -> None:
        print(f"\n=== {title} ===")
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        widths = [
            max(len(str(cols[i])), *(len(str(r[i])) for r in rows)) if rows
            else len(str(cols[i]))
            for i in range(len(cols))
        ]
        print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(cols)))
        print("  ".join("-" * widths[i] for i in range(len(cols))))
        for r in rows:
            print("  ".join(str(v).ljust(widths[i]) for i, v in enumerate(r)))

    show("1. Schema", "DESCRIBE SELECT * FROM c;")

    show(
        "2. Rows per (platform, lang)",
        "SELECT platform, track_lang, count(*) AS rows, "
        "count(DISTINCT media_id) AS titles "
        "FROM c GROUP BY platform, track_lang ORDER BY rows DESC;",
    )

    show(
        "3. ENRICH HEALTH — % rows with non-empty readings (load-bearing)",
        "SELECT track_lang, count(*) AS rows, "
        "round(100.0*avg(CASE WHEN romanizations_json NOT IN ('{}','') "
        "THEN 1 ELSE 0 END),1) AS pct_romanized, "
        "round(100.0*avg(CASE WHEN annotations_json NOT IN ('{}','') "
        "THEN 1 ELSE 0 END),1) AS pct_annotated "
        "FROM c GROUP BY track_lang ORDER BY rows DESC;",
    )

    show(
        "4. Text sanity",
        "SELECT count(*) AS rows, "
        "count(*) FILTER (WHERE text IS NULL OR length(trim(text))=0) AS empty_text, "
        "count(*) FILTER (WHERE text <> trim(text)) AS whitespace_padded, "
        "min(length(text)) AS min_len, max(length(text)) AS max_len "
        "FROM c;",
    )

    show(
        "5. Style coverage (streaming ≈ 0%, expected)",
        "SELECT round(100.0*avg(CASE WHEN style IS NOT NULL THEN 1 ELSE 0 END),1) "
        "AS pct_with_style, count(DISTINCT style) AS distinct_styles FROM c;",
    )

    show(
        "6. Sample ja rows (text + readings)",
        "SELECT seq, text, substr(romanizations_json,1,120) AS romanizations "
        "FROM c WHERE track_lang='ja' ORDER BY random() LIMIT 5;",
    )

    print("\nInspection complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
