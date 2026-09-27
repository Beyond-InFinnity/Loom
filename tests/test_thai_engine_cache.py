"""Thai romanization engine calls: memoized (M-2) and a probe that never
latches a failure (M-14).

M-2  — pythainlp's `romanize(syl, engine='thai2rom')` runs a torch seq2seq
       model and was called once per SYLLABLE (Paiboon+) / TOKEN (RTGS) with no
       memo, so a 600-line episode took ~79 s — past the extension's 60 s
       request timeout.  The model is deterministic in its input, and a Thai
       episode repeats a small syllable vocabulary endlessly, so a bounded
       per-(text, engine) memo makes it ~1 s with byte-identical output.
       Bounded by entry count AND key length: a run of Thai digits / signs
       stays one token of up to a whole 5000-char line, so long tokens bypass
       the memo instead of each retaining ~10 KB.

M-14 — `_detect_thai_ipa_engine` was `@lru_cache(maxsize=1)` and cached its
       FALLBACK too: one transient failure (e.g. the first-use thai-g2p corpus
       download failing inside a user request) permanently switched the worker
       to tone-less thai2rom output — written under the "IPA" cache key.  Now
       only success is memoized; a failure answers the fallback for that call
       and is retried after a short backoff.
"""

import sys

import pytest

pytest.importorskip("pythainlp")

from loom_core import romanize as R  # noqa: E402
from loom_core.styles import get_lang_config  # noqa: E402

_WORDS = ["ผม", "ชอบ", "กิน", "ข้าว", "มาก", "วันนี้", "อากาศ", "ดี", "ขอบคุณ",
          "ครับ", "ไป", "ไหน", "มา", "เธอ", "รัก", "บ้าน", "โรงเรียน", "ทำไม",
          "อะไร", "ไม่", "ใช่", "เรา", "จะ", "ต้อง", "กลับ"]


def _lines(n, seed=1):
    import random
    rnd = random.Random(seed)
    return ["".join(rnd.choice(_WORDS) for _ in range(rnd.randint(4, 9)))
            for _ in range(n)]


def _pt():
    import pythainlp.transliterate  # noqa: F401
    return sys.modules["pythainlp.transliterate"]


# ---- M-2: memoized model calls ---------------------------------------------

def test_repeated_syllables_hit_the_model_once(monkeypatch):
    pt = _pt()
    real = pt.romanize
    calls = []

    def counting(text, engine="royin", **kw):
        calls.append((text, engine))
        return real(text, engine=engine, **kw)

    monkeypatch.setattr(pt, "romanize", counting)
    R._thai_romanize_memo.cache_clear()
    rom = get_lang_config("th", phonetic_system="paiboon")["romanize_func"]
    line = "ขอบคุณครับ ขอบคุณครับ ขอบคุณครับ ขอบคุณครับ"
    rom(line)
    rom(line)
    assert calls, "the model must still be consulted on a cold memo"
    assert len(calls) == len(set(calls)), (
        f"{len(calls)} model calls for {len(set(calls))} distinct syllables")


def test_memo_is_bounded():
    assert R._thai_romanize_memo.cache_info().maxsize == R._THAI_MODEL_MEMO_SIZE
    assert R._thai_transliterate_memo.cache_info().maxsize == R._THAI_MODEL_MEMO_SIZE
    assert 0 < R._THAI_MODEL_MEMO_SIZE <= 16384
    # Real syllables / words are <= ~10 codepoints; the key-length cap must
    # leave them all memoized while bounding each entry.
    assert 16 <= R._THAI_MODEL_MEMO_MAX_KEY_LEN <= 64


def test_long_tokens_bypass_the_memo():
    """_thai_tokenize leaves a run of Thai digits / signs / stacked marks as ONE
    token — up to a whole 5000-char line — and every path hands it straight to
    the model.  Memoizing those let a client stream unique long tokens into
    ~10 KB entries (~680 MB per memo at 65536).  They are answered uncached."""
    pt = _pt()
    R._thai_romanize_memo.cache_clear()
    R._thai_transliterate_memo.cache_clear()
    long_tok = "\u0e51\u0e52\u0e53\u0e54\u0e55\u0e56\u0e57\u0e58\u0e59\u0e50" * 30   # ๑๒๓…๐ x30
    assert R._thai_tokenize(long_tok) == [long_tok], "precondition: one 300-char token"
    for system in ("rtgs", "paiboon", "ipa"):
        get_lang_config("th", phonetic_system=system)["romanize_func"](long_tok)
        get_lang_config("th", phonetic_system=system)["annotation_func"](long_tok)
    assert R._thai_romanize_memo.cache_info().currsize == 0
    assert R._thai_transliterate_memo.cache_info().currsize == 0
    # Same answer as the model, just not retained.
    assert R._thai_romanize_cached(long_tok, "thai2rom") == pt.romanize(long_tok, engine="thai2rom")
    assert R._thai_romanize_memo.cache_info().currsize == 0
    # Ordinary tokens are still memoized.
    get_lang_config("th", phonetic_system="rtgs")["romanize_func"]("\u0e02\u0e2d\u0e1a\u0e04\u0e38\u0e13\u0e04\u0e23\u0e31\u0e1a")  # ขอบคุณครับ
    assert R._thai_romanize_memo.cache_info().currsize > 0


