"""Grammar-aware breakdown of inflected words (loom_core/grammar.py).

Japanese v1: the MeCab morpheme chain → dictionary form + an ordered list of
grammar features.  MeCab-gated (skips cleanly where fugashi/unidic-lite isn't
installed); the CI env has them, so these run there.
"""
import pytest

from loom_core.grammar import (
    analyze_grammar,
    analyze_japanese_grammar,
    grammar_supported,
)


def _mecab_available() -> bool:
    try:
        import fugashi  # noqa: F401
        from loom_core.romanize import get_shared_ja_tagger
        return get_shared_ja_tagger() is not None
    except Exception:
        return False


ja = pytest.mark.skipif(not _mecab_available(), reason="fugashi/unidic-lite unavailable")


def _codes(surface, continuation=""):
    b = analyze_japanese_grammar(surface, continuation)
    return b.dict_form, [f.code for f in b.features]


# --------------------------------------------------------------------------- #
# Core inflections
# --------------------------------------------------------------------------- #

@ja
def test_plain_dictionary_form_has_no_features():
    form, codes = _codes("食べる")
    assert form == "食べる"
    assert codes == []


@ja
def test_past():
    assert _codes("食べた") == ("食べる", ["past"])


@ja
def test_negative_verb():
    assert _codes("来ない") == ("来る", ["negative"])


@ja
def test_negative_adjective():
    # 高くない — the negating auxiliary is the adjective 無い, not 助動詞 ない.
    assert _codes("高くない") == ("高い", ["negative"])


@ja
def test_polite_past_suru_verb():
    # dict form must recover the full suru-verb 勉強する, not bare する.
    assert _codes("勉強しました") == ("勉強する", ["polite", "past"])


@ja
def test_te_form_connective():
    assert _codes("食べて") == ("食べる", ["te_form"])


@ja
def test_progressive_te_iru():
    # て + 居る collapses into ONE aspectual feature, not te_form + a stray verb.
    assert _codes("読んでいる") == ("読む", ["progressive"])


@ja
def test_volitional_from_cform():
    # 飲もう — volitional lives in the head's cForm (意志推量形), no separate morpheme.
    assert _codes("飲もう") == ("飲む", ["volitional"])


@ja
def test_imperative_from_cform():
    assert _codes("食べろ") == ("食べる", ["imperative"])


@ja
def test_provisional_conditional():
    assert _codes("行けば") == ("行く", ["conditional_ba"])


@ja
def test_desiderative():
    assert _codes("食べたい") == ("食べる", ["desiderative"])


@ja
def test_na_adjective_copula_past():
    assert _codes("静かだった") == ("静か", ["copula", "past"])


# --------------------------------------------------------------------------- #
# Stacked chains — order is inner→outer
# --------------------------------------------------------------------------- #

@ja
def test_causative_passive_desiderative_negative_past_chain():
    form, codes = _codes("食べさせられたくなかった")
    assert form == "食べる"
    assert codes == [
        "causative", "passive_potential", "desiderative", "negative", "past",
    ]


@ja
def test_aspectual_then_past():
    assert _codes("行ってしまった") == ("行く", ["completive", "past"])


@ja
def test_passive_potential_is_flagged_ambiguous():
    form, codes = _codes("食べられる")
    assert codes == ["passive_potential"]
    disp = analyze_japanese_grammar("食べられる").features[0].display
    assert "passive" in disp and "potential" in disp  # ambiguity surfaced


@ja
def test_feature_surface_points_at_the_morpheme():
    b = analyze_japanese_grammar("食べた")
    assert b.features[0].surface == "た"


# --------------------------------------------------------------------------- #
# Non-inflecting / edge cases
# --------------------------------------------------------------------------- #

@ja
def test_bare_noun_returns_none():
    assert analyze_japanese_grammar("猫") is None


def test_empty_input_returns_none():
    assert analyze_japanese_grammar("") is None
    assert analyze_japanese_grammar("   ") is None


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

