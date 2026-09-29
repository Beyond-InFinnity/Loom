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

from loom_api import deps as _deps
from loom_core.romanize import get_annotation_func, get_romanizer
from loom_core.styles import _annotation_system_name, get_lang_config
from loom_core.styles import cache_lang as _cache_lang

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


# --------------------------------------------------------------------------- #
# A phonetic_system that is not valid FOR THE LANGUAGE (finding H-2)
#
# Case-normalization closed one gap, but the name resolver and the engine
# resolver still disagreed whenever the requested system belongs to ANOTHER
# language family.  The name side fell back to the language's default NAME
# (th -> "Paiboon+ (with tones)", zh-Hant -> _ROMANIZATION_META "Pinyin"),
# while the engine side fell through to its own auto-resolution:
#
#   th      + "pinyin"/"zhuyin"/"x"  named Paiboon+  computed tone-less RTGS
#   zh-Hant + "rtgs"/"din"/"x"        named Pinyin    computed Zhuyin
#   zh-HK   + "rtgs"/"x"              named Pinyin    computed Jyutping
#
# and the cache is insert-first-wins with no TTL.  Not an attack-only path:
# the extension sends ONE global phonetic-system override to every language
# (discover.ts effectiveTargetPhoneticSystem), so a user who picked Zhuyin for
# Chinese sends "zhuyin" with every Thai request.
#
# The property below drives the REAL route handlers — so the REAL key
# construction, cache_key(kind, cache_lang, system name, mode, engine_version,
# text) — over a broad lang x system matrix and asserts: any two requests that
# write the same cache key wrote the same output.
# --------------------------------------------------------------------------- #


class _RecordingCache:
    """Always-miss result cache that records every row a route writes."""

    def __init__(self):
        self.rows = []

    def get_many(self, keys):
        return {}

    def put_many(self, rows):
        self.rows.extend(rows)


_PROPERTY_LANGS = [
    "ja", "zh", "zh-Hans", "zh-Hant", "zh-TW", "zh-HK", "yue", "cmn-Hant",
    "ko", "th", "hi", "ta", "ru", "uk", "he", "ar", "fa", "ur", "es", "en",
    "jpn", "tha",
]
_KNOWN_SYSTEMS = [
    "pinyin", "zhuyin", "jyutping",      # Chinese family
    "rtgs", "paiboon", "ipa",            # Thai
    "learner", "din", "loose",           # Arabic
    "dmg",                               # Persian (+ learner)
    "ala-lc",                            # Urdu (+ learner)
]
_PROPERTY_SYSTEMS = [None, *_KNOWN_SYSTEMS,
                     "Pinyin", "ZHUYIN", " Jyutping ", "RTGS", "Paiboon", "IPA",
                     "DIN", "ALA-LC", "x", ""]

# One sample per cache_lang class, so every code in a class probes the SAME
# text — a collision needs the same key, and the key includes the text.
_CHINESE_SAMPLE = ["我們今天去看電影，銀行在哪裡？", "我喜欢看电影"]
_PROPERTY_SAMPLES = {
    "ja": ["東京に行きます"], "ko": ["안녕하세요 먹었어요"],
    "th": ["สวัสดีครับ ขอบคุณมาก"], "hi": ["नमस्ते दुनिया"],
    "ta": ["வணக்கம் உலகம்"], "ru": ["Привет мир"], "uk": ["Привіт світ"],
    "he": ["שלום עולם"], "ar": ["مرحبا بالعالم الشمس"],
    "fa": ["سلام دنیا چطوری"], "ur": ["پاکستان ٹھیک ہے"],
    "es": ["Los gatos comieron pescado"], "en": ["The cats ate fish"],
}


def _property_texts(lang):
    clang = _cache_lang(lang)
    if clang in ("zh-Hans", "zh-Hant", "yue"):
        return _CHINESE_SAMPLE
    return _PROPERTY_SAMPLES[clang]