@pytest.mark.parametrize("system", ["paiboon", "rtgs", "ipa"])
def test_memoized_output_is_byte_identical_to_uncached(system, monkeypatch):
    lines = _lines(40)
    cfg = get_lang_config("th", phonetic_system=system)
    R._thai_romanize_memo.cache_clear()
    R._thai_transliterate_memo.cache_clear()
    memo_rom = [cfg["romanize_func"](l) for l in lines]
    memo_ann = [cfg["annotation_func"](l) for l in lines]
    # Uncached reference: route the memo helpers straight to pythainlp.
    pt = _pt()
    monkeypatch.setattr(R, "_thai_romanize_cached",
                        lambda text, engine: pt.romanize(text, engine=engine))
    monkeypatch.setattr(R, "_thai_transliterate_cached",
                        lambda text, engine: pt.transliterate(text, engine=engine))
    cfg = get_lang_config("th", phonetic_system=system)
    assert [cfg["romanize_func"](l) for l in lines] == memo_rom
    assert [cfg["annotation_func"](l) for l in lines] == memo_ann


# ---- M-14: the IPA engine probe must not latch a failure --------------------

@pytest.fixture
def fresh_probe():
    R._reset_thai_ipa_engine_probe()
    yield
    R._reset_thai_ipa_engine_probe()


def _thaig2p_available():
    try:
        return bool(_pt().transliterate("ก", engine="thaig2p").strip())
    except Exception:
        return False


def test_one_transient_failure_does_not_latch_the_fallback(fresh_probe, monkeypatch):
    if not _thaig2p_available():
        pytest.skip("thaig2p engine not available in this environment")
    pt = _pt()
    real = pt.transliterate

    def flaky(*a, **k):
        raise OSError("simulated corpus download failure")

    monkeypatch.setattr(pt, "transliterate", flaky)
    assert R._detect_thai_ipa_engine() == ("romanize", "thai2rom")   # this call degrades
    monkeypatch.setattr(pt, "transliterate", real)                   # network recovers
    monkeypatch.setattr(R, "_THAI_IPA_PROBE_RETRY_SECONDS", 0.0)     # backoff elapsed
    assert R._detect_thai_ipa_engine() == ("transliterate", "thaig2p")
    out = get_lang_config("th", phonetic_system="ipa")["romanize_func"]("สวัสดีครับ")
    assert "˧" in out or "˦" in out or "˨" in out, f"expected tone marks, got {out!r}"


def test_failure_is_not_retried_on_every_token_within_the_backoff(fresh_probe, monkeypatch):
    pt = _pt()
    probes = []

    def failing(*a, **k):
        probes.append(a)
        raise OSError("still down")

    monkeypatch.setattr(pt, "transliterate", failing)
    monkeypatch.setattr(R, "_THAI_IPA_PROBE_RETRY_SECONDS", 3600.0)
    for _ in range(5):
        assert R._detect_thai_ipa_engine() == ("romanize", "thai2rom")
    assert len(probes) == 1, "a persistent failure must back off, not re-probe per token"


def test_success_is_memoized(fresh_probe, monkeypatch):
    if not _thaig2p_available():
        pytest.skip("thaig2p engine not available in this environment")
    assert R._detect_thai_ipa_engine() == ("transliterate", "thaig2p")
    pt = _pt()

    def boom(*a, **k):
        raise AssertionError("a memoized success must not re-probe")

    monkeypatch.setattr(pt, "transliterate", boom)
    assert R._detect_thai_ipa_engine() == ("transliterate", "thaig2p")


@pytest.mark.parametrize("func", ["romanize_func", "annotation_func"])
def test_ipa_engine_is_resolved_once_per_line(func, monkeypatch):
    """The probe's failure backoff can expire mid-line; resolving per TOKEN
    would then mix thai2rom and thaig2p output inside one cached line."""
    calls = []

    def detect():
        calls.append(1)
        return R._THAI_IPA_FALLBACK

    monkeypatch.setattr(R, "_detect_thai_ipa_engine", detect)
    f = get_lang_config("th", phonetic_system="ipa")[func]
    line = "\u0e1c\u0e21\u0e0a\u0e2d\u0e1a\u0e01\u0e34\u0e19\u0e02\u0e49\u0e32\u0e27\u0e21\u0e32\u0e01"   # ผมชอบกินข้าวมาก
    assert len([t for t in R._thai_tokenize(line) if R._has_thai(t)]) >= 3
    f(line)
    assert len(calls) == 1
    f("OK 123")                  # no Thai token -> no probe at all
    assert len(calls) == 1


def test_legacy_cache_clear_alias_resets_the_probe(fresh_probe, monkeypatch):
    """The review repro (and any ad-hoc tooling) resets the probe via the
    functools-style `cache_clear()`; keep that working."""
    pt = _pt()
    monkeypatch.setattr(pt, "transliterate", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(R, "_THAI_IPA_PROBE_RETRY_SECONDS", 3600.0)
    assert R._detect_thai_ipa_engine() == ("romanize", "thai2rom")
    R._detect_thai_ipa_engine.cache_clear()
    calls = []
    monkeypatch.setattr(pt, "transliterate", lambda *a, **k: calls.append(1) or "k a ˧")
    assert R._detect_thai_ipa_engine() == ("transliterate", "thaig2p")
    assert calls == [1]
