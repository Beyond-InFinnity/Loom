"""Leading speaker-name / SFX label handling (corpus finding ①).

Streaming CJK subtitles prefix a large share of cues with the speaker's name in
brackets — （フリーレン）, 【名】, [孫悟空] — or an SFX description （戦闘音）.  This is
metadata for the hard-of-hearing, not dialogue.  Loom keeps it in DISPLAY (the
annotation `spans` still reconstruct the full text) but excludes it from ANALYSIS:

  * no clickable word-token over the label (build_word_tokens drops it), so the
    name isn't a per-word-lookup dead-end;
  * it's stripped before the romanization line so we don't spell out a proper
    noun (strip_leading_speaker_label).

The pure string helper runs anywhere; the token-drop tests need MeCab/jieba and
skip cleanly when absent (CI has them).
"""
import pytest

from loom_core.romanize import (
    build_word_tokens,
    get_annotation_func,
    strip_leading_speaker_label,
    strip_speaker_markup,
)


# --------------------------------------------------------------------------- #
# strip_leading_speaker_label — pure, no deps
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("text, expected", [
    ("（フリーレン）想定の範囲内だね", "想定の範囲内だね"),   # full-width parens
    ("(Frieren)hello", "hello"),                          # ASCII parens
    ("【ナレーション】始まる", "始まる"),                     # lenticular brackets
    ("[孫悟空]我拷！", "我拷！"),                            # square brackets
    ("-[孫悟空]我拷！", "我拷！"),                           # dash + square (speaker turn)
    ("（デンケン）\nそうだ", "そうだ"),                       # label then newline
    ("（フェルン）防がれた", "防がれた"),
])
def test_strips_leading_label(text, expected):
    assert strip_leading_speaker_label(text) == expected


@pytest.mark.parametrize("text", [
    "普通の日本語だよ",          # no label
    "这是我昨天买的",            # plain Chinese
    "（戦闘音）",                # whole cue IS the label → leave it (no dialogue body)
    "【拍手】",                  # whole cue is an SFX bracket
])
def test_leaves_non_label_or_whole_label_untouched(text):
    assert strip_leading_speaker_label(text) == text


def test_only_strips_one_leading_label_not_inline_parenthetical():
    # An in-sentence parenthetical is real content, not a speaker label — untouched.
    assert strip_leading_speaker_label("私は(たぶん)行く") == "私は(たぶん)行く"


def test_body_cap_prevents_swallowing_a_sentence():
    # A long bracketed run (>16 chars) is not a name label — don't strip it.
    long_paren = "（" + "あ" * 20 + "）本文"
    assert strip_leading_speaker_label(long_paren) == long_paren


# --------------------------------------------------------------------------- #
# Token drop — needs the real analyzers
# --------------------------------------------------------------------------- #

def _mecab_available() -> bool:
    try:
        import fugashi  # noqa: F401
        from loom_core.romanize import get_shared_ja_tagger
        return get_shared_ja_tagger() is not None
    except Exception:
        return False


def _jieba_available() -> bool:
    try:
        import jieba  # noqa: F401
        return True
    except Exception:
        return False


ja = pytest.mark.skipif(not _mecab_available(), reason="fugashi/unidic-lite unavailable")
zh = pytest.mark.skipif(not _jieba_available(), reason="jieba unavailable")


def _words(lang, text):
    func = get_annotation_func(lang)
    spans = func(text)
    toks = build_word_tokens(text, lang, spans, func)
    return spans, [t[0] for t in toks]


@ja
def test_ja_label_name_is_not_clickable_but_dialogue_is():
    spans, words = _words("ja", "（フリーレン）想定の範囲内だね")
    # Display preserved: spans still reconstruct the WHOLE cue incl. the label.
    assert "".join(s[0] for s in spans) == "（フリーレン）想定の範囲内だね"
    # But no clickable token covers the name / parens.
    assert "フリーレン" not in words
    assert "（" not in words and "）" not in words
    # Dialogue after the label stays clickable.
    assert "想定" in words


