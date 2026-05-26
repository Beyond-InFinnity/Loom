"""Tests for POST /romanize/batch (5e).

Covers the batch-specific contract on top of /romanize's already-tested
per-language romanization correctness (test_japanese_furigana.py,
test_chinese_romanization.py, test_r4_romanization.py, test_r5_*.py).
The handler itself is a thin loop, so these tests focus on:

- Positional alignment between request.texts and response.results
- Empty / whitespace / oversized text → empty result (NOT dropped)
- Fail-soft on languages without a phonetic layer (Latin, unsupported)
- Phonetic-system override threads through (Chinese pinyin/zhuyin/jyutping)
- Japanese long_vowel_mode threads through
- Response-root metadata (lang_code, romanization_name, has_phonetic_layer)

Tests call the route handler directly with constructed Pydantic models
rather than via HTTP — the routing/validation layer is FastAPI's
responsibility and tested upstream; this file owns the batch logic.
"""
import pytest


# ---------------------------------------------------------------------------
# Shared imports
# ---------------------------------------------------------------------------

@pytest.fixture
def batch_handler():
    """Return (handler, RequestModel) so tests don't repeat imports."""
    from loom_api.routes.romanize import romanize_batch, RomanizeBatchRequest
    return romanize_batch, RomanizeBatchRequest


# ---------------------------------------------------------------------------
# Positional alignment + per-text edge cases
# ---------------------------------------------------------------------------

class TestPositionalAlignment:
    """The batch endpoint's load-bearing contract: result[i] always
    pairs with request.texts[i].  Empty / whitespace / oversized
    entries produce empty result entries instead of being dropped."""

    def test_n_inputs_yield_n_outputs(self, batch_handler):
        handler, Req = batch_handler
        texts = ["こんにちは", "ありがとう", "さようなら"]
        resp = handler(Req(texts=texts, lang_code="ja"))
        assert len(resp.results) == len(texts)
        # Every entry has non-empty romanization for non-empty Japanese input.
        for item in resp.results:
            assert item.romanized.strip() != ""

    def test_empty_text_yields_empty_result(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["こんにちは", "", "ありがとう"], lang_code="ja"))
        assert len(resp.results) == 3
        assert resp.results[0].romanized.strip() != ""
        assert resp.results[1].romanized == ""
        assert resp.results[2].romanized.strip() != ""

    def test_whitespace_only_text_yields_empty_result(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["   ", "\n\t", "ありがとう"], lang_code="ja"))
        assert resp.results[0].romanized == ""
        assert resp.results[1].romanized == ""
        assert resp.results[2].romanized.strip() != ""

    def test_oversized_text_yields_empty_result(self, batch_handler):
        handler, Req = batch_handler
        # >5000 chars triggers the per-text defensive cap.  Real inputs
        # this long indicate a client that should be chunking server-
        # side; we zero rather than reject so the rest of the batch is
        # still usable.
        oversized = "あ" * 5001
        resp = handler(Req(texts=["ありがとう", oversized, "さようなら"], lang_code="ja"))
        assert resp.results[0].romanized.strip() != ""
        assert resp.results[1].romanized == ""
        assert resp.results[2].romanized.strip() != ""

    def test_empty_batch_returns_empty_results(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=[], lang_code="ja"))
        assert resp.results == []
        assert resp.has_phonetic_layer is True


# ---------------------------------------------------------------------------
# Fail-soft on languages without a phonetic layer
# ---------------------------------------------------------------------------

class TestFailSoftUnsupported:
    """Where POST /romanize raises HTTPException(400) on
    has_phonetic_layer=False, POST /romanize/batch returns all-empty
    results with the flag in the response root.  Mirrors the
    /annotate/batch philosophy: the extension's activation flow
    benefits from never having to special-case a 400 mid-batch."""

    def test_latin_lang_returns_empty_results(self, batch_handler):
        handler, Req = batch_handler
        # English is Latin-script / native-display per the extension's
        # classifier — no phonetic layer at all.
        resp = handler(Req(texts=["Hello", "World"], lang_code="en"))
        assert resp.has_phonetic_layer is False
        assert len(resp.results) == 2
        assert all(item.romanized == "" for item in resp.results)

    def test_unknown_lang_returns_empty_results(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["x", "y"], lang_code="zz-XX"))
        assert resp.has_phonetic_layer is False
        assert all(item.romanized == "" for item in resp.results)


