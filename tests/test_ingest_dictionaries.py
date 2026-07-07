"""Tests for scripts/ingest_dictionaries.py parsers (VOCAB_LOOKUP.md §5).

Pure per-line (CC-CEDICT) / per-word (JMdict-simplified) parsers, loaded by
path since scripts/ is not an importable package.  The full-file counts and the
Postgres load get their acceptance test against the real downloaded dumps.
"""
import importlib.util
import pathlib
import sys

_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "ingest_dictionaries.py"
_spec = importlib.util.spec_from_file_location("ingest_dictionaries", _PATH)
ingest = importlib.util.module_from_spec(_spec)
# Register before exec so @dataclass can resolve the module's (stringized, via
# `from __future__ import annotations`) type hints — else KW_ONLY detection
# faults on a module missing from sys.modules.
sys.modules[_spec.name] = ingest
_spec.loader.exec_module(ingest)


# --------------------------------------------------------------------------- #
# CC-CEDICT
# --------------------------------------------------------------------------- #

def test_cedict_single_form_when_trad_equals_simp():
    rows = ingest.parse_cedict_line("你好 你好 [ni3 hao3] /hello; hi/\n")
    assert len(rows) == 1
    r = rows[0]
    assert (r.lang, r.headword, r.reading, r.source) == ("zh", "你好", "ni3 hao3", "cc-cedict")
    assert r.senses[0].gloss == ["hello; hi"]  # ';' kept verbatim inside a sense


def test_cedict_trad_simp_fanout():
    rows = ingest.parse_cedict_line("喜歡 喜欢 [xi3 huan5] /to like/\n")
    assert [r.headword for r in rows] == ["喜歡", "喜欢"]
    assert all(r.reading == "xi3 huan5" for r in rows)


def test_cedict_splits_senses_on_slash():
    rows = ingest.parse_cedict_line("吃 吃 [chi1] /to eat/to suffer/\n")
    assert len(rows) == 1
    assert [s.gloss[0] for s in rows[0].senses] == ["to eat", "to suffer"]


def test_cedict_skips_comments_blanks_garbage():
    assert ingest.parse_cedict_line("# CC-CEDICT\n") == []
    assert ingest.parse_cedict_line("\n") == []
    assert ingest.parse_cedict_line("not a valid entry\n") == []


# --------------------------------------------------------------------------- #
# JMdict-simplified
# --------------------------------------------------------------------------- #

def test_jmdict_verb_headword_reading_pos_common():
    tags = {"v1": "Ichidan verb", "vt": "transitive verb"}
    word = {
        "id": "1", "kanji": [{"common": True, "text": "食べる", "tags": []}],
        "kana": [{"common": True, "text": "たべる", "tags": [], "appliesToKanji": ["*"]}],
        "sense": [
            {"partOfSpeech": ["v1", "vt"], "gloss": [{"lang": "eng", "text": "to eat"}]},
            {"partOfSpeech": ["v1", "vt"], "gloss": [{"lang": "eng", "text": "to live on"}]},
        ],
    }
    rows = ingest.parse_jmdict_word(word, tags)
    assert len(rows) == 1
    r = rows[0]
    assert (r.lang, r.headword, r.reading, r.common) == ("ja", "食べる", "たべる", True)
    assert r.senses[0].pos == ["Ichidan verb", "transitive verb"]
    assert [s.gloss[0] for s in r.senses] == ["to eat", "to live on"]


def test_jmdict_kana_only_word_uses_kana_as_headword():
    word = {
        "id": "2", "kanji": [],
        "kana": [{"common": False, "text": "ニーハオ", "tags": [], "appliesToKanji": ["*"]}],
        "sense": [{"partOfSpeech": ["int"], "misc": ["uk"], "gloss": [{"lang": "eng", "text": "hello"}]}],
    }
    rows = ingest.parse_jmdict_word(word, {"int": "interjection", "uk": "usually kana"})
    assert len(rows) == 1
    assert rows[0].headword == "ニーハオ" and rows[0].reading == "ニーハオ"
    assert rows[0].senses[0].misc == ["usually kana"]


def test_jmdict_multi_kanji_fanout_shares_reading():
    word = {
        "id": "3",
        "kanji": [{"common": True, "text": "彼方", "tags": []},
                  {"common": False, "text": "あの方", "tags": []}],
        "kana": [{"common": True, "text": "あちら", "tags": [], "appliesToKanji": ["*"]}],
        "sense": [{"partOfSpeech": ["pn"], "gloss": [{"lang": "eng", "text": "that way"}]}],
    }
    rows = ingest.parse_jmdict_word(word, {"pn": "pronoun"})
    assert [r.headword for r in rows] == ["彼方", "あの方"]
    assert all(r.reading == "あちら" for r in rows)


def test_jmdict_entry_json_shape_drops_empty_tag_lists():
    word = {"id": "4", "kanji": [{"common": True, "text": "犬"}], "kana": [{"text": "いぬ"}],
            "sense": [{"partOfSpeech": ["n"], "gloss": [{"lang": "eng", "text": "dog"}]}]}
    j = ingest.parse_jmdict_word(word, {"n": "noun"})[0].to_json()
    assert j["headword"] == "犬" and j["reading"] == "いぬ" and j["common"] is True
    assert j["senses"] == [{"gloss": ["dog"], "pos": ["noun"]}]  # empty misc/field omitted


def test_jmdict_entry_with_no_glosses_yields_nothing():
    word = {"id": "5", "kanji": [{"text": "空"}], "kana": [{"text": "から"}], "sense": [{"gloss": []}]}
    assert ingest.parse_jmdict_word(word, {}) == []
