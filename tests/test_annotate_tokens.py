"""Word-level `tokens` on /annotate (VOCAB_LOOKUP.md Phase 0 + Phase 2).

Covers build_word_tokens() — JA morpheme→word merging (verb/aux chains collapse
into one token whose lemma is the head's dictionary form) + contextual reading
(topic は → わ) + lemma cleaning; ZH jieba grouping with exact span alignment
incl. Traditional; KO kiwipiepy morphology (word grouping + 다-form lemmas, incl.
irregular conjugation with overlapping morpheme spans); unsupported langs → [];
punctuation excluded — and the /annotate/batch route (tokens present on compute
AND preserved across the result-cache round-trip).

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


def test_ja_trailing_ellipsis_stripped_from_word():
    # A merged trailing 補助記号 (…) must not end up in the clickable surface.
    spans, toks = _tokens("ja", "は…")
    _assert_aligned(spans, toks)
    words = [t[0] for t in toks]
    assert words == ["は"], words          # ellipsis dropped, not は…


def test_ja_ellipsis_between_words_keeps_both_clean():
    spans, toks = _tokens("ja", "そうか…")
    _assert_aligned(spans, toks)
    words = [t[0] for t in toks]
    assert "…" not in "".join(words)      # no token carries the ellipsis
    assert "か" in words


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
# Korean (Phase 3 — kiwipiepy)
# --------------------------------------------------------------------------- #

def _kiwi_available() -> bool:
    try:
        from loom_core.romanize import _get_kiwi
        return _get_kiwi() is not None
    except Exception:
        return False


korean = pytest.mark.skipif(not _kiwi_available(), reason="kiwipiepy unavailable")


@korean
def test_ko_word_grouping_and_span_alignment():
    spans, toks = _tokens("ko", "밥을 맛있게 먹었어요")
    _assert_aligned(spans, toks)
    words = [t[0] for t in toks]
    # noun+particle, adverbial adjective, and the verb chain each group as one
    # clickable word.
    assert words == ["밥을", "맛있게", "먹었어요"]


@korean
def test_ko_predicate_lemma_is_dictionary_form():
    # Inflected predicates resolve to their 다 dictionary form (KRDict headword).
    by = {t[0]: t for t in _tokens("ko", "밥을 맛있게 먹었어요")[1]}
    assert by["먹었어요"][1] == "먹다"     # verb
    assert by["맛있게"][1] == "맛있다"     # adjective
    assert by["밥을"][1] == "밥"          # noun: lemma == surface stem


@korean
def test_ko_irregular_conjugation_lemma():
    # ㅂ-irregular (즐겁다) and vowel-contraction (빌리다) — kiwipiepy reports
    # OVERLAPPING morpheme spans here; the tokenizer must still keep one word.
    by = {t[0]: t for t in _tokens("ko", "학교생활이 즐거워요")[1]}
    assert by["즐거워요"][1] == "즐겁다"
    spans, toks = _tokens("ko", "책을 빌렸다")
    _assert_aligned(spans, toks)
    assert {t[0]: t for t in toks}["빌렸다"][1] == "빌리다"


@korean
def test_ko_derived_predicate_lemma():
    # 하다/되다 verbs segment as noun + XSV; the lemma must reconstruct the
    # DERIVED dictionary form (교역하다), which is the KRDict headword, not the
    # bare noun (교역).  Bound roots (깨끗/XR) only exist in the derived form.
    by = {t[0]: t for t in _tokens("ko", "열심히 공부했어요")[1]}
    assert by["공부했어요"][1] == "공부하다"
    by2 = {t[0]: t for t in _tokens("ko", "방이 깨끗하다")[1]}
    assert by2["깨끗하다"][1] == "깨끗하다"


@korean
def test_ko_copula_attaches_to_noun():
    # 학생이에요 → one word, lemma the noun 학생 (copula 이다 is enclitic).
    by = {t[0]: t for t in _tokens("ko", "저는 학생이에요")[1]}
    assert "학생이에요" in by
    assert by["학생이에요"][1] == "학생"


@korean
def test_ko_reading_is_none_card_uses_define():
    _, toks = _tokens("ko", "사람")
    assert toks and toks[0][3] is None


@korean
def test_ko_punctuation_excluded():
    _, toks = _tokens("ko", "안녕!")
    assert all(_lookupable(t[0]) for t in toks)
    assert "!" not in {t[0] for t in toks}


def _lookupable(s: str) -> bool:
    return any(c.isalnum() or ("가" <= c <= "힣") for c in s)


# --------------------------------------------------------------------------- #
# Generic space-delimited path (simplemma) — Spanish
# --------------------------------------------------------------------------- #

def _simplemma_available() -> bool:
    try:
        import simplemma  # noqa: F401
        return True
    except Exception:
        return False


generic = pytest.mark.skipif(not _simplemma_available(), reason="simplemma unavailable")


@generic
def test_es_generic_tokens_word_and_lemma():
    from loom_core.romanize import build_word_tokens
    toks = build_word_tokens("Los niños comieron manzanas", "es", [], None)
    by = {t[0]: t for t in toks}
    # inflected words resolve to their dictionary lemma
    assert by["comieron"][1] == "comer"
    assert by["niños"][1] == "niño"
    assert by["manzanas"][1] == "manzana"
    # offsets reconstruct the surface from the raw text
    for word, _l, _p, _r, start, length in toks:
        assert "Los niños comieron manzanas"[start:start + length] == word


@generic
def test_es_generic_excludes_punctuation_and_numbers():
    from loom_core.romanize import build_word_tokens
    words = {t[0] for t in build_word_tokens("¿Tienes 3 gatos, verdad?", "es", [], None)}
    assert "3" not in words and "¿" not in words and "," not in words
    assert "gatos" in words and "verdad" in words


@generic
def test_es_generic_reading_none_pos_empty():
    from loom_core.romanize import build_word_tokens
    t = build_word_tokens("gato", "es", [], None)[0]
    assert t[3] is None and t[2] == []   # no ruby; card uses dictionary reading/pos


@generic
def test_fr_elision_splits_leading_clitic():
    # l'école is orthographically l' + école — the content word must become its
    # own token so it hits the dictionary (the whole top-misses list otherwise).
    from loom_core.romanize import build_word_tokens
    line = "Je l'ai vu à l'école d'un ami"
    words = [t[0] for t in build_word_tokens(line, "fr", [], None)]
    assert "école" in words and "ai" in words and "un" in words
    # offsets still reconstruct the surface after the split
    for word, _l, _p, _r, start, length in build_word_tokens(line, "fr", [], None):
        assert line[start:start + length] == word


@generic
def test_fr_elision_preserves_genuine_apostrophe_words():
    # aujourd'hui / quelqu'un / presqu'île have stems >2 chars — NOT elisions,
    # must stay whole.
    from loom_core.romanize import build_word_tokens
    words = {t[0] for t in build_word_tokens("Aujourd'hui quelqu'un vint", "fr", [], None)}
    assert "Aujourd'hui" in words and "quelqu'un" in words


def test_generic_keeps_devanagari_matras_in_word():
    # Regression: stdlib \w drops Brahmic dependent vowel signs (matras), so
    # करना truncated to करन and every Devanagari word missed the dictionary.
    # The regex \p{L}\p{M} pattern keeps marks in-word.  Requires the `regex`
    # dep (a hard requirement); skip only in a partial env.
    pytest.importorskip("regex")
    from loom_core.romanize import _generic_tokens
    words = [t[0] for t in _generic_tokens("मुझे यह करना है, मैं नहीं गया", "hi")]
    assert "करना" in words and "नहीं" in words and "गया" in words
    # offsets still reconstruct the surface
    line = "मैं नहीं गया"
    for w, _l, _p, _r, s, ln in _generic_tokens(line, "hi"):
        assert line[s:s + ln] == w


@generic
def test_generic_cyrillic_lemmatizes():
    from loom_core.romanize import build_word_tokens
    by = {t[0]: t[1] for t in build_word_tokens("Кошки едят рыбу", "ru", [], None)}
    assert by.get("Кошки") == "кошка" and by.get("рыбу") == "рыба"


@generic
def test_it_elision_splits_but_es_apostrophe_untouched():
    # Italian elides (l'ho → l + ho); Spanish is not an elision language so any
    # apostrophe there is left alone.
    from loom_core.romanize import build_word_tokens
    it_words = {t[0] for t in build_word_tokens("L'ho visto", "it", [], None)}
    assert "ho" in it_words
    es_words = {t[0] for t in build_word_tokens("D'Angelo", "es", [], None)}
    assert "D'Angelo" in es_words  # not an elision locale → regex token kept whole


def test_generic_path_is_opt_in_per_language():
    # A simplemma-supported language NOT in GENERIC_TOKEN_PRIMARIES stays inert
    # (no dictionary/validation yet) — custom-first dispatch, deliberate opt-in.
    from loom_core.romanize import build_word_tokens, is_token_supported, GENERIC_TOKEN_PRIMARIES
    assert "fi" not in GENERIC_TOKEN_PRIMARIES         # Finnish not enabled yet
    assert is_token_supported("es") and not is_token_supported("fi")
    assert build_word_tokens("Hyvää huomenta", "fi", [], None) == []


def test_custom_tokenizer_takes_precedence_over_generic():
    # ja/zh/ko must never fall through to the generic path even though they're
    # "supported" — the dispatch checks them first.
    from loom_core.romanize import is_token_supported
    assert is_token_supported("ja") and is_token_supported("ko") and is_token_supported("zh")


# --------------------------------------------------------------------------- #
# Unsupported languages (Phase 0)
# --------------------------------------------------------------------------- #

def test_thai_yields_no_tokens():
    func = get_annotation_func("th")
    if func is None:
        pytest.skip("thai annotation unavailable")
    spans = func("สวัสดี")
    assert build_word_tokens("สวัสดี", "th", spans, func) == []


# --------------------------------------------------------------------------- #
# Span-index remap for generic-path languages that ALSO have annotation spans
# (Brahmic aksharas / Cyrillic words).  Regression for the bug where per-word
# vocab lookup only worked for ja/zh/ko: the client groups words by SPAN INDEX,
# but these langs emitted CODEPOINT offsets, so no word was ever clickable.
# build_word_tokens now remaps them onto span indices.
# --------------------------------------------------------------------------- #

@generic
def test_hindi_word_tokens_use_span_indices_not_codepoints():
    pytest.importorskip("regex")
    pytest.importorskip("aksharamukha")
    # नमस्ते = 3 aksharas (न · म · स्ते) but 6 codepoints.  The single word token
    # must cover span indices [0:3], NOT codepoint length 6 (which would overflow
    # the 3-span array and drop the word).
    spans, toks = _tokens("hi", "नमस्ते")
    assert len(spans) == 3, [s[0] for s in spans]
    word = next(t for t in toks if t[0] == "नमस्ते")
    _w, _l, _p, _r, start, length = word
    assert (start, length) == (0, 3)
    _assert_aligned(spans, toks)


@generic
def test_hindi_multiword_line_token_span_alignment():
    pytest.importorskip("regex")
    pytest.importorskip("aksharamukha")
    # Every word's span slice must reconstruct its surface, across a line with a
    # space span between words.
    spans, toks = _tokens("hi", "मैं नहीं गया")
    assert len(toks) >= 3
    _assert_aligned(spans, toks)


@generic
def test_cyrillic_word_tokens_use_span_indices():
    # Cyrillic annotation spans are per-word + interleaved-space spans; each word
    # token must map to its single word span, not a codepoint offset.
    spans, toks = _tokens("ru", "Кошки едят рыбу")
    assert toks, "expected clickable word tokens for Russian"
    _assert_aligned(spans, toks)
    # Each token covers exactly one span (a whole word), and its start indexes a
    # real span whose base matches the token surface.
    for word, _l, _p, _r, start, length in toks:
        assert length == 1
        assert spans[start][0] == word


@generic
def test_cyrillic_punctuation_adjacent_word_still_maps():
    # Boundary skew: the word regex yields "привет" (letters only) while the
    # Cyrillic span is "привет," (comma attached).  Overlap-based remap maps the
    # token onto the whole span rather than dropping it.
    spans, toks = _tokens("ru", "привет, мир")
    words = {t[0] for t in toks}
    assert "привет" in words  # not dropped despite the trailing comma
    # Its span run overlaps the "привет," span.
    tok = next(t for t in toks if t[0] == "привет")
    _w, _l, _p, _r, start, length = tok
    covered = "".join(s[0] for s in spans[start:start + length])
    assert "привет" in covered


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


@generic
def test_batch_route_emits_tokens_for_no_annotation_func_lang(mem_cache):
    # Spanish has NO annotation_func (Latin script, no ruby) but IS token-
    # supported — the batch route must still emit clickable word tokens with
    # empty spans/html.  Regression guard for the _computable gate that used to
    # short-circuit any lang without an annotation func.
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch
    resp = annotate_batch(AnnotateBatchRequest(texts=["Los niños comieron"], lang_code="es"))
    item = resp.results[0]
    assert item.spans == [] and item.html == ""  # no ruby for Latin script
    by = {t.word: t.lemma for t in item.tokens}
    assert by.get("comieron") == "comer" and "niños" in by


@generic
def test_single_route_emits_tokens_for_no_annotation_func_lang(mem_cache):
    from loom_api.routes.annotate import AnnotateRequest, annotate
    resp = annotate(AnnotateRequest(text="Los gatos", lang_code="es"))
    assert resp.spans == [] and resp.html == ""
    assert any(t.word == "gatos" for t in resp.tokens)
