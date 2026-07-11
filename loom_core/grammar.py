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

Japanese + Korean (both agglutinative — a predicate stem with a stackable ending
chain — so the same walk-the-suffix approach analyses both).  Romance/Slavic
features are the next leg (they need a real morphological analyzer, not just the
simplemma lemmatizer), feeding the same GrammarBreakdown shape.

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

import re
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

# POS that START A NEW WORD — the suffix walk stops here when analysing a
# STITCHED surface (finding ③).  A split predicate 利用し|て… is stitched with the
# next cue's lead to recover 利用して; without a boundary stop the walk would drift
# into the NEXT word and mis-attribute its inflection (食べて寝た → 食べる wrongly
# tagged 'past' from 寝た).  Aspectual light verbs (居る/しまう/…) never reach the
# walk standalone — they're consumed by the て-lookahead first — so listing 動詞
# here is safe.  Only consulted in continuation mode: a single-word surface has no
# trailing content word, so plain analysis is byte-identical.
_JA_WORD_BOUNDARY_POS = {
    "名詞", "代名詞", "動詞", "形容詞", "形状詞", "副詞",
    "連体詞", "接続詞", "感動詞", "接頭辞", "フィラー",
}

# A stitched continuation is capped — the walk only needs the inflection tail that
# immediately follows the split, and it breaks at the first new word anyway.
_JA_CONTINUATION_CAP = 12


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


def analyze_japanese_grammar(
    surface: str, continuation: str = ""
) -> Optional[GrammarBreakdown]:
    """Break *surface* (one inflected Japanese word) into its dictionary form +
    ordered grammar features.  Returns None when there's nothing to analyze
    (empty input, or no inflecting content word — e.g. a bare noun/particle).

    A word already in dictionary form (食べる) returns a breakdown with an empty
    feature list — the caller can note "plain / dictionary form" or omit the
    section.  Only genuinely uninflectable input returns None.

    *continuation* (finding ③): the text that FOLLOWS this word in the NEXT cue,
    for a predicate split across subtitle events (利用し | てタム… → 利用して).  When
    given, its inflection tail is stitched onto the surface and the suffix walk
    STOPS at the first new content word, so the split verb's own grammar is
    recovered without absorbing the next word's inflection.  A leading （名） label
    on the continuation is dropped first.  Harmless when the surface is already
    complete (the walk breaks immediately).
    """
    if not surface or not surface.strip():
        return None
    surface = surface.strip()
    cont = ""
    if continuation and continuation.strip():
        from .romanize import strip_leading_speaker_label  # avoid import cycle at top
        cont = strip_leading_speaker_label(continuation.strip())[:_JA_CONTINUATION_CAP]
    stop_at_boundary = bool(cont)
    toks = _ja_tokens(surface + cont)
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
        elif stop_at_boundary and p1 in _JA_WORD_BOUNDARY_POS:
            # Stitched-continuation mode: a new content word starts here, so the
            # inflection chain of THIS word is finished — stop before we absorb
            # the next word's grammar (食べて|寝た → 食べる[te-form], not [te,past]).
            break
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
# Korean (kiwipiepy)
# --------------------------------------------------------------------------- #
#
# Korean agglutinates endings onto a predicate stem exactly the way Japanese
# does, and kiwipiepy already tags every morpheme (Sejong tagset) while we
# tokenise for the KRDict lookup — so the same walk-the-suffix-chain approach
# applies.  The differences from JA: negation adverbs (안/못) come BEFORE the
# stem; aspect/modality are 연결어미 + 보조용언 constructions (고 있다, 고 싶다,
# 어야 하다) that need a lookahead; and the 종결어미 (EF) fuses mood + politeness.

