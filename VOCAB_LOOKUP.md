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

New endpoint (shape TBD during build):

```
POST /define/batch      # or /define — (word|lemma, lang, pos?) → senses
  request:  { items: [{ word, lemma?, lang, pos? }] }
  response: { results: [{ word, lemma, lang, senses: [{ gloss[], pos?, common? }], reading? }] }
```

- Looks up `dictionary_entry WHERE lang=? AND (headword=? OR reading=?)` (see §5.4 rule 1),
  **merging** all matching rows into one result (§5.4 rule 2 — sense lists concatenated,
  `common` first).
- Reads through / writes back the **existing result cache** as `kind="definition"`, keyed on the
  word/lemma (not the full line). Fail-open like every other cache path.
- Add the streaming platforms' page origins to CORS as needed (already handled generically via
  `loom_api/cors.py` + `LOOM_CORS_ORIGINS`).
- Rate-limited under the existing slowapi limiter; owner-bypass applies.

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

- **Phase 0 — backend tokens:** emit word tokens; expose JA lemma/POS; jieba grouping for ZH.
  Bump annotate `engine_version`.
- **Phase 1 — backend dictionaries:** load JMdict + CC-CEDICT; `/define` + cache (`kind=definition`).
- **Phase 2 — extension UX:** consume tokens; pause-gated hover-glow; click → card (JA + ZH).
- **Phase 3 — Korean:** add morphological analyzer (`mecab-ko`/`khaiii`) + a usable KR dictionary;
  then reuse the Phase 2 UX.

## 9. Open decisions

1. **Card scope for v1** — recommend **minimal** (headword + reading + top 1–2 senses), let it grow.
2. **Client-side dictionary** — not in v1; revisit CC-CEDICT-in-IndexedDB for offline JA/ZH later.
3. **Korean dictionary source** — KRDict (API/data licensing) vs kengdic vs other. Settle in Phase 3.
4. **`/define` vs `/define/batch`** — single-word on click is simplest; batch leaves room to
   prefetch a paused line's whole token set in one request. Lean single-word first.