def _route(kind):
    from fastapi import HTTPException

    from loom_api.routes.annotate import (
        AnnotateBatchRequest, AnnotateRequest, annotate, annotate_batch)
    from loom_api.routes.romanize import (
        RomanizeBatchRequest, RomanizeRequest, romanize, romanize_batch)

    if kind == "romanize/batch":
        return lambda lang, s, texts: romanize_batch(
            RomanizeBatchRequest(texts=texts, lang_code=lang, phonetic_system=s))
    if kind == "annotate/batch":
        return lambda lang, s, texts: annotate_batch(
            AnnotateBatchRequest(texts=texts, lang_code=lang, phonetic_system=s))
    if kind == "romanize":
        def _single_romanize(lang, s, texts):
            for t in texts:
                try:
                    romanize(RomanizeRequest(text=t, lang_code=lang, phonetic_system=s))
                except HTTPException as e:  # 400 = no phonetic layer (es/en)
                    assert e.status_code == 400
        return _single_romanize

    def _single_annotate(lang, s, texts):
        for t in texts:
            annotate(AnnotateRequest(text=t, lang_code=lang, phonetic_system=s))
    return _single_annotate


@pytest.mark.parametrize("kind", ["romanize/batch", "annotate/batch", "romanize", "annotate"])
def test_same_cache_key_always_means_same_output(kind):
    call = _route(kind)
    seen = {}         # key -> (output, lang, system)
    collisions = []
    try:
        for lang in _PROPERTY_LANGS:
            texts = _property_texts(lang)
            for s in _PROPERTY_SYSTEMS:
                rec = _RecordingCache()
                _deps.set_result_cache(rec)
                call(lang, s, texts)
                for row in rec.rows:
                    first = seen.setdefault(row.key, (row.output, lang, s))
                    if first[0] != row.output:
                        collisions.append(
                            f"{row.lang_code}/{row.phonetic_system!r}: "
                            f"{first[1]}+{first[2]!r} -> {first[0]!r}  vs  "
                            f"{lang}+{s!r} -> {row.output!r}")
    finally:
        _deps.set_result_cache(None)
    assert not collisions, (
        f"{len(collisions)} cache-key collisions (same key, different output):\n  "
        + "\n  ".join(collisions[:12]))


# Valid explicit choices must keep their exact cache-key NAME — a name change
# orphans every cached row for that choice (a needless cold start).
_VALID_ROMANIZATION_NAMES = [
    ("zh-Hans", None, "Pinyin"), ("zh-Hans", "zhuyin", "Zhuyin (Bopomofo)"),
    ("zh-Hant", None, "Pinyin"), ("zh-Hant", "pinyin", "Pinyin"),
    ("zh-Hant", "jyutping", "Jyutping"), ("zh-HK", None, "Jyutping"),
    ("zh-HK", "pinyin", "Pinyin"), ("yue", None, "Jyutping"),
    ("yue", "pinyin", "Jyutping"),  # yue's romanize LINE is always Jyutping
    ("th", None, "Paiboon+ (with tones)"), ("th", "paiboon", "Paiboon+ (with tones)"),
    ("th", "rtgs", "RTGS (no tones)"), ("th", "ipa", "IPA"),
    ("ar", None, "Arabic transliteration"), ("ar", "learner", "Arabic (learner hybrid)"),
    ("ar", "din", "DIN 31635"), ("ar", "loose", "Loose phonetic"),
    ("fa", None, "Persian transliteration"), ("fa", "dmg", "DMG (scholarly)"),
    ("ur", None, "Urdu transliteration"), ("ur", "ala-lc", "ALA-LC (scholarly)"),
    ("ja", None, "Romaji / Furigana"), ("ko", None, "Revised Romanization"),
]


@pytest.mark.parametrize("lang,system,name", _VALID_ROMANIZATION_NAMES)
def test_valid_choices_keep_their_romanization_name(lang, system, name):
    assert get_lang_config(lang, phonetic_system=system)["romanization_name"] == name


