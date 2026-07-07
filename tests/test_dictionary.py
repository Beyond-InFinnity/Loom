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
