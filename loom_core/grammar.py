"""Grammar-aware breakdown of an inflected word (VOCAB_LOOKUP.md → grammar).

The dictionary answers "what does this word MEAN?"; this answers "what is this
word DOING?".  A learner staring at 食べさせられたくなかった needs to see that it's
食べる (to eat) run through causative → passive → desiderative → negative → past
("didn't want to be made to eat") — grammar the bare lemma definition drops.

We already run MeCab (fugashi + unidic-lite) to produce furigana + word tokens,
and every morpheme carries its POS + conjugation (cForm/cType) + lemma — data we
currently compute and throw away.  This module walks that morpheme chain and
turns the auxiliary / inflection sequence into an ordered list of readable
grammar FEATURES, each a stable code (for the client to localize) plus an
English display string (so an unknown code still renders).

Japanese only for now (the core audience + the richest morphology); Korean
(kiwipiepy) and the Romance/Slavic features are the next legs, feeding the same
GrammarBreakdown shape.

Design notes:
- Feature CODES are stable identifiers ("causative", "past", …); the server also
  ships an English `display` so a client with no localization for a code still
  shows something sensible (release-proof, like the dictionary capabilities).
- Order matters: features are listed inner→outer, the order the grammar actually
  stacks (食べ・させ・られ・た → causative, passive, past).
- Ambiguity is surfaced, not hidden: られる is passive OR potential OR honorific
  and MeCab can't tell them apart, so the display says "passive / potential".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass(frozen=True)
class GrammarFeature:
    """One step in the inflection chain."""
    code: str            # stable id, e.g. "causative"
    display: str         # English label, e.g. "causative"
    surface: str = ""    # the morpheme(s) that carry it, e.g. "させ"


@dataclass(frozen=True)
class GrammarBreakdown:
    """Dictionary form + the ordered grammar features applied to it."""
    dict_form: str
    features: List[GrammarFeature] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Japanese
# --------------------------------------------------------------------------- #

# Auxiliary-verb (助動詞) lemma → (code, display).  These stack onto the stem.
_JA_AUX: dict[str, tuple[str, str]] = {
    "させる": ("causative", "causative"),
    "せる": ("causative", "causative"),
    "られる": ("passive_potential", "passive / potential"),
    "れる": ("passive_potential", "passive / potential"),
    "たい": ("desiderative", "desiderative (want to)"),
    "たがる": ("desiderative_3p", "desiderative (3rd-person: shows wanting)"),
    "た": ("past", "past"),
    "ます": ("polite", "polite"),
    "です": ("copula_polite", "copula (polite)"),
    "だ": ("copula", "copula"),
    "ない": ("negative", "negative"),
    "ぬ": ("negative", "negative"),
    "ん": ("negative", "negative"),
    "う": ("volitional", "volitional / presumptive"),
    "よう": ("volitional", "volitional / presumptive"),
    "まい": ("negative_volitional", "negative volitional"),
    "そう": ("hearsay_appearance", "hearsay / appearance (-sō)"),
    "らしい": ("seeming", "seeming (-rashii)"),
    "よう だ": ("likeness", "appears / seems (-yō da)"),
    "みたい": ("likeness", "appears / seems (-mitai)"),
    "べし": ("obligation", "should / must (-beki)"),
}

# Adjective lemma that acts as a negating auxiliary (高くない, 食べたくない).
_JA_NEG_ADJ_LEMMAS = {"無い", "ない"}

# て/で + these auxiliary verbs form aspectual compounds (-te iru, -te shimau …).
_JA_TE_AUX: dict[str, tuple[str, str]] = {
    "居る": ("progressive", "progressive / resultative (-te iru)"),
    "いる": ("progressive", "progressive / resultative (-te iru)"),
    "仕舞う": ("completive", "completive / regret (-te shimau)"),
    "しまう": ("completive", "completive / regret (-te shimau)"),
    "置く": ("preparatory", "preparatory (-te oku)"),
    "おく": ("preparatory", "preparatory (-te oku)"),
    "見る": ("attemptive", "attemptive (-te miru)"),
    "みる": ("attemptive", "attemptive (-te miru)"),
    "行く": ("directional_away", "directional / ongoing (-te iku)"),
    "来る": ("directional_toward", "directional / onset (-te kuru)"),
    "貰う": ("benefactive", "benefactive (-te morau)"),
    "くれる": ("benefactive", "benefactive (-te kureru)"),
    "呉れる": ("benefactive", "benefactive (-te kureru)"),
    "上げる": ("benefactive_give", "benefactive (-te ageru)"),
    "あげる": ("benefactive_give", "benefactive (-te ageru)"),
}

# cForm on the HEAD verb that itself encodes grammar (no separate morpheme).
_JA_CFORM_FEATURE: dict[str, tuple[str, str]] = {
    "意志推量形": ("volitional", "volitional / presumptive"),
    "命令形": ("imperative", "imperative"),
}

# Content-word POS that can head a word (own a dictionary form).
_JA_HEAD_POS = {"動詞", "形容詞", "形状詞", "副詞"}

# Auxiliary-verb suffixes that stack after the head (skip when finding the head).
_JA_SURU_LEMMAS = {"為る", "する"}


def _ja_tokens(surface: str):
    """Return a list of light morpheme records for *surface* via the shared
    MeCab tagger.  Each record: (surface, pos1, pos2, lemma, cForm)."""
    from .romanize import get_shared_ja_tagger  # lazy — MeCab is heavy

    tagger = get_shared_ja_tagger()
    if tagger is None:
        return []
    out = []
    for w in tagger(surface):
        f = w.feature
        out.append((
            w.surface,
            getattr(f, "pos1", "") or "",
            getattr(f, "pos2", "") or "",
            getattr(f, "lemma", "") or "",
            getattr(f, "cForm", "") or "",
        ))
    return out


def analyze_japanese_grammar(surface: str) -> Optional[GrammarBreakdown]:
    """Break *surface* (one inflected Japanese word) into its dictionary form +
    ordered grammar features.  Returns None when there's nothing to analyze
    (empty input, or no inflecting content word — e.g. a bare noun/particle).

    A word already in dictionary form (食べる) returns a breakdown with an empty
    feature list — the caller can note "plain / dictionary form" or omit the
    section.  Only genuinely uninflectable input returns None.
    """
    if not surface or not surface.strip():
        return None
    toks = _ja_tokens(surface.strip())
    if not toks:
        return None

    # 1) Find the head content word (first verb / adjective / na-adj / adverb).
    head_idx = next(
        (i for i, (_s, p1, _p2, _lm, _cf) in enumerate(toks) if p1 in _JA_HEAD_POS),
        None,
    )
    if head_idx is None:
        return None  # no inflecting content word (bare noun / particle only)

    hsurf, hp1, _hp2, hlemma, hcform = toks[head_idx]

    # 2) Dictionary form.  A 名詞+する (勉強する) or 名詞+した head shows up as the
    #    verb 為る heading; recover the noun before it so the dict form is the
    #    full suru-verb.  (The head-finder skips the noun since 名詞 isn't a head
    #    POS, landing on する — so peek back one.)
    dict_form = hlemma or hsurf
    start = head_idx + 1
    if hlemma in _JA_SURU_LEMMAS and head_idx > 0:
        prev_s, prev_p1, _pp2, prev_lm, _pcf = toks[head_idx - 1]
        if prev_p1 == "名詞":
            dict_form = (prev_lm or prev_s) + "する"

    features: List[GrammarFeature] = []

    # 3) cForm on the head that encodes grammar with no separate morpheme
    #    (volitional 飲もう, imperative 食べろ).
    cf_feat = _cform_feature(hcform)
    if cf_feat:
        features.append(GrammarFeature(*cf_feat, surface=hsurf))

    # 4) Walk the suffix chain, mapping each auxiliary / particle to a feature.
    i = start
    while i < len(toks):
        s, p1, p2, lemma, cform = toks[i]
        consumed = 1

        if p1 == "助動詞" and lemma in _JA_AUX:
            code, disp = _JA_AUX[lemma]
            features.append(GrammarFeature(code, disp, surface=s))
        elif p1 == "形容詞" and lemma in _JA_NEG_ADJ_LEMMAS:
            features.append(GrammarFeature("negative", "negative", surface=s))
        elif p1 == "助詞" and lemma in ("て", "で"):
            # て-form: connective, OR the start of an aspectual compound when
            # followed by a light verb (居る/しまう/おく/…).
            aux = toks[i + 1] if i + 1 < len(toks) else None
            if aux and aux[3] in _JA_TE_AUX:
                code, disp = _JA_TE_AUX[aux[3]]
                features.append(
                    GrammarFeature(code, disp, surface=s + aux[0]))
                consumed = 2
            else:
                features.append(
                    GrammarFeature("te_form", "te-form (connective)", surface=s))
        elif p1 == "助詞" and lemma == "ば":
            features.append(
                GrammarFeature("conditional_ba", "provisional conditional (-ba)", surface=s))
        elif p1 == "助詞" and lemma == "たら":
            features.append(
                GrammarFeature("conditional_tara", "conditional (-tara)", surface=s))
        # Unknown suffix morphemes are skipped (kept out of the breakdown rather
        # than surfaced as noise).
        i += consumed

    return GrammarBreakdown(dict_form=dict_form, features=features)


def _cform_feature(cform: str) -> Optional[tuple[str, str]]:
    """Map a UniDic cForm value to a grammar feature when it encodes one.
    cForm values look like '意志推量形' or '連用形-一般'; match on the base."""
    if not cform:
        return None
    base = cform.split("-")[0]
    return _JA_CFORM_FEATURE.get(base)


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

def analyze_grammar(surface: str, lang_code: str) -> Optional[GrammarBreakdown]:
    """Grammar breakdown for *surface* in *lang_code*, or None when the language
    has no grammar analyzer (Chinese is analytic — no inflection — so it returns
    None by design) or nothing to analyze."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary == "ja":
        return analyze_japanese_grammar(surface)
    return None


def grammar_supported(lang_code: str) -> bool:
    """Whether analyze_grammar can produce a breakdown for this language."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    return primary == "ja"
