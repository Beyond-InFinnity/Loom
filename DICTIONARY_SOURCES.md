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

## Recommended ingest order (Claude's read)

1. **KRDict (NIKL)** — unlocks Korean as a source AND many gloss langs (en/ja/zh/…) in one
   bulk-redistributable drop; also the only clean way to get native-language glosses at scale.
   Needs a KO tokenizer (mecab-ko/khaiii) for `is_token_supported` — the known Phase-3 leg.
2. **JMdict multilingual builds** — JA→{de,ru,hu,nl,es,fr,sv,sl} is a drop-in re-ingest of a
   source we already parse; lights up 8 new gloss langs for existing JA tracks immediately.
3. **English Wiktextract per-language** — universal X→English breadth for any new source
   language (adds the source-lang tokenizer as the gating work, not the data).
4. **HanDeDict / CFDICT** — ZH→de / ZH→fr, CEDICT-format so they reuse the CC-CEDICT parser.
5. **Native kaikki editions (zh/ja)** — fill ZH↔JA gaps where no direct dict exists (thin,
   flag quality).

**Flags / could-not-fully-verify:** HanDeDict exact count (blurb only); EDRDG's own pages
wouldn't render a total (JMdict total sourced from jmdict-simplified); CFDICT's two conflicting
counts (used the dated download page); cc-kedict / Urimalsaem sizes partly ESTIMATE.
