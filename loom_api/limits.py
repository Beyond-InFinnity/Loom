"""Operational limits & env knobs for the public web API (stdlib-only).

Central home for the env-overridable operational tunables added in the
2026-07 hardening round: the request-cost caps (below) and the idle-recycle
thresholds (consumed by loom_api/recycle.py).  The cost caps bound the work
a single request can impose (bytes buffered, chars computed), complementing
slowapi's request-COUNT limits in web.py — a count limiter alone permits
~100 maximal 10M-char batches per minute per IP, i.e. ~113x CPU
oversubscription (measured 2026-07: one maximal zh /romanize/batch ≈ 68 s
of GIL-bound CPU; ja ≈ 28 s).

Defaults are set from the measured legitimate client envelope (2026-07
audit of extension / web app / desktop enrich payload builders):

- Largest real body:   ~3–4 MB  (web 2000-text CJK chunk; 10k-line fansub
  corpus capture with styles)
- Largest real batch:  ~1M chars (web app worst-case 2000-text chunk at
  ~500 chars/cue; the extension chunks at 1000 texts, typical 30k–200k)

so each default carries ≥2x headroom over the worst legitimate case.

All caps are env-overridable; 0/off disables (fail-open kill switch, same
philosophy as LOOM_RESULT_CACHE=off).  Consumers read these as module
attributes at call time (``limits.MAX_BODY_BYTES``) so tests can
monkeypatch them and an env change needs only a worker restart.
"""

from __future__ import annotations

import os


def _env_int(name: str, default: int) -> int:
    """Parse an int env var; ''/absent → default; off/none/disabled → 0
    (disabled); junk → default (never crash worker boot on a typo)."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in ("off", "none", "disabled"):
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    """Parse a bool env var; ''/absent/junk → default (never crash on a typo)."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in ("off", "0", "false", "no", "disabled"):
        return False
    if raw in ("on", "1", "true", "yes", "enabled"):
        return True
    return default


#: Max request body in bytes (from Content-Length), enforced by the
#: BodySizeLimit middleware before the body is buffered/parsed.
MAX_BODY_BYTES = _env_int("LOOM_MAX_BODY_BYTES", 10_000_000)

#: Max total chars across one batch's ``texts`` (/romanize/batch +
#: /annotate/batch), enforced at pydantic validation (422).  Bounds the
#: worst-case single-request CPU to ~13 s (zh) instead of ~68 s.
BATCH_MAX_TOTAL_CHARS = _env_int("LOOM_BATCH_MAX_TOTAL_CHARS", 2_000_000)

#: Max serialized size of a /corpus/capture ``styles`` map, in bytes.
#: Oversized maps are DROPPED (capture proceeds without styles) rather than
#: 422ing a fire-and-forget client; heavy real fansub style maps are ~50 KB.
CORPUS_STYLES_MAX_BYTES = _env_int("LOOM_CORPUS_STYLES_MAX_BYTES", 262_144)


def log_safe(value: str, max_len: int = 256) -> str:
    """Neutralize *value* for inclusion in a log line: control characters
    (CR/LF above all — ASGI paths arrive percent-DECODED, so /x%0Ay carries a
    real newline) are escaped so attacker-controlled request fields can't
    forge or split lines in the operationally-watched loom.* logs."""
    out = "".join(
        ch if ch >= " " and ch != "\x7f" else f"\\x{ord(ch):02x}"
        for ch in value[:max_len]
    )
    return out
