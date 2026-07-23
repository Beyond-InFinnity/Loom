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
