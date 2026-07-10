#!/usr/bin/env python3
"""Corpus quality-check harness for a candidate dictionary source language.

Before enabling a space-delimited language for per-word lookup (VOCAB_LOOKUP.md),
we measure — on REAL text — how well our tokenizer + lemmatizer land on entries
the dictionary actually has.  This is the gate: a language goes live only when
this clears the bar (the Japanese pipeline sits at ~96% useful-result).

It runs OFFLINE against a local dictionary export — it does NOT touch prod.  It
exercises the SAME production tokenizer (`loom_core.romanize.build_word_tokens`
via the generic path), so the number reflects what `/define` would actually
resolve.

Inputs:
  --lang       BCP-47 primary (e.g. es)
  --text       file of real text in that language (one passage; newlines ok)
  --headwords  file of dictionary headwords, one per line (lemma entries)
  --forms      optional file of inflected surface forms, one per line

Metrics reported (over CONTENT tokens — letters, not pure punctuation):
  * lemmatized%   — simplemma produced a lemma different from the surface
  * lemma-hit%    — the lemma is a dictionary headword
  * +surface%     — OR the surface form hits (headword/form) — the multi-key path
  * useful%       — the headline: lemma OR surface resolves to SOMETHING
  * top misses    — most frequent tokens that resolve to nothing (eyeball these)

Usage:
  python scripts/dict_quality_check.py --lang es \
      --text sample_es.txt --headwords es_headwords.txt --forms es_forms.txt
"""
from __future__ import annotations

import argparse
import pathlib
import sys
from collections import Counter

# Import the PRODUCTION generic tokenizer directly (not the build_word_tokens
# dispatch) — this harness validates a CANDIDATE space-delimited language BEFORE
# it's opted into GENERIC_TOKEN_PRIMARIES, so it must run the generic path
# regardless of the enable gate.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from loom_core.romanize import _generic_tokens  # noqa: E402


def _load_set(path: str | None) -> set[str]:
    if not path:
        return set()
    return {
        line.strip().casefold()
        for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", required=True, help="BCP-47 primary subtag, e.g. es")
    ap.add_argument("--text", required=True, help="file of real text in that language")
    ap.add_argument("--headwords", required=True, help="dictionary headwords, one per line")
    ap.add_argument("--forms", help="optional inflected surface forms, one per line")
    ap.add_argument("--top", type=int, default=30, help="how many top misses to show")
    args = ap.parse_args(argv)

    headwords = _load_set(args.headwords)
    forms = _load_set(args.forms)
    known = headwords | forms  # surface can hit either a headword or a listed form
    if not headwords:
        print("no headwords loaded", file=sys.stderr)
        return 2

    text = pathlib.Path(args.text).read_text(encoding="utf-8")

    total = 0
    lemmatized = 0
    lemma_hit = 0
    surface_or_lemma_hit = 0
    misses: Counter[str] = Counter()

    # Feed line by line (mirrors caption events) through the generic tokenizer.
    for line in text.splitlines():
        if not line.strip():
            continue
        for word, lemma, _pos, _reading, _s, _l in _generic_tokens(line, args.lang):
            total += 1
            w_cf = word.casefold()
            l_cf = (lemma or word).casefold()
            if l_cf != w_cf:
                lemmatized += 1
            hit_lemma = l_cf in headwords
            hit_surface = w_cf in known
            if hit_lemma:
                lemma_hit += 1
            if hit_lemma or hit_surface:
                surface_or_lemma_hit += 1
            else:
                misses[word] += 1

    if total == 0:
        print("no content tokens found", file=sys.stderr)
        return 2

    def pct(n: int) -> str:
        return f"{100 * n / total:5.1f}%  ({n}/{total})"

    print(f"=== dictionary quality: lang={args.lang} ===")
    print(f"  headwords loaded : {len(headwords)}   forms: {len(forms)}")
    print(f"  content tokens   : {total}")
    print(f"  lemmatized       : {pct(lemmatized)}   (simplemma changed the surface)")
    print(f"  lemma-hit        : {pct(lemma_hit)}")
    print(f"  useful (lemma∨surface) : {pct(surface_or_lemma_hit)}   <<< headline")
    print(f"\n  top {args.top} misses (token: count):")
    for tok, c in misses.most_common(args.top):
        print(f"    {tok!r}: {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
