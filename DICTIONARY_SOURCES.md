# Dictionary-Source Scouting — Multilingual Expansion

Sourced coverage + licensing survey for expanding Loom's per-word lookup beyond
JMdict (JA→en) + CC-CEDICT (ZH→en), toward more **source** languages and more
**gloss** languages (the language a definition is written in). Feeds the
capability-driven `/define` architecture (`VOCAB_LOOKUP.md §6.1`): each source
below is a pure server-side ingest — no extension release.

**Snapshots:** kaikki figures from Wiktionary dumps ~2026-06-28→07-08; JMdict
release `3.6.2` (2026-07-06); CC-CEDICT/CFDICT as of 2026-07-09. Counts drift on
future dumps. Every number below traces to a page fetched during the pass.

**Framing — two distinct levers.** kaikki.org publishes two corpus kinds:
1. `kaikki.org/dictionary/` — the **English** Wiktionary extract; every entry is
   `X → English` (universal, deepest coverage).
2. `kaikki.org/<code>wiktionary/` — a **native-edition** extract; `X → that
   language` (e.g. `jawiktionary` = words glossed in Japanese). Thinner, patchier,
   but the key to native-language glosses (ZH→JA etc.).

---

## ✅ DECISION 2026-07-11 — off-site the dictionary database (deferred; backend TBD)

**Decision.** The dictionary (`dictionary_entry`) will be moved **off the Railway
operational Postgres** onto a **separate, read-only store**. We are PAUSING further
dictionary growth until that store exists — the current Railway volume is full at
~3.5 GB and the zh native edition (3.36M senses) + all further native-edition
columns don't fit.

**Motivation.**
1. **We've already massively increased functionality** — 20 source langs × 16
   gloss langs / 8.95M rows, with the es + ja native-edition columns live
   (es→es 98.3%, ja→ja 90.2% monolingual, zh→ja 57.5% gap-fill). This is a strong,
   coherent stopping point; the remaining work is breadth, not capability.
2. **Finishing it is now PURELY a backend/API change — no extension release.** The
   client is capability-driven (`/define/capabilities` → `{source_langs,
   gloss_langs}` drives the whole UI; the extension stopped hardcoding definable
   langs, `VOCAB_LOOKUP.md §6.1`). And the server already abstracts the store
   behind the `DictionaryStore` protocol (`loom_api/dictionary.py`:
   Postgres / InMemory / Null impls). So swapping to an off-site backend is a
   **drop-in with zero route changes** and zero client work — a new store impl +
   a connection string.

**Why off-site (architectural rationale).** The dictionary and the cache/corpus
have OPPOSITE profiles and shouldn't share one volume:

| | Dictionary | Cache + corpus |
|---|---|---|
| Access | **read-only** (batch ingest; never per-request writes) | read-write, transactional |
| Size | ~10 GB now, **15–25 GB at a full 30×30** | small (~50 MB) |
| Needs | fast indexed point lookups | ACID, live writes |

Keeping the big static reference dataset out of the operational Postgres holds the
$5/mo flat target and lets the dictionary scale on storage priced for reference data.

**Backend — leading candidate + the open concern.** **Turso (hosted libSQL/SQLite)**
is the cleanest drop-in (read-only → SQLite's single-writer model is a non-issue;
the `DictionaryStore` protocol makes a `TursoDictionaryStore` a pure add). **BUT its
~8 GB free tier is likely too small for the near-term goal of a 30×30 dictionary**
(30 source × 30 gloss ≈ **15–25 GB** — 30 native editions at ~1–3M senses each, plus
the English column + JMdict/KRDict/CEDICT). So: Turso free fits the *current + near*
ambition; a real 30×30 needs **Turso paid** or an alternative (dedicated cheap
Postgres — Neon/Supabase scale storage far below Railway; or a prebuilt
`dict.sqlite` on **R2** downloaded to the container). **Backend choice is DEFERRED**
pending the 30×30 sizing call; the decision to off-site is firm regardless.

