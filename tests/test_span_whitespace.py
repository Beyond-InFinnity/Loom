"""Annotation spans must reconstruct the line — whitespace included.

The extension renders the Top line FROM the annotation spans (build-segments.ts:
rawText is ignored whenever spans exist), so a span list that silently drops
whitespace is a DISPLAY bug, not just a data nit:

  * Japanese (MeCab): fugashi reports inter-token whitespace in `white_space`,
    never as a token, and resolve_spans only kept `surface` — so every two-line
    cue lost its line break, embedded English fused ("Thankyouverymuchって言った"),
    and the newline-anchored multi-speaker detection never saw the newline, so
    the SECOND speaker's name stayed a clickable dead-end.
  * Cantonese (pycantonese): characters_to_jyutping drops spaces (3.4 also
    drops newlines), so the spans didn't reconstruct the line and
    _chinese_tokens — which requires one span per character — bailed: ANY
    Jyutping line containing a space or newline had ZERO clickable words.

Plus the pycantonese version skew (prod pins 5.0.0, which space-separates the
syllables INSIDE a word — 'hoeng1 gong2 jan4' where 3.4 gave 'hoeng1gong2jan4'):
the romanization line lost its word grouping in prod.
"""
import pytest

from loom_core.romanize import build_word_tokens, get_annotation_func, get_romanizer


def _mecab_available() -> bool:
    try:
        import fugashi  # noqa: F401
        from loom_core.romanize import get_shared_ja_tagger
        return get_shared_ja_tagger() is not None
    except Exception:
        return False


def _pycantonese_available() -> bool:
    try:
        import pycantonese  # noqa: F401
        import jieba  # noqa: F401
        return True
    except Exception:
        return False


ja = pytest.mark.skipif(not _mecab_available(), reason="fugashi/unidic-lite unavailable")
yue = pytest.mark.skipif(not _pycantonese_available(), reason="pycantonese/jieba unavailable")


def _analyze(lang, text, system=None):
    func = get_annotation_func(lang, system)
    spans = func(text)
    toks = build_word_tokens(text, lang, spans, func)
    return spans, toks


def _joined(spans):
    return "".join(s[0] for s in spans)


def _assert_tokens_cover_their_word(spans, toks):
    """Each token's span range composes its word, modulo LAYOUT whitespace (a
    Japanese token may straddle a line break MeCab analysed straight through —
    see test_ja_verb_chain_broken_across_lines_is_one_word)."""
    for word, _lemma, _pos, _reading, start, length in toks:
        covered = _joined(spans[start:start + length])
        assert "".join(covered.split()) == word, (word, covered, start, length)
        # …and a token never starts or ends ON whitespace.
        assert not covered[0].isspace() and not covered[-1].isspace(), (word, covered)


# --------------------------------------------------------------------------- #
# Japanese — resolve_spans keeps fugashi's white_space as plain spans
# --------------------------------------------------------------------------- #

@ja
@pytest.mark.parametrize("text", [
    "Thank you very much って言った",
    "（アリス）どうして？\n（ボブ）知らない",
    "-どうして？\n-知らない",
    "だから 開きっぱなしなんだよ\nオートロックのドアが！",
    "エレン ミカサ アルミン",
    "言っ た",
    "奴(やつ)らに 支配(しはい)された",
    "OK OK 分かった",
    "3 2 1 行け！",
])
def test_ja_spans_reconstruct_the_line(text):
    from loom_core.romanize import _strip_inline_furigana
    spans, toks = _analyze("ja", text)
    # Inline author furigana is consumed by design (it becomes the reading), so
    # the reconstruction target is the furigana-stripped line.
    assert _joined(spans) == _strip_inline_furigana(text)
    _assert_tokens_cover_their_word(spans, toks)


@ja
def test_ja_whitespace_spans_are_plain():
    spans, _ = _analyze("ja", "Thank you very much って言った")
    ws = [s for s in spans if s[0].isspace()]
    assert ws == [(" ", None)] * 4
    assert [s[0] for s in spans[:7]] == ["Thank", " ", "you", " ", "very", " ", "much"]


@ja
def test_ja_edge_whitespace_is_not_a_span():
    # Only INTERIOR whitespace is layout.  The routes strip the ends
    # (normalize_text), so edge whitespace only ever reaches resolve_spans as
    # the remnant of content a stripper removed (a kanji-only （名） label the
    # reverse-furigana pass deletes, an ASS \N) — rendering it would open the
    # line with a blank row.  HEAD never emitted it either.
    from loom_core.romanize import get_japanese_pipeline
    resolve_spans, _ = get_japanese_pipeline()
    spans = resolve_spans(" 先頭\t\n")
    assert spans == [("先頭", "せんとう")]
    # MeCab-SURFACED whitespace (the ideographic space is a 空白 token) is not
    # layout and is untouched — byte-identical to HEAD.
    spans = resolve_spans("　先頭　")
    assert [s[0] for s in spans] == ["　", "先頭", "　"]


