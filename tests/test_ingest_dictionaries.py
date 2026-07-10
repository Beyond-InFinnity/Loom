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


def test_cedict_default_source_and_gloss_lang():
    r = ingest.parse_cedict_line("吃 吃 [chi1] /to eat/\n")[0]
    assert r.source == "cc-cedict" and r.gloss_lang == "en"


def test_cfdict_reuses_cedict_format_with_french_gloss():
    # CFDICT (zh→fr) is CEDICT-format; same parser, source + gloss_lang differ.
    r = ingest.parse_cedict_line(
        "貓 猫 [mao1] /chat/\n", source="cfdict", gloss_lang="fr"
    )[0]
    assert (r.lang, r.source, r.gloss_lang) == ("zh", "cfdict", "fr")
    assert r.senses[0].gloss == ["chat"]


def test_handedict_reuses_cedict_format_with_german_gloss():
    r = ingest.parse_cedict_line(
        "貓 猫 [mao1] /Katze/\n", source="handedict", gloss_lang="de"
    )[0]
    assert (r.source, r.gloss_lang) == ("handedict", "de")


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


def test_jmdict_word_default_gloss_lang_and_override():
    word = {"id": "6", "kanji": [{"text": "犬"}], "kana": [{"text": "いぬ"}],
            "sense": [{"partOfSpeech": ["n"], "gloss": [{"lang": "ger", "text": "Hund"}]}]}
    assert ingest.parse_jmdict_word(word, {"n": "n"})[0].gloss_lang == "en"   # default
    assert ingest.parse_jmdict_word(word, {"n": "n"}, gloss_lang="de")[0].gloss_lang == "de"


def test_jmdict_auto_detects_gloss_lang_from_file_metadata(tmp_path):
    import json
    build = {
        "version": "3.6.2", "languages": ["ger"], "tags": {"n": "noun"},
        "words": [{"id": "1", "kanji": [{"text": "犬"}], "kana": [{"text": "いぬ"}],
                   "sense": [{"partOfSpeech": ["n"], "gloss": [{"lang": "ger", "text": "Hund"}]}]}],
    }
    p = tmp_path / "jmdict-ger-3.6.2.json"
    p.write_text(json.dumps(build), encoding="utf-8")
    rows = list(ingest.parse_jmdict(str(p)))       # ger→de auto-detected, no flag
    assert rows[0].gloss_lang == "de" and rows[0].senses[0].gloss == ["Hund"]


def test_jmdict_default_gloss_lang_is_en():
    word = {"id": "6", "kanji": [{"text": "本"}], "kana": [{"text": "ほん"}],
            "sense": [{"partOfSpeech": ["n"], "gloss": [{"lang": "eng", "text": "book"}]}]}
    assert ingest.parse_jmdict_word(word, {"n": "noun"})[0].gloss_lang == "en"


# --------------------------------------------------------------------------- #
# KRDict / NIKL LMF XML  (Korean → many languages)
# --------------------------------------------------------------------------- #

# Minimal LMF fragment mirroring the real DTD_LMF_REV_16 shape (feat att/val).
_KRDICT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource dtdVersion="16">
  <GlobalInformation>
    <feat att="label" val="한국어기초사전 - 국립국어원 제공" />
  </GlobalInformation>
  <Lexicon>
    <feat att="language" val="kor" />
    <LexicalEntry att="id" val="1001">
      <feat att="homonym_number" val="0" />
      <feat att="partOfSpeech" val="명사" />
      <Lemma><feat att="writtenForm" val="사람" /></Lemma>
      <WordForm><feat att="type" val="발음" /><feat att="pronunciation" val="사ː람" />
        <feat att="sound" val="http://dicmedia.korean.go.kr/x.wav" /></WordForm>
      <feat att="vocabularyLevel" val="초급" />
      <Sense att="id" val="1">
        <feat att="definition" val="생각을 하고 언어를 사용하는 동물." />
        <Equivalent><feat att="language" val="영어" /><feat att="lemma" val="person" />
          <feat att="definition" val="A being that thinks and speaks." /></Equivalent>
        <Equivalent><feat att="language" val="일본어" /><feat att="lemma" val="ひと【人】" />
          <feat att="definition" val="人。" /></Equivalent>
        <Equivalent><feat att="language" val="중국어" /><feat att="lemma" val="人" /></Equivalent>
      </Sense>
    </LexicalEntry>
    <LexicalEntry att="id" val="1002">
      <feat att="partOfSpeech" val="동사" />
      <Lemma><feat att="writtenForm" val="먹다" /></Lemma>
      <feat att="vocabularyLevel" val="없음" />
      <Sense att="id" val="1">
        <Equivalent><feat att="language" val="영어" /><feat att="lemma" val="to eat" /></Equivalent>
      </Sense>
    </LexicalEntry>
  </Lexicon>
