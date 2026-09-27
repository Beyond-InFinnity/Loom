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
    # Dialogue content survives (何, そうです — です absorbed into its predicate,
    # not a bare-です token); the speaker-turn dashes are dropped as markup.
    assert "何" in words and "そうです" in words
    assert "-" not in words and "- " not in words


# --------------------------------------------------------------------------- #
# Kanji labels, with and without author inline furigana (real Netflix JA:
# "（金田(かなだ)）おい 聞いてんのか？", "（金田）\n聞いてんのか…", "（伏黒(ふしぐろ)）")
# --------------------------------------------------------------------------- #
# Two bugs shared one shape.  (1) DISPLAY: the reverse-furigana stripper deletes
# every (2+ kanji) parenthetical — とりかご(鳥籠) — and a kanji speaker label is
# exactly that shape, so the label vanished from the spans the extension renders
# (and a mid-cue label left a blank row behind).  (2) ROMAJI: the marker regex's
# label body stops at the FIRST closer, so the nested reading's ")" closed the
# label early and the line began with a stray "）" (") Oi, mate").  And keeping
# the label must not cost the dialogue anything: (3) MeCab used to parse label +
# dialogue as one sentence, which re-analysed the word after "）" (katakana and
# mixed labels already suffered it) — the markup is now parsed on its own.

@pytest.mark.parametrize("text, expected", [
    ("（金田(かなだ)）おい、待て", "おい、待て"),
    ("（金田（かなだ））おい", "おい"),                 # full-width inner parens
    ("(金田(かなだ))おい", "おい"),                     # ASCII outer parens
    ("【金田(かなだ)】おい", "おい"),
    ("[金田(かなだ)]おい", "おい"),
    ("（藤沼(ふじぬま)弟）おお？\n（不良）ああ？", "おお？\n ああ？"),
    ("-（金田(かなだ)）行くぞ\n-（新田(にった)）はい", "行くぞ\n はい"),
    # Dialogue's own inline furigana is content, not markup — kept for the
    # romanizer's tier-1 readings.
    ("（金田(かなだ)）奴(やつ)らに支配(しはい)された", "奴(やつ)らに支配(しはい)された"),
    # A whole-cue label stays whole (nothing else to romanize).
    ("（鈴(りん)の音）", "（鈴(りん)の音）"),
    # The 16-char cap measures the label AS DISPLAYED (reading excluded), so a
    # long name with a long reading is still a label…
    ("（煉獄杏寿郎(れんごくきょうじゅろう)）行くぞ", "行くぞ"),
])
def test_strip_speaker_markup_label_with_inline_furigana(text, expected):
    assert strip_speaker_markup(text) == expected


def test_strip_speaker_markup_cap_still_excludes_long_parentheticals_with_readings():
    # …but the cap still applies: 17 displayed chars is a sentence, not a name.
    text = "（" + "漢" * 17 + "(かん)）本文"
    assert strip_speaker_markup(text) == text


def test_strip_leading_speaker_label_with_inline_furigana():
    # The /define continuation stitcher (grammar ③) uses the narrower helper.
    assert strip_leading_speaker_label("（金田(かなだ)）おい") == "おい"
    assert strip_leading_speaker_label("[金田(かなだ)]\nおい") == "おい"


def _legacy_strip_speaker_markup(text):
    """strip_speaker_markup before the inline-furigana fix, verbatim."""
    import re
    from loom_core.romanize import _SPEAKER_TURN_MARKER
    if not text:
        return text
    out = _SPEAKER_TURN_MARKER.sub(" ", text)
    out = re.sub(r"[ \t　]{2,}", " ", out).strip()
    return out if out.strip() else text


# zh-Hans / ko share strip_speaker_markup and are NOT engine-bumped with this
# fix, so their romaji cache keys (the stripped text) must not move.  Author
# inline furigana needs KANA glued to a kanji; without it the helper must be the
# old function byte for byte — including on nested and unbalanced brackets.
@pytest.mark.parametrize("text", [
    "（旁白）这是我买的", "-[孫悟空]我拷\n-[唐三藏]你好", "（张三(配音)）你好", "（张三（配音））你好",
    "[孫悟空(配音)]我拷", "【旁白（画外音）】开始", "（未闭合 你好", "你好）", "（（张三））你好",
    "（张三(zhang)）你好", "（王(wang)）走", "-（张三）你好\n-（李四）再见", "你好\n（张三）\n再见",
    "[정배] 어!", "- [덜컹덜컹]\n- [지게차 경보음]", "[남자(목소리)] 안녕", "(남자(목소리)) 안녕",
    "[金正培(김정배)] 어", "[정배", "[[정배]] 어", "（笑）", "【拍手】",
])
def test_strip_speaker_markup_unchanged_without_inline_furigana(text):
    assert strip_speaker_markup(text) == _legacy_strip_speaker_markup(text)


