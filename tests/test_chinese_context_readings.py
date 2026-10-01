"""Mandarin per-character readings come from WORD context, in both scripts.

The ruby (one reading above each hanzi) used to look every character up ALONE,
so a polyphone got pypinyin's default reading whatever word it sat in:
银行 yín xíng (should be háng), 重庆 zhòng (chóng), 音乐 lè (yuè), 睡觉 jué
(jiào), 便宜 biàn yí (pián yi) — in Simplified AND Traditional.  The
whole-line romanization segmented with jieba and so was right for Simplified,
but for Traditional it ran pypinyin on the Traditional characters, whose
phrase data pypinyin lacks (銀行 → Yínxíng, 重慶 → Zhòngqìng).

Now the ruby, the line and the Zhuyin variants all read the same
context-aware syllable per character: jieba words (through the t2s bridge for
Traditional) + pypinyin's phrase lookup on the Simplified form, validated
against the ORIGINAL character before it is used (see
loom_core.romanize._mandarin_readings).  These tests pin the examples, the
ruby/line agreement, the span structure the client groups words by, and the
guards that keep a bridge problem from ever misaligning a reading.
"""
import re

import pytest

from loom_core.romanize import (
    _strip_ass,
    build_word_tokens,
    get_annotation_func,
    get_romanizer,
)

pytest.importorskip("pypinyin")
pytest.importorskip("jieba")
pytest.importorskip("opencc")


def _ruby(lang, text, system=None):
    return [r for _c, r in get_annotation_func(lang, system)(text)]


def _line(lang, text, system=None):
    return get_romanizer(lang, system)(text)


# (Simplified, Traditional, context pinyin per char, context zhuyin per char)
POLYPHONE_WORDS = [
    ("银行", "銀行", ["yín", "háng"], ["ㄧㄣˊ", "ㄏㄤˊ"]),
    ("重庆", "重慶", ["chóng", "qìng"], ["ㄔㄨㄥˊ", "ㄑㄧㄥˋ"]),
    ("音乐", "音樂", ["yīn", "yuè"], ["ㄧㄣ", "ㄩㄝˋ"]),
    ("睡觉", "睡覺", ["shuì", "jiào"], ["ㄕㄨㄟˋ", "ㄐㄧㄠˋ"]),
    ("便宜", "便宜", ["pián", "yi"], ["ㄆㄧㄢˊ", "ㄧ˙"]),
]


# --------------------------------------------------------------------------- #
# Ruby: per-character readings from word context
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("hans,hant,pinyin,_zhuyin", POLYPHONE_WORDS)
def test_simplified_pinyin_ruby_reads_in_context(hans, hant, pinyin, _zhuyin):
    assert _ruby("zh-Hans", hans) == pinyin


@pytest.mark.parametrize("hans,hant,pinyin,_zhuyin", POLYPHONE_WORDS)
def test_traditional_pinyin_ruby_reads_in_context(hans, hant, pinyin, _zhuyin):
    assert _ruby("zh-Hant", hant) == pinyin


@pytest.mark.parametrize("hans,hant,_pinyin,zhuyin", POLYPHONE_WORDS)
def test_simplified_zhuyin_ruby_reads_in_context(hans, hant, _pinyin, zhuyin):
    assert _ruby("zh-Hans", hans, "zhuyin") == zhuyin


@pytest.mark.parametrize("hans,hant,_pinyin,zhuyin", POLYPHONE_WORDS)
def test_traditional_zhuyin_ruby_reads_in_context(hans, hant, _pinyin, zhuyin):
    assert _ruby("zh-Hant", hant, "zhuyin") == zhuyin


def test_polyphones_inside_a_sentence():
    # The same characters, read differently by the word around them.
    assert _ruby("zh-Hans", "我去银行，他在行走") == [
        "wǒ", "qù", "yín", "háng", None, "tā", "zài", "xíng", "zǒu"]
    assert _ruby("zh-Hant", "我去銀行，他在行走") == [
        "wǒ", "qù", "yín", "háng", None, "tā", "zài", "xíng", "zǒu"]


# --------------------------------------------------------------------------- #
# Line: Traditional is context-aware too (Simplified was already right)
# --------------------------------------------------------------------------- #

LINES = [
    ("银行", "銀行", "Yínháng", "ㄧㄣˊ ㄏㄤˊ"),
    ("重庆", "重慶", "Chóngqìng", "ㄔㄨㄥˊ ㄑㄧㄥˋ"),
    ("音乐", "音樂", "Yīnyuè", "ㄧㄣ ㄩㄝˋ"),
    ("睡觉", "睡覺", "Shuìjiào", "ㄕㄨㄟˋ ㄐㄧㄠˋ"),
    ("便宜", "便宜", "Piányi", "ㄆㄧㄢˊ ㄧ˙"),
]


