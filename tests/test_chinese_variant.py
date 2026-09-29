"""One subtag-parsing Chinese-variant classifier (finding COR-9).

Which Chinese script variant a lang code names — Simplified (Pinyin default),
Traditional (Zhuyin default, and the Traditional->Simplified bridge in front of
jieba), or Cantonese (Jyutping) — used to be decided by SIX separate
exact-string checks (`lc in ("zh-hant", "zh-tw")`, `lc == "zh-hk"`, a
`_TRADITIONAL_LANGS` set, ...) in styles.py and romanize.py.  Any tag with an
extra subtag fell through all of them to Simplified:

    zh-Hant-TW / zh-Hant-HK / zh-MO / zh_TW   ->  cache_lang zh-Hans, Pinyin,
                                                  and jieba WITHOUT the t2s bridge
                                                  (臺|灣的|颱|風季節 — nonsense words)

Now every site asks `classify_chinese_variant()`, which parses subtags:
script Hant, or region TW/MO -> Traditional; region HK with no script ->
Cantonese (today's policy); script Hans -> Simplified; `yue*` -> Cantonese.

HARD REQUIREMENT: every code that was canonical before keeps EXACTLY its
cache_lang (else live cache rows orphan).  Only the previously-misclassified
codes move.
"""

import pytest

from loom_core.romanize import build_word_tokens, classify_chinese_variant, engine_version
from loom_core.styles import _chinese_variant, cache_lang, get_lang_config


# Code -> cache_lang BEFORE this change, captured from the pre-fix code.  These
# must not move.
CANONICAL_TODAY = {
    "zh": "zh-Hans", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant",
    "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", "zh-HK": "yue", "zh-SG": "zh-Hans",
    "zh-yue": "zh-Hans",   # (sic) — extlang yue has always been Simplified here
    "yue": "yue", "yue-HK": "yue", "cmn": "zh-Hans", "cmn-Hans": "zh-Hans",
    "cmn-Hant": "zh-Hant", "chi": "zh-Hans", "zho": "zh-Hans", "chs": "zh-Hans",
    "cht": "zh-Hant", "CantoCaptions": "cantocaptions", "zh-Hans-HK": "zh-Hans",
    "zh-hans": "zh-Hans", "zh-hant": "zh-Hant", "zh-tw": "zh-Hant",
    "zh-hk": "yue", "zh-cn": "zh-Hans", "ZH-TW": "zh-Hant",
}

# Previously misclassified -> what they are.
PREVIOUSLY_WRONG = {
    "zh-Hant-TW": "zh-Hant", "zh-Hant-HK": "zh-Hant", "zh-Hant-MO": "zh-Hant",
    "zh-MO": "zh-Hant", "zh_TW": "zh-Hant", "zh_Hant": "zh-Hant",
    "zh_HK": "yue", "cmn-Hant-TW": "zh-Hant", "zh-cmn-Hant": "zh-Hant",
    "zh-Hant_TW": "zh-Hant",
}


@pytest.mark.parametrize("code,clang", sorted(CANONICAL_TODAY.items()))
def test_canonical_codes_keep_their_cache_lang(code, clang):
    assert cache_lang(code) == clang


@pytest.mark.parametrize("code,clang", sorted(PREVIOUSLY_WRONG.items()))
def test_extra_subtag_codes_are_classified_by_script_and_region(code, clang):
    assert cache_lang(code) == clang


def test_script_subtag_beats_region():
    assert classify_chinese_variant("zh-Hans-TW") == "zh-Hans"
    assert classify_chinese_variant("zh-Hant-HK") == "zh-Hant"   # not Cantonese
    assert classify_chinese_variant("zh-Hans-HK") == "zh-Hans"


def test_non_chinese_and_empty():
    for code in ("ja", "ko", "en", "th", "", None, "cantocaptions", "zhx", "hant"):
        assert classify_chinese_variant(code) is None


def test_private_use_and_extension_subtags_are_ignored():
    # Everything after a singleton (x-, u-, ...) is not a script/region.
    assert classify_chinese_variant("zh-x-tw") == "zh-Hans"
    assert classify_chinese_variant("zh-u-sd-hk") == "zh-Hans"


def test_styles_chinese_variant_is_the_same_classifier():
    for code in [*CANONICAL_TODAY, *PREVIOUSLY_WRONG]:
        assert _chinese_variant(code) == classify_chinese_variant(code), code


# ---- every consumer agrees with the classifier -----------------------------

