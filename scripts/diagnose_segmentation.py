#!/usr/bin/env python3
"""Corpus-driven diagnosis of subtitle-event segmentation edge cases.

Loom's per-word vocab + grammar features analyze ONE subtitle event at a time.
But subtitle events don't line up with linguistic units: a sentence (or even a
single WORD) can split across events, and one event can hold two speakers'
lines.  This tool goes through the captured corpus, classifies every cue, and
flags the pairs where per-event analysis breaks — so we can measure how often
each edge case really happens before building fixes.

Two modes:
    --self-test   run the pure detectors on curated examples (no DB) — verifies
                  the classification logic; safe to run anywhere.
    (default)     read the corpus from Postgres and produce a frequency report +
                  sampled offenders.  Needs a connection string in env:
                      LOOM_CORPUS_DB   (or DATABASE_PUBLIC_URL / DATABASE_URL)
                  Reads ONLY (SELECT); never writes.

Categories reported per (lang):
  multi_speaker      one cue, ≥2 dash-prefixed utterances (- 何  - そうです)
  non_dialogue       music ♪ / SFX / bracketed stage direction only
  terminal           cue ends at a sentence boundary (。！？ / sentence-final)
  incomplete         cue ends mid-grammar (連用形 / dangling particle / 的…) —
                     a continuation candidate (likely stitched to the next cue)
  boundary_word_split  THE worst: joining cue N's tail with N+1's head produces
                     a single word neither fragment saw (食べさせ|られた, 保|护) —
                     per-event analysis mis-segments both halves.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

# Run-from-anywhere: put the repo root on the path so `loom_core` imports.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# --------------------------------------------------------------------------- #
# Pure detectors (unit-testable without a DB)
# --------------------------------------------------------------------------- #

# Speaker-change dash at line start or after whitespace, followed by content.
# Covers ASCII hyphen, en/em dash, JIS full-width dash, katakana chōonpu misuse.
_SPEAKER_DASH = re.compile(r"(?:^|\s)[\-‐-―−－ー]\s*\S")

# Sentence-final punctuation (CJK + ASCII), optionally inside a closing quote.
_TERMINAL_PUNCT = re.compile(r"[。！？!?…‥]+[」』】）\)\"']*\s*$")

# Japanese sentence-final particles that end an utterance without punctuation.
_JA_FINAL_PARTICLES = ("ね", "よ", "わ", "ぞ", "ぜ", "さ", "な", "か", "の", "かな", "よね")

# Non-dialogue: music notes, or a line that's ENTIRELY a bracketed annotation.
_MUSIC = re.compile(r"[♪♫♬〜~～≈]")
_BRACKET_ONLY = re.compile(r"^\s*[（(\[【]{1}.*[）)\]】]{1}\s*$")


# Speaker-name label prefixing a cue: （ゼンゼ） / [孫悟空] / 【名】 — a metadata
# label, not dialogue.  Corpus-discovered (Netflix JA + ZH).  Stripped before any
# linguistic analysis so the name isn't tokenized/romanized/mis-joined.
_SPEAKER_LABEL = re.compile(r"[（(【\[][^）)】\]]{1,10}[）)】\]]")


def strip_speaker_labels(text: str) -> str:
    """Remove leading/inline speaker-name labels and collapse the multi-speaker
    newline so downstream analysis sees dialogue text only."""
    t = (text or "")
    # Only strip a label when it sits at a line/utterance start (after ^ / \n /
    # a speaker dash) — an in-sentence parenthetical (real content) is left.
    t = re.sub(r"(^|\n|[\-‐-―−－]\s*)" + _SPEAKER_LABEL.pattern, r"\1", t)
    return t


def is_multi_speaker(text: str) -> bool:
    """True when one cue holds ≥2 dash-prefixed utterances (speaker change)."""
    marks = _SPEAKER_DASH.findall(text or "")
    return len(marks) >= 2 or bool(re.match(r"^\s*[\-‐-―−－]\s*\S", text or "")) and len(marks) >= 1


def split_speakers(text: str) -> list[str]:
    """Split a multi-speaker cue into its utterances at the speaker dashes."""
    # Split on a dash that starts the line or follows whitespace.
    parts = re.split(r"(?:^|\s)[\-‐-―−－]\s*", text or "")
    return [p.strip() for p in parts if p.strip()]


def is_non_dialogue(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _BRACKET_ONLY.match(t):
        return True
    # A line that is (nearly) all music marks / tildes.
    stripped = _MUSIC.sub("", t).strip()
    return len(stripped) == 0


def has_terminal_punct(text: str) -> bool:
    return bool(_TERMINAL_PUNCT.search((text or "").rstrip()))


def ja_completeness(text: str, tagger) -> str:
    """'terminal' | 'incomplete' | 'unknown' for a Japanese cue, from the final
    morpheme's conjugation form.  A trailing 連用形/未然形/te-form or a dangling
    case particle (を/に/が/へ/と) → continues; 終止形/命令形/sentence-final
    particle → complete."""
    t = (text or "").strip()
    if not t:
        return "unknown"
    if has_terminal_punct(t):
        return "terminal"
    toks = list(tagger(t))
    if not toks:
        return "unknown"
    # Skip trailing closing brackets / spaces.
    last = toks[-1]
    f = last.feature
    pos1 = getattr(f, "pos1", "") or ""
    cform = (getattr(f, "cForm", "") or "").split("-")[0]
    surface = last.surface
    lemma = getattr(f, "lemma", "") or ""
    if pos1 == "助詞":
        if surface in _JA_FINAL_PARTICLES or lemma in _JA_FINAL_PARTICLES:
            return "terminal"
        # case/連用 particles expecting a predicate → continues
        if surface in ("を", "に", "が", "へ", "と", "から", "で", "の"):
            return "incomplete"
        if getattr(f, "pos2", "") == "接続助詞":  # て/ば/ながら…
            return "incomplete"
    if cform in ("連用形", "未然形", "仮定形", "連用形-一般"):
        return "incomplete"
    if cform in ("終止形", "命令形", "意志推量形"):
        return "terminal"
    return "unknown"


def zh_completeness(text: str) -> str:
    """Coarse Chinese completeness: trailing function words that expect more
    (的/地/得/和/与/跟/把/被/而) → continues; ending punctuation → terminal."""
    t = (text or "").strip()
    if not t:
        return "unknown"
    if has_terminal_punct(t):
        return "terminal"
    if t[-1] in "的地得和与跟把被而或且但如因虽即":
        return "incomplete"
    return "unknown"


# Trailing / leading punctuation that legitimately ends or starts an utterance —
# a boundary here is a real break, never a mid-word split, so strip before joining.
_EDGE_PUNCT = "。、，！？!?…‥「」『』【】（）()《》〈〉・～~　 \t\n\"'"


def _clean_for_join(s: str, *, tail: bool) -> str:
    """Speaker-label-stripped, whitespace-collapsed text for the boundary test."""
    s = strip_speaker_labels(s or "")
    s = re.sub(r"[ \t　]+", "", s)
    return s.rstrip(_EDGE_PUNCT) if tail else s.lstrip(_EDGE_PUNCT)


def boundary_word_split(tail: str, head: str, seg) -> str | None:
    """Detect a WORD split across the cue boundary.

    Position-free / whitespace-robust: we join tail+head, re-segment, and look
    for a token that (a) neither fragment produced on its own AND (b) actually
    STRADDLES the junction in the raw joined string (found via str.find, so the
    segmenter's own whitespace/punct stripping can't skew the offset).  Speaker
    labels and edge punctuation are stripped first — a break after 。 or after a
    （名） label is not a mid-word split.  Returns the spanning word, else None."""
    tail = _clean_for_join(tail, tail=True)
    head = _clean_for_join(head, tail=False)
    if not tail or not head:
        return None
    # Window the junction so we don't re-segment whole long lines.
    a, b = tail[-8:], head[:8]
    j = a + b
    boundary = len(a)
    frag = set(seg(a)) | set(seg(b))
    for w in seg(j):
        if len(w) < 2 or w in frag:
            continue
        # Does this (newly-formed) word occur ACROSS the junction?
        idx = j.find(w)
        while idx != -1:
            if idx < boundary < idx + len(w):
                return w
            idx = j.find(w, idx + 1)
    return None


# --------------------------------------------------------------------------- #
# Self-test (no DB)
# --------------------------------------------------------------------------- #

_CURATED = [
    # (lang, prev_cue, cue) — prev used only for boundary tests
    ("ja", None, "- 何　- そうです"),
    ("ja", None, "―何？ ―そうです"),
    ("ja", None, "私は昨日 母に"),
    ("ja", None, "無理やり野菜を食べさせられた。"),
    ("ja", "食べさせ", "られたくなかった"),
    ("ja", None, "♪～"),
    ("ja", None, "（ドアの音）"),
    ("ja", None, "行くよ"),
    ("zh", None, "-你好 -再见"),
    ("zh", "我们应该保", "护环境"),
    ("zh", None, "这是我昨天买的"),
    ("zh", None, "我们走吧。"),
]


def _make_segmenters():
    """Return (ja_word_seg, zh_word_seg, tagger).  The JA segmenter uses the
    MERGED word tokens (build_word_tokens), NOT raw MeCab morphemes — a word
    like 食べさせられた is one merged token but many morphemes, and the boundary
    test needs the WORD unit to see a split.  ZH uses jieba (already word-level).
    """
    import fugashi
    import jieba
    from loom_core.romanize import get_annotation_func, build_word_tokens
    tagger = fugashi.Tagger()
    ja_func = get_annotation_func("ja")

    def ja_word_seg(s: str):
        spans = ja_func(s)
        return [t[0] for t in build_word_tokens(s, "ja", spans, ja_func)]

    def zh_word_seg(s: str):
        return [w for w in jieba.cut(s) if w.strip()]

    return ja_word_seg, zh_word_seg, tagger


def _self_test() -> int:
    ja_seg, jseg, tagger = _make_segmenters()
    print(f"{'lang':4} {'category':16} {'complete':10} cue")
    print("-" * 70)
    for lang, prev, cue in _CURATED:
        if is_non_dialogue(cue):
            cat = "non_dialogue"
        elif is_multi_speaker(cue):
            cat = "multi_speaker"
        else:
            cat = "dialogue"
        comp = ja_completeness(cue, tagger) if lang == "ja" else zh_completeness(cue)
        seg = ja_seg if lang == "ja" else jseg
        split = boundary_word_split(prev, cue, seg) if prev else None
        flag = f"  ⚠ boundary split → {split!r}" if split else ""
        print(f"{lang:4} {cat:16} {comp:10} {cue!r}{flag}")
    return 0


# --------------------------------------------------------------------------- #
# Corpus mode
# --------------------------------------------------------------------------- #

def _dsn() -> str | None:
    for k in ("LOOM_CORPUS_DB", "DATABASE_PUBLIC_URL", "DATABASE_URL"):
        v = os.environ.get(k)
        if v:
            return v
    return None


def _run_corpus(limit_tracks: int) -> int:
    dsn = _dsn()
    if not dsn:
        print("No corpus DSN — set LOOM_CORPUS_DB (or DATABASE_PUBLIC_URL).",
              file=sys.stderr)
        return 2
    import psycopg
    ja_seg, jseg, tagger = _make_segmenters()

    stats: dict[str, Counter] = {}
    samples: dict[str, list] = {"boundary_word_split": [], "incomplete": [],
                                "multi_speaker": [], "speaker_label": []}

    with psycopg.connect(dsn, connect_timeout=10) as conn:
        # NB: %% escapes the LIKE wildcard so psycopg doesn't read it as a param.
        tracks = conn.execute(
            "SELECT t.id, t.lang_code FROM corpus_track t "
            "WHERE lower(t.lang_code) LIKE 'ja%%' OR lower(t.lang_code) LIKE 'zh%%' "
            "ORDER BY t.id LIMIT %s", (limit_tracks,)).fetchall()
        for tid, lang_code in tracks:
            lang = "ja" if lang_code.lower().startswith("ja") else "zh"
            seg = ja_seg if lang == "ja" else jseg
            rows = conn.execute(
                "SELECT text FROM corpus_line WHERE track_id = %s ORDER BY seq",
                (tid,)).fetchall()
            cues = [r[0] for r in rows]
            c = stats.setdefault(lang, Counter())
            for i, cue in enumerate(cues):
                c["cues"] += 1
                if _SPEAKER_LABEL.search(cue or ""):
                    c["speaker_label"] += 1
                    if len(samples["speaker_label"]) < 40:
                        samples["speaker_label"].append((lang, cue))
                if is_non_dialogue(cue):
                    c["non_dialogue"] += 1
                    continue
                if is_multi_speaker(cue):
                    c["multi_speaker"] += 1
                    if len(samples["multi_speaker"]) < 40:
                        samples["multi_speaker"].append((lang, cue))
                # Analyse dialogue text only — strip the （名）/[名] speaker label.
                clean = strip_speaker_labels(cue).strip()
                comp = ja_completeness(clean, tagger) if lang == "ja" else zh_completeness(clean)
                c[comp] += 1
                if comp == "incomplete" and len(samples["incomplete"]) < 40:
                    samples["incomplete"].append((lang, cue))
                if i > 0:
                    split = boundary_word_split(cues[i - 1], cue, seg)
                    if split:
                        c["boundary_word_split"] += 1
                        # High-precision subset: the split is only trustworthy
                        # when the PREVIOUS cue was grammatically incomplete —
                        # otherwise it's a coincidental re-merge (五四 / だなら).
                        prev_clean = strip_speaker_labels(cues[i - 1]).strip()
                        prev_comp = (ja_completeness(prev_clean, tagger)
                                     if lang == "ja" else zh_completeness(prev_clean))
                        bucket = "boundary_gated" if prev_comp == "incomplete" else "boundary_coincidental"
                        c[bucket] += 1
                        tgt = samples["boundary_word_split"] if bucket == "boundary_gated" else samples.setdefault("boundary_coincidental", [])
                        if len(tgt) < 60:
                            tgt.append((lang, cues[i - 1], cue, split))

    for lang, c in stats.items():
        n = max(1, c["cues"])
        print(f"\n=== {lang}  ({c['cues']} cues) ===")
        for k in ("speaker_label", "non_dialogue", "multi_speaker", "terminal",
                  "incomplete", "unknown", "boundary_word_split",
                  "boundary_gated", "boundary_coincidental"):
            print(f"  {k:22} {c[k]:6}  {100*c[k]/n:5.1f}%")
    print("\n--- GATED boundary splits (prev cue grammatically incomplete = REAL) ---")
    for lang, prev, cue, w in samples["boundary_word_split"][:30]:
        print(f"  [{lang}] …{prev[-12:]!r} | {cue[:12]!r}…  → split word {w!r}")
    print("\n--- COINCIDENTAL boundary 'splits' (prev cue complete = false merge) ---")
    for lang, prev, cue, w in samples.get("boundary_coincidental", [])[:15]:
        print(f"  [{lang}] …{prev[-12:]!r} | {cue[:12]!r}…  → merged {w!r}")
    print("\n--- sample multi-speaker cues ---")
    for lang, cue in samples["multi_speaker"][:20]:
        print(f"  [{lang}] {cue!r}")
    print("\n--- sample incomplete (continuation-candidate) cues ---")
    for lang, cue in samples["incomplete"][:20]:
        print(f"  [{lang}] {cue!r}")
    print("\n--- sample speaker-label cues (（名）/[名] metadata prefix) ---")
    for lang, cue in samples["speaker_label"][:20]:
        print(f"  [{lang}] {cue!r}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--limit-tracks", type=int, default=1000)
    args = ap.parse_args()
    return _self_test() if args.self_test else _run_corpus(args.limit_tracks)


if __name__ == "__main__":
    raise SystemExit(main())
