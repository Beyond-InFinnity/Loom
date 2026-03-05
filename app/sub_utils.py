# app/sub_utils.py
"""Shared subtitle-loading utilities.

Provides a caching wrapper around pysubs2.load() that stores parsed SSAFile
objects in a dict (typically st.session_state), keyed by file path + mtime.
This avoids redundant disk I/O and parsing across Streamlit reruns.

The cached SSAFile objects must be treated as **read-only** by all consumers.
Any code that needs to mutate events or styles must work on copies.
"""

import bisect
import collections
import os
import re

import pysubs2

# Matches ASS drawing mode commands (\p1, \p2, etc.).
_DRAWING_RE = re.compile(r'\\p[1-9]')


def load_subs_cached(path, cache=None):
    """Load and cache a parsed SSAFile from a file path.

    Parameters
    ----------
    path : str
        Path to a subtitle file (.ass, .ssa, .srt).
    cache : dict-like | None
        Cache store (typically ``st.session_state``).  When None, falls back
        to ``st.session_state`` via lazy import.  Pass an explicit dict in
        non-Streamlit contexts (tests, benchmarks).

    Returns
    -------
    pysubs2.SSAFile
        Parsed subtitle file.  **Do not mutate** — work on copies if needed.
    """
    if cache is None:
        import streamlit as st
        cache = st.session_state

    mtime = os.path.getmtime(path)
    cache_key = f"_cached_ssa_{path}"
    cached = cache.get(cache_key)
    if cached and cached[0] == mtime:
        print(f"[SSAFile cache] HIT: {path}")
        return cached[1]

    print(f"[SSAFile cache] MISS: {path}")
    subs = pysubs2.load(path)
    cache[cache_key] = (mtime, subs)
    return subs


def shift_events(subs, offset_ms):
    """Return a new SSAFile with all events shifted by *offset_ms*.

    Parameters
    ----------
    subs : pysubs2.SSAFile
        Source subtitle file (**not** mutated).
    offset_ms : int | float
        Milliseconds to shift.  Positive = later, negative = earlier.
        Each event's start/end is clamped to >= 0.

    Returns
    -------
    pysubs2.SSAFile
        A deep copy with shifted timings, or the original object when
        *offset_ms* is 0 (avoids an unnecessary copy).
    """
    if not offset_ms:
        return subs
    import copy
    shifted = copy.deepcopy(subs)
    off = int(round(offset_ms))
    for event in shifted.events:
        event.start = max(0, event.start + off)
        event.end = max(0, event.end + off)
    return shifted


