# Per-Word Vocabulary Lookup — Design

> **Status:** DESIGN (2026-07-08). Not yet built. Supersedes the placeholder marker in
> CLAUDE.md's Active Focus. Owner: Connor. Approach signed off: **server-side lookup**,
> reusing the existing API + result cache.

## 1. Vision

When the video Loom is overlaying is **paused**, the learner can **hover** any word in the
foreign (Top) caption — the word **glows** — and **click** it to open a small **definition
card** anchored to that word. The card shows:

- the word's characters (surface form),
- its per-character annotation (furigana / pinyin / RR) and full romanization,
- what it means (dictionary senses / gloss),
- (later) POS, common-ness, an example sentence.

This is the genre-standard interaction (Language Reactor, Yomitan, Migaku, asbplayer) — but
delivered as Loom's clean overlay across *arbitrary* streaming platforms, which those tools
don't do.

**Initial target languages: Japanese, Chinese (Mandarin), Korean.** Ship **JA + ZH first**
(clean + core anime / C-drama audience); **Korean is Phase 3** (see §3, §8 — it's the hard leg
on both morphology and dictionary data).

## 2. Guiding decision: server-side, on-demand, cached

**No third-party live API.** We own the dictionary data and serve it from
`api.loom.nerv-analytic.ai`. Rationale:

- A live API (Jisho/DeepL/Google) leaks *per-word lookups* to a third party, adds latency, and
  costs money.