@ja
def test_ja_text_after_nul_is_kept():
    # MeCab stops reading at a NUL; the unread tail is real text, not an edge
    # remnant, so it survives as a plain span (HEAD silently dropped it).
    from loom_core.romanize import get_japanese_pipeline
    resolve_spans, _ = get_japanese_pipeline()
    assert _joined(resolve_spans("先頭\x00後ろ")) == "先頭\x00後ろ"


@ja
@pytest.mark.parametrize("text", [
    "（銃声）\n（悲鳴）",
    "（拍手） （歓声）",
    "（金田）",
])
def test_ja_cue_of_stripped_labels_has_no_spans(text):
    # A cue made only of kanji （SFX） labels is emptied by the reverse-furigana
    # stripper; what's left is the whitespace between them.  Returning that as
    # the span list made the client render a BLANK cue (it renders spans in
    # preference to rawText whenever there are any) — [] lets it fall back to
    # rawText, exactly as on HEAD.
    spans, toks = _analyze("ja", text)
    assert spans == [] and toks == []


@ja
@pytest.mark.parametrize("text, body", [
    ("（金田）\n聞いてんのか", "聞いてんのか"),
    ("（新田）\nご両親に伺ったんすけど―", "ご両親に伺ったんすけど―"),
    ("（藤沼弟）\n卒業ぶりですね 伏黒さん", "卒業ぶりですね 伏黒さん"),
])
def test_ja_stripped_label_line_leaves_no_blank_first_line(text, body):
    # Real Netflix JJK cues (spike/netflix/netflix-ja.vtt): a kanji speaker label
    # on its own line.  The label is stripped from the spans (pre-existing), and
    # the newline that followed it must not become a leading blank row.
    spans, _toks = _analyze("ja", text)
    assert not spans[0][0].isspace()
    assert _joined(spans) == body


@ja
def test_ja_trailing_stripped_label_keeps_whole_cue_sfx_tokens():
    # （金田） is stripped, leaving a trailing "\n": as a span it made the SFX
    # marker stop covering the whole cue, so ALL its tokens were dropped.
    spans, toks = _analyze("ja", "（ドアが開く）\n（金田）")
    assert _joined(spans) == "（ドアが開く）"
    assert [t[0] for t in toks] == ["ドア", "が", "開く"]


@ja
def test_ja_second_speaker_label_is_not_clickable():
    # The newline is what anchors the second speaker's marker; with it dropped,
    # ボブ used to stay a clickable dead-end.
    spans, toks = _analyze("ja", "（アリス）どうして？\n（ボブ）知らない")
    words = [t[0] for t in toks]
    assert "アリス" not in words and "ボブ" not in words
    assert "知らない" in words and "どう" in words
    assert "\n" in _joined(spans)


@ja
def test_ja_second_speaker_label_frieren_style():
    _spans, toks = _analyze("ja", "（フリーレン）行くよ\n（フェルン）はい")
    words = [t[0] for t in toks]
    assert "フェルン" not in words and "フリーレン" not in words
    assert "行く" in words


@ja
def test_ja_katakana_words_separated_by_whitespace_stay_separate():
    # _merge_katakana_fragments re-joins MeCab's over-split unknown katakana
    # (ミカ+サ → ミカサ) — but must NOT join ACROSS source whitespace: two names
    # in a list are two words (the merged span could not reconstruct the line).
    from loom_core.romanize import get_romanizer
    spans, toks = _analyze("ja", "エレン ミカサ アルミン")
    assert [t[0] for t in toks] == ["エレン", "ミカサ", "アルミン"]
    assert get_romanizer("ja")("エレン ミカサ アルミン") == "Eren mikasa arumin"
    _spans, toks = _analyze("ja", "ミカサ\nエレン")
    assert [t[0] for t in toks] == ["ミカサ", "エレン"]


@ja
def test_ja_verb_chain_broken_across_lines_is_one_word():
    # MeCab analyses straight through whitespace (it only records it in
    # white_space), so 言っ|た is still one predicate: one clickable token whose
    # lemma is the dictionary form — the layout whitespace sits inside the
    # token's span range but not in its word/reading.
    spans, toks = _analyze("ja", "言っ\nた")
    assert _joined(spans) == "言っ\nた"
    assert len(toks) == 1
    word, lemma, _pos, reading, start, length = toks[0]
    assert (word, lemma, reading, start, length) == ("言った", "言う", "いった", 0, 3)


