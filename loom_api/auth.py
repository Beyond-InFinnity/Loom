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
    """
    if not presented or not keys:
        return False
    matched = False
    for k in keys:
        if hmac.compare_digest(presented, k):
            matched = True
    return matched
