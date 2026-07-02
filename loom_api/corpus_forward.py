"""Sidecar corpus spool — offline-first store-and-forward (CORPUS_WIRING §6).

The desktop app's events never reach its own frontend — subtitle files are
parsed server-side inside the localhost sidecar (loom_api.main), which has
no database.  When a generate request carries ``opt_in_training=true``, the
sidecar shapes /corpus/capture payloads from the parsed files and — rather
than POSTing immediately (original 2026-07-02 design, which silently lost
data when offline) — writes them to a local SPOOL directory, then flushes:

    generate → spool/<payload-hash>.json → flush → prod /corpus/capture → delete

Flush runs at sidecar startup (``kick_spool_flush`` from main.py) and after
every generation.  Offline generation works fully; payloads ship whenever
the machine is next online.  Everything is idempotent end-to-end: payload
files are named by content hash (regenerating the same episode overwrites,
never duplicates) and the server dedups by track content hash, so a crash
between POST and delete just re-sends a no-op.

Deliberately, the spool carries INPUTS ONLY (text + timing + styles +
provenance), never locally-computed romanizations — the server recomputes
derived data itself via the enrichment pass (corpus_export.py --enrich).
Clients shipping outputs into a cache that's served to other users would be
a poisoning vector, and desktop/server engine versions drift.  Clients ship
raw text; the server owns all derived data.

File payloads are small (an episode ≈ 100–300 KB of JSON) — a whole spooled
season is a few MB.

Env:
    LOOM_CORPUS_FORWARD_URL   Corpus-receiving API base.  Default: prod.
                              ``off`` disables spooling AND flushing.
    LOOM_CORPUS_SPOOL_DIR     Spool location.  Default: ~/.loom/corpus-spool
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from loom_core.language import detect_language
from loom_core.subs.utils import load_subs_cached

logger = logging.getLogger("loom.corpus")

_DEFAULT_FORWARD_URL = "https://api.loom.nerv-analytic.ai"

# Curated SSAStyle attrs worth archiving for OCR ground truth.  Values are
# str()-coerced so pysubs2's Color/enum types serialize without surprises.
_STYLE_ATTRS = (
    "fontname", "fontsize", "bold", "italic", "underline", "strikeout",
    "primarycolor", "secondarycolor", "outlinecolor", "backcolor",
    "scalex", "scaley", "spacing", "angle", "borderstyle", "outline",
    "shadow", "alignment", "marginl", "marginr", "marginv",
)

# One flush at a time process-wide — startup kick + post-generation kicks
# must not double-POST the same spool file.
_flush_lock = threading.Lock()


def _forward_url() -> Optional[str]:
    raw = os.environ.get("LOOM_CORPUS_FORWARD_URL", _DEFAULT_FORWARD_URL).strip()
    if not raw or raw.lower() in {"off", "0", "false"}:
        return None
    return raw.rstrip("/")


def spool_dir() -> Path:
    raw = os.environ.get("LOOM_CORPUS_SPOOL_DIR", "").strip()
    return Path(raw) if raw else Path.home() / ".loom" / "corpus-spool"


def serialize_styles(subs: Any) -> dict[str, dict[str, str]]:
    """SSAFile.styles → JSON-safe {name: {attr: str(value)}}."""
    out: dict[str, dict[str, str]] = {}
    for name, style in getattr(subs, "styles", {}).items():
        out[name] = {
            attr: str(getattr(style, attr))
            for attr in _STYLE_ATTRS
            if getattr(style, attr, None) is not None
        }
    return out


def build_file_capture_payload(
    *,
    path: Path,
    lang_code: str,
    role: str,  # "target" | "native"
    subs: Any,  # pysubs2 SSAFile
    platform: str = "desktop",
) -> dict[str, Any]:
    """Shape one subtitle FILE into a /corpus/capture request body.

    media_id/title come from the file's own name — desktop files are
    registered by real path (POST /files/by-path), so the stem is the
    fansub release name: exactly the human-meaningful identity we have.
    """
    stem = path.stem
    lines = []
    for i, ev in enumerate(subs):
        if getattr(ev, "is_comment", False):
            continue
        text = (getattr(ev, "plaintext", "") or "").replace("\n", " ").strip()
        if not text or len(text) > 5000:
            continue
        lines.append(
            {
                "seq": i,
                "start_ms": max(0, int(ev.start)),
                "end_ms": max(0, int(ev.end)),
                "text": text,
                "style": getattr(ev, "style", None),
            }
        )
        if len(lines) >= 10000:
            break
    return {
        "opt_in_training": True,
        "platform": platform,
        "media_id": stem[:256],
        "title": stem[:512] or None,
        "origin_lang": None,
        "track_id": f"{role}:{stem}"[:256],
        "track_lang": lang_code,
        "is_cc": False,
        "track_kind": "file",
        "lines": lines,
        "styles": serialize_styles(subs) or None,
    }


# ---------------------------------------------------------------------------
# Spool
# ---------------------------------------------------------------------------

def spool_payload(payload: dict[str, Any]) -> Optional[Path]:
    """Write one capture payload to the spool.  Filename = sha256 of the
    canonical JSON, so identical content is one file no matter how many
    times it's generated.  Returns the path, or None on any trouble."""
    try:
        body = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
        directory = spool_dir()
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{digest}.json"
        tmp = directory / f"{digest}.json.tmp"
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(target)  # atomic: a flush never sees a half-written file
        return target
    except Exception:
        logger.warning("spool: write failed (swallowed)", exc_info=True)
        return None