@ja
def test_ja_polite_auxiliary_absorbed_across_whitespace():
    # The ます-absorption (never a bare ます dead-ending into 枡) must look past a
    # layout space the same way the merge mask does.
    _spans, toks = _analyze("ja", "聞こえて ます")
    assert [(t[0], t[1]) for t in toks] == [("聞こえてます", "聞こえる")]


@ja
def test_ja_topic_ha_reading_survives_index_shift():
    # particle_ha is a SPAN index; inserting whitespace spans before it must
    # shift it, or the わ reading lands on the wrong span.
    _spans, toks = _analyze("ja", "ええ 私は学生です")
    by_word = {t[0]: t for t in toks}
    assert by_word["は"][3] == "わ"
    assert get_romanizer("ja")("ええ 私は学生です") == "Ē watashi wa gakusei desu"


@ja
@pytest.mark.parametrize("text, expected", [
    # Whitespace is layout, not pronunciation: the romaji line is exactly what it
    # was (MeCab never saw it) — a newline reads as the ordinary word gap, the
    # same way the Pinyin line treats it.
    ("どうして？\n知らない", "Dō shite? Shiranai"),
    ("食べ\nた", "Tabeta"),
    ("言っ た", "Itta"),
    ("聞こえて ます", "Kikoete masu"),
    ("OK OK 分かった", "OK OK wakatta"),
])
def test_ja_romaji_line_treats_whitespace_as_layout(text, expected):
    assert get_romanizer("ja")(text) == expected


@ja
@pytest.mark.parametrize("mode", ["macrons", "doubled", "unmarked"])
def test_ja_romaji_all_modes_ignore_layout_whitespace(mode):
    from loom_core.romanize import get_japanese_pipeline
    resolve_spans, spans_to_romaji = get_japanese_pipeline()
    spaced = spans_to_romaji(resolve_spans("そうだと\n思います"), mode)
    plain = spans_to_romaji(resolve_spans("そうだと思います"), mode)
    assert spaced == plain


@ja
def test_ja_annotate_route_two_line_cue():
    from loom_api.deps import set_result_cache
    from loom_api.result_cache import InMemoryResultCache
    from loom_api.routes.annotate import AnnotateBatchRequest, annotate_batch
    set_result_cache(InMemoryResultCache())
    try:
        text = "（アリス）どうして？\n（ボブ）知らない"
        for _ in range(2):  # compute, then the cache round-trip
            item = annotate_batch(AnnotateBatchRequest(texts=[text], lang_code="ja")).results[0]
            assert "".join(s.base for s in item.spans) == text
            assert "ボブ" not in [t.word for t in item.tokens]
            assert "\n" in item.html
    finally:
        set_result_cache(None)


# --------------------------------------------------------------------------- #
# Cantonese / Jyutping — pycantonese pairs re-aligned onto the input
# --------------------------------------------------------------------------- #

@yue
@pytest.mark.parametrize("lang, system", [
    ("yue", None), ("zh-Hant", "jyutping"), ("zh-Hans", "jyutping"),
])
@pytest.mark.parametrize("text", [
    "係咪呀？ 係呀！",
    "你好\n世界",
    "我係 香港人",
    "唔該晒，我唔識講廣東話。 abc 123",
])
def test_jyutping_spans_reconstruct_and_words_are_clickable(lang, system, text):
    spans, toks = _analyze(lang, text, system)
    assert _joined(spans) == text
    assert toks, f"no clickable words for {text!r}"
    for word, _lemma, _pos, _reading, start, length in toks:
        assert _joined(spans[start:start + length]) == word
    # Whitespace never carries a reading.
    assert all(r is None for b, r in spans if b.isspace())


@yue
def test_jyutping_zero_token_regression():
    # The finding's repro: one space used to zero out every clickable word.
    spans, toks = _analyze("yue", "係咪呀？ 係呀！")
    assert _joined(spans) == "係咪呀？ 係呀！"
    assert "呀" in {t[0] for t in toks}


@yue
def test_jyutping_romanization_treats_whitespace_as_a_word_gap():
    r = get_romanizer("yue")
    out = r("係咪呀？\n係呀！")
    assert "\n" not in out
    assert out == r("係咪呀？係呀！")


# The version-skew tests pin pycantonese's OUTPUT SHAPE, not a version: they
# replay the exact pairs each version returns (captured from 3.4.0 and 5.0.0
# for the same input) so both run under whatever version CI installs.
_PAIRS_34 = [("我", "ngo5"), ("係", "hai6"), ("香港人", "hoeng1gong2jan4"),
             ("講", "gong2"), ("廣東話", "gwong2dung1waa2"), ("。", None)]