**State when paused.** es + ja columns LIVE; zh + fr/de/ru/… native columns DEFERRED
to the off-site store; `dictionary_entry` = 8.95M rows / ~3.25 GB (the
`(source,lang,gloss_lang)` index was dropped to relieve the full disk — `_SCHEMA`
recreates it on the next ingest). Resumes once the off-site store is chosen.

---

## Tier 1 — ready now (good data + clean CC/permissive license)

| Source | Coverage | Count | License |
|---|---|---:|---|
| kaikki **English Wiktextract** | X→English (all target langs) | JA 233,493 · ZH(Han) 385,393 · KO 79,022 · HI 56,272 · ES 868,109 · FR 457,182 · DE 627,523 · PT 506,984 · IT 718,166 · RU 491,362 · AR 98,467 · VI 60,856 · TH 27,184 · TR 58,438 · ID 53,935 (senses) | CC-BY-SA + GFDL |
| **JMdict-simplified** | JA→{en,de,ru,hu,nl,es,fr,sv,sl} | en 217,768 · de 128,754 · ru 69,229 · hu 41,896 · nl 41,775 · es 34,288 · fr 15,338 · sv 14,518 · sl 8,776 | CC-BY-SA 4.0 / EDRDG |
| **CC-CEDICT** | ZH→English | 124,752 | CC-BY-SA 4.0 |
| **KRDict (NIKL)** | KO→11 langs incl. en/ja/zh/fr/es/ar/mn/vi/th/id/ru | multilingual bulk XML | CC-BY-SA 2.0 KR (bulk redistribution OK) |
| **HanDeDict** | ZH→German | ~149,000 (project blurb) | CC-BY-SA 2.0 |
| **CFDICT** | ZH→French | 85,493 | CC-BY-SA 3.0 |
| kaikki **zh/ja/es Wiktionary** editions | X→ZH/JA/ES (native gloss) | 3.36M / 877k / 1.23M total senses | CC-BY-SA + GFDL |

**Sources / downloads:**
- English Wiktextract total: 12,827,217 senses; `raw-wiktextract-data.jsonl`, 2.6 GB
  compressed / 22.0 GB uncompressed. Per-language JSONL on each
  `kaikki.org/dictionary/<Language>/` page. Index table:
  https://kaikki.org/dictionary/ · rawdata: https://kaikki.org/dictionary/rawdata.html
  · ZH note: `/Chinese/` (385,393 senses / 302,683 words, umbrella Han — the useful set)
  vs `/Mandarin/` (112,061, topolect subset).
- JMdict-simplified: all 9 gloss builds are separate downloadable JSON (`.json.tgz`/`.zip`)
  verified via the GitHub release API `3.6.2+20260706150322`. Repo license CC-BY-SA-4.0;
  underlying JMdict = EDRDG licence (= CC-BY-SA 4.0 **plus** EDRDG attribution). Also ships
  JMnedict (743,456 names), Kanjidic2 (13,108), kradfile/radkfile.
  https://github.com/scriptin/jmdict-simplified/releases
- CC-CEDICT: `cedict_1_0_ts_utf-8_mdbg.zip`, UTF-8 simp+trad, actively maintained.
  https://www.mdbg.net/chinese/dictionary?page=cc-cedict
- KRDict/NIKL 한국어기초사전: relicensed CC-BY-SA 2.0 KR (2019-03-11); **bulk XML download
  exists** ("Dictionary Download", not just API); redistribution explicitly permitted.
  Open API free key, 50k req/day. **Carve-out:** publisher example sentences + media (audio/
  images) are NOT redistributable — strip before use. Companion NIKL: 우리말샘/Urimalsaem
  (1,109,722 headwords, monolingual). FOSS mirror proving redistribution:
  https://github.com/spellcheck-ko/korean-dict-nikl-krdict · https://krdict.korean.go.kr/eng/openApi
- HanDeDict: CEDICT-format `handedict.u8`, CC-BY-SA 2.0 DE; nightly mirror
  https://github.com/gugray/HanDeDict · https://handedict.zydeo.net/en/ . *Count is the
  project blurb, not a numbered page.*
