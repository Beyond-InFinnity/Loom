"""CORS origin allow-list regression tests (loom_api/cors.py).

Why this file exists: the browser extension's annotate/romanize/presets
calls are content-script fetches.  On Chrome MV3 they carry the *streaming
site's* page origin (e.g. https://www.netflix.com), so that origin must be
CORS-allowed by the API or the requests fail their preflight.  Firefox MV2
content scripts bypass CORS, which masked the omission — Netflix support
shipped (v0.2.0) without adding netflix.com here, so annotations and
romanization silently failed on Chrome/Netflix while the dual subtitle
tracks (served from Netflix's own manifest, not our API) kept working.

These tests assert that every supported streaming site + the extension's
own origins pass, and that arbitrary origins don't.  When the extension
gains a new site, add it to loom_api/cors.py AND a row here.

Imports only loom_api.cors (stdlib `re` only) — NOT loom_api.web, which
pulls slowapi (requirements-web.txt, absent from the CI requirements).
"""
import pytest

from loom_api.cors import is_allowed_origin


# --- Streaming sites the extension injects into (page origin on Chrome MV3) ---
@pytest.mark.parametrize(
    "origin",
    [
        "https://www.netflix.com",
        "https://www.youtube.com",
        "https://m.youtube.com",
        "https://music.youtube.com",
    ],
)
def test_supported_streaming_origins_allowed(origin):
    assert is_allowed_origin(origin) is True


# --- The extension's own origins (randomized per install) ---
@pytest.mark.parametrize(
    "origin",
    [
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "moz-extension://0123abcd-4567-89ef-0123-456789abcdef",
    ],
)
def test_extension_origins_allowed(origin):
    assert is_allowed_origin(origin) is True


# --- Production frontend + local dev (exact-match list) ---
@pytest.mark.parametrize(
    "origin",
    [
        "https://loom.nerv-analytic.ai",
        "http://localhost:3000",
        "http://localhost:1420",
    ],
)
def test_first_party_origins_allowed(origin):
    assert is_allowed_origin(origin) is True


# --- Arbitrary / spoofed origins must NOT be allowed ---
@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example.com",
        "https://notyoutube.com",
        # Substring/suffix-spoof attempts: the regex anchors via fullmatch.
        "https://www.netflix.com.evil.com",
        "https://evil-youtube.com",
        "https://www.netflix.org",
        "http://www.netflix.com",  # scheme must be https for streaming sites
    ],
)
def test_unknown_origins_rejected(origin):
    assert is_allowed_origin(origin) is False


def test_env_override_extends_exact_list():
    """A deploy-time LOOM_CORS_ORIGINS list is honored via exact_origins."""
    custom = ["https://preview-xyz.vercel.app"]
    assert is_allowed_origin("https://preview-xyz.vercel.app", custom) is True
    # Regex sites still pass even when the exact list is replaced.
    assert is_allowed_origin("https://www.netflix.com", custom) is True
    # And the default exact entries no longer match (list was replaced).
    assert is_allowed_origin("https://loom.nerv-analytic.ai", custom) is False