@pytest.mark.parametrize("hans,hant,pinyin,zhuyin", LINES)
def test_simplified_line_unchanged(hans, hant, pinyin, zhuyin):
    assert _line("zh-Hans", hans) == pinyin
    assert _line("zh-Hans", hans, "zhuyin") == zhuyin


@pytest.mark.parametrize("hans,hant,pinyin,zhuyin", LINES)
def test_traditional_pinyin_line_reads_in_context(hans, hant, pinyin, zhuyin):
    assert _line("zh-Hant", hant) == pinyin


@pytest.mark.parametrize("hans,hant,pinyin,zhuyin", LINES)
def test_traditional_zhuyin_line_reads_in_context(hans, hant, pinyin, zhuyin):
    assert _line("zh-Hant", hant, "zhuyin") == zhuyin


def test_tones_are_pypinyin_phrase_data_not_a_sandhi_rule():
    # The Simplified line has always printed pypinyin's PHRASE tones, which
    # encode some 一/不 sandhi (不要 bú, 一个 yí) and not others (一样 yī).
    # The ruby now shows exactly those; no sandhi RULE is applied on top (a
    # rule would turn 一样 into yíyàng).
    assert _line("zh-Hans", "不要") == "Búyào"
    assert _ruby("zh-Hans", "不要") == ["bú", "yào"]
    assert _line("zh-Hans", "一样") == "Yīyàng"
    assert _ruby("zh-Hans", "一样") == ["yī", "yàng"]


# Ordinal / counted 一 keeps its citation tone.  pypinyin reads a jieba word
# with its OWN phrase matching, so inside 第一个 it matches the phrase 一个
# (yígè, "one of") and puts cardinal sandhi on an ordinal; a few phrase
# entries carry the same error themselves (第一名, 十一点, 一月份, 一年级,
# 一等奖).  Per-character lookup (the old ruby) always showed yī here.
# (Simplified, Traditional, index of the 一, the line in both scripts)
ORDINAL_YI = [
    ("第一个", "第一個", 1, "Dìyīgè"),
    ("十一个", "十一個", 1, "Shíyīgè"),
    ("二十一个", "二十一個", 2, "Èrshíyīgè"),
    ("第一代", "第一代", 1, "Dìyīdài"),
    ("第一名", "第一名", 1, "Dìyīmíng"),
    ("十一点", "十一點", 1, "Shíyīdiǎn"),
    ("第一次世界大战", "第一次世界大戰", 1, "Dìyīcìshìjièdàzhàn"),
    ("一月份", "一月份", 0, "Yīyuèfèn"),
    ("一月底", "一月底", 0, "Yīyuèdǐ"),
    ("一年级", "一年級", 0, "Yīniánjí"),
    ("一等奖", "一等獎", 0, "Yīděngjiǎng"),
]


@pytest.mark.parametrize("hans,hant,k,line", ORDINAL_YI)
@pytest.mark.parametrize("script", ["hans", "hant"])
def test_ordinal_yi_keeps_citation_tone(hans, hant, k, line, script):
    lang, text = ("zh-Hans", hans) if script == "hans" else ("zh-Hant", hant)
    assert _ruby(lang, text)[k] == "yī"
    assert _ruby(lang, text, "zhuyin")[k] == "ㄧ"
    assert _line(lang, text) == line
    assert _line(lang, text, "zhuyin").split(" ")[k] == "ㄧ"


def test_counting_idiom_reads_both_yi_in_citation_tone():
    # 一五一十 ("one, five, one, ten" — counting it all out): pypinyin's
    # phrase entry sandhis both 一.
    for lang in ("zh-Hans", "zh-Hant"):
        assert _ruby(lang, "一五一十") == ["yī", "wǔ", "yī", "shí"]
        assert _line(lang, "一五一十") == "Yīwǔyīshí"


@pytest.mark.parametrize("text,k,reading", [
    # Cardinal 一 before a measure word / verb keeps pypinyin's sandhi.
    ("一个", 0, "yí"),
    ("第一个人来了，一个人走了", 7, "yí"),
    # The numeral must be in the SAME word: 千万 ("be sure to") | 一定,
    # 他们三 | 一起 — 万/三 there are not counting into the 一.
    ("千万一定要小心", 2, "yí"),
    ("他们三一起去", 3, "yì"),
    # 月复一月 ("month after month") is one month each time: the ordinal
    # words only count at the START of a word.
    ("月复一月", 2, "yí"),
    # Bare 一月 is January OR "one month" (不出一月, 一月之内) — jieba gives
    # both the same word, so pypinyin's phrase reading stands.
    ("一月之内", 0, "yí"),
])
def test_cardinal_yi_sandhi_is_untouched(text, k, reading):
    assert _ruby("zh-Hans", text)[k] == reading


