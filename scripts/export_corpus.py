#!/usr/bin/env python3
"""Export the subtitle corpus from Postgres to object storage (Parquet).

Scheduled by .github/workflows/export-corpus.yml; also runnable by hand.
See loom_api/corpus_export.py for the pipeline itself.

Environment:
    DATABASE_URL / LOOM_CORPUS_URL   Postgres DSN (Railway public URL when
                                     running outside Railway's network).
    LOOM_CORPUS_BUCKET               Destination bucket name (S3/R2).
    LOOM_CORPUS_S3_ENDPOINT          Optional endpoint URL — set for R2:
                                     https://<account_id>.r2.cloudflarestorage.com
    AWS_ACCESS_KEY_ID/-SECRET-       Credentials for the bucket.
    LOOM_ENRICH_API_URL              API base for --enrich (default: prod).
    LOOM_ENRICH_AUTH_KEY             Owner bypass key for --enrich (X-Loom-Auth);
                                     without it the public rate limit throttles
                                     large replays.

Usage:
    python scripts/export_corpus.py                       # export to bucket
    python scripts/export_corpus.py --dry-run             # walk, write nothing
    python scripts/export_corpus.py --local-dir ./corpus  # bucket-less export
    python scripts/export_corpus.py --prune               # + prune archived lines
    python scripts/export_corpus.py --settle-days 3 --prune --prune-days 30

Extra deps beyond requirements-web.txt: scripts/requirements-export.txt
(pyarrow, boto3).
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from loom_api.corpus_export import ExportRunner, LocalDirSink, S3Sink  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--settle-days", type=int, default=7,
                        help="Only export tracks captured at least this many days ago (default 7).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the whole pipeline but write/archive nothing.")
    parser.add_argument("--local-dir", default=None,
                        help="Write Parquet under this directory instead of the bucket.")
    parser.add_argument("--prune", action="store_true",
                        help="After export, delete line rows for long-archived tracks.")
    parser.add_argument("--prune-days", type=int, default=30,
                        help="Prune lines for tracks archived at least this many days ago (default 30).")
    parser.add_argument("--enrich", action="store_true",
                        help="Before export, replay all unarchived corpus texts through the API's "
                             "batch endpoints so the cache holds current-engine readings "
                             "(idempotent; hits are free).")
    args = parser.parse_args()

    dsn = os.environ.get("LOOM_CORPUS_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        print("export_corpus: no DATABASE_URL / LOOM_CORPUS_URL set; nothing to do.", file=sys.stderr)
        return 0  # graceful no-op so the scheduled workflow is green pre-wiring

    if args.local_dir:
        sink = LocalDirSink(args.local_dir)
    else:
        bucket = os.environ.get("LOOM_CORPUS_BUCKET")
        if not bucket and not args.dry_run:
            print("export_corpus: LOOM_CORPUS_BUCKET not set (and no --local-dir); nothing to do.", file=sys.stderr)
            return 0
        sink = S3Sink(bucket, os.environ.get("LOOM_CORPUS_S3_ENDPOINT")) if bucket else LocalDirSink(".")

    runner = ExportRunner(dsn, sink, settle_days=args.settle_days, dry_run=args.dry_run)
    if args.enrich:
        enriched = runner.enrich(
            os.environ.get("LOOM_ENRICH_API_URL", "https://api.loom.nerv-analytic.ai"),
            os.environ.get("LOOM_ENRICH_AUTH_KEY") or None,
        )
        print(f"export_corpus: enriched {enriched} text(s).")
    files = runner.run()
    print(f"export_corpus: wrote {files} partition file(s).")
    if args.prune:
        deleted = runner.prune(args.prune_days)
        print(f"export_corpus: pruned {deleted} line row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
