"""Thai IPA output computed on the degraded engine must never reach the
result cache.

M-14 (tests/test_thai_engine_cache.py) stopped `_detect_thai_ipa_engine`
latching a failure for the worker's whole life: after a failed thaig2p probe
(typically the first-use corpus download failing inside a user's request) it
serves the tone-less thai2rom FALLBACK for a bounded window, then re-probes.
The residual was the cache: every line computed inside that window was still
written under the (th, "IPA") key — and the result cache is insert-first-wins
with no TTL, so those rows served RTGS-like, tone-less "IPA" to every later
IPA reader of those lines, forever (only an ENGINE_VERSIONS bump clears it).

Contract pinned here, for /romanize, /romanize/batch, /annotate and
/annotate/batch:

  * a degraded computation is still RETURNED to its requester (fail-soft —
    a legible transliteration beats an empty phonetic line);
  * it is NEVER written to the result cache;
  * once the engine recovers, the next request computes real IPA and caches
    it (i.e. no degraded row is sitting in front of it);
  * the decision is per ITEM and per THREAD: the engine can flip mid-batch,
    and another request degrading concurrently must not stop a healthy
    batch's rows being cached;
  * paiboon (the default) and rtgs never touch thaig2p and are unaffected.
"""

import sys
import threading

import pytest

pytest.importorskip("pythainlp")

from loom_api import deps as _deps  # noqa: E402
from loom_api.result_cache import InMemoryResultCache  # noqa: E402
from loom_api.routes.annotate import (  # noqa: E402
    AnnotateBatchRequest, AnnotateRequest, annotate, annotate_batch)
from loom_api.routes.romanize import (  # noqa: E402
    RomanizeBatchRequest, RomanizeRequest, romanize, romanize_batch)
from loom_core import romanize as R  # noqa: E402
from loom_core.styles import get_lang_config  # noqa: E402

# Multi-token lines (the concurrency test needs >= 2 Thai tokens per line so a
# thread can be caught mid-line), all distinct so every one is its own key.
_LINE = "สวัสดีครับ"                     # สวัสดีครับ
_A1 = "ผมชอบกินข้าวมาก"  # ผมชอบกินข้าวมาก
_A2 = "วันนี้อากาศดี"         # วันนี้อากาศดี
_B1 = "เธอไปไหน"                                   # เธอไปไหน
_B2 = "เราต้องกลับบ้าน"  # เราต้องกลับบ้าน

_TONES = "˥˦˧˨˩"   # ˥˦˧˨˩ — thaig2p contour marks
_KINDS = ["romanize/batch", "annotate/batch", "romanize", "annotate"]


def _pt():
    import pythainlp.transliterate  # noqa: F401
    return sys.modules["pythainlp.transliterate"]


def _thaig2p_available():
    try:
        return bool(_pt().transliterate("ก", engine="thaig2p").strip())
    except Exception:
        return False


def _has_tones(output) -> bool:
    return any(c in _TONES for c in repr(output))


