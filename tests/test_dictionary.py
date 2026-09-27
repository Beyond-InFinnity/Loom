"""Tests for per-word dictionary lookup (VOCAB_LOOKUP.md).

Covers the merge/lookup logic (headword-OR-reading match, multi-row merge,
common-first ordering, gloss dedup, lang scoping), POST /define/batch
(order+echo, found flag, lang lowercasing, NFC normalization, fail-soft), and
provider wiring.  The Postgres store follows the same fail-open pattern verified
for Layers 1/2 and gets its acceptance test on a live DB.

Handlers are called directly with Pydantic models (house idiom); the store is
swapped via loom_api.deps.set_dictionary_store.
"""
import unicodedata

import pytest

from loom_api.deps import set_dictionary_store
from loom_api.dictionary import InMemoryDictionaryStore, NullDictionaryStore


@pytest.fixture
def mem_store():
    store = InMemoryDictionaryStore()
    set_dictionary_store(store)
    yield store
    set_dictionary_store(None)


@pytest.fixture
def define_handler():
    from loom_api.routes.define import DefineRequest, define_batch
    return define_batch, DefineRequest


# --------------------------------------------------------------------------- #
# Store: lookup + merge
# --------------------------------------------------------------------------- #

def test_lookup_by_headword(mem_store):
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"], "pos": ["Ichidan verb"]}],
                  common=True, source="jmdict")
    d = mem_store.lookup("ja", ["食べる"])["食べる"]
    assert d.reading == "たべる"
    assert d.senses[0].gloss == ("to eat",)
    assert d.senses[0].pos == ("Ichidan verb",)
    assert d.sources == ("jmdict",)


def test_lookup_by_reading(mem_store):
    # a kana query hits the reading column, not headword (VOCAB_LOOKUP.md §5.4 rule 1)
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    d = mem_store.lookup("ja", ["たべる"])["たべる"]
    assert d.senses[0].gloss == ("to eat",)


def test_lookup_is_lang_scoped(mem_store):
    mem_store.add("zh", "行", "xing2", [{"gloss": ["to walk"]}], source="cc-cedict")
    mem_store.add("ja", "行", "こう", [{"gloss": ["line"]}], source="jmdict")
    assert mem_store.lookup("zh", ["行"])["行"].senses[0].gloss == ("to walk",)
    assert mem_store.lookup("ja", ["行"])["行"].senses[0].gloss == ("line",)


def test_merge_multiple_rows_common_first(mem_store):
    # §5.4 rule 2: multiple rows per headword merge; common sorts first
    mem_store.add("zh", "吃", "chi1", [{"gloss": ["variant of 吃"]}], common=False, source="cc-cedict")
    mem_store.add("zh", "吃", "chi1", [{"gloss": ["to eat"]}, {"gloss": ["to suffer"]}],
                  common=True, source="cc-cedict")
    d = mem_store.lookup("zh", ["吃"])["吃"]
    assert d.senses[0].gloss == ("to eat",)  # common row's senses lead
    assert ("variant of 吃",) in [s.gloss for s in d.senses]


def test_merge_dedups_glosses_across_sources(mem_store):
    mem_store.add("zh", "你好", "ni3 hao3", [{"gloss": ["hello"]}], source="cc-cedict")
    mem_store.add("zh", "你好", "ni3 hao3", [{"gloss": ["hello"]}], source="other")
    d = mem_store.lookup("zh", ["你好"])["你好"]
    assert len(d.senses) == 1                 # duplicate gloss dropped
    assert d.sources == ("cc-cedict", "other")  # both sources still credited


def test_lookup_miss_is_absent(mem_store):
    assert mem_store.lookup("ja", ["存在しない語"]) == {}


def test_batch_lookup_mixed_hits(mem_store):
    mem_store.add("ja", "犬", "いぬ", [{"gloss": ["dog"]}], source="jmdict")
    mem_store.add("ja", "猫", "ねこ", [{"gloss": ["cat"]}], source="jmdict")
    out = mem_store.lookup("ja", ["犬", "未収録", "猫"])
    assert set(out) == {"犬", "猫"}


def test_null_store_returns_empty():
    assert NullDictionaryStore().lookup("ja", ["食べる"]) == {}


# --------------------------------------------------------------------------- #
# Chinese decomposition fallback (jieba over-grouping, e.g. 一顶 / 两个)
# --------------------------------------------------------------------------- #

def test_zh_decomposition_on_miss(mem_store):
    mem_store.add("zh", "一", "yī", [{"gloss": ["one"]}], source="cc-cedict")
    mem_store.add("zh", "顶", "dǐng", [{"gloss": ["measure word for hats"]}], source="cc-cedict")
    d = mem_store.lookup("zh", ["一顶"])["一顶"]
    assert d.senses == ()                       # not a direct headword
    assert [p.word for p in d.parts] == ["一", "顶"]
    assert d.parts[0].senses[0].gloss == ("one",)
    assert d.parts[1].reading == "dǐng"


def test_zh_direct_hit_has_no_parts(mem_store):
    mem_store.add("zh", "你好", "ni3 hao3", [{"gloss": ["hello"]}], source="cc-cedict")
    d = mem_store.lookup("zh", ["你好"])["你好"]
    assert d.senses and d.parts == ()


def test_zh_decomposition_is_longest_match(mem_store):
    mem_store.add("zh", "一", "yī", [{"gloss": ["one"]}], source="cc-cedict")
    mem_store.add("zh", "帽子", "màozi", [{"gloss": ["hat"]}], source="cc-cedict")
    d = mem_store.lookup("zh", ["一帽子"])["一帽子"]
    assert [p.word for p in d.parts] == ["一", "帽子"]  # 帽子 grouped, not 帽+子


def test_zh_no_decomposition_when_nothing_matches(mem_store):
    assert "虚构词" not in mem_store.lookup("zh", ["虚构词"])


# --------------------------------------------------------------------------- #
# Decomposition cost bound.  Substring generation is O(len²) PER WORD and the
# route admits up to 200 words × (1 + 16 alt_keys) × 64 chars — the code's
# "words are short → bounded" assumption is a request-controlled quantity, so
# a ~2 MB body (well under the 10 MB cap, one rate-limit slot) could generate
# millions of strings and OOM the single worker before the query even ran.
# --------------------------------------------------------------------------- #

def _pathological_words(n: int = 200, length: int = 64):
    """n DISTINCT max-length CJK "words" — what 200 words × 16 alt_keys can
    expand to in the candidate union the route passes down."""
    base = 0x4E00
    return ["".join(chr(base + (i * length + j) % 20000) for j in range(length))
            for i in range(n)]


def _recording_lookup():
    """exact_lookup stub that records how many keys it was asked for."""
    seen = {"max_batch": 0, "total": 0}

    def lookup(words):
        n = len(list(words))
        seen["max_batch"] = max(seen["max_batch"], n)
        seen["total"] += n
        return {}

    return lookup, seen


def test_zh_decomposition_key_count_is_bounded_for_pathological_input():
    from loom_api.dictionary import _lookup_with_decomposition

    lookup, seen = _recording_lookup()
    words = _pathological_words()      # the worst request the route allows
    _lookup_with_decomposition("zh", words, lookup)
    # Unbounded generation would be ~200 × 2080 distinct substrings.
    assert seen["max_batch"] < 6000, f"generated {seen['max_batch']} keys in one query"


def test_zh_decomposition_completes_promptly_for_pathological_input():
    import time
    from loom_api.dictionary import _lookup_with_decomposition

    lookup, _ = _recording_lookup()
    words = _pathological_words()
    t0 = time.time()
    _lookup_with_decomposition("zh", words, lookup)
    assert time.time() - t0 < 2.0


# --------------------------------------------------------------------------- #
# capabilities() memoization.  The query is SELECT DISTINCT lang, gloss_lang
# over ~9M rows / ~3GB with no covering index (the composite was dropped to
# free disk), i.e. a full heap scan measured at 30–48 s cold in prod — and the
# extension AWAITS it before fetching furigana.  So the memo is
# stale-while-revalidate: once any value exists a caller never waits on the
# scan again; an expired value is served while ONE background refresh runs.
# --------------------------------------------------------------------------- #