_PAIRS_50 = [("我", "ngo5"), ("係", "hai6"), ("香港人", "hoeng1 gong2 jan4"),
             ("講", "gong2"), ("廣東話", "gwong2 dung1 waa2"), ("。", None)]
_TEXT = "我係香港人講廣東話。"


def _with_pairs(monkeypatch, pairs):
    import pycantonese
    monkeypatch.setattr(pycantonese, "characters_to_jyutping", lambda _t: list(pairs))


@yue
@pytest.mark.parametrize("pairs", [_PAIRS_34, _PAIRS_50], ids=["pc3.4", "pc5.0"])
def test_jyutping_romanization_is_word_grouped_under_both_versions(monkeypatch, pairs):
    _with_pairs(monkeypatch, pairs)
    assert get_romanizer("yue")(_TEXT) == "Ngo5 hai6 hoeng1gong2jan4 gong2 gwong2dung1waa2."


@yue
@pytest.mark.parametrize("pairs", [_PAIRS_34, _PAIRS_50], ids=["pc3.4", "pc5.0"])
def test_jyutping_annotation_is_identical_under_both_versions(monkeypatch, pairs):
    _with_pairs(monkeypatch, pairs)
    spans = get_annotation_func("yue")(_TEXT)
    assert spans == [("我", "ngo5"), ("係", "hai6"), ("香", "hoeng1"), ("港", "gong2"),
                     ("人", "jan4"), ("講", "gong2"), ("廣", "gwong2"), ("東", "dung1"),
                     ("話", "waa2"), ("。", None)]


@yue
@pytest.mark.parametrize("jp", ["hoeng1gong2", "hoeng1 gong2"], ids=["pc3.4", "pc5.0"])
def test_jyutping_whole_word_fallback_is_version_independent(monkeypatch, jp):
    # Syllable/char mismatch keeps the word as ONE span — its reading must not
    # carry 5.0's intra-word spaces either.
    _with_pairs(monkeypatch, [("香港人", jp)])
    assert get_annotation_func("yue")("香港人") == [("香港人", "hoeng1gong2")]


# Real pycantonese output, captured from 5.0.0 (prod's pin) and 3.4.0 for every
# call these lines provoke: the WHOLE line (what the romanizer used to send) and
# the per-run / per-piece calls it sends now.  An unexpected call is a KeyError.
#
# 5.0's segmenter GLUES a character it has no reading for onto the neighbouring
# hanzi — U+3000, tab, NBSP, "\r", but also ♪, the name interpunct, ⋯ — and one
# unknown character voids the whole word's reading: ('好\u3000', None),
# ('大文\u3000你', None), ('♪我愛', None), ('哈利·波特', None).  Both versions also
# join words across an ASCII space ('一 二 三' → '一二三' / '一二').
_PC50 = {
    "你好\u3000世界": [("你", "nei5"), ("好\u3000", None), ("世界", "sai3 gaai3")],
    "你好": [("你", "nei5"), ("好", "hou2")],
    "世界": [("世界", "sai3 gaai3")],
    "我係陳大文\u3000你呢": [("我", "ngo5"), ("係", "hai6"), ("陳", "can4"),
                        ("大文\u3000你", None), ("呢", "ne1")],
    "我係陳大文": [("我", "ngo5"), ("係", "hai6"), ("陳", "can4"), ("大文", "daai6 man4")],
    "你呢": [("你", "nei5"), ("呢", "ne1")],
    "你好\r\n世界": [("你", "nei5"), ("好\r", None), ("\n", None), ("世界", "sai3 gaai3")],
    "係咪呀？\t係呀！": [("係", "hai6"), ("咪", "mi1"), ("呀", "aa4"), ("？", None),
                      ("\t係", None), ("呀", "aa4"), ("！", None)],
    "係咪呀？\xa0係呀！": [("係", "hai6"), ("咪", "mi1"), ("呀", "aa4"), ("？", None),
                        ("\xa0係", None), ("呀", "aa4"), ("！", None)],
    "係咪呀？": [("係", "hai6"), ("咪", "mi1"), ("呀", "aa4"), ("？", None)],
    "係呀！": [("係", "hai6"), ("呀", "aa4"), ("！", None)],
    "一 二 三": [("一二三", "jat1 ji6 saam1")],
    "一": [("一", "jat1")], "二": [("二", "ji6")], "三": [("三", "saam1")],
    "♪我愛你♪": [("♪我愛", None), ("你♪", None)],
    "我愛": [("我愛", "ngo5 oi3")],
    "你": [("你", "nei5")],
    "哈利·波特": [("哈利·波特", None)],
    "哈利": [("哈利", "haa1 lei6")],
    "波特": [("波特", "bo1 dak6")],
}
_PC34 = {
    "一 二 三": [("一二", "jat1ji6"), ("三", "saam1")],
    "一": [("一", "jat1")], "二": [("二", "ji6")], "三": [("三", "saam1")],
}