# Predicate-head tags (stem + 다 = dict form) and derivational-predicate tags.
_KO_PRED_TAGS = frozenset({"VV", "VA", "VX", "VCN"})
_KO_DERIV_TAGS = frozenset({"XSV", "XSA"})
# A NEW word starts here → stop a stitched-continuation walk (finding ③).
_KO_BOUNDARY_TAGS = frozenset({
    "NNG", "NNP", "NNB", "NP", "NR", "VV", "VA", "VCN",
    "MAG", "MAJ", "MM", "IC",
})

# 선어말어미 (EP) — prefinal endings, matched on the normalized morpheme form.
_KO_EP_FEATURE: dict[str, tuple[str, str]] = {
    "았": ("past", "past"), "었": ("past", "past"), "였": ("past", "past"),
    "시": ("honorific", "subject honorific"),
    "으시": ("honorific", "subject honorific"),
    "겠": ("presumptive", "presumptive / intention (-gess)"),
}
# Negation adverbs (MAG) that precede the stem.
_KO_NEG_ADV: dict[str, tuple[str, str]] = {
    "안": ("negative", "negative"),
    "못": ("inability", "inability (cannot, -mot)"),
}
# 고 + 보조용언.
_KO_GO_AUX: dict[str, tuple[str, str]] = {
    "있": ("progressive", "progressive (-go itda)"),
    "계시": ("progressive", "progressive (honorific)"),
    "싶": ("desiderative", "desiderative (want to, -go sipda)"),
}
# 어/아 + 보조용언 (infinitive connector).
_KO_INF_AUX: dict[str, tuple[str, str]] = {
    "주": ("benefactive", "benefactive (-a juda)"),
    "드리": ("benefactive", "benefactive (humble)"),
    "보": ("attemptive", "attemptive (-a boda)"),
    "버리": ("completive", "completive (-a beorida)"),
    "있": ("resultative", "resultative (-a itda)"),
    "놓": ("preparatory", "preparatory (-a nota)"),
    "두": ("preparatory", "preparatory (-a duda)"),
}
# 어야/아야 + 하/되 → obligation.
_KO_OBLIG_AUX = frozenset({"하", "되"})
# 지 + 보조용언 → negation / prohibition.
_KO_JI_AUX: dict[str, tuple[str, str]] = {
    "않": ("negative", "negative (-ji anta)"),
    "못하": ("inability", "inability (-ji mothada)"),
    "말": ("prohibitive", "prohibitive (don't, -ji malda)"),
}
# 연결어미 (EC) that are plain connectives (no 보조용언 lookahead).
_KO_EC_FEATURE: dict[str, tuple[str, str]] = {
    "으면": ("conditional", "conditional (if, -myeon)"),
    "면": ("conditional", "conditional (if, -myeon)"),
    "어서": ("connective_cause", "and-so / because (-seo)"),
    "아서": ("connective_cause", "and-so / because (-seo)"),
    "여서": ("connective_cause", "and-so / because (-seo)"),
    "지만": ("connective_but", "but (-jiman)"),
    "는데": ("connective_background", "background / but (-nde)"),
    "은데": ("connective_background", "background / but (-nde)"),
    "ㄴ데": ("connective_background", "background / but (-nde)"),
    "고": ("connective_and", "and (-go)"),
}


def _ko_ef_feature(form: str) -> Optional[tuple[str, str]]:
    """Map a 종결어미 (final ending) to its mood/politeness feature.  Plain
    declaratives (다/ㄴ다/는다) carry no feature (≈ dictionary form)."""
    if "니까" in form:
        return ("formal_polite_q", "formal polite (question, -mnikka)")
    if "니다" in form:
        return ("formal_polite", "formal polite (-mnida)")
    if "요" in form:
        return ("polite", "polite (-yo)")
    if form.endswith("라") or form.endswith("아라") or form.endswith("어라"):
        return ("imperative", "imperative")
    if form == "자":
        return ("propositive", "propositive (let's)")
    return None