# ---------------------------------------------------------------------------
# Phonetic-system override threads through (Chinese variants)
# ---------------------------------------------------------------------------

class TestPhoneticSystemOverride:
    """phonetic_system at the request root routes to the right
    romanizer (Pinyin vs Zhuyin vs Jyutping for Han, Paiboon vs RTGS
    vs IPA for Thai, etc.).  We probe the obvious markers in the
    output rather than asserting exact strings — those live in the
    per-language tests."""

    def test_zh_hans_default_yields_pinyin(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["你好"], lang_code="zh-Hans"))
        # Pinyin = Latin letters with tone diacritics.
        assert any(c.isalpha() and c.isascii() for c in resp.results[0].romanized)

    def test_zh_hant_default_yields_zhuyin(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["你好"], lang_code="zh-Hant"))
        # Bopomofo block: U+3105..U+312F.
        assert any(0x3105 <= ord(c) <= 0x312F for c in resp.results[0].romanized)

    def test_yue_default_yields_jyutping(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["你好"], lang_code="yue"))
        # Jyutping = Latin letters + tone digits 1-6.
        result = resp.results[0].romanized
        assert any(c.isalpha() and c.isascii() for c in result)
        assert any(c in "123456" for c in result)


# ---------------------------------------------------------------------------
# Japanese long_vowel_mode threads through
# ---------------------------------------------------------------------------

class TestJapaneseLongVowelMode:
    """Japanese is the only language that takes long_vowel_mode in
    /romanize.  Batch threads the request-root value through to every
    text, which means switching modes between requests changes the
    output for canonical long-vowel words."""

    def test_macrons_default(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["とうきょう"], lang_code="ja"))
        # 'とうきょう' → 'tōkyō' under macrons.
        assert "ō" in resp.results[0].romanized.lower()

    def test_doubled_mode(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(
            Req(texts=["とうきょう"], lang_code="ja", long_vowel_mode="doubled")
        )
        # Doubled mode emits 'tookyoo' / 'toukyou' instead of 'tōkyō'.
        out = resp.results[0].romanized.lower()
        assert "ō" not in out
        # 'oo' or 'ou' both acceptable; what we're really checking is
        # that the macron didn't get applied.
        assert "oo" in out or "ou" in out

    def test_unmarked_mode(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(
            Req(texts=["とうきょう"], lang_code="ja", long_vowel_mode="unmarked")
        )
        out = resp.results[0].romanized.lower()
        assert "ō" not in out


# ---------------------------------------------------------------------------
# Response-root metadata
# ---------------------------------------------------------------------------

class TestResponseMetadata:
    """The constant-per-batch fields (lang_code, romanization_name,
    has_phonetic_layer) live at the response root, not per-result —
    so the client only needs to read them once."""

    def test_lang_code_echoed(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["ありがとう"], lang_code="ja"))
        assert resp.lang_code == "ja"

    def test_romanization_name_present_for_supported_lang(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["ありがとう"], lang_code="ja"))
        assert resp.romanization_name and resp.romanization_name != "N/A"

    def test_has_phonetic_layer_true_for_japanese(self, batch_handler):
        handler, Req = batch_handler
        resp = handler(Req(texts=["x"], lang_code="ja"))
        assert resp.has_phonetic_layer is True


# ---------------------------------------------------------------------------
# Cross-family smoke (one input per family) — exercises the routing
# in get_lang_config without re-testing the romanization correctness.
# ---------------------------------------------------------------------------

class TestCrossFamilySmoke:
    """One sample per Loom-supported non-Latin family.  These exist
    less to verify output and more to catch regressions where a family
    silently stops producing romanization through the batch path
    (e.g. a refactor that drops Thai's spans_to_romaji branch)."""

    @pytest.mark.parametrize(
        "lang_code,text",
        [
            ("ja", "ありがとう"),
            ("ko", "안녕하세요"),
            ("zh-Hans", "你好"),
            ("zh-Hant", "你好"),
            ("yue", "你好"),
            ("ru", "Привет"),
            ("th", "สวัสดี"),
            ("hi", "नमस्ते"),
            ("he", "שלום"),
            ("ar", "مرحبا"),
        ],
    )
    def test_family_produces_nonempty_romanization(self, batch_handler, lang_code, text):
        handler, Req = batch_handler
        resp = handler(Req(texts=[text], lang_code=lang_code))
        assert resp.has_phonetic_layer is True, lang_code
        assert resp.results[0].romanized.strip() != "", lang_code