def _post_capture(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/corpus/capture",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def flush_spool() -> int:
    """POST every spooled payload; delete on success.  Returns files sent.

    Outcome handling:
      - 2xx (stored / deduped / no-op)  → delete (server has it or refused
        it by policy; either way re-sending is pointless).
      - 4xx (validation)                → rename to .rejected.json — never
        going to succeed, but don't silently destroy data.
      - network error / 5xx             → keep; retry on the next flush.
    """
    url = _forward_url()
    if url is None:
        return 0
    directory = spool_dir()
    if not directory.is_dir():
        return 0
    sent = 0
    with _flush_lock:
        for path in sorted(directory.glob("*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                path.rename(path.with_suffix(".rejected.json"))
                logger.warning("spool: unreadable payload %s quarantined", path.name)
                continue
            try:
                result = _post_capture(url, payload)
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500:
                    path.rename(path.with_suffix(".rejected.json"))
                    logger.warning("spool: %s rejected by server (%s) — quarantined", path.name, e.code)
                else:
                    logger.info("spool: %s deferred (server %s)", path.name, e.code)
                continue
            except Exception:
                # Offline / DNS / timeout — perfectly normal; try next flush.
                logger.info("spool: flush deferred (network unavailable), %d file(s) waiting",
                            len(list(directory.glob("*.json"))))
                break
            path.unlink(missing_ok=True)
            sent += 1
            logger.info(
                "spool: %s %s lines=%s → %s",
                payload.get("platform"),
                payload.get("media_id"),
                len(payload.get("lines", [])),
                "stored" if result.get("stored") else f"no-op ({result.get('reason') or 'deduped'})",
            )
    return sent


def kick_spool_flush() -> None:
    """Fire-and-forget flush on a daemon thread (sidecar startup + after
    each generation)."""
    if _forward_url() is None:
        return
    threading.Thread(target=flush_spool, name="loom-corpus-flush", daemon=True).start()


# ---------------------------------------------------------------------------
# Generation hook
# ---------------------------------------------------------------------------

def forward_generate_capture(
    *,
    native_path: Path,
    target_path: Path,
    target_lang_code: str,
) -> None:
    """Spool both generation inputs, then kick a flush.  Returns
    immediately; all work (parse via the mtime cache — the generate call
    just loaded these same files — language-detect the native side, spool
    write, network) happens on a daemon thread, every failure swallowed."""
    if _forward_url() is None:
        return

    def work() -> None:
        try:
            for path, role, lang in (
                (target_path, "target", target_lang_code),
                (native_path, "native", None),
            ):
                subs = load_subs_cached(str(path))
                if subs is None:
                    continue
                lang_code = lang or detect_language(str(path)) or "und"
                payload = build_file_capture_payload(
                    path=Path(path), lang_code=lang_code, role=role, subs=subs
                )
                if payload["lines"]:
                    spool_payload(payload)
            flush_spool()
        except Exception:
            logger.warning("spool: capture failed (swallowed)", exc_info=True)

    threading.Thread(target=work, name="loom-corpus-forward", daemon=True).start()