def _ko_morphs(text: str):
    """Light morpheme list (form, base_tag) for *text* via the shared kiwipiepy
    analyzer; [] when kiwipiepy is unavailable."""
    from .romanize import _get_kiwi  # lazy — heavy model, shared singleton

    kiwi = _get_kiwi()
    if kiwi is None:
        return []
    return [(m.form, m.tag.split("-", 1)[0]) for m in kiwi.tokenize(text)]


def analyze_korean_grammar(
    surface: str, continuation: str = ""
) -> Optional[GrammarBreakdown]:
    """Break a Korean predicate *surface* into its dictionary (다) form + ordered
    grammar features, mirroring analyze_japanese_grammar.  Returns None for a
    bare noun / particle (no predicate) or empty input.  *continuation* stitches
    the next cue's lead for a predicate split across events (finding ③)."""
    if not surface or not surface.strip():
        return None
    surface = surface.strip()
    cont = ""
    if continuation and continuation.strip():
        from .romanize import strip_leading_speaker_label
        cont = strip_leading_speaker_label(continuation.strip())[:12]
    stop_at_boundary = bool(cont)
    ms = _ko_morphs(surface + cont)
    if not ms:
        return None

    features: List[GrammarFeature] = []

    # 1) Leading negation adverb (안/못) precedes the stem.
    neg: Optional[GrammarFeature] = None
    idx = 0
    while idx < len(ms) and ms[idx][1] in ("MAG", "MAJ"):
        code_disp = _KO_NEG_ADV.get(ms[idx][0])
        if code_disp:
            neg = GrammarFeature(*code_disp, surface=ms[idx][0])
        idx += 1

    # 2) Find the predicate head: a real stem (VV/VA/VCN), a 하/되-derived
    #    predicate (noun+XSV/XSA), or a copula (noun+VCP).
    head = None
    for i in range(idx, len(ms)):
        form, tag = ms[i]
        if tag in ("VV", "VA", "VCN"):
            head = (i, form, tag, "")
            break
        if tag in _KO_DERIV_TAGS:            # 공부+하 → 공부하다
            noun = ms[i - 1][0] if i > 0 else ""
            head = (i, noun, "DERIV", form)
            break
        if tag == "VCP":                      # 학생+이(다) copula
            noun = ms[i - 1][0] if i > 0 else ""
            head = (i, noun, "VCP", "")
            break
    if head is None:
        return None

    hi, hform, htag, deriv = head
    if htag == "DERIV":
        dict_form = (hform + deriv + "다")
    elif htag == "VCP":
        dict_form = hform + "이다"
        features.append(GrammarFeature("copula", "copula (-ida)", surface="이"))
    else:
        dict_form = hform + "다"

    if neg is not None:
        features.append(neg)

    # 3) Walk the ending chain after the head.
    i = hi + 1
    while i < len(ms):
        form, tag = ms[i]
        consumed = 1
        if tag == "EP":
            cd = _KO_EP_FEATURE.get(form)
            if cd:
                features.append(GrammarFeature(*cd, surface=form))
        elif tag == "EC":
            nxt = ms[i + 1] if i + 1 < len(ms) else None
            if form == "고" and nxt and nxt[1] in ("VX", "VV", "VA") and nxt[0] in _KO_GO_AUX:
                features.append(GrammarFeature(*_KO_GO_AUX[nxt[0]], surface=form + nxt[0]))
                consumed = 2
            elif form in ("어", "아", "여") and nxt and nxt[1] in ("VX", "VV", "VA") and nxt[0] in _KO_INF_AUX:
                features.append(GrammarFeature(*_KO_INF_AUX[nxt[0]], surface=form + nxt[0]))
                consumed = 2
            elif form in ("어야", "아야", "여야") and nxt and nxt[0] in _KO_OBLIG_AUX:
                features.append(GrammarFeature("obligation", "obligation (must, -aya hada)", surface=form + nxt[0]))
                consumed = 2
            elif form == "지" and nxt and nxt[0] in _KO_JI_AUX:
                features.append(GrammarFeature(*_KO_JI_AUX[nxt[0]], surface=form + nxt[0]))
                consumed = 2
            elif form in _KO_EC_FEATURE:
                features.append(GrammarFeature(*_KO_EC_FEATURE[form], surface=form))
            # else: an unmapped connective → skipped
        elif tag == "EF":
            cd = _ko_ef_feature(form)
            if cd:
                features.append(GrammarFeature(*cd, surface=form))
        elif tag == "ETM" and form in ("을", "ㄹ", "를"):
            # 을 수 있다/없다 → potential.  ETM 을 + NNB 수 + VA/VX 있/없.
            if (i + 2 < len(ms) and ms[i + 1][0] == "수"
                    and ms[i + 2][0] in ("있", "없")):
                if ms[i + 2][0] == "있":
                    features.append(GrammarFeature("potential", "can (-l su itda)", surface="을 수 있"))
                else:
                    features.append(GrammarFeature("potential_negative", "cannot (-l su eopda)", surface="을 수 없"))
                consumed = 3
        elif stop_at_boundary and tag in _KO_BOUNDARY_TAGS:
            break
        i += consumed

    return GrammarBreakdown(dict_form=dict_form, features=features)