def compute_subtitle_offset(reference_subs, target_subs):
    """Compute the timing offset between two same-language subtitle tracks.

    Uses a pairwise-difference histogram (coarse) followed by a bisect-based
    refinement pass (fine) to find the shift that maximises event alignment.

    Sign convention
    ---------------
    Returns ``target_time - reference_time`` in seconds.

    * **Positive** → reference events are earlier than the target video's;
      tracks from the reference source need to be shifted *later*.
    * **Negative** → reference events are later; shift *earlier*.

    This matches the manual offset fields where positive = subs appear later.

    Parameters
    ----------
    reference_subs : pysubs2.SSAFile
        Subtitle track from the reference source.
    target_subs : pysubs2.SSAFile
        Subtitle track from the target video (one of the loaded tracks).

    Returns
    -------
    tuple[float, str | None]
        ``(offset_seconds, warning_message)``.  *warning_message* is ``None``
        on success, or a human-readable string when the result is unreliable.
    """

    def _dialogue_starts(subs):
        """Extract start-times (ms) of dialogue events, skipping comments and drawings."""
        starts = []
        for ev in subs.events:
            if ev.is_comment:
                continue
            if _DRAWING_RE.search(ev.text):
                continue
            starts.append(ev.start)
        return starts

    ref_starts = _dialogue_starts(reference_subs)
    tgt_starts = _dialogue_starts(target_subs)

    if len(ref_starts) < 5 or len(tgt_starts) < 5:
        return 0.0, (
            "Too few dialogue events for reliable alignment "
            f"(reference: {len(ref_starts)}, comparison: {len(tgt_starts)}; "
            "need at least 5 in each track)."
        )

    # ── Coarse pass: pairwise-difference histogram, 100 ms bins ──────────
    bins = collections.Counter()
    for r in ref_starts:
        for t in tgt_starts:
            bins[(t - r) // 100] += 1

    coarse_bin = max(bins, key=bins.get)
    coarse_ms = coarse_bin * 100

    # ── Fine pass: ±2 s around coarse peak, 10 ms steps ─────────────────
    # Collect scores for all candidates, then take the midpoint of the
    # best-scoring plateau (avoids systematic bias from first-wins).
    sorted_tgt = sorted(tgt_starts)
    n_tgt = len(sorted_tgt)
    best_count = -1
    scores = []

    for step in range(-200, 201):  # ±2000 ms in 10 ms steps
        candidate_ms = coarse_ms + step * 10
        count = 0
        for r in ref_starts:
            shifted = r + candidate_ms
            lo = bisect.bisect_left(sorted_tgt, shifted - 500)
            if lo < n_tgt and sorted_tgt[lo] <= shifted + 500:
                count += 1
        scores.append((candidate_ms, count))
        if count > best_count:
            best_count = count

    best_candidates = [ms for ms, cnt in scores if cnt == best_count]
    best_offset_ms = (best_candidates[0] + best_candidates[-1]) // 2

    return best_offset_ms / 1000.0, None


def detect_ass_channels(ass_path, cache=None):
    """Detect distinct style-based channels in an ASS/SSA file.

    Groups dialogue events by their ``Style`` field.  Comment events and
    vector-path drawing events (``\\p1`` etc.) are excluded from counts.

    Parameters
    ----------
    ass_path : str
        Path to the ASS/SSA file.
    cache : dict | None
        Optional SSAFile cache for :func:`load_subs_cached`.

    Returns
    -------
    list[dict]
        ``[{'style': str, 'count': int}, ...]`` sorted by *count*
        descending.  Empty list if the file cannot be parsed.
    """
    try:
        subs = load_subs_cached(ass_path, cache)
    except Exception:
        return []

    counts = {}
    for ev in subs.events:
        if ev.is_comment:
            continue
        if _DRAWING_RE.search(ev.text):
            continue
        counts[ev.style] = counts.get(ev.style, 0) + 1

    channels = [{'style': name, 'count': count}
                for name, count in counts.items()]
    channels.sort(key=lambda c: c['count'], reverse=True)
    return channels


def extract_ass_channel(ass_path, channel_style, output_path, cache=None):
    """Extract events of a single style channel from an ASS file.

    Preserves the source ``[Script Info]`` and ``[V4+ Styles]`` sections
    intact.  Only events whose ``style`` matches *channel_style* are kept
    (both ``Dialogue`` and ``Comment`` lines).

    Parameters
    ----------
    ass_path : str
        Source ASS/SSA file.
    channel_style : str
        Style name to extract.
    output_path : str
        Destination path for the extracted file.
    cache : dict | None
        Optional SSAFile cache for :func:`load_subs_cached`.

    Returns
    -------
    str
        *output_path* on success.
    """
    import copy

    subs = load_subs_cached(ass_path, cache)
    extracted = copy.deepcopy(subs)
    extracted.events = [e for e in extracted.events
                        if e.style == channel_style]
    extracted.save(output_path)
    return output_path


def load_subs(source, cache=None):
    """Load subtitles from a file path (str) or Streamlit file object.

    For file paths, uses the cache.  For Streamlit file objects (uploads),
    parses directly without caching (no stable path/mtime).

    Parameters
    ----------
    source : str or file-like
        Path string or Streamlit uploaded file object.
    cache : dict-like | None
        Cache store for path-based loads.  See ``load_subs_cached()``.
    """
    if isinstance(source, str):
        return load_subs_cached(source, cache=cache)
    source.seek(0)
    return pysubs2.SSAFile.from_string(source.getvalue().decode("utf-8"))
