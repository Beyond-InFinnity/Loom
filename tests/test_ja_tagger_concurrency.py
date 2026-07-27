"""The shared MeCab tagger must be safe under the API's thread pool.

Every loom_api route is a sync `def`, so FastAPI runs it in anyio's ~40-thread
pool — genuinely concurrent Python threads.  Since 2026-07-11 one process-wide
fugashi Tagger has been shared by the furigana pipeline and the grammar
analyzer.  MeCab is NOT reentrant, and fugashi Nodes are VIEWS over the
tagger's lattice: reading `.surface` / `.feature` after another thread has
re-parsed returns THAT parse's data.

Measured on the pre-fix code: 2 of 1600 concurrent parses came back corrupted —
彼女 read as コン, 今日 as オミナ.  Those readings don't just render wrong, they
are written into the shared Postgres result cache and served to every later
viewer of that line until an ENGINE_VERSIONS bump.

These are stress tests: the race is probabilistic (~0.1%), so they use enough
iterations to make a miss unlikely rather than asserting on one call.
"""

import threading

import pytest

fugashi = pytest.importorskip("fugashi")

from loom_core.grammar import analyze_japanese_grammar  # noqa: E402
from loom_core.romanize import get_annotation_func  # noqa: E402

A = "今日はいい天気ですね散歩に行きましょうか"
B = "彼女は昨日図書館で本を読みましたそれから公園を歩きました"
C = "食べさせられた"


def _run_threads(targets):
    ts = [threading.Thread(target=t) for t in targets]
    for t in ts:
        t.start()
    for t in ts:
        t.join()


def test_annotation_spans_are_stable_under_concurrency():
    spans = get_annotation_func("ja")
    truth_a, truth_b = list(spans(A)), list(spans(B))
    bad = []

    def worker(text, expect, n=800):
        for _ in range(n):
            got = list(spans(text))
            if got != expect:
                bad.append((text, got))

    _run_threads([
        lambda: worker(A, truth_a), lambda: worker(B, truth_b),
        lambda: worker(A, truth_a), lambda: worker(B, truth_b),
    ])
    assert not bad, f"{len(bad)} corrupted annotation results, e.g. {bad[0][1][:4]}"


def test_grammar_analysis_is_stable_under_concurrency():
    truth = analyze_japanese_grammar(C)
    bad = []

    def grammar_worker(n=800):
        for _ in range(n):
            got = analyze_japanese_grammar(C)
            if got != truth:
                bad.append(got)

    def spans_worker(n=800):
        spans = get_annotation_func("ja")
        for _ in range(n):
            spans(B)

    _run_threads([grammar_worker, spans_worker, grammar_worker, spans_worker])
    assert not bad, f"{len(bad)} corrupted grammar results, e.g. {bad[0]}"