def _sync_spawn():
    """spawn= stub that queues background refreshes so a test runs them when
    it chooses (deterministic, no threads)."""
    queued = []
    return queued, queued.append


def test_capabilities_memo_recomputes_only_after_ttl():
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    calls = []
    queued, spawn = _sync_spawn()
    memo = _TTLMemo(ttl=900, clock=lambda: now[0], spawn=spawn)

    def compute():
        calls.append(1)
        return f"CAPS{len(calls)}"

    assert memo.get(compute) == "CAPS1"
    assert memo.get(compute) == "CAPS1"
    assert len(calls) == 1, "second call within the TTL must not re-query"
    now[0] += 901
    # Expired: the STALE value is returned immediately and a refresh is queued
    # in the background instead of running on the caller's request.
    assert memo.get(compute) == "CAPS1"
    assert len(calls) == 1
    assert len(queued) == 1
    queued.pop()()
    assert len(calls) == 2
    assert memo.get(compute) == "CAPS2"


def test_capabilities_memo_does_not_cache_a_failed_result():
    """With nothing cached yet, a failed compute answers None and is NOT
    remembered for the TTL — that would keep every word un-clickable for hours
    after the DB recovers.  It is retried once the short failure pacing lapses
    (see test_capabilities_memo_failed_first_compute_is_single_flight)."""
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    memo = _TTLMemo(ttl=900, clock=lambda: now[0])
    calls = []

    def failing():
        calls.append(1)
        return None

    assert memo.get(failing) is None
    now[0] += memo.first_retry_seconds + 1
    assert memo.get(failing) is None
    assert len(calls) == 2
    now[0] += memo.first_retry_seconds + 1
    assert memo.get(lambda: "CAPS") == "CAPS"
    assert memo.get(failing) == "CAPS"
    assert len(calls) == 2


def test_capabilities_memo_single_background_refresh_while_stale():
    """Any number of callers past the TTL trigger exactly ONE refresh."""
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    queued, spawn = _sync_spawn()
    memo = _TTLMemo(ttl=900, clock=lambda: now[0], spawn=spawn)
    memo.get(lambda: "OLD")
    now[0] += 5000
    for _ in range(25):
        assert memo.get(lambda: "NEW") == "OLD"
    assert len(queued) == 1, "refresh must be single-flight"


def test_capabilities_memo_failed_refresh_keeps_serving_stale():
    """A refresh that fails (DB blip, pool contention) must never degrade the
    answer to nothing — the stale value keeps being served, and the retry is
    rate-limited rather than re-launched on every request."""
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    queued, spawn = _sync_spawn()
    memo = _TTLMemo(ttl=900, clock=lambda: now[0], spawn=spawn)
    memo.get(lambda: "OLD")
    now[0] += 901
    attempts = []

    def failing():
        attempts.append(1)
        return None

    assert memo.get(failing) == "OLD"
    queued.pop()()                      # the refresh fails
    assert len(attempts) == 1
    assert memo.get(failing) == "OLD"   # still served
    assert queued == [], "a failed refresh must not be retried immediately"
    now[0] += memo.retry_seconds + 1
    assert memo.get(lambda: "NEW") == "OLD"
    assert len(queued) == 1             # retried once the backoff lapses
    queued.pop()()
    assert memo.get(lambda: "unused") == "NEW"


def test_capabilities_memo_refresh_exception_keeps_stale():
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    queued, spawn = _sync_spawn()
    memo = _TTLMemo(ttl=900, clock=lambda: now[0], spawn=spawn)
    memo.get(lambda: "OLD")
    now[0] += 901

    def boom():
        raise RuntimeError("scan died")

    assert memo.get(boom) == "OLD"
    queued.pop()()                      # must not propagate
    assert memo.get(boom) == "OLD"


def test_capabilities_memo_stale_get_never_waits_for_the_refresh():
    """The load-bearing property (H-7): with a value cached, a caller returns
    at once even while the (real-thread) refresh is stuck in a 40 s scan."""
    import threading
    import time as _time
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    memo = _TTLMemo(ttl=900, clock=lambda: now[0])
    memo.get(lambda: "OLD")
    now[0] += 901
    release = threading.Event()
    started = threading.Event()

    def slow_scan():
        started.set()
        release.wait(10)
        return "NEW"

    t0 = _time.monotonic()
    assert memo.get(slow_scan) == "OLD"
    assert started.wait(5), "refresh should have been launched"
    assert memo.get(slow_scan) == "OLD"
    assert _time.monotonic() - t0 < 1.0
    release.set()
    deadline = _time.monotonic() + 5
    while memo.get(slow_scan) != "NEW" and _time.monotonic() < deadline:
        _time.sleep(0.01)
    assert memo.get(slow_scan) == "NEW"


def test_capabilities_memo_first_compute_is_single_flight():
    """Nothing cached: concurrent callers share ONE compute (as before)."""
    import threading
    from loom_api.dictionary import _TTLMemo

    memo = _TTLMemo(ttl=900)
    calls = []
    gate = threading.Event()

    def scan():
        calls.append(1)
        gate.wait(5)
        return "CAPS"

    results = []
    threads = [threading.Thread(target=lambda: results.append(memo.get(scan)))
               for _ in range(8)]
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join(5)
    assert results == ["CAPS"] * 8
    assert len(calls) == 1


