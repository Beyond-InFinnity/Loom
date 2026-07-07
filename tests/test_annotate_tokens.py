"""Word-level `tokens` on /annotate (VOCAB_LOOKUP.md Phase 0).

Covers build_word_tokens() (JA 1:1 with lemma/POS + lemma cleaning + inflection;
ZH jieba grouping with exact span alignment incl. Traditional; unsupported langs
→ []; punctuation excluded) and the /annotate/batch route (tokens present on
compute AND preserved across the result-cache round-trip).
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
    for word, _lemma, _pos, start, length in toks:
        covered = "".join(s[0] for s in spans[start:start + length])
        assert covered == word, f"{word!r} != covered {covered!r} at [{start}:{start+length}]"


# --------------------------------------------------------------------------- #
# Japanese
# --------------------------------------------------------------------------- #

def test_ja_tokens_one_to_one_with_lemma_and_pos():
    spans, toks = _tokens("ja", "寿司を食べる")
    _assert_aligned(spans, toks)
    by_word = {t[0]: t for t in toks}
    assert by_word["寿司"][1] == "寿司"          # lemma
    assert by_word["寿司"][2] == ["名詞"]         # pos
    assert by_word["食べる"][1] == "食べる"
    assert all(t[4] == 1 for t in toks)          # JA is 1 span : 1 token


def test_ja_lemma_is_dictionary_form_for_inflection():
    _, toks = _tokens("ja", "映画を見た")
    lemmas = {t[0]: t[1] for t in toks}
    assert lemmas["見"] == "見る"                 # inflected 見た → dict form 見る


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
    assert xh[4] == 2                             # spans two characters
    assert all(t[2] == [] for t in toks)          # ZH carries no POS


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
        return [(t.word, t.lemma, t.pos, t.start, t.length) for t in resp.results[0].tokens]

    miss = annotate_batch(AnnotateBatchRequest(texts=["寿司を食べる"], lang_code="ja"))
    assert toks(miss), "expected tokens on compute"
    hit = annotate_batch(AnnotateBatchRequest(texts=["寿司を食べる"], lang_code="ja"))
    assert toks(hit) == toks(miss), "tokens must survive the cache round-trip"


def test_batch_route_empty_text_has_empty_tokens(mem_cache):
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch
    resp = annotate_batch(AnnotateBatchRequest(texts=[""], lang_code="ja"))
    assert resp.results[0].tokens == []
