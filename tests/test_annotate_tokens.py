"""Word-level `tokens` on /annotate (VOCAB_LOOKUP.md Phase 0 + Phase 2).

Covers build_word_tokens() — JA morpheme→word merging (verb/aux chains collapse
into one token whose lemma is the head's dictionary form) + contextual reading
(topic は → わ) + lemma cleaning; ZH jieba grouping with exact span alignment
incl. Traditional; unsupported langs → []; punctuation excluded — and the
/annotate/batch route (tokens present on compute AND preserved across the
result-cache round-trip).

Token tuple shape (6): (word, lemma, pos, reading, start, length).
"""
import pytest

from loom_core.romanize import build_word_tokens, get_annotation_func


def _tokens(lang, text, system=None):
    func = get_annotation_func(lang, system)
    spans = func(text)
    toks = build_word_tokens(text, lang, spans, func)
    return spans, toks


def _assert_aligned(spans, toks):
    """Every token's span range must reconstruct exactly its word surface."""
    for word, _lemma, _pos, _reading, start, length in toks:
        covered = "".join(s[0] for s in spans[start:start + length])
        assert covered == word, f"{word!r} != covered {covered!r} at [{start}:{start+length}]"


# --------------------------------------------------------------------------- #
# Japanese
# --------------------------------------------------------------------------- #

def test_ja_tokens_with_lemma_and_pos():
    spans, toks = _tokens("ja", "寿司を食べる")
    _assert_aligned(spans, toks)
    by_word = {t[0]: t for t in toks}
    assert by_word["寿司"][1] == "寿司"          # lemma
    assert by_word["寿司"][2] == ["名詞"]         # pos
    assert by_word["食べる"][1] == "食べる"


def test_ja_lemma_is_dictionary_form_for_inflection():
    # 見た is an inflected form; MeCab over-segments it into 見／た, which the
    # merge mask collapses into one token whose lemma is the dict form 見る.
    _, toks = _tokens("ja", "映画を見た")
    _assert_aligned(_tokens("ja", "映画を見た")[0], toks)
    by_word = {t[0]: t for t in toks}
    assert "見た" in by_word, f"expected merged 見た, got {list(by_word)}"
    assert by_word["見た"][1] == "見る"           # inflected 見た → dict form 見る


def test_ja_verb_chain_merges_to_single_token():
    # 食べさせられた over-segments to 食べ／させ／られ／た; must collapse to ONE
    # clickable token whose lemma is the head's dict form (→ /define hits 食べる).
    spans, toks = _tokens("ja", "食べさせられた")
    _assert_aligned(spans, toks)
    words = [t[0] for t in toks]
    assert words == ["食べさせられた"], words
    assert toks[0][1] == "食べる"                 # head lemma
    assert toks[0][5] == 4                        # spans four morphemes


def test_ja_contextual_reading_topic_ha_becomes_wa():
    # The topic particle は must carry reading わ (matching the romaji line),
    # not its literal kana は.
    _, toks = _tokens("ja", "これは寿司です")
    by_word = {t[0]: t for t in toks}
    assert by_word["は"][3] == "わ", by_word["は"]
    assert by_word["寿司"][3] == "すし"           # kanji token carries its kana reading


def test_ja_lemma_disambiguator_suffix_stripped():
    # UniDic gives 私 the lemma "私-代名詞"; must be cleaned to "私" for JMdict.
    _, toks = _tokens("ja", "私")
    assert toks[0][1] == "私"


def test_ja_punctuation_gets_no_token():
    spans, toks = _tokens("ja", "はい。")
    _assert_aligned(spans, toks)
    assert "。" not in {t[0] for t in toks}


# --------------------------------------------------------------------------- #
# Chinese
# --------------------------------------------------------------------------- #

def test_zh_hans_jieba_word_grouping_aligned():
    spans, toks = _tokens("zh-Hans", "我喜欢吃寿司")
    _assert_aligned(spans, toks)
    words = [t[0] for t in toks]
    assert "喜欢" in words                        # multi-char word grouped
    xh = next(t for t in toks if t[0] == "喜欢")
    assert xh[5] == 2                             # spans two characters
    assert all(t[2] == [] for t in toks)          # ZH carries no POS
    assert all(t[3] is None for t in toks)        # ZH reading None → card uses /define pinyin


def test_zh_hant_traditional_grouping_aligned():
    spans, toks = _tokens("zh-Hant", "我喜歡吃壽司")
    _assert_aligned(spans, toks)                  # boundaries map back onto Traditional
    assert "喜歡" in {t[0] for t in toks}


def test_zh_lemma_equals_word_no_inflection():
    _, toks = _tokens("zh-Hans", "喜欢")
    assert toks[0][1] == toks[0][0]


# --------------------------------------------------------------------------- #
# Unsupported languages (Phase 0)
# --------------------------------------------------------------------------- #

def test_korean_yields_no_tokens():
    _, toks = _tokens("ko", "안녕하세요")
    assert toks == []


def test_thai_yields_no_tokens():
    func = get_annotation_func("th")
    if func is None:
        pytest.skip("thai annotation unavailable")
    spans = func("สวัสดี")
    assert build_word_tokens("สวัสดี", "th", spans, func) == []


# --------------------------------------------------------------------------- #
# Route: tokens through /annotate/batch + cache round-trip
# --------------------------------------------------------------------------- #

@pytest.fixture
def mem_cache():
    from loom_api.deps import set_result_cache
    from loom_api.result_cache import InMemoryResultCache
    cache = InMemoryResultCache()
    set_result_cache(cache)
    yield cache
    set_result_cache(None)


def test_batch_route_emits_tokens_and_survives_cache(mem_cache):
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch

    def toks(resp):
        return [
            (t.word, t.lemma, t.pos, t.reading, t.start, t.length)
            for t in resp.results[0].tokens
        ]

    miss = annotate_batch(AnnotateBatchRequest(texts=["寿司を食べる"], lang_code="ja"))
    assert toks(miss), "expected tokens on compute"
    hit = annotate_batch(AnnotateBatchRequest(texts=["寿司を食べる"], lang_code="ja"))
    assert toks(hit) == toks(miss), "tokens must survive the cache round-trip"


def test_batch_route_preserves_contextual_reading_through_cache(mem_cache):
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch

    def ha_reading(resp):
        return next(t.reading for t in resp.results[0].tokens if t.word == "は")

    miss = annotate_batch(AnnotateBatchRequest(texts=["これは寿司です"], lang_code="ja"))
    assert ha_reading(miss) == "わ"
    hit = annotate_batch(AnnotateBatchRequest(texts=["これは寿司です"], lang_code="ja"))
    assert ha_reading(hit) == "わ", "contextual reading must survive the cache round-trip"


def test_batch_route_empty_text_has_empty_tokens(mem_cache):
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch
    resp = annotate_batch(AnnotateBatchRequest(texts=[""], lang_code="ja"))
    assert resp.results[0].tokens == []
