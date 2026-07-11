"""Wiktionary form-of resolution + grammar-from-tags (intelligent inflected-word
handling for Hindi, Spanish, French, German, Russian, … — every Wiktextract
language).

An inflected form (करते, comieron, Kinder) is stored as a "form-of" entry that
names its lemma in the gloss and carries structured grammatical `tags`.  The
/define route follows the gloss to the lemma for the REAL definition and turns
the tags into a GrammarBreakdown.  Pure functions run anywhere; the route test
uses the InMemory store.
"""
import pytest

from loom_core.grammar import extract_form_of_lemma, grammar_from_tags
from loom_api.deps import set_dictionary_store
from loom_api.dictionary import InMemoryDictionaryStore


# --------------------------------------------------------------------------- #
# extract_form_of_lemma
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("gloss, lemma", [
    ("inflection of करना (karnā):", "करना"),
    ("oblique plural of घटना (ghaṭnā)", "घटना"),
    ("first-person singular masculine future indicative of लेना (lenā)", "लेना"),
    ("third-person plural preterite indicative of comer", "comer"),
    ("plural of niño", "niño"),
    ("past participle of manger", "manger"),
    ("nominative/accusative/genitive plural of Kind", "Kind"),
    ("masculine singular past indicative imperfective of чита́ть (čitátʹ)", "читать"),  # stress stripped
])
def test_extract_lemma(gloss, lemma):
    assert extract_form_of_lemma(gloss) == lemma


@pytest.mark.parametrize("gloss", [
    "a small domestic animal",   # a real definition, not a form-of
    "",
    None,
])
def test_extract_lemma_none_for_non_form_of(gloss):
    assert extract_form_of_lemma(gloss) is None


# --------------------------------------------------------------------------- #
# grammar_from_tags
# --------------------------------------------------------------------------- #

def _codes(tags, lemma="X"):
    b = grammar_from_tags(tags, lemma)
    return (b.dict_form, [f.code for f in b.features]) if b else None


def test_grammar_from_tags_orders_features_canonically():
    # Alphabetical misc → canonical order (aspect/tense → mood → person → number → gender).
    assert _codes(
        ["first-person", "form-of", "future", "indicative", "masculine", "singular"],
        "लेना",
    ) == ("लेना", ["future", "indicative", "first-person", "singular", "masculine"])


def test_grammar_from_tags_drops_markers_and_unknowns():
    # 'form-of' + an unrecognized tag are dropped; only real features remain.
    assert _codes(["form-of", "habitual", "masculine", "participle", "plural", "xyzzy"]) == (
        "X", ["habitual", "participle", "plural", "masculine"],
    )


def test_grammar_from_tags_case_feature():
    assert _codes(["form-of", "oblique", "plural"]) == ("X", ["plural", "oblique"])


def test_grammar_from_tags_none_when_no_feature():
    # A non-inflectional 'alternative form of' has no grammatical feature → None.
    assert grammar_from_tags(["form-of", "alternative"], "X") is None
    assert grammar_from_tags([], "X") is None


def test_grammar_from_tags_display_overrides():
    b = grammar_from_tags(["third-person", "oblique"], "X")
    disp = {f.code: f.display for f in b.features}
    assert disp["third-person"] == "3rd person"
    assert disp["oblique"] == "oblique case"


# --------------------------------------------------------------------------- #
# Route: form-of resolution end-to-end (InMemory store)
# --------------------------------------------------------------------------- #

@pytest.fixture
def mem_store():
    store = InMemoryDictionaryStore()
    set_dictionary_store(store)
    yield store
    set_dictionary_store(None)


@pytest.fixture
def define():
    from loom_api.routes.define import DefineRequest, define_batch
    return define_batch, DefineRequest


def test_form_of_resolves_to_lemma_definition_and_grammar(mem_store, define):
    handler, Req = define
    # करते is a form-of entry; करना is the real lemma.
    mem_store.add("hi", "करते", None,
                  [{"gloss": ["inflection of करना (karnā):"],
                    "pos": ["verb"],
                    "misc": ["form-of", "habitual", "masculine", "plural"]}],
                  source="wiktextract")
    mem_store.add("hi", "करना", None,
                  [{"gloss": ["to do"], "pos": ["verb"]}], source="wiktextract")

    r = handler(Req(lang="hi", words=["करते"])).results[0]
    assert r.found is True
    # The card now shows the REAL meaning, not "inflection of करना".
    assert r.senses and r.senses[0].gloss == ["to do"]
    # And a grammar breakdown pointing at the dictionary form.
    assert r.grammar is not None
    assert r.grammar.dict_form == "करना"
    assert [f.code for f in r.grammar.features] == ["habitual", "plural", "masculine"]


def test_form_of_with_missing_lemma_falls_back(mem_store, define):
    handler, Req = define
    # form-of entry whose lemma isn't in the dictionary → no crash; keep the
    # form-of entry as-is rather than fabricating a definition.
    mem_store.add("hi", "करते", None,
                  [{"gloss": ["inflection of करना (karnā):"],
                    "misc": ["form-of", "habitual"]}],
                  source="wiktextract")
    r = handler(Req(lang="hi", words=["करते"])).results[0]
    # Lemma unresolved → falls through to the plain entry (still returns something).
    assert r.senses and "inflection of" in r.senses[0].gloss[0]


def test_direct_entry_unaffected_by_form_of_path(mem_store, define):
    handler, Req = define
    mem_store.add("hi", "घर", None, [{"gloss": ["house"], "pos": ["noun"]}],
                  source="wiktextract")
    r = handler(Req(lang="hi", words=["घर"])).results[0]
    assert r.found is True and r.senses[0].gloss == ["house"]
    assert r.grammar is None  # a plain noun has no inflection to explain