@pytest.mark.parametrize("code", ["zh-HK", "yue"])
def test_explicit_mandarin_on_a_cantonese_code_reads_traditional_in_context(code):
    # zh-HK / yue text is Traditional; an explicit pinyin/zhuyin request goes
    # through the same bridge (and the same code) as zh-Hant.
    assert _ruby(code, "銀行", "pinyin") == ["yín", "háng"]
    assert _ruby(code, "銀行", "zhuyin") == ["ㄧㄣˊ", "ㄏㄤˊ"]
    assert _line("zh-HK", "銀行", "pinyin") == "Yínháng"


def test_traditional_and_simplified_lines_agree():
    hans = "我们明天去银行取钱，然后去重庆听音乐会。"
    hant = "我們明天去銀行取錢，然後去重慶聽音樂會。"
    assert _line("zh-Hant", hant) == _line("zh-Hans", hans)
    assert _line("zh-Hant", hant, "zhuyin") == _line("zh-Hans", hans, "zhuyin")


# --------------------------------------------------------------------------- #
# Ruby and line agree: the same syllable per character
# --------------------------------------------------------------------------- #

SENTENCES = [
    ("zh-Hans", "他长大以后当了银行行长，还还了所有的钱。"),
    ("zh-Hant", "他長大以後當了銀行行長，還還了所有的錢。"),
    ("zh-Hans", "我觉得这首音乐很好听，睡觉前总会听一遍。"),
    ("zh-Hant", "我覺得這首音樂很好聽，睡覺前總會聽一遍。"),
    ("zh-Hans", "重庆的东西很便宜，不要担心。"),
    ("zh-Hant", "重慶的東西很便宜，不要擔心。"),
    ("zh-Hant", "他頭髮乾淨，一隻貓沈默地看著。"),
    ("zh-Hans", "今天是2024年，Tom说OK。"),
    ("zh-Hant", "（旁白）三體世界\n第一集"),
]


def _cjk_readings(lang, text, system):
    return [r for c, r in get_annotation_func(lang, system)(text) if r is not None]


# Separators of the line's tokens: whitespace, ASCII punctuation (the polish
# pass turns CJK punctuation into ASCII) and any leftover CJK/fullwidth marks.
_LINE_SEP = re.compile(r"[\s.,!?;:()\[\]\"'\u3000-\u303f\uff00-\uffef-]+")


@pytest.mark.parametrize("lang,text", SENTENCES)
def test_zhuyin_line_syllables_equal_ruby(lang, text):
    # Zhuyin keeps every syllable space-separated, so the line's bopomofo
    # tokens must be exactly the ruby readings, in order.
    bopo = [t for t in _LINE_SEP.split(_line(lang, text, "zhuyin"))
            if any(0x3100 <= ord(ch) <= 0x312F for ch in t)]
    assert bopo == _cjk_readings(lang, text, "zhuyin")


@pytest.mark.parametrize("lang,text", SENTENCES)
def test_pinyin_line_syllables_equal_ruby(lang, text):
    # Pinyin glues a word's syllables, spaces words and capitalizes sentence
    # starts.  Rebuild the line's letters from the ruby — each hanzi's reading,
    # every other character as itself (Latin, digits pass through) — and
    # compare the alphanumeric streams case-insensitively.
    spans = get_annotation_func(lang, None)(text)
    from_ruby = "".join(r if r is not None else c for c, r in spans)

    def alnum(s):
        return "".join(ch for ch in s.lower() if ch.isalnum())

    assert alnum(_line(lang, text)) == alnum(from_ruby)


# --------------------------------------------------------------------------- #
# Span structure: one span per character, exactly as before
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("lang", ["zh-Hans", "zh-Hant"])
@pytest.mark.parametrize("system", [None, "zhuyin"])
def test_span_structure_is_one_per_character(lang, system):
    text = "{\\an8}第1集：Hello 世界！\n  銀行 银行\u3000OK…"
    spans = get_annotation_func(lang, system)(text)
    clean = _strip_ass(text)
    assert [c for c, _r in spans] == list(clean)
    for c, r in spans:
        is_han = 0x4E00 <= ord(c) <= 0x9FFF or 0x3400 <= ord(c) <= 0x4DBF
        assert (r is not None) == is_han, (c, r)


def test_empty_and_han_free_input():
    for lang in ("zh-Hans", "zh-Hant"):
        for system in (None, "zhuyin"):
            f = get_annotation_func(lang, system)
            assert f("") == []
            assert f("ABC 123") == [(c, None) for c in "ABC 123"]


# --------------------------------------------------------------------------- #
# The Traditional bridge is validated, never trusted blindly
# --------------------------------------------------------------------------- #

