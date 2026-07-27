"""The cache-key name and the compute engine must agree on `phonetic_system`.

The result cache keys annotate/romanize rows on the RESOLVED SYSTEM NAME
(loom_core.styles._annotation_system_name / romanization_name), while the
actual output is produced by loom_core.romanize.get_annotation_func /
get_romanizer.  Those two resolvers must never disagree about which system a
request asked for — if they can, one request writes engine A's output into
engine B's cache row and every later reader of that row is served the wrong
reading, permanently (only an ENGINE_VERSIONS bump clears it).

They DID disagree: the name resolver lowercases (`"Pinyin"` -> `Pinyin`) but
the engine resolver compared case-SENSITIVELY (`system == "pinyin"`), so
`phonetic_system:"Pinyin"` on zh-Hant produced ZHUYIN output stored under the
`Pinyin` key — the hottest zh-Hant key in prod, since the extension defaults
zh-Hant to Pinyin.  One unauthenticated request was enough to poison it.

These tests assert the invariant directly (same key name => same output) rather
than any particular normalization, so they keep holding if the resolvers change.
"""

import pytest

from loom_core.romanize import get_annotation_func, get_romanizer
from loom_core.styles import _annotation_system_name, get_lang_config

# (lang, probe text, systems that must all mean the same thing)
CASE_VARIANTS = [
    ("zh-Hant", "語", ["pinyin", "Pinyin", "PINYIN", " pinyin "]),
    ("zh-Hans", "语", ["zhuyin", "Zhuyin", "ZHUYIN"]),
    ("zh-Hant", "語", ["jyutping", "Jyutping"]),
]


@pytest.mark.parametrize("lang,probe,systems", CASE_VARIANTS)
def test_case_variants_resolve_to_one_cache_key_name(lang, probe, systems):
    names = {_annotation_system_name(lang, s) for s in systems}
    assert len(names) == 1, f"{systems} produced several cache-key names: {names}"


@pytest.mark.parametrize("lang,probe,systems", CASE_VARIANTS)
def test_case_variants_produce_identical_annotation_output(lang, probe, systems):
    """Same cache key => same bytes in the row. Anything else is poisoning."""
    outputs = []
    for s in systems:
        fn = get_annotation_func(lang, s)
        outputs.append(None if fn is None else list(fn(probe)))
    first = outputs[0]
    for s, out in zip(systems[1:], outputs[1:]):
        assert out == first, (
            f"{lang}: phonetic_system={s!r} yields different annotation output "
            f"than {systems[0]!r} while sharing one cache key -> poisoning"
        )


def test_case_variants_produce_identical_romanization_output():
    probe = "語"
    outs = []
    for s in ("pinyin", "Pinyin", "PINYIN"):
        fn = get_romanizer("zh-Hant", s)
        outs.append(None if fn is None else fn(probe))
    assert outs[0] == outs[1] == outs[2], f"romanizer disagrees across case: {outs}"


def test_thai_system_case_variants_agree():
    probe = "ไทย"
    names = {get_lang_config("th", phonetic_system=s).get("romanization_name")
             for s in ("rtgs", "RTGS")}
    assert len(names) == 1
    outs = [get_romanizer("th", s)(probe) for s in ("rtgs", "RTGS")]
    assert outs[0] == outs[1]


def test_unknown_system_is_stable_not_random():
    """An unrecognised system must at least be CONSISTENT: same name, same
    engine, every time — otherwise two junk values share one key with two
    different outputs."""
    a_name = _annotation_system_name("zh-Hant", "bogus")
    b_name = _annotation_system_name("zh-Hant", "garbage")
    if a_name == b_name:
        fa = get_annotation_func("zh-Hant", "bogus")
        fb = get_annotation_func("zh-Hant", "garbage")
        assert list(fa("語")) == list(fb("語"))