@ja
def test_ja_kanji_label_with_inline_furigana_is_kept_in_display():
    spans, words = _words("ja", "（金田(かなだ)）おい、待て")
    # Display keeps the label (the inline reading moves into the ruby, like any
    # author furigana)…
    assert "".join(s[0] for s in spans) == "（金田）おい、待て"
    assert ("金田", "かなだ") in [tuple(s) for s in spans]
    # …but it is still speaker markup: not a clickable word.
    assert "金田" not in words
    assert "おい" in words and "待て" in words


@ja
@pytest.mark.parametrize("text", [
    "（金田）おい、待て",
    "（金田）\n聞いてんのかって言ってるだろ！",
    "（藤沼弟）おお？\n（不良）ああ？",
    "-（金田）行くぞ\n-（新田）はい",
])
def test_ja_plain_kanji_label_is_kept_in_display(text):
    spans, words = _words("ja", text)
    assert "".join(s[0] for s in spans) == text
    assert not {"金田", "新田", "藤沼", "不良"} & set(words)


@ja
def test_ja_mid_cue_kanji_label_leaves_no_blank_row():
    spans, words = _words("ja", "おい\n（金田）\n聞いて")
    assert "".join(s[0] for s in spans) == "おい\n（金田）\n聞いて"
    assert not any(s[0].count("\n") > 1 for s in spans)   # no fused "\n\n" row
    assert "金田" not in words
    assert "おい" in words and "聞いて" in words


@ja
@pytest.mark.parametrize("text", [
    # Real Netflix JJK cues (spike/netflix/netflix-ja.vtt).  Parsed as one
    # sentence, the label made MeCab read the dialogue's first word as a clause
    # continuation: は？ ("huh?") became the topic particle, ん？ the nominalizer
    # の, ある日 ("one day") the verb 有る, ええ ("yeah") the adjective 良い.
    "（虎杖）は？　えっ？\n（釘崎）えっ？　おっ？",
    "（新田）ん？",
    "（武田）ある日 金田たち４人が\n無断欠席をしてね",
    "（新田）で 同じ呪霊の仕業か\nって話っすけど―",
    "（釘崎･虎杖）ええ話や",
    "（金田(かなだ)）おい 聞いてんのか？",
    "（アルミン）は？",
])
def test_ja_label_does_not_change_the_dialogue_analysis(text):
    # The dialogue after a label must be analyzed exactly as it is on its own —
    # the same text the romaji line is built from.
    import re
    from loom_core.romanize import _strip_inline_furigana
    body = re.sub(r"(^|\n)[（(][^）)\n]*[）)]", r"\1", _strip_inline_furigana(text))
    func = get_annotation_func("ja")
    with_label = [t[:4] for t in build_word_tokens(text, "ja", func(text), func)]
    alone = [t[:4] for t in build_word_tokens(body, "ja", func(body), func)]
    assert with_label == alone


@ja
def test_ja_reverse_furigana_is_still_stripped_mid_line():
    # The real reverse-furigana convention — (kanji) glued AFTER the word it
    # glosses — can never open a line, so it is still dropped.
    spans, _words_ = _words("ja", "とりかご(鳥籠)の中")
    assert "".join(s[0] for s in spans) == "とりかごの中"


@ja
@pytest.mark.parametrize("text, expected", [
    ("（金田(かなだ)）おい、待て", "Oi, mate"),
    ("（金田）おい、待て", "Oi, mate"),
    ("【金田(かなだ)】おい", "Oi"),
    ("[金田(かなだ)]おい", "Oi"),
    ("おい\n（金田）\n待て", "Oi mate"),
    ("おい\n（金田(かなだ)）\n待て", "Oi mate"),
])
@pytest.mark.parametrize("mode", ["macrons", "doubled"])
def test_ja_romaji_route_strips_label_cleanly(text, expected, mode):
    from loom_api.routes.romanize import romanize_batch, RomanizeBatchRequest
    resp = romanize_batch(RomanizeBatchRequest(texts=[text], lang_code="ja", long_vowel_mode=mode))
    assert resp.results[0].romanized == expected


# --------------------------------------------------------------------------- #
# Readings over a kept label: the author's or none
# --------------------------------------------------------------------------- #
# A displayed kanji label got MeCab's tier-3 furigana, and a label is mostly a
# NAME — MeCab's weakest case: real JJK cues showed 新田[しんでん] (Nitta, 19
# cues), 伏[ふく]黒[くろ] (Fushiguro, 18), 真人[しんじん] (Mahito), and 夏[なつ]油[あぶら]
# even where the author had written 夏油(げとう).  A wrong reading is worse than
# none.  Markup is metadata, so over a label the only reading shown is the one
# the AUTHOR supplied (tier 1); the label stays plain text otherwise.

def _readings(spans, chars):
    """Readings of the spans whose text lies inside `chars`."""
    return [s[1] for s in spans if s[0] and s[0] in chars]


