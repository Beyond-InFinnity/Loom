"""Sidecar → prod corpus forwarding (CORPUS_WIRING.md multi-surface).

The desktop app's events never reach its own frontend — subtitle files are
parsed server-side inside the localhost sidecar (loom_api.main), which has
no database.  So when a generate request carries ``opt_in_training=true``,
the SIDECAR builds the capture payload from the already-parsed subtitle
files and fire-and-forget POSTs it to the production API's
``/corpus/capture`` (decision 2026-07-02: one write path through one API;
no DB credentials on the desktop).

Same opportunistic contract as every capture path: a daemon thread, every
failure swallowed and logged, generation latency untouched.  The prod
endpoint's content-hash dedup makes repeat generations of the same files
no-ops.

Unlike the extension (dialogue-only visibility), file sources capture ALL
non-comment events INCLUDING signs/karaoke/typesetting styles — stylized
text is precisely the hard case Step 6's OCR training wants — plus the ASS
style definitions those events reference.

Env:
    LOOM_CORPUS_FORWARD_URL   Base URL of the corpus-receiving API.
                              Default: the production API.  ``off`` disables.
"""

from __future__ import annotations

import json
import logging
import os
import threading
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


def _forward_url() -> Optional[str]:
    raw = os.environ.get("LOOM_CORPUS_FORWARD_URL", _DEFAULT_FORWARD_URL).strip()
    if not raw or raw.lower() in {"off", "0", "false"}:
        return None
    return raw.rstrip("/")


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


def _post_capture(url: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/corpus/capture",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    logger.info(
        "forward: %s %s lines=%s → %s",
        payload["platform"],
        payload["media_id"],
        len(payload["lines"]),
        "stored" if result.get("stored") else f"no-op ({result.get('reason') or 'deduped'})",
    )


def forward_generate_capture(
    *,
    native_path: Path,
    target_path: Path,
    target_lang_code: str,
) -> None:
    """Fire-and-forget capture of both generation inputs.  Returns
    immediately; all work (parse via the mtime cache — the generate call
    just loaded these same files — language-detect the native side, POST)
    happens on a daemon thread and every failure is swallowed."""
    url = _forward_url()
    if url is None:
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
                    _post_capture(url, payload)
        except Exception:
            logger.warning("forward: capture failed (swallowed)", exc_info=True)

    threading.Thread(target=work, name="loom-corpus-forward", daemon=True).start()