class _RecordingCache(InMemoryResultCache):
    """In-memory cache that also records every row a route writes — reads
    are real, so a degraded row that DID get written would be served back
    to the next request, exactly as in prod."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self._lock = threading.Lock()

    def put_many(self, rows):
        rows = list(rows)
        with self._lock:
            self.rows.extend(rows)
            super().put_many(rows)

    def written(self):
        with self._lock:
            return {r.input_text: r.output for r in self.rows}


@pytest.fixture
def rec():
    R._reset_thai_ipa_engine_probe()
    cache = _RecordingCache()
    _deps.set_result_cache(cache)
    yield cache
    _deps.set_result_cache(None)
    R._reset_thai_ipa_engine_probe()


def _degrade(monkeypatch):
    """thaig2p unavailable (the probe raises) and the backoff far away."""
    def failing(*a, **k):
        raise OSError("simulated thai-g2p corpus download failure")

    real = _pt().transliterate
    monkeypatch.setattr(_pt(), "transliterate", failing)
    monkeypatch.setattr(R, "_THAI_IPA_PROBE_RETRY_SECONDS", 3600.0)
    return real


def _recover(monkeypatch, real):
    monkeypatch.setattr(_pt(), "transliterate", real)
    monkeypatch.setattr(R, "_THAI_IPA_PROBE_RETRY_SECONDS", 0.0)   # backoff elapsed


def _call(kind, texts, system="ipa"):
    """Drive the REAL route handler; return one output per text."""
    if kind == "romanize/batch":
        r = romanize_batch(RomanizeBatchRequest(texts=texts, lang_code="th", phonetic_system=system))
        return [i.romanized for i in r.results]
    if kind == "annotate/batch":
        r = annotate_batch(AnnotateBatchRequest(texts=texts, lang_code="th", phonetic_system=system))
        return [[(s.base, s.reading) for s in i.spans] for i in r.results]
    if kind == "romanize":
        return [romanize(RomanizeRequest(text=t, lang_code="th", phonetic_system=system)).romanized
                for t in texts]
    return [[(s.base, s.reading) for s in
             annotate(AnnotateRequest(text=t, lang_code="th", phonetic_system=system)).spans]
            for t in texts]


def _tone_less_fallback(kind, text):
    """What the degraded engine serves: thai2rom per token — byte-for-byte
    the RTGS system's output (computed straight off the engine, no route)."""
    cfg = get_lang_config("th", phonetic_system="rtgs")
    if kind.startswith("romanize"):
        return cfg["romanize_func"](text)
    return [tuple(s) for s in cfg["annotation_func"](text)]


# ---- the seam ---------------------------------------------------------------

def test_degraded_marker_reports_only_fallback_computations(rec, monkeypatch):
    ipa = get_lang_config("th", phonetic_system="ipa")
    mark = R.degraded_output_mark()
    get_lang_config("th", phonetic_system="rtgs")["romanize_func"](_LINE)
    get_lang_config("th", phonetic_system="paiboon")["annotation_func"](_LINE)
    ipa["romanize_func"]("OK 123")          # no Thai token -> no engine at all
    assert not R.degraded_since(mark)

    _degrade(monkeypatch)
    mark = R.degraded_output_mark()
    ipa["romanize_func"](_LINE)
    assert R.degraded_since(mark)
    mark = R.degraded_output_mark()
    ipa["annotation_func"](_LINE)
    assert R.degraded_since(mark)


# ---- routes: returned, never cached, real IPA after recovery -----------------

@pytest.mark.parametrize("kind", _KINDS)
def test_degraded_ipa_is_returned_but_never_cached(kind, rec, monkeypatch):
    if not _thaig2p_available():
        pytest.skip("thaig2p engine not available in this environment")
    real = _degrade(monkeypatch)

    # (a) fail-soft: the requester still gets the tone-less transliteration.
    degraded = _call(kind, [_LINE])
    assert degraded == [_tone_less_fallback(kind, _LINE)]
    assert not _has_tones(degraded)

    # (b) ...but nothing was written under the IPA key.
    assert rec.rows == [], f"degraded rows reached the cache: {rec.rows!r}"

    # (c) after recovery the next request computes REAL IPA (a written
    # degraded row would have been served back here instead) and caches it.
    _recover(monkeypatch, real)
    healed = _call(kind, [_LINE])
    assert _has_tones(healed), f"expected thaig2p tone marks, got {healed!r}"
    assert healed != degraded
    written = rec.written()
    assert list(written) == [_LINE]
    assert _has_tones(written[_LINE])
    assert all(r.phonetic_system == "IPA" for r in rec.rows)


@pytest.mark.parametrize("kind", _KINDS)
@pytest.mark.parametrize("system", ["paiboon", "rtgs", None])
def test_non_ipa_systems_still_cache_while_ipa_is_degraded(kind, system, rec, monkeypatch):
    """Paiboon+ (the default) and RTGS never consult thaig2p: an IPA outage
    must not cost them a single cache row."""
    _degrade(monkeypatch)
    R._detect_thai_ipa_engine()                       # the IPA probe has failed
    _call(kind, [_LINE, _A1], system=system)
    assert sorted(rec.written()) == sorted([_LINE, _A1])


