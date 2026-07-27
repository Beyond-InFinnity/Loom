"""Owner bypass-key checks, shared by web.py's rate-limiter bypass and the
/debug/echo owner gate (routes/debug.py).

Keys live in the LOOM_BYPASS_KEYS env var (comma-separated long random
strings — see the Owner Auth section of CLAUDE.md).  web.py reads them once
at import (worker boot); /debug/echo re-reads per request so tests can
monkeypatch the env without reloading modules.
"""

import hmac
import os
from typing import Optional, Sequence


def bypass_keys_from_env() -> list[str]:
    raw = os.environ.get("LOOM_BYPASS_KEYS", "").strip()
    return [k.strip() for k in raw.split(",") if k.strip()]


def is_bypass_key(presented: Optional[str], keys: Sequence[str]) -> bool:
    """Constant-time check: is `presented` in the allow-list?

    Iterates every key with hmac.compare_digest to keep timing leakage
    proportional only to len(keys), not to which key matched (or how many
    leading bytes agreed).

    Compares BYTES, not str: ``compare_digest`` raises TypeError on a str
    containing any non-ASCII character, and `presented` is attacker-controlled
    — it is latin-1 decoded straight from the header, and HTTP permits obs-text
    (0x80-0xFF) in field values.  As str this raised out of the caller and 500'd
    the request (verified in prod); as bytes every input is comparable, so a
    junk header is simply "not a key".  UTF-8 with surrogateescape round-trips
    any latin-1 decoded header without raising.
    """
    if not presented or not keys:
        return False
    p = presented.encode("utf-8", "surrogateescape")
    matched = False
    for k in keys:
        if hmac.compare_digest(p, k.encode("utf-8", "surrogateescape")):
            matched = True
    return matched
