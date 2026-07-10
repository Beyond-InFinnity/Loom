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
5. **Native kaikki editions** — 🔲 **NEXT** (scoped below) — the one remaining lever that fills whole
   gloss COLUMNS instead of single cells.

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

**Work required (why it's "medium," not "free").** The native-edition JSONL schema differs from the
English `kaikki.org/dictionary/` schema `parse_wiktextract` handles today (senses nest differently; the
gloss language is the EDITION, not per-gloss `lang`). So lever 5 needs a **`parse_wiktextract_native`
variant** (or a schema-detecting branch) that (a) sets `gloss_lang` = the edition code, (b) reads the
edition's sense/gloss shape, (c) still filters by `lang_code` so one edition can ingest many source
rows. Then it's the same harness-gate → COPY-ingest loop, one download per column.

**Recommended sequence for lever 5** (by value × our existing source rows):
1. **zh / ja editions first** — the ZH↔JA pair has NO open direct dictionary; these are the only
   native fill (thin: ~59–93k cross senses) and the highest-demand pair for our audience.
2. **es / fr / de / ru editions** — fill the columns for our biggest user languages; each also
   richly self-defines (diagonal) for the monolingual-learner mode.
3. **pt / it / pl / nl / … as demand appears** — pure repeat of the loop.

Decision owed before building: confirm the native-edition JSONL schema on one real dump (ja or es),
then write the parser variant + harness one column end-to-end before fanning out.

**Flags / could-not-fully-verify:** HanDeDict exact count (blurb only); EDRDG's own pages
wouldn't render a total (JMdict total sourced from jmdict-simplified); CFDICT's two conflicting
counts (used the dated download page); cc-kedict / Urimalsaem sizes partly ESTIMATE.