- CFDICT: `CFDICT.u8`/`.xml`, 85,493 per the dated download page
  https://chine.in/mandarin/open/CFDICT/ (a sister page shows an older 60,375 — download page
  is authoritative); CC-BY-SA 3.0; low-activity.
- Non-English kaikki editions (all CC-BY-SA+GFDL, JSONL): **jawiktionary** 877,740 senses
  (foreign glossed-in-JA: EN 105,525 · Latin 72,190 · **ZH 59,082** · KO 39,862 · FR 36,661 · …);
  **zhwiktionary** 3,360,464 (KO 200,034 · IT 193,606 · … · **JA 93,506**); **eswiktionary**
  1,227,902. kaikki publishes 20+ such editions (fr/de/ru/pl/pt/it/th/tr/id/vi/nl/cs/…).

---

## Tier 2 — usable but thin / needs care

| Source | Why thin |
|---|---|
| kaikki **kowiktionary** (379,582 total; KO native 114,102) | small foreign blocks; "work in progress" quality |
| Non-English editions' *foreign* coverage | e.g. ZH→JA only ~59k senses vs the 385k English path |
| **kengdic** (KO→en, 133,764 rows; MPL 2.0 / LGPL 2.0+) | self-described "still quite dirty" — supplement, not authority. https://github.com/garfieldnate/kengdic |
| **cc-kedict** (KO→en, POS + pronunciation) | clean license, tiny/unverified size (ESTIMATE low-thousands). https://github.com/mhagiwara/cc-kedict |

---

## Tier 3 — licensing gap / doesn't exist

| Gap | Reality |
|---|---|
| **Chinese↔Japanese direct open dict** | **None at usable size + open license.** All large zh-ja dicts (e.g. 白水社中国語辞典, 65k entries, circulating for Yomitan) are extractions of copyrighted commercial dictionaries. For ZH↔JA you must **pivot through English** (CC-CEDICT + JMdict) or accept thin Wiktionary coverage (jawiktionary ~59k ZH senses / zhwiktionary ~93k JA senses). |
| KRDict example sentences + media | Explicitly excluded from the CC license — strip before redistributing. |

---

## KRDict ingest — ✅ DONE 2026-07-10 (live in prod)

The official 11-language NIKL XML (`한국어기초사전`, dated 2026-06-19) was downloaded and ingested:
**603,562 ko rows across all 11 gloss languages incl. Chinese** (`dictionary_entry` → 1,106,218 total).
`/define/capabilities` now reports `source_langs: [ja, ko, zh]`, `gloss_langs: [ar,en,es,fr,id,ja,mn,ru,th,vi,zh]`.
Verified live: `/define` ko 사람 → EN senses; `gloss_lang=ja` → Japanese senses; `/annotate` ko →
tokens 먹었어요→먹다. The parser scrubs two real data bugs in the official XML (unescaped `<` in a
French gloss; a stray `\x08` control char in an Arabic gloss). Data lives on disk in
`dictionaries/krdict/` (gitignored). Only remaining gap: user visibility needs the next extension
build (0.4.0 hardcodes {ja,zh}). Runbook below kept for re-ingest (idempotent per source).

**Runbook (for re-ingest / refresh):**