</LexicalResource>
"""


def _write_krdict(tmp_path):
    p = tmp_path / "krdict_chunk.xml"
    p.write_text(_KRDICT_XML, encoding="utf-8")
    return str(p)


def test_krdict_one_row_per_gloss_language(tmp_path):
    rows = list(ingest.parse_krdict(_write_krdict(tmp_path)))
    person = [r for r in rows if r.headword == "사람"]
    assert {r.gloss_lang for r in person} == {"en", "ja", "zh"}
    assert all(r.lang == "ko" and r.source == "krdict" for r in person)


def test_krdict_headword_reading_pos_common(tmp_path):
    rows = list(ingest.parse_krdict(_write_krdict(tmp_path)))
    en = next(r for r in rows if r.headword == "사람" and r.gloss_lang == "en")
    assert en.reading == "사ː람"            # pronunciation, length mark kept
    assert en.senses[0].pos == ["noun"]     # 명사 → noun
    assert en.common is True                # 초급 → common
    # gloss = [translated headword, translated definition]
    assert en.senses[0].gloss == ["person", "A being that thinks and speaks."]


def test_krdict_gloss_without_definition_keeps_headword_only(tmp_path):
    rows = list(ingest.parse_krdict(_write_krdict(tmp_path)))
    zh = next(r for r in rows if r.headword == "사람" and r.gloss_lang == "zh")
    assert zh.senses[0].gloss == ["人"]     # no <definition> → just the equivalent


def test_krdict_verb_headword_kept_in_dictionary_form(tmp_path):
    # KRDict lists 먹다 (다-form) — the tokenizer's lemma must match THIS.
    rows = list(ingest.parse_krdict(_write_krdict(tmp_path)))
    verb = [r for r in rows if r.headword == "먹다"]
    assert verb and verb[0].gloss_lang == "en" and verb[0].common is False
    assert verb[0].senses[0].gloss == ["to eat"]


def test_krdict_sanitizes_unescaped_markup_in_values(tmp_path):
    # Real KRDict data has bare < > & inside translation values (a French gloss
    # `(gudeul <système…>)`), which is not well-formed XML.  The parser must
    # sanitize + still parse, and the char must round-trip on read.
    xml = (
        '<LexicalResource dtdVersion="16"><Lexicon>'
        '<LexicalEntry att="id" val="1"><feat att="partOfSpeech" val="명사" />'
        '<Lemma><feat att="writtenForm" val="온돌방" /></Lemma>'
        '<Sense att="id" val="1"><Equivalent><feat att="language" val="프랑스어" />'
        '<feat att="lemma" val="chambre (gudeul <système> & sol)" /></Equivalent>'
        '</Sense></LexicalEntry></Lexicon></LexicalResource>'
    )
    p = tmp_path / "bad.xml"
    p.write_text(xml, encoding="utf-8")
    rows = list(ingest.parse_krdict(str(p)))
    assert len(rows) == 1
    assert rows[0].senses[0].gloss == ["chambre (gudeul <système> & sol)"]


def test_krdict_strips_invalid_control_chars(tmp_path):
    # Real KRDict data has a stray \x08 (backspace) inside an Arabic gloss — an
    # invalid XML 1.0 char that crashes the parser.  It must be stripped.
    xml = (
        '<LexicalResource dtdVersion="16"><Lexicon>'
        '<LexicalEntry att="id" val="1"><feat att="partOfSpeech" val="명사" />'
        '<Lemma><feat att="writtenForm" val="세금" /></Lemma>'
        '<Sense att="id" val="1"><Equivalent><feat att="language" val="아랍어" />'
        '<feat att="lemma" val="المال\x08الذي" /></Equivalent>'
        '</Sense></LexicalEntry></Lexicon></LexicalResource>'
    )
    p = tmp_path / "ctrl.xml"
    p.write_text(xml, encoding="utf-8")
    rows = list(ingest.parse_krdict(str(p)))
    assert len(rows) == 1
    assert "\x08" not in rows[0].senses[0].gloss[0]
    assert rows[0].senses[0].gloss[0] == "المالالذي"


# --------------------------------------------------------------------------- #
# Wiktextract (kaikki JSONL — X → English)
# --------------------------------------------------------------------------- #

def _write_jsonl(tmp_path, objs):
    import json as _json
    p = tmp_path / "wikt.jsonl"
    p.write_text("\n".join(_json.dumps(o, ensure_ascii=False) for o in objs), encoding="utf-8")
    return str(p)


def test_wiktextract_basic_entry(tmp_path):
    path = _write_jsonl(tmp_path, [{
        "word": "comer", "lang_code": "es", "pos": "verb",
        "sounds": [{"ipa": "/koˈmeɾ/"}],
        "senses": [{"glosses": ["to eat"]}, {"glosses": ["to have lunch"], "tags": ["Spain"]}],
    }])
    rows = list(ingest.parse_wiktextract(path))
    assert len(rows) == 1
    r = rows[0]
    assert (r.lang, r.headword, r.gloss_lang, r.source) == ("es", "comer", "en", "wiktextract")
    assert r.reading == "koˈmeɾ"                       # IPA, slashes stripped
    assert [s.gloss[0] for s in r.senses] == ["to eat", "to have lunch"]
    assert r.senses[0].pos == ["verb"]
    assert r.senses[1].misc == ["Spain"]


def test_wiktextract_lang_filter(tmp_path):
    path = _write_jsonl(tmp_path, [
        {"word": "comer", "lang_code": "es", "pos": "verb", "senses": [{"glosses": ["to eat"]}]},
        {"word": "comer", "lang_code": "pt", "pos": "verb", "senses": [{"glosses": ["to eat"]}]},
    ])
    rows = list(ingest.parse_wiktextract(path, lang="es"))
    assert [r.lang for r in rows] == ["es"]


def test_wiktextract_pos_code_mapped(tmp_path):
    path = _write_jsonl(tmp_path, [
        {"word": "rojo", "lang_code": "es", "pos": "adj", "senses": [{"glosses": ["red"]}]},
    ])
    assert list(ingest.parse_wiktextract(path))[0].senses[0].pos == ["adjective"]


def test_wiktextract_skips_glossless_entries(tmp_path):
    path = _write_jsonl(tmp_path, [
        {"word": "x", "lang_code": "es", "pos": "noun", "senses": [{"tags": ["obsolete"]}]},
    ])
    assert list(ingest.parse_wiktextract(path)) == []


def test_wiktextract_keeps_form_of_as_fallback(tmp_path):
    # inflection entries are kept (they never displace a real card; useful when
    # the tokenizer's lemma misses).
    path = _write_jsonl(tmp_path, [{
        "word": "comieron", "lang_code": "es", "pos": "verb",
        "senses": [{"glosses": ["inflection of comer"], "form_of": [{"word": "comer"}]}],
    }])
    rows = list(ingest.parse_wiktextract(path))
    assert len(rows) == 1 and rows[0].senses[0].gloss == ["inflection of comer"]


def test_wiktextract_native_edition_gloss_lang_and_keep_langs(tmp_path):
    # A native edition (eswiktionary) shares the schema but glosses in Spanish
    # and holds MANY source langs; gloss_lang stamps the column, keep_langs takes
    # only the source langs we support (dropping the long tail).
    path = _write_jsonl(tmp_path, [
        {"word": "japonés", "lang_code": "es", "pos": "adj",
         "senses": [{"glosses": ["Originario de Japón."]}]},                 # es→es (diagonal)
        {"word": "cat", "lang_code": "en", "pos": "noun",
         "senses": [{"glosses": ["Animal felino doméstico."]}]},            # en→es (cross)
        {"word": "foo", "lang_code": "xyz", "pos": "noun",
         "senses": [{"glosses": ["Palabra rara."]}]},                        # unsupported → dropped
    ])
    rows = list(ingest.parse_wiktextract(
        path, gloss_lang="es", keep_langs={"es", "en"}))
    by = {(r.lang, r.headword): r for r in rows}
    assert set(by) == {("es", "japonés"), ("en", "cat")}                     # xyz dropped
    assert all(r.gloss_lang == "es" for r in rows)                           # es column
    assert by[("en", "cat")].senses[0].gloss == ["Animal felino doméstico."]


def test_krdict_never_reads_media_urls(tmp_path):
    # The sound/Multimedia URLs are not redistributable; they must not leak into
    # any row (reading is the pronunciation string, never a URL).
    rows = list(ingest.parse_krdict(_write_krdict(tmp_path)))
    assert all("http" not in (r.reading or "") for r in rows)
    assert all("http" not in g for r in rows for s in r.senses for g in s.gloss)
