# Romanization/Annotation Result Cache + Subtitle Corpus — Design Notes

> **Status: LAYER 1 CODE SHIPPED 2026-07-02** (design captured 2026-06-23).
> Implemented per §7: `loom_api/result_cache.py` (fail-open Postgres cache +
> Null/InMemory impls + hit/miss/RSS telemetry), read-through/write-back in
> both batch routes (with in-batch dedup of repeated lines), `engine_version()`
> registry in `loom_core/romanize.py`, gunicorn worker recycling
> (`--max-requests 500`, Procfile + railway.json), psycopg deps in
> `requirements-web.txt`, 20 tests in `tests/test_result_cache.py`.
>
> **Owner steps to activate (until then the API runs uncached, byte-identical
> to pre-cache behavior):**
> 1. Railway: add a Postgres service to the Loom project.
> 2. Railway: on the API service, add a reference variable `DATABASE_URL` →
>    the Postgres service's `DATABASE_URL` (or set `LOOM_RESULT_CACHE_URL`).
>    `LOOM_RESULT_CACHE=off` is the kill switch.
> 3. Deploy (push to main), load an episode twice via the extension, and read
>    the `loom.cache` log lines (hits/misses/rss_mb/langs_computed) — that's
>    the §5 measurement that decides whether Option B is ever needed.
>
> **Layer 2 (media-identity corpus): SERVER INFRA SHIPPED 2026-07-02.**
> `POST /corpus/capture` (opt-in-gated, fail-soft, content-hash dedup) +
> `loom_api/corpus_store.py` (corpus_media/track/line/export_manifest,
> shares the Layer-1 DSN) + `loom_api/corpus_export.py` +
> `scripts/export_corpus.py` (Postgres → partitioned Parquet on R2/S3,
> manifest-audited, optional prune) + monthly `.github/workflows/
> export-corpus.yml` (no-ops until secrets exist) + 21 tests
> (`tests/test_corpus.py`).  `@loom/api-client` regenerated with the
> endpoint.  **Wiring owed (Connor): see `CORPUS_WIRING.md`** — extension
> opt-in toggle + capture call, R2 bucket + GitHub secrets, privacy/store
> copy (the privacy-policy change from §6 gotcha 4 ships WITH the toggle).
>
> **Original owner ask:** stop re-running the romanization/annotation pipeline in real-time on
> every piece of content; store results in a SQL DB (Railway Postgres) so compute is
> cached/bypassed, RAM/CPU is freed, the app scales, AND we accumulate a data asset we own.
>
> **Decisions locked at design time:**
> - Goal: **both scaling relief AND owning the data — cache first**, structured so the
>   corpus/media-index layer drops in next without rework.
> - Perceived constraint: **RAM** (to be confirmed by measurement — see §5).

---

## 1. Why this fits Loom unusually well

`/romanize/batch` and `/annotate/batch` (`loom_api/routes/{romanize,annotate}.py`) are
**pure functions**. Output depends only on:

- romanize: `(text, lang_code, phonetic_system, long_vowel_mode)`
- annotate: `(text, lang_code, phonetic_system, render_mode)`

No timestamps, no user state, no media identity. Romanizing `おはよう` is byte-identical
whether it came from *Frieren* or a cooking vlog. **So the natural cache key is the content
itself, not the media.** Two separable layers fall out of this:

---

## 2. The two layers (build independently)

### Layer 1 — Content-addressed result cache (the compute-saver) — BUILD FIRST

- **Key:** `hash(normalized_text, lang_code, phonetic_system, long_vowel_mode|render_mode, engine_version)`
- **Value:** romanized string / annotation spans+html.
- **Batch loop becomes:** `SELECT` by key → collect misses → run *only the misses* through
  MeCab/jieba/aksharamukha → `INSERT` new results → return.
- **Effect:** the 2nd viewer of a popular episode gets ~100% hit rate; heavy NLP libraries
  never run. Media-agnostic, so hits accumulate across *all* content, not per-title.