def test_chinese_has_no_grammar_analyzer():
    # Chinese is analytic — no inflection — so grammar analysis is None by design.
    assert analyze_grammar("你好", "zh") is None
    assert grammar_supported("zh") is False


def test_grammar_supported_flags_japanese():
    assert grammar_supported("ja") is True
    assert grammar_supported("ja-JP") is True
    assert grammar_supported("zh") is False


@ja
def test_dispatch_routes_japanese():
    b = analyze_grammar("食べた", "ja")
    assert b is not None and b.dict_form == "食べる"


# --------------------------------------------------------------------------- #
# /define/batch delivery
# --------------------------------------------------------------------------- #

@ja
def test_define_route_attaches_grammar_from_surface():
    from loom_api.routes.define import define_batch, DefineRequest
    # Client sends the lemma as the key + the inflected surface separately.
    req = DefineRequest(
        lang="ja", words=["食べる"], surfaces=["食べさせられた"], readings=[""],
    )
    g = define_batch(req).results[0].grammar
    assert g is not None
    assert g.dict_form == "食べる"
    assert [f.code for f in g.features] == ["causative", "passive_potential", "past"]


@ja
def test_define_route_no_grammar_for_plain_form():
    from loom_api.routes.define import define_batch, DefineRequest
    req = DefineRequest(lang="ja", words=["猫"], surfaces=["猫"])
    assert define_batch(req).results[0].grammar is None


def test_define_route_no_grammar_for_chinese():
    from loom_api.routes.define import define_batch, DefineRequest
    req = DefineRequest(lang="zh", words=["你好"], surfaces=["你好"])
    assert define_batch(req).results[0].grammar is None


@ja
def test_define_route_falls_back_to_word_when_no_surface():
    from loom_api.routes.define import define_batch, DefineRequest
    # No `surfaces` → analyze the primary key itself.
    req = DefineRequest(lang="ja", words=["食べた"])
    g = define_batch(req).results[0].grammar
    assert g is not None and [f.code for f in g.features] == ["past"]


# --------------------------------------------------------------------------- #
# Continuation stitching — a predicate split across cues (finding ③)
# --------------------------------------------------------------------------- #

@ja
def test_continuation_recovers_te_form_across_split():
    # 利用し | てタム上に狙った → 利用して (te-form), not a bare 連用形 stem.
    assert _codes("利用し", "てタム上に狙った") == ("利用する", ["te_form"])


@ja
def test_continuation_recovers_progressive_across_split():
    # 食べ | ている → 食べている (progressive), the aspectual stitched from the next cue.
    assert _codes("食べ", "ている") == ("食べる", ["progressive"])


@ja
def test_continuation_does_not_absorb_next_words_inflection():
    # THE correctness case: 食べ | て寝た must be 食べる[te-form], NOT [te-form, past]
    # — the past belongs to 寝た (a new word), which the boundary stop excludes.
    assert _codes("食べ", "て寝た") == ("食べる", ["te_form"])


@ja
def test_continuation_harmless_when_word_already_complete():
    # A complete surface + continuation == the surface analysed alone.
    assert _codes("食べさせられた", "それは違う") == _codes("食べさせられた")


@ja
def test_continuation_strips_next_cue_speaker_label():
    # The next cue often starts with a （名） label — it must not derail the stitch.
    assert _codes("食べ", "（花子）ている") == ("食べる", ["progressive"])


@ja
def test_define_route_threads_continuation():
    from loom_api.routes.define import define_batch, DefineRequest
    req = DefineRequest(
        lang="ja", words=["利用する"], surfaces=["利用し"],
        surface_continuations=["てタム上に狙った"],
    )
    g = define_batch(req).results[0].grammar
    assert g is not None
    assert g.dict_form == "利用する"
    assert [f.code for f in g.features] == ["te_form"]


# --------------------------------------------------------------------------- #
# Korean (kiwipiepy) — same GrammarBreakdown shape, agglutinative ending chain
# --------------------------------------------------------------------------- #