- **No new privacy boundary:** the server already receives the full subtitle text via
  `/annotate` and `/romanize`. A server-side `/define` sees strictly *less* than that. (The
  extension's corpus-consent posture is unaffected — definitions are not user data.)
- Reuses infra we already have: the FastAPI service, CORS allow-list, and the content-addressed
  Postgres result cache.

**Definitions are looked up on-demand (per click), NOT precomputed into the batch.** A full
JMdict entry per word × every line × a whole episode would bloat the `/annotate/batch` payload
enormously when ~95% of words are never clicked. The batch grows only by lightweight
**word-token grouping + lemma** (§4); the heavy dictionary payload is fetched lazily and cached.

**Client-side dictionary (IndexedDB) is explicitly out of scope for v1** — a nice later
optimization for offline / zero-latency (CC-CEDICT is small enough to consider), but it's a
data-versioning burden inside the extension we won't take on now.

## 3. What already exists (grounding — verified 2026-07-08)

The segmentation the lookup keys off of is **partly** already produced. One assumption in the
original premise needs correcting:

| Language | Annotation granularity today | Word boundaries? | Lemma / dict-form? |
|---|---|---|---|
| **Japanese** | **word-level** (MeCab tokens) | ✅ yes (MeCab) | ✅ **already computed, then discarded** |
| **Chinese** | **per-character** (你, 好) | ✅ **already computed** in the *romanizer-line* pipeline (jieba) — just collapsed to a string, not exposed | n/a — no inflection, word = headword |
| **Korean** | **per-syllable** | ❌ none in annotation | ❌ none — needs a morphological analyzer |

Key file references:
- **Wire span shape = `(base, reading)` only**, no lemma/POS: `loom_api/routes/annotate.py:68-71`
  (`AnnotateSpan`), batch item at `:183-191`.
- **Japanese lemma + POS ARE captured internally then dropped:** `loom_core/romanize.py:919`
  (`lemma = word.feature.lemma`), `:926` (5-tuple `(surface, kana, pos1, pos2, lemma)`), but only
  `(surface, reading)` survives span-building at `:959-971`. Lemma is used solely by the romaji
  verb-chain merge heuristic (`_should_merge_for_romaji`).
- **Chinese annotation is per-character:** `_make_chinese_annotation_func`, `romanize.py:1157-1168`
  (jieba word-seg is used only in `_make_pinyin_romanizer`, the *line*, not annotation).
- **Korean annotation is per-syllable:** `_make_korean_annotation_func`, `romanize.py:1321-1332`.
- **Client tokens are already discrete DOM elements** (one `<ruby>`/`<span>` per token):
  `apps/extension/components/annotated-text.tsx:109-182`. Raw fetch type
  `apps/extension/lib/annotate/types.ts:8-18`; rendered as `RichSegment`
  (`lib/orthography/types.ts:26-39`). So hover-glow + click bind directly per element.
- **Result cache** keys on `sha256(kind, lang, system, mode, engine_ver, NORMALIZATION_VERSION,
  normalized_text)`, arbitrary JSON value: `loom_api/result_cache.py:71-86`. A new
  `kind="definition"` keyed on the **word/lemma** (not the line) fits with zero schema change.

**Consequence for the clickable unit:** a "word" for lookup purposes is a group of the current
per-char/syllable spans. JA gets this grouping for free (MeCab). ZH needs jieba grouping carried
into the annotation layer. KR needs a real analyzer.

## 4. Data model — word tokens

Introduce a **word-level token** in the annotate response, additive and backward-compatible
(keep the flat `spans` array for the existing render; add a `tokens` grouping):

```
Token {
  word:    str            # the clickable surface unit (食べて / 你好 / 먹었어요)
  lemma:   str | null     # dictionary form for lookup (食べる); == word when no inflection (ZH)
  pos:     str | null     # part of speech, for sense disambiguation + card display (JA)
  spans:   [{ base, reading }]   # the per-char/syllable sub-units for ruby rendering
  lang:    str            # resolved lang code
}
```

The client renders ruby per `spans[]` exactly as today, but draws the glow + binds the click at
the **token** level. Bump `engine_version` for annotate when this lands (cache discipline).

Producing tokens per language:
- **JA** — stop discarding the MeCab lemma/POS; emit tokens directly (word grouping is native).
- **ZH** — the jieba segmentation **already exists** inside `_make_pinyin_romanizer`
  (`romanize.py:635`, `words = list(jieba.cut(clean))`), and already maps word boundaries back
  onto the original surface text for Traditional via the OpenCC t2s round-trip (`:623-633`, each
  word is a slice `clean[pos:pos+len(sw)]`). Today it collapses to a string at `:652`. The work
  is to **expose that `words` list as structured tokens** (each = surface slice + its per-char
  annotation sub-spans), NOT to add jieba. `lemma = word` (no inflection, no lemmatizer).
- **KR** — Phase 3: add `mecab-ko` / `khaiii` for eojeol→morpheme + lemma; group syllable spans.

## 5. Dictionaries (server-side)

### 5.1 Sources — verified + downloaded 2026-07-08

| Language | Dictionary | License | Source (exact) | Size / count |
|---|---|---|---|---|
| Japanese | **JMdict-simplified** (pre-parsed JSON of EDRDG JMdict) | CC-BY-SA 4.0 (EDRDG) | `github.com/scriptin/jmdict-simplified` releases — `jmdict-eng-*.json` (full, ~11MB tgz) or `jmdict-eng-common-*` (22,610 entries, 1.4MB tgz). Release `3.6.2+20260706150322`. | full ≈200k entries |
| Chinese | **CC-CEDICT** | CC-BY-SA 4.0 (MDBG) | `mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz` (4MB gz) | **124,788 entries** |
| Korean | **KRDict / kengdic / Kaikki** (TBD) | mixed / weaker | Phase 3 — settle then | the weak leg |

**Full vs common (JA):** ingest the **full** `jmdict-eng` (Postgres removes the size pressure) and
use each entry's `common` flag as a **ranking** signal (common senses first), NOT as a filter —
a learner clicking a rare word should still get a hit, not "not found". `eng-common` (22.6k) is a
fine fast-start if we want to move quickly.

### 5.2 Real formats (as observed)

**JMdict-simplified** — top level `{version, languages, tags, words[]}`; `tags` maps POS/misc
codes → human text (`v1` → "Ichidan verb", `vt` → transitive). Each word:
```
{ id, kanji: [{common, text, tags}], kana: [{common, text, tags, appliesToKanji}],
  sense: [{ partOfSpeech:[code], field:[], misc:[], gloss:[{lang, text}] }] }
```
Lookup keys on `kanji[].text` AND `kana[].text` (kana-only words have empty `kanji`). MeCab lemma
matches `kanji[].text` directly; POS from MeCab helps rank/disambiguate multi-entry hits.

**CC-CEDICT** — one line per entry, `#` comments:
```
繁體 简体 [pin1 yin1] /sense one; synonym/sense two/.../
```
`/` splits **distinct senses**, `;` splits **synonyms within** a sense. Pinyin is space-separated
numbered-tone (`ni3 hao3`). Some sense strings embed `CL:個|个[ge4]` (measure words) and cross-refs
— preserve or lightly clean at ingest. No POS. Keyed on both Traditional and Simplified headwords.

### 5.3 Unified storage schema (Postgres)

Normalize both sources into one table (see §2 — RAM tripwire keeps this out of worker memory; the
result cache fronts reads):
```
dictionary_entry (
  id            bigserial pk,
  lang          text,           -- 'ja' | 'zh'
  headword      text,           -- 食べる / 你好  (INDEX on (lang, headword))
  reading       text,           -- たべる / 'ni3 hao3'  (INDEX on (lang, reading) for JA kana + ZH)
  senses        jsonb,          -- [{ pos:[str], gloss:[str], misc:[str]?, field:[str]? }]
  common        bool,           -- ranking, not filter
  source        text,           -- 'jmdict' | 'cc-cedict'
  source_version text
)
```
- **JA:** one row per JMdict word; `headword` = each kanji form, `reading` = each kana form
  (may fan out to a few rows per word so any surface/reading hits). `senses[].pos` = expanded tag
  text.
- **ZH:** one row keyed on Traditional + one on Simplified (or a single row with both indexed) so
  either script hits; `reading` = pinyin; `senses[].pos` = [].

Attribution required (CC-BY-SA) — card footer + a `/licenses` (or `/privacy`) entry.
✅ DONE 2026-07-08 (shipped in 0.4.0): the definition card names its source dictionary, and the
`/privacy` page carries a "Dictionary data & licenses" section attributing JMdict (EDRDG) +
CC-CEDICT under CC BY-SA 4.0 with license links.

### 5.4 Parser — built + validated 2026-07-08

`scripts/ingest_dictionaries.py` normalizes both sources into §5.3's row shape.
`validate` mode (DB-free) parses both and dumps sample words; `ingest` mode upserts to Postgres
(creates the table + indexes, deletes-then-inserts per source for idempotent re-runs).

Validated against the downloaded files: **502,656 rows total (JA 300,268 / ZH 202,388)**.
Spot-checks confirmed: 食べる (2 senses, POS expanded, `common:true`), 你好 (both a ZH and a JA
row under one headword), 喜歡/喜欢 (trad+simp fan-out), 吃 (multiple rows — real entry + variant).

**Two query rules this surfaced for `/define` (§6):**
1. **Query `headword OR reading`.** A kana-written word (たべる) lives in the `reading` column, not
   `headword` (that row's headword is the kanji 食べる). Both are indexed. So MeCab may hand us
   either a kanji lemma (→ headword hit) or a kana lemma (→ reading hit).
2. **Expect multiple rows per (lang, headword)** — homographs, CC-CEDICT variant/cross-ref lines,
   JMdict multi-form words. `/define` merges them into ONE card (concatenate sense lists,
   `common` rows first). CC-CEDICT "variant of X" glosses can be deprioritized (refinement).

## 6. API surface

**`POST /define/batch` — BUILT 2026-07-08** (`loom_api/routes/define.py`,
`loom_api/dictionary.py`, `loom_api/deps.py`; mounted on web + main). Actual shape:

```
request:  { lang: "ja"|"zh", words: [str] }          # words = lemmas/surface forms
response: { lang, results: [ { word, found,
                               reading?, sources: [str],
                               senses: [ { gloss:[str], pos:[str], misc:[str] } ] } ] }
```

- `results` is **1:1 with `words`** — same order, duplicates kept, each with its own `found` flag,
  so the client zips them straight back onto the clicked tokens. This endpoint does NOT
  tokenize/lemmatize — it defines exactly the strings given (Phase 0 / the client owns the lemma).
- Store (`DictionaryStore`: Null / InMemory / Postgres, mirroring `corpus_store.py`) queries
  `dictionary_entry WHERE lang=? AND (headword = ANY(?) OR reading = ANY(?))` — ONE query for the
  whole word list (§5.4 rule 1) — then merges rows per word (§5.4 rule 2: `common` first, glosses
  deduped across sources).
- **Decomposition fallback (Chinese)** — jieba groups number+measure-word and other compounds
  (一顶 / 两个 / 一道) that CC-CEDICT only holds the *pieces* of, so an exact lookup misses. On a
  zh miss (len ≥ 2), the store greedily longest-matches the word against the dictionary itself
  (`_decompose_zh`, one extra batch query over the missed words' substrings) and returns the
  components as `Definition.parts` (`found=false`, `senses=[]`). `/define` surfaces them as
  `DefineResult.parts`; the card renders a "Breakdown" (一 + 顶). Same technique as Pleco/Yomitan;
  generalizes past measure words to any OOV compound. JA is not decomposed (MeCab already lemmatizes).
- **No result-cache layer** (revised from the earlier plan): a dictionary lookup is a single
  indexed query, not expensive compute like MeCab/jieba, and the batch collapses a paused line into
  one query — so caching would trade latency for latency. Trivial to add later if profiling shows a
  need. **Fail-open** like the cache/corpus stores: no DSN / down DB → every word `found=false`.
- CORS: streaming origins already handled generically (`loom_api/cors.py` + `LOOM_CORS_ORIGINS`).
  Rate-limited under the existing slowapi limiter; owner-bypass applies.
- Env: `LOOM_DICTIONARY_URL` (else `DATABASE_URL`); `LOOM_DICTIONARY=off` kills it.
- Tests: `tests/test_dictionary.py` (store merge/scoping + route order/echo/nfc/failsoft),
  `tests/test_ingest_dictionaries.py` (pure CC-CEDICT/JMdict parsers). 21 new, green.

### 6.1 Capability-driven, language-agnostic client — SHIPPED 2026-07-09 (`9989b7a`)

**Governing goal (Connor):** *"when I develop and implement a new dictionary, I don't want to
ever have to upload a new extension."* The client no longer hardcodes which languages are
definable. That decision — and which language definitions are written in — is served.

- **`GET /define/capabilities` → `{source_langs, gloss_langs, version}`.** A source language is
  listed only if it has BOTH a dictionary AND a word tokenizer (`is_token_supported` in
  `romanize.py`, `SUPPORTED_TOKEN_PRIMARIES={ja,zh,yue}`). `gloss_langs` = languages definitions
  can be written in (English always present). `version` bumps only on wire-shape change — a new
  dictionary needs NO bump (client refetches per session).
- **Gloss-language axis.** `dictionary_entry.gloss_lang` column (schema + `ALTER … ADD COLUMN IF
  NOT EXISTS`); `/define/batch` takes `gloss_lang` and falls back to English **per word** when a
  word has no gloss in the requested language (`_select_gloss_lang`). So a JA speaker learning ZH
  gets ZH→JA definitions the moment that data lands, English elsewhere — no client change.
- **Client (`apps/extension/lib/annotate/`):** `capabilities.ts` session-caches the GET (build-time
  fallback `{ja,zh}`/`{en}`, never persisted so a new dictionary appears next page load).
  `define-lang.ts` is no longer an allowlist — `normalizeDefineSourceLang` only NORMALIZES (all
  Chinese variants → `zh`, never null); `isDefinable(caps, code)` consults the served set;
  `resolveGlossLang(caps, override?)` picks override → `browser.i18n.getUILanguage()` → `en`.
  `discover.ts` gates target-track token fetching on `isDefinable`, and the definition card sends
  the source lang + resolved `gloss_lang`.
- **No dead-end glow:** a track whose language isn't in `source_langs` gets empty `targetTokens` →
  words are not interactive (no hover glow, no click). The media track never "bugs out."
- **Verified live 2026-07-09:** `/define/capabilities` → `{ja,zh},{en},v1`; `猫` `gloss_lang=fr`
  falls back to English "cat" with tone-marked `māo`; `東京` → `Tōkyō`/`Toukyou`.
- **What a new dictionary now costs (no extension release):** ingest rows into `dictionary_entry`
  (with `gloss_lang`), and — if it's a NEW source language — ensure a tokenizer exists so
  `is_token_supported` returns true for it. Then it lights up on the next page load everywhere.

### 6.2 Grammar-aware breakdown — SHIPPED 2026-07-11 (`31ddb7c` JA, `8fe2f02` KO, `ef1dd3e` form-of)

The dictionary says what a word MEANS; this says what it's DOING. Clicking an inflected word
returns, above the senses, its **dictionary form + an ordered inflection chain**
(食べさせられた → 食べる · causative · passive · past). All of it rides the existing `/define/batch`
call — no new endpoint, computed per-click so the batch never bloats.

- **Wire shape (additive to §6):**
  ```
  request:  { …, surfaces?: [str], surface_continuations?: [str] }   # aligned 1:1 with words
  response: { …, results: [ { …, grammar?: { dict_form, features:[{ code, display, surface }] } } ] }
  ```
  `surfaces[i]` = the inflected caption word (vs `words[i]` = the lemma the client already
  computed); grammar is analyzed from the SURFACE, independent of whether the dict hit. Each
  feature carries a stable `code` (client-localizable later) + an English `display` shown now →
  **release-proof**. `surface_continuations[i]` = the next cue's lead text for the LAST token
  (finding ③ cross-cue stitching); server-accepted, **client doesn't send it yet** (deferred to
  a later build).

- **Two engine families, one `GrammarBreakdown` shape (`loom_core/grammar.py`):**
  1. **Live morphology — ja + ko only.** `analyze_japanese_grammar` walks the MeCab (fugashi/unidic)
     morpheme chain — causative / passive / potential / desiderative / past / polite / negative /
     volitional / imperative / te-form + -te aspectuals / conditionals / copula; suru-verbs recover
     the full dict form (勉強しました → 勉強する). `analyze_korean_grammar` walks the kiwipiepy
     morpheme chain the same way (agglutinative endings: past 았/었, honorific 시, presumptive 겠,
     progressive 고 있다, desiderative, benefactive, obligation, potential, EF mood/politeness,
     copula). Both share `get_shared_ja_tagger` / the KRDict tokenizer already spun up for reading.
  2. **Dictionary-driven form-of — ~15 Wiktextract languages, NO analyzer.** hi / es / fr / de / it /
     pt / ru / uk / … don't get a morphological engine (stanza/spaCy ~1 GB is wrong for the $5/mo
     box). Instead the ingested Wiktextract data ALREADY encodes morphology: an inflected form
     (करते, comieron, Kinder) is a **`form-of` entry** whose gloss names its lemma and whose
     structured `tags` list is stored in the sense `misc`. `/define` detects a form-of first-sense
     (`_form_of`), follows `extract_form_of_lemma(gloss)` to the lemma, does a SECOND batched
     `store.lookup` for the real senses, and turns the tags into a `GrammarBreakdown` via
     `grammar_from_tags(tags, lemma)` (drops `form-of`/unknown markers; orders
     voice→aspect→tense→mood→verbform→person→number→gender→case→politeness→degree via
     `_WIKT_TAG_ORDER`; humanizes via `_WIKT_TAG_DISPLAY`). So the card shows करते → करना ·
     habitual · participle · plural · masculine with NO per-language code and NO new dependency —
     Wiktionary's editors already did the analysis. This is the "Romance/Slavic leg" that was
     thought to need an analyzer; it didn't.

- **`grammar_supported(lang)`** = ja ∪ ko (live morphology) ∪ any lang whose dict rows carry
  form-of tags (resolved at request time, not a static set). `_to_grammar_model` bridges the
  loom_core dataclass → the pydantic response model. Fail-soft: unparseable surface / no
  recognized feature → `grammar` omitted, senses still return.

- **DEPENDENCY on the dictionary data:** form-of grammar REQUIRES the `form-of` inflection rows
  to stay in `dictionary_entry`. Do NOT drop them to save space (see `DICTIONARY_SOURCES.md` —
  that footprint-trim idea is now disallowed for any language we want grammar on).

- Client: the card renders a "Grammar" section (dict form → feature pills); **rides the next store
  build** (the LIVE 0.4.0 has no grammar UI). Tests: `tests/test_grammar.py`,
  `tests/test_form_of.py` (19).

## 7. Extension UX

- **Pause-gated.** Lookup mode activates only while the `<video>` is paused (aligns with the
  existing dev pause probe, `lib/overlay/caption-probe.ts`). During playback, tokens are inert.
- **Hover → glow.** CSS on the per-token elements (they're already discrete DOM nodes).
- **Click → card.** Fetch `/define` for that token, render a floating card anchored to the word,
  flipping above/below to stay inside the picture. Card = surface + ruby reading + romanization +
  senses (+ later POS / common-ness / example).
- **Click must not toggle play/pause** — reuse `lib/overlay/stop-player-events.ts`.
- Perf tripwires still apply (no `backdrop-filter`; keep the card off the per-frame path).

## 8. Phasing

- **Phase 0 — backend tokens:** ✅ DONE 2026-07-08. `/annotate` + `/annotate/batch` now return a
  `tokens` array alongside `spans` — each `{word, lemma?, pos[], start, length}` where
  `spans[start:start+length]` compose the word (`loom_api/routes/annotate.py`). Production in
  `loom_core.romanize.build_word_tokens`: **JA** carries the MeCab lemma+POS (1 token : 1 span;
  UniDic `私-代名詞` disambiguator suffix stripped so JMdict lookup hits; inflected 見た→lemma 見る)
  via a per-span metadata stash on `resolve_spans`; **ZH** (all variants) groups the atomic
  per-char spans by jieba words (`_jieba_words`, incl. the Traditional→Simplified boundary
  round-trip), exact char-count alignment. Other langs return `[]` (Korean = Phase 3). Cache:
  `{spans, tokens}` cached together, `ENGINE_VERSIONS` bumped ja/zh/yue→2 so old spans-only rows
  don't serve token-less results. `@loom/api-client` regenerated (additive). Tests:
  `tests/test_annotate_tokens.py` (11, incl. the span-alignment invariant). Extension + api-client
  tsc clean.
- **Phase 1 — backend dictionaries:** 🟡 IN PROGRESS.
  ✅ parser (`scripts/ingest_dictionaries.py`, validated 502k rows); ✅ `/define/batch` + store +
  tests (`loom_api/dictionary.py` / `routes/define.py`, 21 tests green); ✅ **local Postgres ingest
  + lookup validated 2026-07-08** — 502,656 rows loaded in 21s (ja/jmdict 300,268 + zh/cc-cedict
  202,388), `PostgresDictionaryStore.lookup` confirmed live incl. the kana→`reading` path (たべる
  found) and 6-sense merge (吃); batch of 5 in 0.7ms. ✅ **Railway ingest + prod deploy DONE
  2026-07-08** — 502,656 rows loaded into the prod Postgres (neighbors untouched: cache 54,816 /
  corpus_line 53,605), `/define` deployed to `main`, and `POST api.loom.nerv-analytic.ai/define/batch`
  smoke-tested live (食べる 2 senses + POS, kana たべる, zh 吃/你好). **Phase 1 COMPLETE.**
- **Phase 2 — extension UX:** 🟡 BUILT 2026-07-08, awaiting live verification. Pause-gated
  per-word hover-glow + click → `DefinitionCard` (fetches `/define/batch`). Seams: (a) `tokens`
  threaded through a parallel `AnnotateTokenMap` (spans render path untouched) — `lib/annotate/`
  {types,build-map,cache} + discover + caption-context; (b) `planWordGroups` groups segments into
  word runs, `annotated-text.tsx` wraps each token's run in a `.loom-vocab-word` span
  (`swallowPlayerEventsExceptClick`, glow `<style>` only when interactive); (c) `usePaused`
  (capture-phase play/pause on the tracked `<video>`, target-gated + 1s resync), `defineLangFor`
  (BCP-47→ja/zh), `definition-card.tsx` (solid bg, own layer, shadow-aware dismiss).
  **Interactivity fully gated on `paused` → zero playback-time change.** Review fix: `buildRichSegments`
  gained `coalescePlain` — disabled for the interactive target line so segments stay 1:1 with spans
  (coalescing adjacent plains would mis-wrap tokens after a punctuation/kana run). tsc + 290 vitest
  green. **Owed: live browser test** — card positioning (windowed + fullscreen), glow/wrap on the
  right glyphs, pause events firing per platform (Netflix MSE / Prime surface), native line inert.
- **Phase 2.1 — JA word merging + contextual reading:** ✅ DONE 2026-07-08 (`8c52c73`, deployed).
  Two live-testing bugs on Frieren: (1) MeCab/UniDic over-segments — 食べさせられた split to
  食べ／させ／られ／た, so clicking an inflected verb hit a fragment that missed JMdict; (2) the topic
  particle は was read literally "ha", not the spoken わ. Both fixed by reusing the romaji pipeline's
  merge metadata (`resolve_spans._loom_ja_meta` → `{token_meta, merge_mask, particle_ha}`):
  `_japanese_tokens` now groups content-word + trailing auxiliaries into ONE token via the same
  `_should_merge_for_romaji` merge_mask the romaji line uses, lemma from the HEAD morpheme's dict
  form (→ 食べる); nouns/particles keep their boundaries. Each token carries a CONTEXTUAL reading
  (は→わ) surfaced in the card header over the dictionary reading. **Token tuple grew to 6:**
  `(word, lemma, pos, reading, start, length)` — threaded through the route (+cache), `AnnotateToken`
  schema, regenerated api-client, and the extension click chain (`onWordClick`→`SelectedWord`→card).
  ZH tokens emit `reading=None` (card falls back to /define pinyin). `ENGINE_VERSIONS` ja/zh/yue→3.
  Also fixed a latent module-import `NameError` (`_clean_ja_lemma` annotation referenced unimported
  `Optional`). Decision: **keep MeCab, do NOT swap to Sudachi** — split-mode-C's benefit is
  replicated by the merge mask, deinflection is tokenizer-independent, and the large tested JA
  pipeline is the argument against a swap. Tests: +2 py (verb-chain merge, contextual reading via
  cache round-trip); `test_annotate_tokens` on the 6-tuple; 232 romanize/annotate py + 290 vitest green.
- **Phase 2.2 — corpus-driven JA robustness:** ✅ DONE 2026-07-08 (`ccbc98b`, deployed). Measured
  over ALL 114,247 JA tokens in loom-corpus (Evangelion / Mononoke / Frieren / Apothecary / JJK):
  95% of tokens already resolved; the 5% miss was dominated by EXPECTED misses (character names 68%,
  English lyrics, numbers, interjections). Two genuinely-fixable patterns fixed:
  (1) **Tokenizer punctuation-strip** — a merged trailing 補助記号 (…) was inside the clickable word
  (は…, あっ…, そうか… — ~2,443 tokens); `_japanese_tokens` now trims leading/trailing punctuation-only
  spans. Corpus: punctuation-in-surface 2,443 → 52 (98% gone). `ENGINE_VERSIONS` ja→4.
  (2) **`/define` multi-key + honorific decomposition** — endpoint gained optional `alt_keys` (the
  extension sends the token SURFACE as a fallback to the lemma); rescues MeCab lemma truncations
  (黒曜石 lemma=黒曜 misses, surface hits: obsidian). Plus a honorific peel (`dictionary.py`
  `_decompose_ja`): a name glued to 様/さん/君/ちゃん/殿/氏/坊 that misses as a whole decomposes into
  [stem?, honorific], the honorific gloss from a **hardcoded closed-set table** (bare kana are
  ambiguous homophones in JMdict: さん→acid, 様→sorry-state). **Miss-gated**, so lexicalized
  お母さん/母さん/赤ちゃん/たくさん hit directly and never decompose (verified). Net over corpus:
  useful-result rate 95.0% → 96.0%. **Deliberately NOT done: a JA deinflection ruleset** — MeCab's
  lemma already covers inflection at 95%, and the residual misses (刺さって→差さる wrong-kanji lemma,
  compound-noun gaps like 混ぜ入れる) are mostly NOT deinflectable (they're dictionary-coverage /
  decomposition territory). Deinflection is best-practice for tokenizer-LESS tools (Yomitan); we run
  MeCab, so it's redundant. Tests: +5 dictionary, +2 tokenizer; 292 py + 290 vitest green.
- **Phase 3 — Korean:** ✅ BUILT 2026-07-10 (backend; rides the next extension build for user
  visibility). Two pieces:
  - **Tokenizer** (`romanize.py::_korean_tokens`): **kiwipiepy** (chosen over mecab-ko/khaiii —
    pip-installable manylinux wheels, no system deps → clean on Railway; live-validated). Korean
    annotation spans are per-syllable (like Chinese), so the analyzer groups them into words and
    recovers the DICTIONARY FORM: a content head (noun/verb/adj/…) opens a word, particles + endings
    + suffixes attach, a space or the next head closes it. Lemma = KRDict headword: predicates get
    stem + 다 (먹었어요 → 먹다, irregulars via kiwipiepy's normalized stem 즐거워요 → 즐겁다), and 하다/되다
    derivations reconstruct the DERIVED form (공부했어요 → 공부하다, 깨끗하다 → 깨끗하다) rather than the bare
    noun/root. Load-bearing detail: irregular conjugations give OVERLAPPING morpheme char-spans, so
    attachment tests "no whitespace between", not exact adjacency. `SUPPORTED_TOKEN_PRIMARIES` += ko;
    `ENGINE_VERSIONS["ko"]=2` (was [] tokens at the default v1). +8 token tests (kiwipiepy-gated skip).
  - **Dictionary** (`ingest_dictionaries.py::parse_krdict`): **KRDict / NIKL 한국어기초사전**, the standout
    multilingual source — Korean → up to **11 gloss languages** (en/ja/zh/fr/es/ar/mn/vi/th/id/ru),
    **CC-BY-SA 2.0 KR**, bulk-redistributable. Format is NIKL LMF XML (`<feat att val>`); the target
    language is a Korean NAME string (영어/일본어/…) mapped to BCP-47. One row per (headword, gloss_lang)
    → the `gloss_lang` axis lights these up with no client change. Media/audio URLs never read
    (not redistributable). Attribution "한국어기초사전 - 국립국어원 제공" added to `/privacy`. Parser
    validated against a real 35 MB mirror chunk (spellcheck-ko); +8 parser tests.
  - **Acquisition** (`DICTIONARY_SOURCES.md §5`): pull LMF chunks from the spellcheck-ko mirror
    (git-versioned, no download gate) — but that 2019 snapshot has 10 languages, **no Chinese (중국어)**;
    top up zh from a fresh official NIKL download later. Ingest: `python scripts/ingest_dictionaries.py
    ingest --krdict <dir-of-chunks>` (idempotent per source).
  Prior NOTE stands: Phase 3 is a NET-NEW language, not a fix for the JA issues — decided on its own
  merits (K-drama / K-content audience; Korean had zero word-level lookup before this).
- **Phase 4 — generic multilingual expansion (space-delimited langs):** ✅ Spanish 2026-07-09;
  **fr/de/it/pt/sv/nl 2026-07-10** (backend live; rides the next extension build for user visibility).
  The insight: for space-delimited languages the tokenizer is trivial (letter-run regex) and the only
  real work is LEMMATIZATION (comieron→comer) so the click resolves to a dictionary headword. That's
  **simplemma** (one light dep, ~50 languages, non-contextual, fail-soft to the surface form) behind a
  `_generic_tokens` fallback in `build_word_tokens` — reached ONLY for langs with no bespoke analyzer
  (custom ja/zh/ko always win). Enabled PER language via `GENERIC_TOKEN_PRIMARIES`, and only after
  `scripts/dict_quality_check.py` clears the bar on REAL text.
  - **The gate is a corpus quality harness**: tokenize a Tatoeba sample through the production generic
    path, measure what fraction of content tokens resolve (lemma OR surface hits a kaikki Wiktextract
    headword/form). Tier-1 batch results (~15k Tatoeba sentences each): **de 98.5% · pt 98.5% ·
    sv 98.5% · nl 98.3% · it 97.0% · fr 94.4%** — every residual miss a proper noun (John/Kyoto/
    Tatoeba) except fr/it apostrophe elisions. All clear the ~96% JA baseline.
  - **Romance elision split** (`_split_elision`): fr/it/ca/oc elide a proclitic before a vowel
    (l'école, d'un, j'ai) — orthographically the apostrophe is a word boundary but the regex kept
    "l'école" whole so it never hit the dict (it was the ENTIRE fr/it miss list). Peel a LEADING
    clitic only when ≤2 letters → every elided clitic separates while genuine apostrophe-lexemes stay
    whole (aujourd'hui, quelqu'un, presqu'île — stems >2). Lifts fr/it content words miss→hit.
  - **Dictionaries**: kaikki **English Wiktextract** per-language JSONL (X→English, CC-BY-SA + GFDL),
    `parse_wiktextract` (keeps "form of" inflection senses as a lemmatizer-miss fallback; first IPA →
    reading). Ingested to prod: fr 400,741 · de 367,157 · it 622,231 · pt 427,927 · sv 310,953 ·
    nl 144,815 (+ es 804,263 from Phase 4's Spanish). `dictionary_entry` now ≈ 4.2M rows across 10
    source langs. Attribution added to `/privacy` ("Other languages — Wiktionary via kaikki").
  - **No client change needed**: definability is `is_token_supported ∩ SELECT DISTINCT lang`, resolved
    per-request by the capability endpoint (§6.1) — ingesting a dictionary + opting the lang into
    `GENERIC_TOKEN_PRIMARIES` lights it up server-side. `ENGINE_VERSIONS` es/fr/de/it/pt/sv/nl→2 (were
    [] tokens at the default v1). Tests: +3 elision, opt-in probe moved to pl. **Adding the NEXT
    space-delimited language = run the harness, ingest if it passes, add one line to
    `GENERIC_TOKEN_PRIMARIES` — no extension release.**
  - **Tier-2 batch — ru/pl/ro/da/cs/uk/hi/tr/id 2026-07-10** (backend live; rides the next build).
    Harness over ~15k Tatoeba/lang: **pl 98.6 · ru 98.2 · ro 97.8 · da 96.6 · cs 96.2 · uk 94.9 ·
    tr 94.8 · id 94.0** useful — the absolute numbers are DEPRESSED by Tatoeba's Tom/Mary
    over-representation (every miss list is proper-noun-topped: Tom appears 220× in tr, 1492× in hi),
    so real-content useful is ~96%+. Ingested to prod (ru 441,543 · pl 194,149 · ro 130,161 ·
    da 57,333 · cs 71,547 · uk 58,458 · hi 38,054 · tr 44,494 · id 38,450); `dictionary_entry` ≈ 5.26M
    rows / **19 source langs**.
  - **Brahmic-safe tokenization (the load-bearing fix here).** Python's stdlib `\w` / `str.isalnum()`
    is FALSE for a combining mark, so `_GENERIC_WORD_RE = [^\W\d_]+` dropped Devanagari dependent
    vowel signs (matras): करना → करन, and EVERY Devanagari word missed the dict (Hindi measured 88.5%,
    misses were truncated fragments). Fix: the **`regex` module's `\p{L}\p{M}`** (letters + combining
    marks) keeps marks in-word — one change that fixes all Brahmic + Arabic/Hebrew scripts at once
    (`requirements.txt` += `regex`; stdlib fallback if absent, correct for Latin/Cyrillic which is all
    we enable without it). Hindi → 93.8% (real ~96%), misses now real words. **Unlocks every future
    Indic language** with no further tokenizer work; hi also has aksharamukha ruby, so it gets ruby +
    clickable definitions together. Tests: +2 (matras kept in-word + offset reconstruction; Cyrillic).
  - **Deferred / caveats.** **Norwegian**: kaikki serves it as the macrolanguage `no`; simplemma has
    `nb`/`nn` but no `no` lemmatizer, so it needs a `no→nb` map + a harness pass before enabling.
    **Turkish**: sentence-initial İ-words (İyi/İki) miss because Python's default lowercasing of İ
    yields `i̇` (dotted) ≠ dictionary `iyi` — a Turkish-locale casefold fix, filed as a follow-up.
    **Indonesian**: enclitics (-kah/-lah/-ku/-mu/-nya) aren't peeled (Bisakah, padaku) — a clitic-split
    like the Romance elision handling would close it. Both ship now (proper-noun-dominated, ~94%).

## 9. Open decisions

1. **Card scope for v1** — recommend **minimal** (headword + reading + top 1–2 senses), let it grow.
2. **Client-side dictionary** — not in v1; revisit CC-CEDICT-in-IndexedDB for offline JA/ZH later.
3. **Korean dictionary source** — KRDict (API/data licensing) vs kengdic vs other. Settle in Phase 3.
4. **`/define` vs `/define/batch`** — single-word on click is simplest; batch leaves room to
   prefetch a paused line's whole token set in one request. Lean single-word first.