@ja
def test_ja_token_span_indices_still_align_after_drop():
    # Dropping leading tokens must not corrupt the remaining tokens' span indices.
    func = get_annotation_func("ja")
    text = "（デンケン）そうだ"
    spans = func(text)
    toks = build_word_tokens(text, "ja", spans, func)
    for word, _lemma, _pos, _reading, start, length in toks:
        assert "".join(s[0] for s in spans[start:start + length]) == word


@ja
def test_ja_unlabelled_line_keeps_all_words():
    _spans, words = _words("ja", "普通の日本語だよ")
    assert "普通" in words and "日本" in words


@zh
def test_zh_label_dropped_dialogue_kept():
    spans, words = _words("zh", "（旁白）这是我买的")
    assert "".join(s[0] for s in spans) == "（旁白）这是我买的"
    assert "旁白" not in words
    assert "买" in words


# --------------------------------------------------------------------------- #
# Multi-speaker markup (finding ②)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("text, expected", [
    ("-[孫悟空]我拷\n-[唐三藏]你好", "我拷\n 你好"),   # newline-separated turns (real corpus)
    ("-饒命啊\n-妳有本事", "饒命啊\n 妳有本事"),        # bare dashes across a newline
    ("- 何\n- そうです", "何\n そうです"),
    ("（フリーレン）想定の範囲内だね", "想定の範囲内だね"),  # ① leading label still handled
])
def test_strip_speaker_markup_multi_turn(text, expected):
    assert strip_speaker_markup(text) == expected


def test_strip_speaker_markup_leaves_content_dash():
    # A space-padded content dash (not a turn marker) is preserved.
    assert strip_speaker_markup("3 - 5 の範囲") == "3 - 5 の範囲"


def test_strip_speaker_markup_whole_cue_label_untouched():
    assert strip_speaker_markup("（戦闘音）") == "（戦闘音）"


@zh
def test_zh_multi_speaker_both_labels_dropped_dialogue_kept():
    spans, words = _words("zh", "-[孫悟空]我拷\n-[唐三藏]你好")
    # Display keeps the whole cue (both names + dashes + newline).
    assert "".join(s[0] for s in spans) == "-[孫悟空]我拷\n-[唐三藏]你好"
    # Neither speaker name is clickable; both utterances' dialogue is.
    assert "孫悟空" not in words and "唐三藏" not in words
    assert "你好" in words


@ja
def test_ja_multi_speaker_dashes_dropped():
    _spans, words = _words("ja", "- 何\n- そうです")
    assert "何" in words and "です" in words


# --------------------------------------------------------------------------- #
# Latin generics (es/fr/de/en) — codepoint-offset token path (①+② extension)
# --------------------------------------------------------------------------- #

def _generic_available() -> bool:
    try:
        import simplemma  # noqa: F401
        return True
    except Exception:
        return False


generic = pytest.mark.skipif(not _generic_available(), reason="simplemma unavailable")


def _latin_words(lang, text):
    # Latin generics have no annotation_func → spans == [], codepoint-offset tokens.
    func = get_annotation_func(lang)
    spans = func(text) if func else []
    return [t[0] for t in build_word_tokens(text, lang, spans, func)]


@generic
def test_es_bracket_label_dropped():
    words = _latin_words("es", "(HOMBRE) ¡Quieto o disparo!")
    assert "HOMBRE" not in words and "Hombre" not in words
    assert "disparo" in words


@generic
def test_es_multi_speaker_dashes_dropped_dialogue_kept():
    words = _latin_words("es", "-Vamos ya\n-Espera")
    assert "Vamos" in words and "Espera" in words


@generic
def test_en_sfx_label_dropped():
    words = _latin_words("en", "[male voice] Blue Goose, this is Dispatch")
    assert "male" not in words and "voice" not in words
    assert "Dispatch" in words


@generic
def test_latin_plain_line_unaffected():
    words = _latin_words("en", "That's what I'm talking about")
    assert "talking" in words and "about" in words


@generic
def test_latin_whole_cue_label_kept():
    # A bare SFX cue "(Risas)" has no dialogue body — its one token stays.
    assert _latin_words("es", "(Risas)") == ["Risas"]