def _kiwi_available() -> bool:
    try:
        from loom_core.romanize import _get_kiwi
        return _get_kiwi() is not None
    except Exception:
        return False


ko = pytest.mark.skipif(not _kiwi_available(), reason="kiwipiepy unavailable")


def _kcodes(surface, continuation=""):
    from loom_core.grammar import analyze_korean_grammar
    b = analyze_korean_grammar(surface, continuation)
    return (b.dict_form, [f.code for f in b.features]) if b else None


@ko
def test_ko_plain_dict_form_has_no_features():
    assert _kcodes("먹다") == ("먹다", [])


@ko
def test_ko_past_polite():
    assert _kcodes("먹었어요") == ("먹다", ["past", "polite"])


@ko
def test_ko_formal_polite():
    assert _kcodes("먹습니다") == ("먹다", ["formal_polite"])


@ko
def test_ko_honorific_past_polite_stack():
    # 가셨어요 — honorific 시 + past 었 + polite 요, inner→outer.
    assert _kcodes("가셨어요") == ("가다", ["honorific", "past", "polite"])


@ko
def test_ko_negative_adverb_and_long_negative():
    assert _kcodes("안 먹어요") == ("먹다", ["negative", "polite"])
    assert _kcodes("먹지 않아요") == ("먹다", ["negative", "polite"])


@ko
def test_ko_inability():
    assert _kcodes("못 먹어요") == ("먹다", ["inability", "polite"])


@ko
def test_ko_progressive_and_desiderative():
    assert _kcodes("먹고 있어요") == ("먹다", ["progressive", "polite"])
    assert _kcodes("먹고 싶어요") == ("먹다", ["desiderative", "polite"])


@ko
def test_ko_obligation_and_potential():
    assert _kcodes("먹어야 해요") == ("먹다", ["obligation", "polite"])
    assert _kcodes("먹을 수 있어요") == ("먹다", ["potential", "polite"])


@ko
def test_ko_presumptive():
    assert _kcodes("먹겠어요") == ("먹다", ["presumptive", "polite"])


@ko
def test_ko_suru_style_hada_verb_dict_form():
    # 공부했어요 → the dict form recovers the full 하다-verb 공부하다, not bare 하다.
    assert _kcodes("공부했어요") == ("공부하다", ["past", "polite"])


@ko
def test_ko_adjective_and_copula():
    assert _kcodes("깨끗해요") == ("깨끗하다", ["polite"])
    assert _kcodes("학생이에요") == ("학생이다", ["copula", "polite"])


@ko
def test_ko_imperative_and_propositive():
    assert _kcodes("먹어라") == ("먹다", ["imperative"])
    assert _kcodes("먹자") == ("먹다", ["propositive"])


@ko
def test_ko_bare_noun_returns_none():
    from loom_core.grammar import analyze_korean_grammar
    assert analyze_korean_grammar("사람") is None


@ko
def test_ko_continuation_recovers_construction_across_split():
    # 먹 | 고 있어요 → 먹다[progressive], the aspectual stitched from the next cue.
    assert _kcodes("먹", "고 있어요") == ("먹다", ["progressive", "polite"])


@ko
def test_ko_continuation_does_not_absorb_next_verb():
    # 먹 | 어서 자요 → 먹다[connective_cause]; must NOT pull 자다's polite ending.
    assert _kcodes("먹", "어서 자요") == ("먹다", ["connective_cause"])


def test_grammar_supported_now_includes_korean():
    from loom_core.grammar import grammar_supported
    assert grammar_supported("ko") is True
    assert grammar_supported("ko-KR") is True


@ko
def test_define_route_attaches_korean_grammar():
    from loom_api.routes.define import define_batch, DefineRequest
    req = DefineRequest(lang="ko", words=["먹다"], surfaces=["먹었어요"])
    g = define_batch(req).results[0].grammar
    assert g is not None and g.dict_form == "먹다"
    assert [f.code for f in g.features] == ["past", "polite"]