@pytest.mark.parametrize("kind", ["romanize/batch", "annotate/batch"])
def test_batch_mixes_degraded_and_healthy_items_correctly(kind, rec, monkeypatch):
    """The engine recovers MID-BATCH: items computed before the flip are
    returned but not cached; items computed after it are real IPA and cached."""
    if not _thaig2p_available():
        pytest.skip("thaig2p engine not available in this environment")
    real = _degrade(monkeypatch)
    real_rom = R._thai_romanize_cached

    def flip_after_first_line(text, engine):
        out = real_rom(text, engine)
        # The first degraded token has been served; line 1 stays on the
        # fallback (the engine is resolved once per line), line 2 re-probes.
        _recover(monkeypatch, real)
        return out

    monkeypatch.setattr(R, "_thai_romanize_cached", flip_after_first_line)
    out = _call(kind, [_A1, _A2])
    monkeypatch.setattr(R, "_thai_romanize_cached", real_rom)

    assert out[0] == _tone_less_fallback(kind, _A1)
    assert _has_tones(out[1])
    written = rec.written()
    assert _A1 not in written, "a degraded item was cached"
    assert _A2 in written and _has_tones(written[_A2])


@pytest.mark.parametrize("kind", ["romanize/batch", "annotate/batch"])
def test_healthy_batch_is_cached_while_another_request_degrades(kind, rec, monkeypatch):
    """Two requests on two threadpool threads, interleaved deterministically:

      A: starts line A1 on the fallback engine and is held mid-line
      -- engine recovers --
      B: starts a healthy batch, is held mid-line on real IPA
      A: serves ANOTHER fallback token of A1 (while B's line is in flight),
         finishes A1, then computes A2 on the recovered engine
      B: finishes

    A1 must not be cached; A2, B1, B2 must be.  A global "degraded now?"
    flag read at the end of A's batch would cache A1; a process-wide
    degradation counter would drop B1 (A degraded during it)."""
    if not _thaig2p_available():
        pytest.skip("thaig2p engine not available in this environment")
    real = _degrade(monkeypatch)
    assert R._detect_thai_ipa_engine() == R._THAI_IPA_FALLBACK
    real_rom, real_tr = R._thai_romanize_cached, R._thai_transliterate_cached
    a_in_degraded_line = threading.Event()
    b_mid_line = threading.Event()
    a_degraded_during_b = threading.Event()
    a_fallback_calls = []

    def rom_hook(text, engine):
        if threading.current_thread().name == "A":
            a_fallback_calls.append(text)
            if len(a_fallback_calls) == 1:
                a_in_degraded_line.set()
                assert b_mid_line.wait(60)
            elif len(a_fallback_calls) == 2:
                a_degraded_during_b.set()
        return real_rom(text, engine)

    def tr_hook(text, engine):
        if threading.current_thread().name == "B" and not b_mid_line.is_set():
            b_mid_line.set()
            assert a_degraded_during_b.wait(60)
        return real_tr(text, engine)

    monkeypatch.setattr(R, "_thai_romanize_cached", rom_hook)
    monkeypatch.setattr(R, "_thai_transliterate_cached", tr_hook)
    results, errors = {}, []

    def run(name, texts):
        try:
            results[name] = _call(kind, texts)
        except BaseException as e:   # surfaced below, not lost in the thread
            errors.append((name, e))

    a = threading.Thread(target=run, args=("A", [_A1, _A2]), name="A")
    b = threading.Thread(target=run, args=("B", [_B1, _B2]), name="B")
    a.start()
    assert a_in_degraded_line.wait(60)
    _recover(monkeypatch, real)
    b.start()
    a.join(120)
    b.join(120)
    assert not a.is_alive() and not b.is_alive()
    assert not errors, errors
    assert a_degraded_during_b.is_set(), "the interleaving did not happen"

    assert results["A"][0] == _tone_less_fallback(kind, _A1)
    assert _has_tones(results["A"][1])
    assert all(_has_tones(o) for o in results["B"])
    written = rec.written()
    assert _A1 not in written, "the degraded line was cached"
    assert set(written) == {_A2, _B1, _B2}
    assert all(_has_tones(o) for o in written.values())