def test_bridge_reading_must_be_valid_for_the_original_character():
    # t2s maps 隻 (zhī only) to 只, whose own default is zhǐ.  The Simplified
    # reading is not a reading 隻 has, so it is rejected for the original's.
    assert _ruby("zh-Hant", "隻") == ["zhī"]
    assert _line("zh-Hant", "隻") == "Zhī"


def test_bridge_fixes_characters_that_merge_in_simplified():
    # 乾淨 → 干净 (gān), 沈默 → 沉默 (chén): readings the Traditional
    # characters have, which pypinyin's Traditional data picks wrongly.
    assert _ruby("zh-Hant", "乾淨") == ["gān", "jìng"]
    assert _ruby("zh-Hant", "沈默") == ["chén", "mò"]
    # ...while a phrase OpenCC keeps unconverted keeps its own reading.
    assert _ruby("zh-Hant", "乾隆") == ["qián", "lóng"]


class _Converter:
    def __init__(self, fn):
        self.convert = fn


# What the Traditional line reads as when its characters are read AS-IS (no
# bridge) — pypinyin on the original characters, jieba on the original text.
_AS_IS = ["wǒ", "qù", "yín", "xíng", "qǔ", "qián", None, "zhòng", "qìng", "hěn", "yuǎn"]
# With the real bridge.
_BRIDGED = ["wǒ", "qù", "yín", "háng", "qǔ", "qián", None, "chóng", "qìng", "hěn", "yuǎn"]


# Each fake wraps the REAL t2s conversion (``real``) and corrupts it.
@pytest.mark.parametrize("fake,expected", [
    # Length changes: no position can be trusted → the whole line is read
    # as-is.  (Grows at the end / shrinks at the START, so a naive
    # length-mapping would shift every boundary after the change.)
    (lambda real: lambda s: real(s) + "多", _AS_IS),
    (lambda real: lambda s: real(s)[1:], _AS_IS),
    # Same length, but 行 "converts" to 甲 (jiǎ): not a reading 行 has, so the
    # 銀行 run falls back to its own characters; every other run is bridged.
    (lambda real: lambda s: real(s).replace("行", "甲"),
     _BRIDGED[:3] + ["xíng"] + _BRIDGED[4:]),
])
def test_unprovable_bridge_falls_back_without_misaligning(monkeypatch, fake, expected):
    import loom_core.romanize as R

    text = "我去銀行取錢，重慶很遠"
    assert _ruby("zh-Hant", text) == _BRIDGED
    real = R._get_t2s().convert
    monkeypatch.setattr(R, "_get_t2s", lambda: _Converter(fake(real)))
    # The segmentation memo holds the REAL bridge for this line; drop it so
    # the fake converter is what gets exercised (and again afterwards, so no
    # fake-derived segmentation outlives the test).
    R._zh_segment_memo.cache_clear()
    try:
        spans = get_annotation_func("zh-Hant")(text)
        # Structure identical: one span per character, reading on hanzi only.
        assert [c for c, _ in spans] == list(text)
        assert [r for _c, r in spans] == expected
        # The line reads the same syllables (never a shifted one)...
        line = _line("zh-Hant", text).lower().replace(" ", "").replace(",", "")
        assert line == "".join(r for r in expected if r)
        # ...and the word tokens still tile the text exactly.
        words = R._jieba_words(text, traditional=True)
        assert "".join(words) == text
        toks = build_word_tokens(text, "zh-Hant", spans, None)
        for word, _l, _p, _r, start, length in toks:
            assert "".join(c for c, _ in spans[start:start + length]) == word
    finally:
        R._zh_segment_memo.cache_clear()


# --------------------------------------------------------------------------- #
# Word tokens: boundaries unchanged, reading contract unchanged
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("lang,text", [("zh-Hans", "我去银行取钱"), ("zh-Hant", "我去銀行取錢")])
def test_tokens_align_with_the_ruby(lang, text):
    func = get_annotation_func(lang)
    spans = func(text)
    toks = build_word_tokens(text, lang, spans, func)
    words = [t[0] for t in toks]
    assert text[2:4] in words
    for word, lemma, pos, reading, start, length in toks:
        assert "".join(c for c, _ in spans[start:start + length]) == word
        # ZH tokens carry no reading of their own (the card shows /define's),
        # so nothing on them can contradict the ruby.
        assert reading is None and pos == [] and lemma == word


# --------------------------------------------------------------------------- #
# Cantonese is a different engine and must not move
# --------------------------------------------------------------------------- #

def test_jyutping_untouched():
    pytest.importorskip("pycantonese")
    spans = get_annotation_func("yue")("我去銀行")
    assert [c for c, _ in spans] == list("我去銀行")
    assert spans[2][1] == "ngan4" and spans[3][1] == "hong4"