# --------------------------------------------------------------------------- #
# Wiktionary form-of tags → grammar (Hindi, Spanish, French, German, Russian, …)
# --------------------------------------------------------------------------- #
#
# Fusional/inflectional languages (unlike agglutinative ja/ko) don't get a
# morpheme-chain walk — but we don't need one.  Wiktionary already analysed every
# inflected form: kaikki Wiktextract marks it "form-of" and carries structured
# grammatical `tags` (करते → habitual/masculine/plural; comieron → preterite/
# third-person/plural), plus the lemma in the gloss ("... of करना (karnā)").  So a
# single tag→feature map turns that into a GrammarBreakdown for ~15 languages at
# once, no per-language engineering and no heavy NLP dependency.  The dictionary
# store keeps the tags in each sense's `misc`; the /define route follows the
# form-of gloss to the lemma for the real definition and calls grammar_from_tags.

# Marker tags that aren't grammatical FEATURES (dropped from the breakdown).
_WIKT_SKIP_TAGS = frozenset({
    "form-of", "form of", "inflection", "alternative", "romanization",
    "abbreviation", "obsolete", "archaic", "rare", "dialectal", "nonstandard",
    "colloquial", "informal-spelling", "misspelling", "combining-form", "error",
})

# Canonical DISPLAY order (voice → aspect → tense → mood → verb-form → person →
# number → gender → case → politeness → degree → definiteness).  Only tags listed
# here surface, in this order; anything else is dropped as noise.
_WIKT_TAG_ORDER: tuple[str, ...] = (
    "causative", "passive", "active", "middle",
    "perfective", "imperfective", "habitual", "progressive", "continuous",
    "aorist", "preterite", "imperfect", "pluperfect", "perfect",
    "present", "past", "future", "future-i", "future-ii",
    "indicative", "subjunctive", "imperative", "conditional", "presumptive",
    "optative", "jussive", "cohortative", "potential",
    "participle", "infinitive", "gerund", "supine", "converb", "verbal-noun",
    "transgressive", "gerundive",
    "first-person", "second-person", "third-person", "impersonal",
    "singular", "dual", "plural",
    "masculine", "feminine", "neuter", "common-gender",
    "direct", "oblique", "nominative", "accusative", "dative", "genitive",
    "vocative", "ergative", "locative", "instrumental", "ablative",
    "prepositional", "partitive", "essive", "translative",
    "formal", "informal", "familiar", "polite", "intimate", "honorific",
    "positive", "comparative", "superlative",
    "definite", "indefinite",
)
_WIKT_TAG_RANK = {t: i for i, t in enumerate(_WIKT_TAG_ORDER)}