_VALID_ANNOTATION_NAMES = [
    ("zh-Hans", None, "Pinyin"), ("zh-Hant", None, "Pinyin"),
    ("zh-Hant", "pinyin", "Pinyin"), ("zh-Hant", "jyutping", "Jyutping"),
    ("zh-HK", None, "Jyutping"), ("yue", None, "Jyutping"), ("yue", "pinyin", "Pinyin"),
    ("th", None, "Paiboon+"), ("th", "rtgs", "RTGS"), ("th", "ipa", "IPA"),
    ("ja", None, "Furigana"), ("ko", None, "Romanization"),
    ("ru", None, "Transliteration"), ("hi", None, "Transliteration"),
]


@pytest.mark.parametrize("lang,system,name", _VALID_ANNOTATION_NAMES)
def test_valid_choices_keep_their_annotation_name(lang, system, name):
    assert get_lang_config(lang, phonetic_system=system)["annotation_system_name"] == name


@pytest.mark.parametrize("lang,system,probe", [
    ("th", "pinyin", "สวัสดีครับ"),       # a global Chinese override reaching Thai
    ("th", "zhuyin", "สวัสดีครับ"),
    ("th", "x", "สวัสดีครับ"),
    ("zh-Hant", "rtgs", "我們去看電影"),   # a global Thai override reaching Chinese
    ("zh-Hant", "din", "我們去看電影"),
    ("zh-HK", "x", "我哋今日去睇戲"),
    ("ar", "pinyin", "مرحبا بالعالم"),
])
def test_foreign_system_falls_back_to_the_language_default(lang, system, probe):
    """A system from another family means 'use this language's default' —
    for the NAME and the ENGINE alike, so it lands on the default's key with
    the default's bytes."""
    got = get_lang_config(lang, phonetic_system=system)
    default = get_lang_config(lang)
    assert got["romanization_name"] == default["romanization_name"]
    assert got["annotation_system_name"] == default["annotation_system_name"]
    assert got["romanize_func"](probe) == default["romanize_func"](probe)
    ga, da = got["annotation_func"], default["annotation_func"]
    assert (ga is None) == (da is None)
    if ga is not None:
        assert list(ga(probe)) == list(da(probe))


def test_effective_phonetic_system_is_family_scoped():
    from loom_core.romanize import effective_phonetic_system as eff

    # Valid for the language's family -> the normalized value.
    assert eff("zh-Hant", " Pinyin ") == "pinyin"
    assert eff("zh-HK", "zhuyin") == "zhuyin"
    assert eff("yue", "jyutping") == "jyutping"
    assert eff("cht", "PINYIN") == "pinyin"          # alias codes resolve too
    assert eff("th", "IPA") == "ipa"
    assert eff("tha", "rtgs") == "rtgs"
    assert eff("ar", "din") == "din"
    assert eff("fa", "dmg") == "dmg"
    assert eff("ur", "ala-lc") == "ala-lc"
    # Another family's system, junk, or nothing -> None (the language default).
    assert eff("th", "pinyin") is None
    assert eff("zh-Hant", "rtgs") is None
    assert eff("ar", "dmg") is None                  # Persian-only system
    assert eff("fa", "din") is None                  # Arabic-only system
    assert eff("ja", "pinyin") is None               # ja/ko/... offer no choice
    assert eff("ko", "zhuyin") is None
    assert eff("th", "x") is None
    assert eff("th", "") is None
    assert eff("th", None) is None


def test_foreign_override_no_longer_blanks_korean_ruby():
    """User-visible face of the bug: under a global Pinyin override the Korean
    track got the CHINESE annotator (every reading None — blank ruby).  The
    override is meaningless for Korean, so Korean RR ruby comes back."""
    cfg = get_lang_config("ko", phonetic_system="pinyin")
    assert cfg["annotation_system_name"] == "Romanization"
    assert any(r for _, r in cfg["annotation_func"]("안녕하세요"))


def test_direct_engine_calls_honour_the_same_scoping():
    """get_annotation_func / get_romanizer are public too — a Chinese system on
    a Japanese or Thai code must not hand back a Chinese engine."""
    ja = get_annotation_func("ja", "pinyin")
    assert any(r and all("぀" <= c <= "ゟ" for c in r) for _, r in ja("東京"))
    assert get_romanizer("th", "pinyin")("สวัสดีครับ") == get_romanizer("th")("สวัสดีครับ")