@ja
@pytest.mark.parametrize("text, label", [
    ("（新田）おい", "新田"),
    ("（伏黒）おい", "伏黒"),
    ("（真人）\n聞いてんのか", "真人"),
    ("（藤沼弟）おお？\n（不良）ああ？", "藤沼弟不良"),
    ("-（新田）今日は\n-（虎杖）え？", "新田虎杖"),
    ("【新田】おい", "新田"),
    ("[新田]おい", "新田"),
    ("（足音）おい", "足音"),                         # an SFX label is markup too
    # The author glossed it, but MeCab splits the compound (伏+黒), so the
    # author's reading can't be placed — and MeCab's per-kanji guess is not shown.
    ("（伏黒(ふしぐろ)）おい", "伏黒"),
])
def test_ja_label_shows_no_generated_reading(text, label):
    spans, _words_ = _words("ja", text)
    assert _readings(spans, label) and not any(_readings(spans, label)), spans


@ja
def test_ja_label_keeps_the_author_reading_and_the_dialogue_keeps_its_own():
    spans, _words_ = _words("ja", "（金田(かなだ)）今日は")
    assert ("金田", "かなだ") in [tuple(s) for s in spans]      # tier 1 stays
    assert ("今日", "きょう") in [tuple(s) for s in spans]      # dialogue untouched


@ja
@pytest.mark.parametrize("text, expected", [
    ("（足音）おい", "(Ashioto)oi"),
    ("（小声）おい", "(Kogoe)oi"),
    ("-（足音）今日は\n-（虎杖）え？", "-(Ashioto)kyō wa -(Itadori)e?"),
    ("（金田(かなだ)）おい", "(Kanada)oi"),
])
@pytest.mark.parametrize("mode", ["macrons", "doubled", "unmarked"])
def test_ja_hiding_a_label_reading_does_not_touch_the_romaji(text, expected, mode):
    # The reading is hidden from the DISPLAY only.  spans_to_romaji still
    # pronounces the label (the desktop generator romanizes whole cues, labels
    # included) — never the raw kanji.
    from loom_core.romanize import get_japanese_pipeline
    resolve_spans, spans_to_romaji = get_japanese_pipeline()
    out = spans_to_romaji(resolve_spans(text), mode)
    assert out == expected.replace("ō", {"macrons": "ō", "doubled": "ou", "unmarked": "o"}[mode])
    assert not any("一" <= c <= "鿿" for c in out)


@ja
@pytest.mark.parametrize("text, words", [
    # A cue that is ONLY a label/SFX is content — there is nothing else — so it
    # keeps its reading and its clickable words, like a whole-cue （戦闘音）.
    ("（足音）", ["足音"]),
    # So is a cue made only of several markers — the same test the romaji route
    # applies (strip_speaker_markup keeps an all-markup cue, and romanizes it).
    ("（ため息）\n（金田）", ["ため息", "金田"]),
    ("（銃声）\n（悲鳴）", ["銃声", "悲鳴"]),
    ("（ドアが開く）\n（アルミン）", ["ドア", "が", "開く", "アルミン"]),
])
def test_ja_cue_of_nothing_but_markup_is_content(text, words):
    spans, got = _words("ja", text)
    assert got == words
    kanji = [s for s in spans if any("一" <= c <= "鿿" for c in s[0])]
    assert kanji and all(s[1] for s in kanji), spans


@ja
def test_ja_all_markup_cue_tokens_match_its_romaji_line():
    from loom_api.routes.romanize import romanize_batch, RomanizeBatchRequest
    resp = romanize_batch(RomanizeBatchRequest(texts=["（ため息）\n（金田）"], lang_code="ja"))
    assert resp.results[0].romanized == "(Tameiki)(Kaneda)"


@ja
def test_ja_kanji_parenthetical_after_a_label_is_kept_like_its_romaji():
    # （小声） right after the label glosses no word — a bracket precedes it, not a
    # word — so it is a stage direction, not reverse furigana.  The display keeps
    # it (as for the katakana analog), and the romaji line — built from the text
    # with only the leading label stripped — spells the same "(Kogoe)".
    from loom_api.routes.romanize import romanize_batch, RomanizeBatchRequest
    for text in ("（金田）（小声）おい", "（カネダ）（コゴエ）おい"):
        spans, words = _words("ja", text)
        assert "".join(s[0] for s in spans) == text
        assert "金田" not in words and "カネダ" not in words
    spans, words = _words("ja", "（金田）（小声）おい")
    assert "小声" in words and "おい" in words
    resp = romanize_batch(RomanizeBatchRequest(texts=["（金田）（小声）おい"], lang_code="ja"))
    assert resp.results[0].romanized == "(Kogoe)oi"
    # Mid-cue too.
    spans, _w = _words("ja", "おい\n（金田）（小声）\n聞いて")
    assert "".join(s[0] for s in spans) == "おい\n（金田）（小声）\n聞いて"


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