# Nicer English display for a few tags (else the tag text is shown verbatim).
_WIKT_TAG_DISPLAY: dict[str, str] = {
    "first-person": "1st person", "second-person": "2nd person",
    "third-person": "3rd person",
    "direct": "direct case", "oblique": "oblique case",
    "verbal-noun": "verbal noun", "common-gender": "common gender",
    "future-i": "future I", "future-ii": "future II",
}


def grammar_from_tags(
    tags, dict_form: str
) -> Optional[GrammarBreakdown]:
    """Build a GrammarBreakdown from a Wiktionary form-of entry's grammatical
    `tags` (kaikki `senses[].tags`, stored in the dictionary sense's `misc`) and
    the resolved lemma *dict_form*.  Returns None when no recognised grammatical
    feature is present (so a non-inflectional 'alternative form of' shows no
    grammar section).  Language-agnostic: the tag vocabulary is shared across all
    Wiktextract languages."""
    if not dict_form:
        return None
    seen: set[str] = set()
    feats: list[str] = []
    for raw in tags or []:
        t = (raw or "").strip().lower()
        if t in _WIKT_SKIP_TAGS or t in seen or t not in _WIKT_TAG_RANK:
            continue
        seen.add(t)
        feats.append(t)
    if not feats:
        return None
    feats.sort(key=lambda t: _WIKT_TAG_RANK[t])
    return GrammarBreakdown(
        dict_form=dict_form,
        features=[
            GrammarFeature(code=t, display=_WIKT_TAG_DISPLAY.get(t, t))
            for t in feats
        ],
    )


# Wiktionary form-of glosses are "FEATURES of LEMMA(  (translit))(:)":
#   "oblique plural of घटना (ghaṭnā)"  ·  "past participle of manger"
#   "inflection of करना (karnā):"      ·  "plural of niño"
# The lemma is the run after the LAST " of ", minus a trailing "(translit)"/":".
_FORM_OF_SPLIT = re.compile(r"\bof\s+", re.IGNORECASE)


def extract_form_of_lemma(gloss: str) -> Optional[str]:
    """Pull the lemma out of a Wiktionary form-of gloss, or None if it doesn't
    look like one.  Handles the parenthetical transliteration and trailing colon;
    the lemma keeps its own script (Devanagari / Latin / Cyrillic)."""
    if not gloss:
        return None
    parts = _FORM_OF_SPLIT.split(gloss)
    if len(parts) < 2:
        return None
    tail = parts[-1].strip()
    # Drop a trailing "(romanization)" and any terminal punctuation/colon.
    tail = re.sub(r"\s*\([^)]*\)\s*$", "", tail).strip()
    tail = tail.rstrip(":;,. ").strip()
    # Strip pedagogical stress accents (Russian чита́ть → читать) so the lemma
    # re-lookup matches the plain dictionary headword.  These combining acute/
    # grave marks aren't lexical in the languages we serve (Spanish etc. use
    # PRECOMPOSED accented letters, untouched here).
    tail = tail.replace("́", "").replace("̀", "").strip()
    # A lemma is a single token (no spaces); guard against odd glosses.
    if not tail or " " in tail:
        return tail.split()[0] if tail else None
    return tail or None


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

_GRAMMAR_LANGS = frozenset({"ja", "ko"})


def analyze_grammar(
    surface: str, lang_code: str, continuation: str = ""
) -> Optional[GrammarBreakdown]:
    """Grammar breakdown for *surface* in *lang_code*, or None when the language
    has no grammar analyzer (Chinese is analytic — no inflection — so it returns
    None by design) or nothing to analyze.  *continuation* stitches the next
    cue's lead for a predicate split across events (finding ③; ja + ko)."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    if primary == "ja":
        return analyze_japanese_grammar(surface, continuation)
    if primary == "ko":
        return analyze_korean_grammar(surface, continuation)
    return None


def grammar_supported(lang_code: str) -> bool:
    """Whether analyze_grammar can produce a breakdown for this language."""
    primary = (lang_code or "").lower().split("-")[0].split("_")[0]
    return primary in _GRAMMAR_LANGS