def _replay(monkeypatch, table):
    import pycantonese
    calls = []

    def fake(text):
        calls.append(text)
        return list(table[text])

    monkeypatch.setattr(pycantonese, "characters_to_jyutping", fake)
    return calls


def _is_han(ch):
    return "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"


@yue
@pytest.mark.parametrize("text, expected", [
    ("你好\u3000世界", "Nei5 hou2 sai3gaai3"),
    ("我係陳大文\u3000你呢", "Ngo5 hai6 can4 daai6man4 nei5 ne1"),
    ("你好\r\n世界", "Nei5 hou2 sai3gaai3"),
    ("係咪呀？\t係呀！", "Hai6 mi1 aa4? Hai6 aa4!"),
    ("係咪呀？\xa0係呀！", "Hai6 mi1 aa4? Hai6 aa4!"),
    ("♪我愛你♪", "♪ Ngo5oi3 nei5 ♪"),
    ("哈利·波特", "Haa1lei6 · bo1dak6"),
])
def test_jyutping_5_0_glued_characters_keep_their_readings(monkeypatch, text, expected):
    # Prod's 5.0 shape: the hanzi beside a glued character used to lose their
    # reading, and the raw hanzi + whitespace leaked into the romanization line
    # ("Nei5 好　 sai3gaai3", "Ngo5 hai6 can4 大文　你 ne1").
    calls = _replay(monkeypatch, _PC50)
    spans = get_annotation_func("yue")(text)
    assert _joined(spans) == text
    assert all(r for b, r in spans if any(_is_han(c) for c in b)), spans
    assert all(r is None for b, r in spans if b.isspace())
    line = get_romanizer("yue")(text)
    assert line == expected
    assert not any(_is_han(c) for c in line) and not any(c.isspace() and c != " " for c in line)
    # pycantonese never sees whitespace — that is what keeps it from gluing it.
    assert not any(ch.isspace() for call in calls for ch in call), calls


@yue
@pytest.mark.parametrize("table", [_PC34, _PC50], ids=["pc3.4", "pc5.0"])
def test_jyutping_source_space_is_a_word_boundary_under_both_versions(monkeypatch, table):
    # Both versions segmented ACROSS a dropped space (3.4 '一二', 5.0 '一二三'),
    # so the same line romanized differently per version and against the
    # documented "whitespace = word gap" contract.  Per-run calls make the space
    # a hard boundary, identically.
    _replay(monkeypatch, table)
    assert get_romanizer("yue")("一 二 三") == "Jat1 ji6 saam1"
    assert get_annotation_func("yue")("一 二 三") == [
        ("一", "jat1"), (" ", None), ("二", "ji6"), (" ", None), ("三", "saam1")]


@yue
def test_jyutping_whitespace_free_line_is_one_call(monkeypatch):
    # The byte-identity guarantee: a line without whitespace or glued symbols
    # is exactly the single whole-line call it always was.
    calls = _replay(monkeypatch, {"我係陳大文": _PC50["我係陳大文"]})
    get_annotation_func("yue")("我係陳大文")
    get_romanizer("yue")("我係陳大文")
    assert calls == ["我係陳大文", "我係陳大文"]


@yue
@pytest.mark.parametrize("word", ["abc", "⋯⋯", "iPhone15"])
def test_jyutping_unreadable_non_hanzi_word_is_left_whole(monkeypatch, word):
    # Only a word mixing hanzi with non-hanzi is split back apart — a Latin /
    # digit / symbol token stays one unit (no extra calls, same output as
    # before), so 3.4 output is untouched.
    calls = _replay(monkeypatch, {word: [(word, None)]})
    assert get_annotation_func("yue")(word) == [(c, None) for c in word]
    assert calls == [word]


@yue
def test_jyutping_unalignable_output_falls_back_to_pairs(monkeypatch):
    # Defensive: if pycantonese ever returns text that is NOT in the input
    # (normalization), don't guess — emit its pairs as before.
    _with_pairs(monkeypatch, [("香港", "hoeng1gong2")])
    assert get_annotation_func("yue")("香江") == [("香", "hoeng1"), ("港", "gong2")]
