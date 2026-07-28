#!/usr/bin/env python3
"""Measure the LIVE per-word definition pipeline on real caption lines.

scripts/dict_quality_check.py answers "should we enable language X?" offline,
against a candidate dictionary export.  This answers the different question:
**what does a user actually get when they click a word today?** — end to end,
through the deployed tokenizer and the deployed dictionary.

Pipeline under test (identical to the extension's):
    caption line --> POST /annotate/batch  --> per-word tokens (word, lemma, reading)
    token        --> POST /define/batch    --> the definition card's contents
The define call mirrors packages/player-ui definition-card.tsx exactly:
    {lang, words:[lemma], alt_keys:[[surface]], readings:[reading], surfaces:[surface]}
so a difference here is a difference the user sees.

Outcome classes per token (the thing being measured):
    HIT      - a substantive gloss came back: the card is useful
    POINTER  - a gloss came back, but it only points elsewhere ("inflection of X",
               "alternative spelling of Y").  The card RENDERS but dead-ends —
               strictly worse than a miss, because it looks like an answer.
               These are form-of entries the server's resolver failed to follow.
    PARTS    - no direct entry, but decomposition returned component senses
               (the Chinese 一顶 -> 一 + 顶 path)
    MISS     - nothing; the word is clickable but yields an empty card

Rates are reported BOTH ways, and the difference matters:
    type-weighted   - per distinct word: what fraction of the vocabulary works
    token-weighted  - per occurrence: what a viewer actually experiences
                      (a missing high-frequency particle hurts far more than a
                      missing rare noun)

Usage:
    python scripts/corpus_sample.py --out sample.json      # via `railway run`
    python scripts/dict_pipeline_audit.py --sample sample.json --out report.json

Auth: set LOOM_OWNER_KEY (an entry from LOOM_BYPASS_KEYS) to bypass rate
limiting — without it this trips 30/min immediately.  Read-only against prod;
it only calls the same public endpoints the extension does.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict

API = os.environ.get("LOOM_API_BASE", "https://api.loom.nerv-analytic.ai")

# The `lang` a define call uses for a given corpus group.  All Chinese variants
# normalise to zh client-side (define-lang.ts), so mirror that here.
DEFINE_LANG = {
    "ja": "ja", "ko": "ko", "zh-Hans": "zh", "zh-Hant": "zh",
    "en": "en", "hi": "hi", "es": "es", "de": "de", "fr": "fr",
}

# A gloss that only redirects.  These are Wiktionary form-of entries whose
# lemma resolution did not fire; the card shows this text and the user is stuck.
_POINTER_RE = re.compile(
    r"^\s*\(?[^)]*\)?\s*("
    r"(inflection|inflected form|plural|singular|past tense|past participle|"
    r"present participle|gerund|comparative|superlative|feminine|masculine|"
    r"diminutive|alternative spelling|alternative form|alternate spelling|"
    r"obsolete spelling|obsolete form|misspelling|archaic form|abbreviation|"
    r"initialism|acronym|contraction|synonym|romanization|romanisation)"
    r"\s+of\b|see\s+\S+$)",
    re.IGNORECASE,
)


def _post(path: str, body: dict, key: str | None, tries: int = 4) -> dict:
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Loom-Auth"] = key
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            body_txt = exc.read()[:200].decode("utf-8", "replace")
            last = f"HTTP {exc.code}: {body_txt}"
            if exc.code in (429, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            break
        except Exception as exc:  # network flake
            last = repr(exc)
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"POST {path} failed: {last}")


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def classify(res: dict) -> str:
    senses = res.get("senses") or []
    glosses = [g for s in senses for g in (s.get("gloss") or []) if g and g.strip()]
    if glosses:
        return "POINTER" if all(_POINTER_RE.match(g) for g in glosses) else "HIT"
    parts = res.get("parts") or []
    if any((p.get("senses") or []) for p in parts):
        return "PARTS"
    return "MISS"


def audit_language(group: str, lines: list[dict], key: str | None, verbose: bool) -> dict:
    lang_code = lines[0]["lang_code"] if lines else group
    texts = [l["text"] for l in lines]

    # 1) tokenise through the deployed annotate path
    tokens_per_line: list[list[dict]] = []
    for batch in _chunks(texts, 300):
        resp = _post("/annotate/batch", {"texts": batch, "lang_code": lang_code}, key)
        for item in resp.get("results", resp.get("items", [])):
            tokens_per_line.append(item.get("tokens") or [])
    while len(tokens_per_line) < len(texts):       # defensive: keep alignment
        tokens_per_line.append([])

    # 2) coverage: how much of each line is clickable at all
    covered_chars = total_chars = 0
    lines_with_no_tokens = 0
    for text, toks in zip(texts, tokens_per_line):
        content = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
        total_chars += len(content)
        covered_chars += sum(len(re.sub(r"[\s\W_]+", "", t.get("word") or "", flags=re.UNICODE))
                             for t in toks)
        if not toks:
            lines_with_no_tokens += 1

    # 3) unique tokens, keeping occurrence counts (token-weighted rates)
    freq: Counter[tuple[str, str, str]] = Counter()
    for toks in tokens_per_line:
        for t in toks:
            word = (t.get("word") or "").strip()
            if not word:
                continue
            lemma = (t.get("lemma") or word).strip() or word
            freq[(word, lemma, (t.get("reading") or ""))] += 1

    # 4) define, exactly as the client does
    outcomes: dict[str, str] = {}
    grammar_count = 0
    items = list(freq)
    dl = DEFINE_LANG.get(group, group)
    for batch in _chunks(items, 150):
        body = {
            "lang": dl,
            "words": [lemma for (_w, lemma, _r) in batch],
            "alt_keys": [[w] for (w, _l, _r) in batch],
            "readings": [r for (_w, _l, r) in batch],
            "surfaces": [w for (w, _l, _r) in batch],
        }
        resp = _post("/define/batch", body, key)
        results = resp.get("results", [])
        for (w, lemma, _r), res in zip(batch, results):
            outcomes[w] = classify(res)
            if res.get("grammar"):
                grammar_count += 1

    # 5) aggregate
    types = Counter(outcomes.values())
    occ: Counter[str] = Counter()
    for (w, _l, _r), c in freq.items():
        occ[outcomes.get(w, "MISS")] += c
    n_types = sum(types.values()) or 1
    n_occ = sum(occ.values()) or 1

    misses = Counter()
    pointers = Counter()
    for (w, _l, _r), c in freq.items():
        o = outcomes.get(w)
        if o == "MISS":
            misses[w] += c
        elif o == "POINTER":
            pointers[w] += c

    report = {
        "group": group,
        "lang_code_sampled": lang_code,
        "lines": len(texts),
        "lines_with_no_tokens": lines_with_no_tokens,
        "distinct_tokens": len(freq),
        "token_occurrences": sum(freq.values()),
        "tokens_per_line": round(sum(freq.values()) / max(len(texts), 1), 2),
        "clickable_char_coverage_pct": round(100 * covered_chars / max(total_chars, 1), 1),
        "grammar_breakdowns": grammar_count,
        "by_type_pct": {k: round(100 * v / n_types, 1) for k, v in types.items()},
        "by_occurrence_pct": {k: round(100 * v / n_occ, 1) for k, v in occ.items()},
        "top_misses": misses.most_common(25),
        "top_pointers": pointers.most_common(15),
    }
    if verbose:
        print(json.dumps(report, ensure_ascii=False, indent=1)[:1500])
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample", required=True, help="JSON from corpus_sample.py")
    ap.add_argument("--out", help="write full report JSON here")
    ap.add_argument("--langs", default="", help="comma-separated subset")
    ap.add_argument("--limit", type=int, default=0, help="cap lines per language")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    key = os.environ.get("LOOM_OWNER_KEY")
    if not key:
        print("warning: no LOOM_OWNER_KEY — expect 429s", file=sys.stderr)

    sample = json.load(open(args.sample, encoding="utf-8"))
    groups = [g.strip() for g in args.langs.split(",") if g.strip()] or list(sample)

    reports = []
    for g in groups:
        lines = sample.get(g) or []
        if args.limit:
            lines = lines[: args.limit]
        if not lines:
            continue
        t0 = time.time()
        rep = audit_language(g, lines, key, args.verbose)
        rep["seconds"] = round(time.time() - t0, 1)
        reports.append(rep)
        occ = rep["by_occurrence_pct"]
        print(
            f"{g:8s} lines={rep['lines']:>4} tok/line={rep['tokens_per_line']:>5} "
            f"cover={rep['clickable_char_coverage_pct']:>5}%  "
            f"HIT={occ.get('HIT',0):>5}% POINTER={occ.get('POINTER',0):>4}% "
            f"PARTS={occ.get('PARTS',0):>4}% MISS={occ.get('MISS',0):>5}%  ({rep['seconds']}s)"
        )

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(reports, fh, ensure_ascii=False, indent=1)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