def test_capabilities_memo_failed_first_compute_is_single_flight():
    """Nothing cached and the compute FAILS: the callers queued behind it must
    share that failure, not each re-run the scan in turn.  Before, a failure
    tripped the store's 30 s breaker so queued callers got None at once; the
    scan's own statement_timeout and pool contention now deliberately do NOT
    trip, so without this the Nth caller waited N × (up to 180 s), each
    holding one of anyio's ~40 threadpool slots."""
    import threading
    import time as _time
    from loom_api.dictionary import _TTLMemo

    memo = _TTLMemo(ttl=21600)
    calls = []

    def slow_failing_scan():
        calls.append(1)
        _time.sleep(0.3)
        return None

    results, waits = [], []

    def caller():
        t0 = _time.monotonic()
        results.append(memo.get(slow_failing_scan))
        waits.append(_time.monotonic() - t0)

    threads = [threading.Thread(target=caller) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert results == [None] * 6
    assert len(calls) == 1, "queued callers must not each re-run a failed compute"
    assert max(waits) < 1.0


def test_capabilities_memo_first_compute_failure_pacing():
    """The pause after a failed first compute is at least first_retry_seconds
    and at least as long as the failed attempt took — so a scan that ran into
    its 180 s statement_timeout isn't relaunched back-to-back, pinning one of
    the pool's four connections, while a cheap failure (pool contention, a
    tripped breaker) is retried soon."""
    from loom_api.dictionary import _TTLMemo

    now = [1000.0]
    memo = _TTLMemo(ttl=21600, clock=lambda: now[0])
    calls = []

    def timed_out_scan():
        calls.append(1)
        now[0] += 180                    # the attempt itself took 180 s
        return None

    assert memo.get(timed_out_scan) is None
    now[0] += 179
    assert memo.get(timed_out_scan) is None
    assert len(calls) == 1
    now[0] += 2
    assert memo.get(lambda: "CAPS") == "CAPS"

    quick = _TTLMemo(ttl=21600, clock=lambda: now[0])
    assert quick.get(lambda: None) is None
    now[0] += quick.first_retry_seconds - 1
    assert quick.get(lambda: "CAPS") is None
    now[0] += 2
    assert quick.get(lambda: "CAPS") == "CAPS"


def test_capabilities_default_ttl_is_six_hours():
    """With background refresh the TTL only sets how often a 3 GB scan runs in
    the background — 6 h, still env-overridable via LOOM_CAPABILITIES_TTL.
    Read at import, so checked in a fresh interpreter (reloading the module in
    place would orphan the classes other modules already imported)."""
    import os
    import subprocess
    import sys

    probe = "import loom_api.dictionary as d; print(d.CAPABILITIES_TTL_SECONDS)"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {k: v for k, v in os.environ.items() if k != "LOOM_CAPABILITIES_TTL"}
    out = subprocess.run([sys.executable, "-c", probe], cwd=root, env=env,
                         capture_output=True, text=True, check=True)
    assert float(out.stdout.strip()) == 21600
    env["LOOM_CAPABILITIES_TTL"] = "60"
    out = subprocess.run([sys.executable, "-c", probe], cwd=root, env=env,
                         capture_output=True, text=True, check=True)
    assert float(out.stdout.strip()) == 60


def test_zh_decomposition_still_works_for_real_words(mem_store):
    """The bound must not break the case it exists for."""
    mem_store.add("zh", "一", "yī", [{"gloss": ["one"]}], source="cc-cedict")
    mem_store.add("zh", "顶", "dǐng", [{"gloss": ["measure word"]}], source="cc-cedict")
    d = mem_store.lookup("zh", ["一顶"])["一顶"]
    assert [p.word for p in d.parts] == ["一", "顶"]


def test_ja_no_decomposition_for_ordinary_miss(mem_store):
    # A plain missing word (no honorific suffix) still just misses — the JA
    # fallback only peels honorifics, it doesn't segment arbitrarily.
    mem_store.add("ja", "食", "しょく", [{"gloss": ["food"]}], source="jmdict")
    assert "刺さって" not in mem_store.lookup("ja", ["刺さって"])


def test_ja_honorific_decomposition_on_miss(mem_store):
    # 玉葉 (a name) isn't in the dict; 玉葉様 peels the honorific so the card
    # still teaches 様.  The honorific gloss is hardcoded, not looked up.
    out = mem_store.lookup("ja", ["玉葉様"])
    d = out["玉葉様"]
    assert d.senses == ()                       # no direct entry
    assert [p.word for p in d.parts] == ["様"]   # honorific peeled
    assert d.parts[0].reading == "さま"
    assert d.parts[0].sources == ("honorific",)


def test_ja_honorific_shows_stem_when_it_is_a_word(mem_store):
    mem_store.add("ja", "先生", "せんせい", [{"gloss": ["teacher"]}], source="jmdict")
    d = mem_store.lookup("ja", ["先生さん"])["先生さん"]  # contrived stem+honorific
    assert [p.word for p in d.parts] == ["先生", "さん"]
    assert d.parts[0].senses[0].gloss == ("teacher",)


def test_ja_lexicalized_word_hits_directly_never_decomposes(mem_store):
    # お母さん / 母さん / 赤ちゃん end in an honorific syllable but are real
    # headwords — a direct hit must win, the honorific peel must NOT fire.
    mem_store.add("ja", "お母さん", "おかあさん", [{"gloss": ["mother"]}], source="jmdict")
    d = mem_store.lookup("ja", ["お母さん"])["お母さん"]
    assert d.senses[0].gloss == ("mother",)
    assert d.parts == ()


def test_ja_bare_honorific_does_not_decompose(mem_store):
    # A honorific with no stem (さん alone) has nothing to peel.
    assert mem_store.lookup("ja", ["さん"]) == {}


def test_route_returns_decomposition_parts(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("zh", "一", "yī", [{"gloss": ["one"]}], source="cc-cedict")
    mem_store.add("zh", "顶", "dǐng", [{"gloss": ["MW for hats"]}], source="cc-cedict")
    r = handler(Req(lang="zh", words=["一顶"])).results[0]
    assert r.found is False
    assert [p.word for p in r.parts] == ["一", "顶"]
    assert r.parts[0].senses[0].gloss == ["one"]


def test_route_multikey_surface_fallback(mem_store, define_handler):
    # MeCab's lemma (黒曜) misses; the surface (黒曜石) hits — the alt key wins.
    handler, Req = define_handler
    mem_store.add("ja", "黒曜石", "こくようせき", [{"gloss": ["obsidian"]}], source="jmdict")
    r = handler(Req(lang="ja", words=["黒曜"], alt_keys=[["黒曜石"]])).results[0]
    assert r.found is True
    assert r.word == "黒曜"                       # primary echoed back
    assert r.senses[0].gloss == ["obsidian"]


def test_route_multikey_prefers_primary_lemma(mem_store, define_handler):
    # When both the lemma and surface resolve, the primary (lemma) wins.
    handler, Req = define_handler
    mem_store.add("ja", "見る", "みる", [{"gloss": ["to see"]}], source="jmdict")
    mem_store.add("ja", "見た", "みた", [{"gloss": ["WRONG surface entry"]}], source="jmdict")
    r = handler(Req(lang="ja", words=["見る"], alt_keys=[["見た"]])).results[0]
    assert r.senses[0].gloss == ["to see"]


def test_route_alt_keys_optional_and_backcompat(mem_store, define_handler):
    # No alt_keys → behaves exactly as the single-key endpoint did.
    handler, Req = define_handler
    mem_store.add("ja", "犬", "いぬ", [{"gloss": ["dog"]}], source="jmdict")
    assert handler(Req(lang="ja", words=["犬"])).results[0].found is True


def test_route_case_insensitive_fallback_for_sentence_initial(mem_store, define_handler):
    # A sentence-initial capitalized word (Polish "Koty") must resolve to the
    # lowercase dictionary headword — every subtitle line's first word is caps.
    handler, Req = define_handler
    mem_store.add("pl", "koty", None, [{"gloss": ["cats"]}], source="wiktextract")
    r = handler(Req(lang="pl", words=["Koty"])).results[0]
    assert r.found is True
    assert r.word == "Koty"                       # original echoed back verbatim
    assert r.senses[0].gloss == ["cats"]


def test_route_exact_case_wins_over_lowercase(mem_store, define_handler):
    # German nouns are capitalized in the dictionary; the exact form must be
    # tried FIRST so "Kinder" hits its own row, not a spurious lowercase one.
    handler, Req = define_handler
    mem_store.add("de", "Kinder", None, [{"gloss": ["children"]}], source="wiktextract")
    r = handler(Req(lang="de", words=["Kinder"])).results[0]
    assert r.found is True and r.senses[0].gloss == ["children"]


def test_candidates_appends_lowercase_after_exact():
    from loom_api.routes.define import _candidates
    # exact forms first, lowercase variants appended (order matters for cased dicts)
    assert _candidates("Koty", None) == ["Koty", "koty"]
    assert _candidates("犬", None) == ["犬"]        # caseless → no duplicate
    assert _candidates("kot", None) == ["kot"]      # already lowercase → no dup


# --------------------------------------------------------------------------- #
# Japanese Hepburn romaji on /define
# --------------------------------------------------------------------------- #

def test_route_ja_romaji_macron_and_doubled(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("ja", "東京", "とうきょう", [{"gloss": ["Tokyo"]}], source="jmdict")
    r = handler(Req(lang="ja", words=["東京"])).results[0]
    assert r.romaji == "Tōkyō"
    assert r.romaji_alt == "Toukyou"


def test_route_ja_romaji_alt_collapses_without_long_vowel(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("ja", "犬", "いぬ", [{"gloss": ["dog"]}], source="jmdict")
    r = handler(Req(lang="ja", words=["犬"])).results[0]
    assert r.romaji == "Inu"
    assert r.romaji_alt is None          # no long vowel → no redundant form


def test_route_ja_romaji_tracks_contextual_reading(mem_store, define_handler):
    # The card shows the inflected furigana (見た); romaji must match it, not
    # the dictionary form's reading (みる).
    handler, Req = define_handler
    mem_store.add("ja", "見る", "みる", [{"gloss": ["to see"]}], source="jmdict")
    r = handler(Req(lang="ja", words=["見る"], readings=["みた"])).results[0]
    assert r.romaji == "Mita"


def test_route_ja_romaji_present_even_on_miss(mem_store, define_handler):
    # A word with no entry still gets its reading romanized for the header.
    handler, Req = define_handler
    r = handler(Req(lang="ja", words=["東京"], readings=["とうきょう"])).results[0]
    assert r.found is False
    assert r.romaji == "Tōkyō"


def test_route_zh_has_no_romaji(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("zh", "你好", "ni3 hao3", [{"gloss": ["hello"]}], source="cc-cedict")
    r = handler(Req(lang="zh", words=["你好"])).results[0]
    assert r.romaji is None and r.romaji_alt is None


def test_hepburn_from_kana_unit():
    from loom_core.romanize import hepburn_from_kana
    assert hepburn_from_kana("とうきょう") == ("Tōkyō", "Toukyou")
    assert hepburn_from_kana("しゅうまつ") == ("Shūmatsu", "Shuumatsu")
    assert hepburn_from_kana("みた") == ("Mita", "Mita")     # no long vowel
    assert hepburn_from_kana("") == ("", "")


# --------------------------------------------------------------------------- #
# CC-CEDICT numbered Pinyin -> tone marks
# --------------------------------------------------------------------------- #

def test_cedict_pinyin_to_diacritics_unit():
    from loom_api.dictionary import cedict_pinyin_to_diacritics as c
    assert c("ni3 hao3") == "nǐ hǎo"
    assert c("lu:4") == "lǜ"           # ü written as u:
    assert c("lv4") == "lǜ"            # ü written as v
    assert c("nu:3") == "nǚ"
    assert c("ma5") == "ma"            # neutral tone → no mark
    assert c("Zhong1 guo2") == "Zhōng guó"   # proper-noun capitalization kept
    assert c("jiu3") == "jiǔ"          # iu → mark the u
    assert c("gui4") == "guì"          # ui → mark the i
    assert c("") == "" and c(None) is None


def test_zh_reading_served_with_tone_marks(mem_store):
    # The store must convert CC-CEDICT's numbered Pinyin before it reaches a card.
    mem_store.add("zh", "你好", "ni3 hao3", [{"gloss": ["hello"]}], source="cc-cedict")
    assert mem_store.lookup("zh", ["你好"])["你好"].reading == "nǐ hǎo"


def test_ja_reading_not_touched_by_pinyin_conversion(mem_store):
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    assert mem_store.lookup("ja", ["食べる"])["食べる"].reading == "たべる"


def test_clean_gloss_pinyin_unit():
    from loom_api.dictionary import clean_gloss_pinyin as g
    assert g("variant of 逼格[bi1 ge2]") == "variant of 逼格[bī gé]"
    assert g("CL:個|个[ge4]") == "CL:個|个[gè]"
    assert g("plain [no pinyin here]") == "plain [no pinyin here]"  # left alone


def test_zh_gloss_crossref_pinyin_marked(mem_store):
    mem_store.add("zh", "B格", "bi1 ge2", [{"gloss": ["variant of 逼格[bi1 ge2]"]}],
                  source="cc-cedict")
    d = mem_store.lookup("zh", ["B格"])["B格"]
    assert d.senses[0].gloss[0] == "variant of 逼格[bī gé]"


# --------------------------------------------------------------------------- #
# Route: POST /define/batch
# --------------------------------------------------------------------------- #

def test_route_preserves_order_and_duplicates(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    resp = handler(Req(lang="ja", words=["食べる", "未収録", "食べる"]))
    assert resp.lang == "ja"
    assert [r.word for r in resp.results] == ["食べる", "未収録", "食べる"]
    assert [r.found for r in resp.results] == [True, False, True]
    assert resp.results[0].senses[0].gloss == ["to eat"]


def test_route_lowercases_lang(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("ja", "犬", "いぬ", [{"gloss": ["dog"]}], source="jmdict")
    assert handler(Req(lang="JA", words=["犬"])).results[0].found


def test_route_nfc_normalizes_query(mem_store, define_handler):
    handler, Req = define_handler
    composed = "ぱ"  # single NFC codepoint
    mem_store.add("ja", unicodedata.normalize("NFC", composed), "ぱ", [{"gloss": ["pa"]}], source="jmdict")
    resp = handler(Req(lang="ja", words=[unicodedata.normalize("NFD", composed)]))
    assert resp.results[0].found


def test_route_failsoft_on_null_store(define_handler):
    handler, Req = define_handler
    set_dictionary_store(NullDictionaryStore())
    try:
        resp = handler(Req(lang="ja", words=["食べる"]))
        assert resp.results[0].found is False
        assert resp.results[0].senses == []
    finally:
        set_dictionary_store(None)


# --------------------------------------------------------------------------- #
# Capabilities — per-source gloss availability (Dictionary-language picker)
# --------------------------------------------------------------------------- #

def test_capabilities_per_source_gloss_map(mem_store):
    mem_store.add("ja", "猫", "ねこ", [{"gloss": ["cat"]}], source="jmdict")
    mem_store.add("ja", "猫", "ねこ", [{"gloss": ["Katze"]}], source="jmdict", gloss_lang="de")
    mem_store.add("es", "gato", None, [{"gloss": ["cat"]}], source="wiktextract")
    caps = mem_store.capabilities()
    assert set(caps.source_langs) == {"ja", "es"}
    assert set(caps.gloss_langs) == {"en", "de"}
    # ja has both en + de definitions; es only en.
    assert set(caps.gloss_langs_by_source["ja"]) == {"en", "de"}
    assert set(caps.gloss_langs_by_source["es"]) == {"en"}


def test_null_store_has_empty_gloss_map():
    assert NullDictionaryStore().capabilities().gloss_langs_by_source == {}


def test_capabilities_route_exposes_per_source_map(mem_store):
    from loom_api.routes.define import define_capabilities
    mem_store.add("ja", "猫", "ねこ", [{"gloss": ["cat"]}], source="jmdict")
    mem_store.add("ja", "猫", "ねこ", [{"gloss": ["Katze"]}], source="jmdict", gloss_lang="de")
    resp = define_capabilities()
    assert resp.version >= 2
    assert "ja" in resp.gloss_langs_by_source
    assert set(resp.gloss_langs_by_source["ja"]) == {"en", "de"}
    # The per-source map is filtered to token-supported source langs only, so
    # every key is also a definable source lang.
    assert set(resp.gloss_langs_by_source).issubset(set(resp.source_langs))


# --------------------------------------------------------------------------- #
# Cost guards (2026-07 hardening) — fail-soft, never 422 a positional batch
# --------------------------------------------------------------------------- #

def test_oversized_word_is_failsoft_not_crash(mem_store, define_handler):
    # A "word" longer than any real headword yields zero candidate keys →
    # no lookup, found=false — and the rest of the batch is unaffected.
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    resp = handler(Req(lang="ja", words=["あ" * 5000, "食べる"]))
    assert resp.results[0].found is False
    assert resp.results[1].found is True


def test_alt_keys_beyond_cap_are_ignored(mem_store, define_handler):
    from loom_api.routes.define import _MAX_ALT_KEYS
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    # The real key parked just past the cap → not tried.
    padded = [f"junk{i}" for i in range(_MAX_ALT_KEYS)] + ["食べる"]
    resp = handler(Req(lang="ja", words=["みつからない"], alt_keys=[padded]))
    assert resp.results[0].found is False
    # Same key inside the cap → tried and found.
    resp = handler(Req(lang="ja", words=["みつからない"], alt_keys=[["食べる"]]))
    assert resp.results[0].found is True


def test_oversized_candidate_key_skipped_not_queried(mem_store, define_handler):
    from loom_api.routes.define import _candidates
    long_key = "き" * 100
    assert _candidates(long_key, None) == []
    assert _candidates("食べる", [long_key]) == ["食べる"]


def test_oversized_surface_never_reaches_analyzer(mem_store, define_handler, monkeypatch):
    # An implausibly long surface must not reach MeCab.  `grammar is None`
    # alone can't discriminate (analyze_grammar returns None for garbage and
    # the fail-soft catch swallows raises), so spy on the analyzer itself:
    # NOT called for the oversized surface, called for the normal control.
    import loom_api.routes.define as define_mod
    calls = []

    def spy(surface, lang, continuation=""):
        calls.append((surface, continuation))
        return None

    monkeypatch.setattr(define_mod, "analyze_grammar", spy)
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")

    resp = handler(Req(lang="ja", words=["食べる"], surfaces=["あ" * 1000]))
    assert resp.results[0].found is True and resp.results[0].grammar is None
    assert calls == []  # oversized surface: analyzer never invoked

    handler(Req(lang="ja", words=["食べる"], surfaces=["食べた"]))
    assert len(calls) == 1 and calls[0][0] == "食べた"  # positive control


def test_oversized_continuation_arrives_sliced(mem_store, define_handler, monkeypatch):
    # The continuation (next cue's lead) is attacker-length; it must reach
    # the analyzer sliced to _MAX_SURFACE_LENGTH, never whole.
    import loom_api.routes.define as define_mod
    from loom_api.routes.define import _MAX_SURFACE_LENGTH
    seen = []

    def spy(surface, lang, continuation=""):
        seen.append(continuation)
        return None

    monkeypatch.setattr(define_mod, "analyze_grammar", spy)
    handler, Req = define_handler
    handler(Req(lang="ja", words=["食べ"], surfaces=["食べ"],
                surface_continuations=["て" * 10_000]))
    assert len(seen) == 1 and len(seen[0]) == _MAX_SURFACE_LENGTH


def test_oversized_primary_with_valid_alt_still_resolves(mem_store, define_handler):
    # The length skip is PER-KEY, not per-item: a garbage-long lemma with a
    # sane surface alternate must still resolve via the alternate — the
    # sharpest pin of "caps never reject legitimate traffic".
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    resp = handler(Req(lang="ja", words=["あ" * 100], alt_keys=[["食べる"]]))
    assert resp.results[0].found is True
    assert resp.results[0].senses[0].gloss == ["to eat"]


def test_oversized_reading_skips_romaji(mem_store, define_handler):
    handler, Req = define_handler
    mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
    resp = handler(Req(lang="ja", words=["食べる"], readings=["あ" * 1000]))
    assert resp.results[0].found is True
    assert resp.results[0].romaji is None


def test_aligned_list_length_caps_are_validated(define_handler):
    import pydantic
    import pytest as _pytest
    from loom_api.routes.define import _MAX_WORDS
    _, Req = define_handler
    with _pytest.raises(pydantic.ValidationError):
        Req(lang="ja", words=["犬"], readings=["いぬ"] * (_MAX_WORDS + 1))


# --------------------------------------------------------------------------- #
# /define/batch language normalization.
#
# Every other route canonicalizes its lang code; define only did .strip().lower()
# and passed that straight into WHERE lang = %s.  Rows are stored under 'ja'/'zh',
# so a caller sending 'ja-JP', 'jpn' or 'zh-Hant' got 200 OK with every word
# found:false — indistinguishable from "not in the dictionary" — plus no ZH
# decomposition and no JA honorific peel, since those branch on lang == "zh"/"ja".
# The extension normalizes client-side (define-lang.ts), so this is latent there
# but live for the Loom Player, the web app and any direct caller.
# --------------------------------------------------------------------------- #

class TestDefineLangNormalization:
    def test_region_variant_resolves(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("ja", "猫", "ねこ", [{"gloss": ["cat"]}], source="jmdict")
        r = handler(Req(lang="ja-JP", words=["猫"])).results[0]
        assert r.found is True and r.senses[0].gloss == ["cat"]

    def test_iso639_2_alias_resolves(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("ja", "猫", "ねこ", [{"gloss": ["cat"]}], source="jmdict")
        assert handler(Req(lang="jpn", words=["猫"])).results[0].found is True

    def test_chinese_script_variants_resolve_to_zh(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("zh", "猫", "māo", [{"gloss": ["cat"]}], source="cc-cedict")
        for code in ("zh-Hant", "zh-CN", "cmn", "zh-TW"):
            assert handler(Req(lang=code, words=["猫"])).results[0].found is True, code

    def test_zh_decomposition_survives_a_variant_code(self, mem_store, define_handler):
        """The lang-gated branches must see the canonical code too."""
        handler, Req = define_handler
        mem_store.add("zh", "一", "yī", [{"gloss": ["one"]}], source="cc-cedict")
        mem_store.add("zh", "顶", "dǐng", [{"gloss": ["MW"]}], source="cc-cedict")
        r = handler(Req(lang="zh-Hans", words=["一顶"])).results[0]
        assert [p.word for p in r.parts] == ["一", "顶"]

    def test_canonical_codes_unchanged(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("ko", "사람", None, [{"gloss": ["person"]}], source="krdict")
        assert handler(Req(lang="ko", words=["사람"])).results[0].found is True


# --------------------------------------------------------------------------- #
# The reading-column match is a JAPANESE rule (H-8).
#
# "Query headword OR reading" exists because a kana-written Japanese word
# (たべる) lives in the reading column of the 食べる row.  Applied to every
# language it merged HOMOPHONES: KRDict stores the hangul pronunciation (남우
# "actor" is read 나무, so 나무 "tree" also showed "actor"; 동물 "animal" showed
# 독물 "poison"), and Wiktextract stores bare IPA (French des is read /de/, so
# `de` "of" absorbed the plural-article senses of des — and, with des's row
# first, answered "an, a" with a plural-of-un grammar pill).
# --------------------------------------------------------------------------- #

class TestReadingMatchIsJapaneseOnly:
    def test_korean_homophone_is_not_merged(self, mem_store):
        mem_store.add("ko", "나무", "나무", [{"gloss": ["tree"]}], source="krdict")
        mem_store.add("ko", "남우", "나무", [{"gloss": ["actor"]}], source="krdict")
        d = mem_store.lookup("ko", ["나무"])["나무"]
        assert [s.gloss for s in d.senses] == [("tree",)]

    def test_korean_pronunciation_alone_does_not_hit(self, mem_store):
        mem_store.add("ko", "독물", "동물", [{"gloss": ["poison"]}], source="krdict")
        assert mem_store.lookup("ko", ["동물"]) == {}

    def test_wiktextract_ipa_reading_does_not_merge_homophones(
            self, mem_store, define_handler):
        handler, Req = define_handler
        # Row order des-first is the one that answered "an, a" for `de`.
        mem_store.add("fr", "des", "de",
                      [{"gloss": ["plural of un"], "misc": ["form-of", "plural"]}],
                      source="wiktextract")
        mem_store.add("fr", "de", "də", [{"gloss": ["of"]}], source="wiktextract")
        mem_store.add("fr", "un", "œ̃", [{"gloss": ["an, a"]}], source="wiktextract")
        r = handler(Req(lang="fr", words=["de"])).results[0]
        assert [s.gloss for s in r.senses] == [["of"]]
        assert r.grammar is None

    def test_chinese_reading_is_not_a_query_key(self, mem_store):
        mem_store.add("zh", "好", "hao3", [{"gloss": ["good"]}], source="cc-cedict")
        assert mem_store.lookup("zh", ["hao3"]) == {}

    def test_japanese_kana_query_still_hits_reading(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("ja", "食べる", "たべる", [{"gloss": ["to eat"]}], source="jmdict")
        r = handler(Req(lang="ja", words=["たべる"])).results[0]
        assert r.found is True and r.senses[0].gloss == ["to eat"]


# --------------------------------------------------------------------------- #
# A bad simplemma lemma must not beat a correct SURFACE entry (H-9).
#
# The card sends words=[lemma], alt_keys=[[surface]], surfaces=[surface] and
# the first key that hits wins — so for the Wiktextract (generic-path)
# languages a wrong lemma won outright: es eres→ere "the letter R", fr te/me→le
# "the", fr notre/votre/nos/vos/leur/mes/ses→son "sound", es se→él "he".  The
# route now reads the SURFACE's own entry first and only takes the lemma when
# Wiktionary itself links the surface to it (a form-of sense naming it).
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("gloss,target", [
    # the gloss delimits the target — keep it, minus the delimiter
    ("second-person singular present indicative of ser; you are", "ser"),
    ("nominative/accusative neuter singular of der: the", "der"),
    ("first-person singular present indicative of essere: (I) am, I'm", "essere"),
    # single-word tail, with or without a trailing parenthetical / colon
    ("third-person plural preterite indicative of comer", "comer"),
    ("third-person singular present indicative of haber (“there is, there are”)", "haber"),
    ("inflection of करना (karnā):", "करना"),
    ("masculine singular past indicative imperfective of чита́ть", "читать"),
    # run-on tails that still delimit the target
    ("first-person singular present indicative of avere and (obsolete) havere", "avere"),
    ("feminine singular of un (“a / an”), the feminine indefinite article", "un"),
    # run-on prose / multi-word lemma — the first word is NOT the target
    ("form of the article i (“the”) used before a vowel, impure s, gn", None),
    ("plural of de la (“some”, the plural partitive article)", None),
    ("you", None),
])
def test_form_of_target_shapes(gloss, target):
    from loom_api.routes.define import _form_of_target
    assert _form_of_target(gloss) == target


def _card(handler, Req, lang, lemma, surface):
    """Exactly the request definition-card.tsx sends on a click."""
    return handler(Req(lang=lang, words=[lemma], alt_keys=[[surface]],
                       surfaces=[surface], readings=[""])).results[0]


def _fo(gloss, *tags):
    return {"gloss": [gloss], "pos": ["verb"], "misc": ["form-of", *tags]}


class TestSurfaceBeatsBadLemma:
    def test_es_eres_resolves_its_own_form_of_not_letter_r(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("es", "ere", "ˈeɾe",
                      [{"gloss": ["The name of the Latin script letter R/r."]}],
                      source="wiktextract")
        # Real kaikki shape: the verb sense first, and a "plural of ere" noun
        # sense that DOES name the (wrong) lemma — the first sense decides.
        mem_store.add("es", "eres", "ˈeɾes", [
            _fo("second-person singular present indicative of ser; you are",
                "indicative", "present", "second-person", "singular"),
            {"gloss": ["plural of ere"], "pos": ["noun"],
             "misc": ["feminine", "form-of", "plural"]},
        ], source="wiktextract")
        mem_store.add("es", "ser", "ˈseɾ",
                      [{"gloss": ["to be (essentially or identified as)"]}],
                      source="wiktextract")
        r = _card(handler, Req, "es", "ere", "eres")
        assert r.found is True
        assert r.senses[0].gloss == ["to be (essentially or identified as)"]
        assert r.grammar is not None and r.grammar.dict_form == "ser"
        assert {f.code for f in r.grammar.features} >= {"second-person", "singular"}

    def test_fr_te_standalone_surface_beats_lemma_le(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("fr", "le", "lə", [{"gloss": ["the (definite article)"]}],
                      source="wiktextract")
        mem_store.add("fr", "te", "tə", [{"gloss": ["you"]}, {"gloss": ["yourself"]}],
                      source="wiktextract")
        r = _card(handler, Req, "fr", "le", "te")
        assert r.senses[0].gloss == ["you"]
        assert r.word == "le"            # the primary key is still echoed back

    def test_fr_notre_is_our_not_sound(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("fr", "son", "sɔ̃", [{"gloss": ["sound"]}], source="wiktextract")
        mem_store.add("fr", "notre", "nɔtʁ", [{"gloss": ["our"]}], source="wiktextract")
        assert _card(handler, Req, "fr", "son", "notre").senses[0].gloss == ["our"]

    def test_fr_nos_resolves_form_of_target_with_trailing_punctuation(
            self, mem_store, define_handler):
        # extract_form_of_lemma leaves "notre;" for "plural of notre; our"; the
        # route must still resolve it.
        handler, Req = define_handler
        mem_store.add("fr", "son", "sɔ̃", [{"gloss": ["sound"]}], source="wiktextract")
        mem_store.add("fr", "nos", "no", [
            {"gloss": ["plural of notre; our"], "pos": ["determiner"],
             "misc": ["form-of", "plural"]}], source="wiktextract")
        mem_store.add("fr", "notre", "nɔtʁ", [{"gloss": ["our"]}], source="wiktextract")
        r = _card(handler, Req, "fr", "son", "nos")
        assert r.senses[0].gloss == ["our"]
        assert r.grammar is not None and r.grammar.dict_form == "notre"

    def test_fr_est_keeps_lemma_etre_and_gains_grammar(self, mem_store, define_handler):
        # "est" is also a headword ("east"), but Wiktionary links it to être —
        # so the lemma is trusted, and the linking sense supplies the grammar.
        handler, Req = define_handler
        mem_store.add("fr", "être", "ɛtʁ", [{"gloss": ["to be"]}], source="wiktextract")
        mem_store.add("fr", "est", "ɛ", [
            {"gloss": ["east"], "pos": ["adjective"]},
            _fo("third-person singular present indicative of être",
                "indicative", "present", "singular", "third-person"),
        ], source="wiktextract")
        r = _card(handler, Req, "fr", "être", "est")
        assert r.senses[0].gloss == ["to be"]
        assert r.grammar is not None and r.grammar.dict_form == "être"
        assert {f.code for f in r.grammar.features} >= {"third-person", "present"}

    def test_pt_sao_links_lemma_through_a_later_sense(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("pt", "ser", "ˈseɾ", [{"gloss": ["to be"]}], source="wiktextract")
        mem_store.add("pt", "são", "ˈsɐ̃w̃", [
            {"gloss": ["sound, healthy"], "pos": ["adjective"]},
            _fo("third-person plural present indicative of ser",
                "indicative", "plural", "present", "third-person"),
        ], source="wiktextract")
        r = _card(handler, Req, "pt", "ser", "são")
        assert r.senses[0].gloss == ["to be"]
        assert r.grammar is not None and r.grammar.dict_form == "ser"

    def test_first_sense_form_of_the_lemma_attaches_grammar(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("es", "comer", "koˈmeɾ", [{"gloss": ["to eat"]}], source="wiktextract")
        mem_store.add("es", "comieron", "komˈjeɾon", [
            _fo("third-person plural preterite indicative of comer",
                "indicative", "plural", "preterite", "third-person")],
            source="wiktextract")
        r = _card(handler, Req, "es", "comer", "comieron")
        assert r.senses[0].gloss == ["to eat"]
        assert r.grammar is not None and r.grammar.dict_form == "comer"
        assert "preterite" in {f.code for f in r.grammar.features}

    def test_surface_without_entry_keeps_lemma(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("es", "comer", "koˈmeɾ", [{"gloss": ["to eat"]}], source="wiktextract")
        r = _card(handler, Req, "es", "comer", "comieron")
        assert r.found is True and r.senses[0].gloss == ["to eat"]
        assert r.grammar is None

    def test_sentence_initial_surface_uses_lowercase_fallback(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("fr", "le", "lə", [{"gloss": ["the (definite article)"]}],
                      source="wiktextract")
        mem_store.add("fr", "te", "tə", [{"gloss": ["you"]}], source="wiktextract")
        assert _card(handler, Req, "fr", "le", "Te").senses[0].gloss == ["you"]

    def test_surface_equal_to_lemma_is_unchanged(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("es", "casa", "ˈkasa", [{"gloss": ["house"]}], source="wiktextract")
        r = _card(handler, Req, "es", "casa", "casa")
        assert r.senses[0].gloss == ["house"] and r.grammar is None

    def test_no_surfaces_field_keeps_lemma_first(self, mem_store, define_handler):
        # Callers that don't send `surfaces` keep the documented contract:
        # the primary key is tried first.
        handler, Req = define_handler
        mem_store.add("fr", "le", "lə", [{"gloss": ["the (definite article)"]}],
                      source="wiktextract")
        mem_store.add("fr", "te", "tə", [{"gloss": ["you"]}], source="wiktextract")
        r = handler(Req(lang="fr", words=["le"], alt_keys=[["te"]])).results[0]
        assert r.senses[0].gloss == ["the (definite article)"]

    def test_prose_form_of_gloss_is_not_followed(self, mem_store, define_handler):
        # it "gli": "form of the article i (“the”) used before a vowel …" —
        # extract_form_of_lemma's run-on fallback yields the ENGLISH word
        # "the", and Italian Wiktionary has "the" = "misspelling of tè".  The
        # surface IS a form-of, but of what can't be read — so it can't be
        # shown to be unrelated to the lemma, and the lemma (il "the") stands.
        handler, Req = define_handler
        mem_store.add("it", "il", "il", [{"gloss": ["the"]}], source="wiktextract")
        mem_store.add("it", "the", "tɛ", [
            {"gloss": ["misspelling of tè"], "misc": ["form-of", "misspelling"]}],
            source="wiktextract")
        mem_store.add("it", "gli", "ʎi", [
            {"gloss": ["form of the article i (“the”) used before a vowel, impure s, "
                       "gn, pn, ps, x and z"], "pos": ["article"],
             "misc": ["form-of", "masculine", "plural"]},
            {"gloss": ["him, to him; it; to it"], "pos": ["pronoun"]},
        ], source="wiktextract")
        r = _card(handler, Req, "it", "il", "gli")
        assert "tè" not in r.senses[0].gloss[0]
        assert r.senses[0].gloss == ["the"]

    def test_run_on_target_joined_by_a_conjunction_resolves(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("it", "avere", "aˈve.re", [{"gloss": ["to have"]}], source="wiktextract")
        mem_store.add("it", "ho", "ɔ", [
            _fo("first-person singular present indicative of avere and (obsolete) havere",
                "first-person", "indicative", "present", "singular")],
            source="wiktextract")
        r = _card(handler, Req, "it", "avere", "ho")
        assert r.senses[0].gloss == ["to have"]
        assert r.grammar is not None and r.grammar.dict_form == "avere"

    def test_japanese_lemma_still_wins(self, mem_store, define_handler):
        # MeCab's lemma is a real morphological analysis — never second-guessed.
        handler, Req = define_handler
        mem_store.add("ja", "見る", "みる", [{"gloss": ["to see"]}], source="jmdict")
        mem_store.add("ja", "見た", "みた", [{"gloss": ["WRONG surface entry"]}], source="jmdict")
        r = _card(handler, Req, "ja", "見る", "見た")
        assert r.senses[0].gloss == ["to see"]

    def test_korean_lemma_still_wins(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("ko", "먹다", None, [{"gloss": ["eat"]}], source="krdict")
        mem_store.add("ko", "먹었어요", None, [{"gloss": ["WRONG surface entry"]}], source="krdict")
        r = _card(handler, Req, "ko", "먹다", "먹었어요")
        assert r.senses[0].gloss == ["eat"]


# --------------------------------------------------------------------------- #
# The surface may only override the lemma on POSITIVE, READABLE evidence.
#
# Three review findings against the first cut of H-9, each a way the surface
# entry beat a CORRECT lemma and put a confidently wrong answer on the card:
#
# - Sentence-initial capitals.  simplemma lowercases (May → may), the card sends
#   the capitalized surface, and Wiktextract is full of capitalized homographs
#   — months, surnames, villages, "honorific alternative letter-case form of".
#   Measured (real kaikki rows, English line-initial words): 27/60 first
#   glosses turned wrong — "May I come in?" → "The fifth month …".
# - Peeled elision clitics.  l'/qu'/d' look up le/que/de through a CURATED
#   table (012dfb1), not simplemma; the surface is a bare letter whose entry
#   ("The twelfth letter of the French alphabet") is exactly what 012dfb1
#   removed from 7.4% of French tokens.
# - Native-edition gloss columns (gloss_lang=es is live).  Their form-of
#   glosses are written in the gloss language ("… de comer."), which the
#   English " of " parser cannot read — so an inflected form looked like a
#   standalone headword and its pointer gloss replaced the lemma's meaning.
# --------------------------------------------------------------------------- #

class TestSurfaceOverrideGuards:
    def test_en_capitalized_homograph_does_not_beat_case_only_lemma(
            self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("en", "May", "/meɪ/",
                      [{"gloss": ["The fifth month of the Gregorian calendar"]}],
                      source="wiktextract")
        mem_store.add("en", "may", "/meɪ/", [{"gloss": ["To be able; can."]}],
                      source="wiktextract")
        r = _card(handler, Req, "en", "may", "May")
        assert r.senses[0].gloss == ["To be able; can."]

    def test_de_capitalized_pronoun_keeps_its_lemma(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("de", "Ich", "/ɪç/", [{"gloss": ["ego"]}], source="wiktextract")
        mem_store.add("de", "ich", "/ɪç/", [{"gloss": ["I"]}], source="wiktextract")
        assert _card(handler, Req, "de", "ich", "Ich").senses[0].gloss == ["I"]

    def test_en_capitalized_surface_whose_lowercase_links_the_lemma(
            self, mem_store, define_handler):
        # "Is" (lemma be): the capitalized entry is "plural of I", but the
        # lowercase entry names be — Wiktionary DOES relate the surface to the
        # lemma, so the lemma stands (and gains that sense's grammar).
        handler, Req = define_handler
        mem_store.add("en", "be", "/biː/", [{"gloss": ["To exist; to have real existence."]}],
                      source="wiktextract")
        mem_store.add("en", "Is", "/aɪz/", [
            {"gloss": ["plural of I"], "pos": ["noun"], "misc": ["form-of", "plural"]}],
            source="wiktextract")
        mem_store.add("en", "I", "/aɪ/",
                      [{"gloss": ["The ninth letter of the English alphabet."]}],
                      source="wiktextract")
        mem_store.add("en", "is", "/ɪz/", [
            _fo("third-person singular simple present indicative of be",
                "indicative", "present", "singular", "third-person")],
            source="wiktextract")
        r = _card(handler, Req, "en", "be", "Is")
        assert r.senses[0].gloss == ["To exist; to have real existence."]
        assert r.grammar is not None and r.grammar.dict_form == "be"

    def test_capitalized_surface_prefers_its_lowercase_entry(self, mem_store, define_handler):
        # it "La" (line-initial; simplemma lemma il): neither entry links to
        # il, and the capitalized headword is an "alternative letter-case
        # form" pointer — the lowercase article entry is the word on screen.
        handler, Req = define_handler
        mem_store.add("it", "il", "/il/", [{"gloss": ["the"]}], source="wiktextract")
        mem_store.add("it", "La", "/la/", [{"gloss": ["alternative letter-case form of la (“you”)"],
                                            "misc": ["alt-of", "alternative"]}],
                      source="wiktextract")
        mem_store.add("it", "la", "/la/", [{"gloss": ["the (feminine singular definite article)"]}],
                      source="wiktextract")
        r = _card(handler, Req, "it", "il", "La")
        assert r.senses[0].gloss == ["the (feminine singular definite article)"]

    @pytest.mark.parametrize("text,surface,lemma", [
        ("l'école", "l", "le"),
        ("L'école est fermée", "L", "le"),
        ("qu'il vient", "qu", "que"),
        ("s'il vous plaît", "s", "si"),
    ])
    def test_fr_peeled_clitic_keeps_its_curated_lemma(
            self, mem_store, define_handler, text, surface, lemma):
        from loom_core.romanize import _generic_tokens
        handler, Req = define_handler
        tok = _generic_tokens(text, "fr")[0]
        assert (tok[0], tok[1]) == (surface, lemma)   # what the client sends
        mem_store.add("fr", "l", "/ɛl/", [{"gloss": [
            "The twelfth letter of the French alphabet, written in the Latin script."]}],
            source="wiktextract")
        mem_store.add("fr", "qu", "/ky/", [
            {"gloss": ["alternative spelling of ku"], "misc": ["alt-of", "alternative"]}],
            source="wiktextract")
        mem_store.add("fr", "s", "/ɛs/", [{"gloss": [
            "The nineteenth letter of the French alphabet, written in the Latin script."]}],
            source="wiktextract")
        mem_store.add("fr", "le", "/lə/", [{"gloss": ["the (definite article)"]}],
                      source="wiktextract")
        mem_store.add("fr", "que", "/kə/", [{"gloss": ["that"]}], source="wiktextract")
        mem_store.add("fr", "si", "/si/", [{"gloss": ["if, whether"]}], source="wiktextract")
        r = _card(handler, Req, "fr", tok[1], tok[0])
        assert "letter" not in r.senses[0].gloss[0]
        assert "ku" not in r.senses[0].gloss[0]
        assert r.senses[0].gloss == list(mem_store.lookup("fr", [lemma])[lemma].senses[0].gloss)

    def test_it_peeled_clitic_keeps_its_curated_lemma(self, mem_store, define_handler):
        from loom_core.romanize import _generic_tokens
        handler, Req = define_handler
        tok = _generic_tokens("l'amico", "it")[0]
        assert (tok[0], tok[1]) == ("l", "il")
        mem_store.add("it", "l", "/ɛl.le/", [{"gloss": [
            "The tenth letter of the Italian alphabet, called elle."]}], source="wiktextract")
        mem_store.add("it", "il", "/il/", [{"gloss": ["the"]}], source="wiktextract")
        assert _card(handler, Req, "it", tok[1], tok[0]).senses[0].gloss == ["the"]

    def test_native_gloss_column_form_of_keeps_the_lemma(self, mem_store, define_handler):
        # Real eswiktionary shape (gloss_lang=es, live in prod): tagged form-of,
        # but the gloss is Spanish, so its target can't be read.
        handler, Req = define_handler
        mem_store.add("es", "comer", "koˈmeɾ", [{"gloss": ["Ingerir o tomar alimentos."]}],
                      source="wiktextract", gloss_lang="es")
        mem_store.add("es", "comieron", "koˈmjeɾon", [
            {"gloss": ["Tercera persona del plural (ellos, ellas; ustedes) del pretérito "
                       "perfecto simple de indicativo de comer."],
             "pos": ["verb"], "misc": ["form-of"]}],
            source="wiktextract", gloss_lang="es")
        r = handler(Req(lang="es", gloss_lang="es", words=["comer"], alt_keys=[["comieron"]],
                        surfaces=["comieron"], readings=[""])).results[0]
        assert r.senses[0].gloss == ["Ingerir o tomar alimentos."]

    def test_native_gloss_column_untagged_pointer_keeps_the_lemma(
            self, mem_store, define_handler):
        # A native-edition row need not carry the form-of tag at all; nothing
        # in a non-English gloss can be read as "unrelated to the lemma".
        handler, Req = define_handler
        mem_store.add("es", "ser", "ˈseɾ", [{"gloss": [
            "Tener algo una determinada naturaleza, condición o identidad."]}],
            source="wiktextract", gloss_lang="es")
        mem_store.add("es", "soy", "ˈsoj", [{"gloss": [
            "Primera persona del singular (yo) del presente de indicativo de ser."],
            "pos": ["verb"]}], source="wiktextract", gloss_lang="es")
        r = handler(Req(lang="es", gloss_lang="es", words=["ser"], alt_keys=[["soy"]],
                        surfaces=["soy"], readings=[""])).results[0]
        assert r.senses[0].gloss[0].startswith("Tener algo")

    def test_english_fallback_rows_still_get_the_fix_for_other_gloss_langs(
            self, mem_store, define_handler):
        # The gate is the language the surface's glosses are ACTUALLY in, not
        # the requested one: a word with no Spanish gloss falls back to English
        # per-word, and that English entry is readable.
        handler, Req = define_handler
        mem_store.add("fr", "le", "lə", [{"gloss": ["the (definite article)"]}],
                      source="wiktextract")
        mem_store.add("fr", "te", "tə", [{"gloss": ["you"]}], source="wiktextract")
        r = handler(Req(lang="fr", gloss_lang="es", words=["le"], alt_keys=[["te"]],
                        surfaces=["te"], readings=[""])).results[0]
        assert r.senses[0].gloss == ["you"]

    def test_definition_reports_the_gloss_language_it_was_served_in(self, mem_store):
        mem_store.add("es", "comer", None, [{"gloss": ["to eat"]}], source="wiktextract")
        mem_store.add("es", "comer", None, [{"gloss": ["Ingerir alimentos."]}],
                      source="wiktextract", gloss_lang="es")
        mem_store.add("es", "casa", None, [{"gloss": ["house"]}], source="wiktextract")
        got = mem_store.lookup("es", ["comer", "casa"], "es")
        assert got["comer"].gloss_lang == "es"
        assert got["casa"].gloss_lang == "en"          # per-word English fallback
        assert mem_store.lookup("es", ["comer"])["comer"].gloss_lang == "en"


# --------------------------------------------------------------------------- #
# Surface-vs-lemma grammar: show only what every reading agrees on
# --------------------------------------------------------------------------- #

def _noun_fo(gloss, *tags):
    return {"gloss": [gloss], "pos": ["noun"], "misc": ["form-of", *tags]}


class TestSurfaceGrammarIsShared:
    """The grammar pill is context-free, so a surface that inflects the lemma
    several ways may only show the grammar those readings share (real kaikki
    shapes; before this, "They were" showed second-person singular and "It
    flies away" showed the noun's plural)."""

    def test_en_were_shows_only_the_shared_tense(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("en", "be", "biː", [{"gloss": ["to exist"]}], source="wiktextract")
        mem_store.add("en", "were", "wɜː", [
            _fo("second-person singular simple past indicative of be",
                "indicative", "past", "second-person", "singular"),
            _fo("plural simple past indicative of be", "indicative", "past", "plural"),
        ], source="wiktextract")
        r = _card(handler, Req, "en", "be", "were")
        assert r.senses[0].gloss == ["to exist"]
        assert r.grammar is not None and r.grammar.dict_form == "be"
        assert [f.code for f in r.grammar.features] == ["past", "indicative"]

    def test_en_flies_noun_and_verb_readings_show_no_pill(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("en", "fly", "flaɪ", [{"gloss": ["an insect"]}], source="wiktextract")
        mem_store.add("en", "flies", "flaɪz", [
            _noun_fo("plural of fly", "plural"),
            _fo("third-person singular simple present indicative of fly",
                "indicative", "present", "singular", "third-person"),
        ], source="wiktextract")
        r = _card(handler, Req, "en", "fly", "flies")
        assert r.senses[0].gloss == ["an insect"]
        assert r.grammar is None

    def test_en_leaves_noun_verb_homograph_keeps_the_lemma(self, mem_store, define_handler):
        # First sense inflects a DIFFERENT word (leaf) but a later VERB sense
        # names the lemma: genuinely ambiguous, so keep HEAD's lemma answer.
        handler, Req = define_handler
        mem_store.add("en", "leaf", "liːf", [{"gloss": ["green organ of a plant"]}],
                      source="wiktextract")
        mem_store.add("en", "leave", "liːv", [{"gloss": ["to depart"]}], source="wiktextract")
        mem_store.add("en", "leaves", "liːvz", [
            _noun_fo("plural of leaf", "plural"),
            _fo("third-person singular simple present indicative of leave",
                "indicative", "present", "singular", "third-person"),
        ], source="wiktextract")
        r = _card(handler, Req, "en", "leave", "leaves")
        assert r.senses[0].gloss == ["to depart"]
        assert r.grammar is not None and r.grammar.dict_form == "leave"

    def test_single_reading_keeps_its_full_grammar(self, mem_store, define_handler):
        handler, Req = define_handler
        mem_store.add("es", "comer", "koˈmeɾ", [{"gloss": ["to eat"]}], source="wiktextract")
        mem_store.add("es", "comieron", "komiˈeɾon", [
            _fo("third-person plural preterite indicative of comer",
                "indicative", "plural", "preterite", "third-person"),
        ], source="wiktextract")
        # Surface ≠ lemma, so the surface entry is consulted; its one sense
        # names the lemma, so nothing is intersected away.
        r = _card(handler, Req, "es", "comer", "comieron")
        assert r.senses[0].gloss == ["to eat"]
        assert {f.code for f in r.grammar.features} == {
            "preterite", "indicative", "third-person", "plural"}