- **Acquire (needs an interactive browser — the site 400s scripted requests):** krdict.korean.go.kr
  → 사전 내려받기 / download popup → choose the **XML** build (the parser reads NIKL LMF XML; the JSON
  build's schema is unverified). Save the XML chunk(s) to a directory. The parser already maps
  `중국어 → zh`, so Chinese lights up automatically once present.
- **Verify (no DB):** `python scripts/ingest_dictionaries.py validate --krdict <dir> --sample 사람 --sample 먹다`
  — check the `by gloss-lang` line now includes `zh` (the mirror showed 10 langs / 531,485 rows; the
  official pull should add `zh`). The parser sanitizes unescaped `< > &` inside values (a real KRDict
  data bug) and streams per chunk.
- **Ingest (prod write, idempotent — deletes `source='krdict'` first):**
  `python scripts/ingest_dictionaries.py ingest --krdict <dir> --dsn <Railway DATABASE_PUBLIC_URL>`
  (run from a machine with `psycopg`; same pattern as the corpus export).
- **After ingest:** `/define/capabilities` will expose `ko` + all gloss langs automatically
  (`SELECT DISTINCT` ∩ `is_token_supported`). User visibility still needs the next EXTENSION build —
  the live 0.4.0 hardcodes `{ja,zh}` client-side; the capability-driven client (committed) ships next.

## Recommended ingest order (Claude's read) — status 2026-07-10

1. **KRDict (NIKL)** — ✅ **DONE / LIVE** (603,562 ko rows, 11 gloss langs).
2. **JMdict multilingual builds** — ✅ **DONE / LIVE** — JA→{de,ru,hu,nl,es,fr,sv,sl} ingested
   from the same jmdict-simplified release; the **Japanese row now has 9 gloss langs** (+567k rows).
   `parse_jmdict` auto-detects gloss_lang from each build's `languages` metadata.
3. **English Wiktextract per-language** — ✅ **DONE / LIVE** as a SOURCE: English enabled in
   `GENERIC_TOKEN_PRIMARIES` (harness 99.7%), 1,472,158 en→en rows. Also the universal breadth path
   for any future source language.
4. **HanDeDict / CFDICT** — ✅ **DONE / LIVE** — ZH→de (264,827) / ZH→fr (95,363), CEDICT-format via
   `parse_cedict(source=…, gloss_lang=…)`. **Chinese row now en·fr·de.**
5. **Native kaikki editions** — 🟡 **VALIDATED + FIRST COLUMN LIVE** (eswiktionary, 2026-07-10) — the
   lever that fills whole gloss COLUMNS. Schema + parser proven, es column ingested; see below.

**State after 1–4:** `dictionary_entry` = **7.6M rows / 20 source langs / 16 gloss langs / 2.77 GB**.
Ingest is now COPY-based (183k rows in ~30 s) with TCP keepalives + a (source,lang,gloss_lang) index.

## Native-edition Wiktextracts — scoping (lever 5)

**What they are.** `kaikki.org/<xx>wiktionary/` is a per-edition extract of a NON-English Wiktionary
(e.g. `frwiktionary` = the French Wiktionary), containing entries for words in MANY source languages,
each **glossed in that edition's language**. Where the English Wiktextract fills the **English column**
across every row, each native edition fills **one gloss COLUMN** (its own language) across many rows —
richest on the diagonal (its own language defined in itself), thinner off-diagonal.

**Why it's the last lever, and its ceiling.** Native editions are the ONLY open path to native-language
glosses at breadth for the non-CJK/Korean languages (no bilingual dicts exist for most pairs). But their
cross-language coverage is far thinner than the English edition's — English Wiktionary is uniquely
complete. So the honest target is: **diagonal rich, own-column decent, cross-pairs partial**, with the
English column as the universal fallback under every gap.

**Sizes (kaikki, senses; from the scouting pass — verify on the live dump before ingesting):**

| Edition | Gloss col it fills | Total senses | Own-lang (diagonal) | Notes |
|---|---|---:|---:|---|
| `zhwiktionary` | zh | 3,360,464 | large | biggest; also KO 200k · IT 194k · **JA 93k** |
| `eswiktionary` | es | 1,227,902 | large | strong Romance diagonal |
| `jawiktionary` | ja | 877,740 | large | **ZH ~59k** (the ZH→JA gap-filler) |
| `frwiktionary` | fr | (large) | large | fills the fr column |
| `dewiktionary` | de | (large) | large | de column |
| `ruwiktionary` | ru | (large) | large | ru column |
| `kowiktionary` | ko | 379,582 | 114,102 | thin foreign blocks, "WIP" quality (Tier-2) |
| + pt/it/pl/nl/cs/tr/id/vi/th | those cols | — | — | 20+ editions exist |

**Work required — RESOLVED, cheaper than scoped.** On inspecting live `eswiktionary` + `jawiktionary`
dumps the native-edition JSONL turned out to share the EXACT schema `parse_wiktextract` already handles
(`word` / `lang_code` / `senses[].glosses` / `sounds[].ipa`) — it differs only in the gloss LANGUAGE and
in carrying many source langs per file. So NO parser variant was needed: `parse_wiktextract` gained two
params — `gloss_lang` (stamp the column) + `keep_langs` (take only the source langs we tokenize). Then
it's the same harness-gate → COPY-ingest loop, one download per column.

**es column — proven + LIVE (2026-07-10).** Harness of the `es` edition vs Tatoeba, by source row:

| Source row → es gloss | headwords in es-edition | useful% |
|---|---:|---:|
| **es → es (diagonal)** | 831,025 | **98.3%** |
| en → es | 17,847 | 97.4% |
| fr → es | 7,625 | 82.6% |
| pt → es | 5,335 | 76.2% |
| it → es | 6,257 | 72.4% |
| de → es | 3,880 | 67.1% |

The predicted shape, now measured: **diagonal rich** (near the English-edition's 99.1% Spanish), the
own-column near-neighbour (en) decent, distant cross-pairs thin. Ingested the whole es column
(gloss_lang=es, keep = our 20 supported source langs) → **911,704 rows** (es 848k … zh 47); every
cross-pair miss is backstopped by the English column. Verified live: `/define` gloss_lang=es —
es comer→"Ingerir o tomar alimentos", en cat→"(Felis silvestris catus) Gato", fr chat→"Gato".
`dictionary_entry` → **8.52M rows / 3.13 GB**. `/privacy`'s generic "Wiktionary via kaikki" credit
already covers native editions.

**Recommended sequence for lever 5** (by value × our existing source rows):
1. ✅ **es edition — DONE / LIVE** (validated the whole approach; diagonal 98.3%).
2. ✅ **ja edition — DONE / LIVE** (423,874 rows). Prod-harness (tokenize via live `/annotate` MeCab,
   check native gloss in DB): **ja→ja 90.2%** (monolingual Japanese — net-new), **zh→ja 57.5%** (the
   ZH↔JA gap-filler, the only open native fill; English-backstopped). Live: `/define` gloss_lang=ja
   猫→"（ねこ…）ネコ科を構成する小型の哺乳類…", zh 猫→"ねこ。".
3. 🔴 **zh edition — BLOCKED on disk (2026-07-10).** The zhwiktionary extract is the 3.36M-sense
   monster; ingesting it hit a hard **`DiskFull` on the Railway Postgres volume** (full at ~3.5 GB
   data). Relieved by dropping the `dictionary_entry_source_lang_gloss` index (70 MB, recreated by
   `_SCHEMA` on next ingest) + VACUUM → DB back to 3.25 GB and writable. **Decision owed (Connor):**
   (a) EXPAND the Railway volume (dashboard → Postgres → Volume; clean, ~billing) — then zh + future
   columns fit; or (b) TRIM footprint — DROP "form of" inflection rows (~70% of Wiktextract; our
   tokenizers lemmatize so the base headword usually hits — small recall cost, roughly HALVES the
   Wiktextract footprint, freeing room for zh + more); or (c) zh **diagonal-only** (keep_langs=zh,ja,ko)
   to shrink the zh ingest. Until then zh definitions come from CC-CEDICT (en) + the zh column is deferred.
4. **fr / de / ru editions, then pt / it / pl / nl …** — the same loop, gated on the disk decision.

The loop is: download `kaikki.org/<xx>wiktionary/raw-wiktextract-data.jsonl` → (optional harness)
→ `ingest --wiktextract <file> --wiktextract-gloss-lang <xx> --wiktextract-keep-langs <supported set>`.
`load_to_postgres` now COPY-streams with periodic commits (200k rows) + TCP keepalives — resilient to
a proxy drop, but NOT to a full volume (a capacity limit, not a code bug).

**Flags / could-not-fully-verify:** HanDeDict exact count (blurb only); EDRDG's own pages
wouldn't render a total (JMdict total sourced from jmdict-simplified); CFDICT's two conflicting
counts (used the dated download page); cc-kedict / Urimalsaem sizes partly ESTIMATE.