- **No API contract change, no client change.** Wraps the existing batch loops.

### Layer 2 — Media-identity index (the "own the data" / Step 6 corpus layer) — NEXT

- **Key:** `(platform, media_id, track_id) → ordered [(text, start, end)]`, joined to Layer-1 results.
- **Effect:** a *queryable* corpus — "every Japanese subtitle line we've seen, with furigana,
  grouped by show." This is literally the `(text, style, language)` archive Step 6's OCR
  pipeline wants, and where the long-owed `opt_in_training` flag finally does something.
- **Not needed for the scaling win** — it's where the *interesting* (research/PhD) stuff lives.

**Recommendation:** Layer 1 first (pure infra win, anonymous strings, no privacy surface),
then Layer 2 as a deliberate, separately-reasoned data-collection step.

---

## 3. The RAM story — KEY FINDING this session

The constraint is believed to be **RAM**, not CPU. Whether a cache fixes that hinges on
how the heavy NLP libs load. **Verified this session:** every heavy import is **lazy and
inside the romanizer closures** — nothing heavy loads at import time:

```
loom_core/romanize.py
  580  import jieba        # lazy (pinyin)
  589  import opencc       # lazy
  662  import jieba        # lazy (zhuyin)
  669  import opencc       # lazy
  738  import fugashi      # lazy (japanese)
 1024  import fugashi      # lazy
 1318  import cyrtranslit  # lazy
 1342  import cyrtranslit
```

`get_lang_config()` (`loom_core/styles.py:261`) and the `_make_*` factories just return
**closures**; the dictionary load happens only when the closure is first *called*.

Consequences:

1. A worker loads a language's dictionary **the first time it actually romanizes that
   language**, then holds it resident for the worker's whole life. unidic-lite (Japanese)
   is the heaviest; jieba + opencc (Chinese) next.
2. RAM is therefore **not flat — it creeps upward over a worker's uptime**, asymptoting at
   "all dicts loaded." **This is very likely the actual RAM pressure** — a long-lived worker
   that has now seen ja + zh + ko + th + … and holds all of them.
3. **A cache helps RAM here, not just CPU — conditionally.** A cache *hit* never enters the
   closure → never executes the lazy import → never loads the dict. BUT one *miss* in
   language X permanently loads X into that worker. A single shared worker on mixed-language
   traffic still creeps to "everything loaded" eventually, cache or not.

---

## 4. Architecture options (A and B share the same cache + schema)

### Option A — one service, Postgres cache + worker recycling (cheapest; likely sufficient)
- Wrap batch loops read-through/write-back **and** set gunicorn/uvicorn `max_requests` so
  workers recycle periodically.
- A recycled worker sheds rare-language dicts; with a high hit rate, misses (= loads) are
  rare, so most fresh workers only ever reload the dominant languages (almost certainly
  ja/zh/ko).
- No new service, no API change. **Best bet to fix the practical RAM problem.**

### Option B — compute/serve split (the guaranteed RAM fix)
- Two Railway services. **Serve** = FastAPI + Postgres lookups, *never imports the romanize
  closures* → tiny, constant footprint by construction; handles 100% of cache hits. **Compute**
  = the only thing that ever loads a dictionary, invoked solely on miss.
- The lazy imports make this split unusually clean — serve literally never reaches those
  `import` lines. Can also concentrate the truly heavy deps (unidic, aksharamukha) into the
  compute image only.
- Cost: a 2nd service (check whether it pushes off the $5 hobby tier — Railway bills by
  service/usage), an internal hop on misses.
- **Correct if traffic stays genuinely multilingual and the creep is unacceptable.**

### Option C — cache + CDN precompute (bypass Railway entirely; endgame)
- Layer-2 media index + static `{media_id}.{params}.json` on object storage/CDN. Extension
  reads the static file first; only falls back to the API (which computes + backfills the
  file) on a miss. Hits never touch Railway at all → serve-path RAM effectively zero.
