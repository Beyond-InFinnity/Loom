"""Helper: auto-detect ASS style roles for a given subtitle path.

Mirrors the Streamlit flow: ``detect_ass_styles`` returns a rich dict
(``{name: {role, event_count, ...}}``); the engine's preview + generate
paths want a flat ``{name: role}`` mapping. This helper runs the
detection and performs the flattening, returning ``None`` for non-ASS
files (SRT, VTT) so the engine falls back to its existing behavior.

Called from ``/preview`` and ``/generate/*`` so the Tauri UI doesn't have
to run a separate detect step before every request.
"""
from pathlib import Path
from typing import Optional

from loom_core.subs.processing import detect_ass_styles


def auto_style_mapping(path: Path) -> Optional[dict[str, str]]:
    suffix = path.suffix.lower()
    if suffix not in (".ass", ".ssa"):
        return None
    try:
        info = detect_ass_styles(str(path))
    except Exception:
        return None
    if not info:
        return None
    return {name: meta["role"] for name, meta in info.items()}
