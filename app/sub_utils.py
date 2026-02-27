# app/sub_utils.py
"""Shared subtitle-loading utilities.

Provides a caching wrapper around pysubs2.load() that stores parsed SSAFile
objects in a dict (typically st.session_state), keyed by file path + mtime.
This avoids redundant disk I/O and parsing across Streamlit reruns.

The cached SSAFile objects must be treated as **read-only** by all consumers.
Any code that needs to mutate events or styles must work on copies.
"""

import os
import pysubs2


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