- Most work; the "thousands of users on $5/mo" endgame.

**Because cache comes first, A→B is a refactor, not a rewrite** — B is just "move the compute
closure behind an internal endpoint." Don't choose now; build the cache, let measurement decide.

---

## 5. The one measurement that settles A vs B (DO THIS BEFORE THE SPLIT)

Plot a worker's **RSS over uptime** against which languages it has served:

- **RSS climbs step-wise as each new language first appears, then plateaus** → it's the creep
  → Option A (cache + recycling) likely sufficient; B is over-engineering.
- **RSS is already high right after restart serving only ja** → baseline footprint of even
  *one* dict is the wall → need B (or trim installed language packs).

Also note *how* the ceiling manifests:
- **Periodic OOM-kill after long uptime** → creep → recycling helps.
- **Instant OOM on the first heavy request** → baseline → split / trim.

---

## 6. Gotchas (load-bearing — don't relearn these)

1. **Version-stamp the cache key — non-negotiable.** CLAUDE.md documents dozens of *known*
   romanization failure modes we intend to fix later (ברוך → varokh, Pākistān → Pākasatān, …).
   The moment we fix e.g. the Hebrew romanizer, every cached Hebrew entry is stale. Include a
   per-language (or global) `engine_version` in the key → old rows are simply never read again.
   Without it we serve old bugs forever and "why didn't my fix take?" becomes a nightmare.
2. **Caching cuts CPU; it cuts RAM only via lazy-load avoidance** (see §3). Don't assume a
   cache flattens RAM on a single shared worker — it doesn't, without recycling or the split.
3. **"Bypass Railway" has two tiers.** A DB cache still hits Railway (cheap indexed SELECT vs
   NLP run). Railway *untouched* on hits requires the CDN-precompute tier (Option C). Postgres
   cache is the right v1; CDN is the scale endgame.
4. **Layer 2 is a privacy-policy change.** The AMO listing declares `data_collection:
   websiteContent`. Storing subtitle text + which media an (implicit) user watched, server-side,
   is real collection — store **decoupled from IP/identity**, and update `/privacy` + store
   listing copy. Layer 1 stores anonymous strings and is much lower-stakes.
5. **Text normalization before hashing** raises hit rate (strip/normalize whitespace, unicode
   NFC) but must be applied identically on read and write, and must not change what gets
   romanized. Keep the normalization deterministic and version it alongside `engine_version`.

---

## 7. Recommended first increment (when we resume)

1. Add a Postgres service on Railway.
2. One table, e.g. `romanization_cache(key_hash PK, lang_code, phonetic_system, mode,
   engine_version, input_text, output_json, created_at)` — keyed per §2 Layer 1, including
   `engine_version`.
3. Wrap the two batch loops (`romanize_batch`, `annotate_batch`) read-through/write-back —
   only misses run the closures.
4. Turn on worker recycling (`max_requests`).
5. **Measure RSS-vs-uptime (§5).** That number decides whether the compute/serve split (B)
   is necessary or architecture-astronaut appeal.

~Half a day, no API contract change, no client change. Ships the scaling win, starts the data
asset, and everything else (media index, CDN tier, compute/serve split) layers on top without
rework.

---

## 8. Open threads to pick up next session

- Schema/key design details (exact normalization, hash function, output_json shape per route).
- Railway service-vs-cost mechanics of the split (does a 2nd service leave the $5 tier?).
- How the same table feeds the Step 6 OCR corpus (Layer 2 join + `opt_in_training` wire-up).
- Whether to trim installed language packs as a separate RAM lever.

**Cross-refs:** `CLAUDE.md` (Owner Auth Roadmap notes the Step-6 fan-out that needs the
bypass), `loom_api/routes/{romanize,annotate}.py` (the pure batch loops to wrap),
`loom_core/styles.py:261` (`get_lang_config`), `loom_core/romanize.py` (lazy imports + factories),
`memory/reference_ocr_roadmap.md` (Step 6 corpus consumer).