_EXPECTED_DEFAULT_NAMES = {
    "zh-Hans": ("Pinyin", "Pinyin"),
    "zh-Hant": ("Pinyin", "Pinyin"),   # Taiwan uses Pinyin; Zhuyin is opt-in
    "yue": ("Jyutping", "Jyutping"),
}


@pytest.mark.parametrize("code", sorted(set(PREVIOUSLY_WRONG) | {
    "zh", "zh-Hans", "zh-Hant", "zh-TW", "zh-HK", "cht", "chs", "yue"}))
def test_names_variant_and_engine_follow_the_classifier(code):
    cfg = get_lang_config(code)
    variant = cache_lang(code)
    rom_name, ann_name = _EXPECTED_DEFAULT_NAMES[variant]
    assert cfg["chinese_variant"] == variant
    assert cfg["romanization_name"] == rom_name
    assert cfg["annotation_system_name"] == ann_name
    # The engine resolves the same way as the name: a zh-Hant-TW line reads
    # exactly like a zh-Hant line (Pinyin with the t2s jieba bridge), not
    # like zh-Hans (no bridge, so Traditional text mis-segments).
    probe = "臺灣的颱風季節"
    ref = get_lang_config({"zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant", "yue": "yue"}[variant])
    assert cfg["romanize_func"](probe) == ref["romanize_func"](probe)
    assert list(cfg["annotation_func"](probe)) == list(ref["annotation_func"](probe))
    assert engine_version(code) == engine_version(variant)


def test_traditional_extra_subtag_gets_the_t2s_jieba_bridge():
    """The user-visible symptom: without the Traditional->Simplified bridge,
    jieba (a Simplified dictionary) mis-segments Traditional text into
    nonsense clickable words."""
    text = "臺灣的颱風季節通常從七月開始"
    ann = get_lang_config("zh-Hant")["annotation_func"]
    spans = ann(text)
    ref = [t[0] for t in build_word_tokens(text, "zh-Hant", spans, ann)]
    assert ref[:4] == ["臺灣", "的", "颱風", "季節"]
    for code in ("zh-Hant-TW", "zh-MO", "zh_TW"):
        got = [t[0] for t in build_word_tokens(text, code, spans, ann)]
        assert got == ref, code


def test_default_fonts():
    fonts = {c: get_lang_config(c)["default_font"] for c in (
        "zh", "zh-Hans", "zh-Hant", "zh-TW", "zh-HK", "yue", "cht", "chs",
        "zh-Hant-TW", "zh-MO", "zh-Hant-HK", "zh_HK", "zh-Hans-HK")}
    assert fonts == {
        # unchanged
        "zh": "Noto Sans CJK SC", "zh-Hans": "Noto Sans CJK SC",
        "zh-Hant": "Noto Sans CJK TC", "zh-TW": "Noto Sans CJK TC",
        "zh-HK": "Noto Sans CJK HK", "yue": "Noto Sans CJK HK",
        "cht": "Noto Sans CJK TC", "chs": "Noto Sans CJK SC",
        "zh-Hans-HK": "Noto Sans CJK SC",
        # previously SC (Simplified glyph forms for Traditional text)
        "zh-Hant-TW": "Noto Sans CJK TC", "zh-MO": "Noto Sans CJK TC",
        "zh-Hant-HK": "Noto Sans CJK TC", "zh_HK": "Noto Sans CJK HK",
    }


# ---- the classifier parses the code EXACTLY as the engines do ---------------
#
# Every engine-side primary extraction (get_romanizer, get_annotation_func,
# get_lang_config, _annotation_system_name, build_word_tokens) is
# `lower().split("-")[0].split("_")[0]` — no strip.  A classifier that stripped
# whitespace or skipped a leading empty subtag gave ' zh-TW' / '-zh' a Chinese
# cache_lang while the engines treated them as unknown, writing
# {"spans": [], "tokens": []} under the (zh-*, "Annotation") keys: a new
# cache_lang-vs-engine divergence, the pattern cache_lang exists to rule out.

@pytest.mark.parametrize("code", [
    " zh", "zh ", "-zh", "_zh", " zh-TW", "-zh-HK", "\tzh", "-yue", " yue", "yue "])
def test_malformed_codes_classify_exactly_as_the_engines_parse_them(code):
    primary = code.lower().split("-")[0].split("_")[0]
    assert primary not in ("zh", "yue"), "precondition: the engines see non-Chinese"
    assert classify_chinese_variant(code) is None
    # ...so cache_lang falls back to the same primary the engines key off
    # (today's value for these codes, unchanged).
    assert cache_lang(code) == primary
