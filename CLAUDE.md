# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-04-26):** R1–R6a + R6b-presets + R6b-fonts (library primitive) + timing offsets + auto-alignment complete on the `monorepo-restructure` branch. R5 closed out — Hebrew + Arabic + Persian + Urdu all shipped. **Step 3b complete (full feature parity with Streamlit)** — full backend (`loom_core` engine + `loom_api` FastAPI service) + Tauri desktop shell covering the full pipeline: file picker → video scan → dual-view style editor → timing offsets + auto-align → live preview → generate .ass/.sup → mux into MKV. Preview posts to `/preview` (debounced ~200ms, stale-response guard). `GenerateSection.tsx` hits `/generate/ass` (sync) and `/generate/pgs` (async → poll 500ms); `MuxSection.tsx` hits `/mux` (async) which writes ffmpeg's output directly to the user-picked path so multi-GB remux doesn't round-trip through HTTP. CI pipeline (`.github/workflows/ci.yml`) is **fully cross-platform**: Ubuntu / macOS / Windows all green. Windows passed first try (durations: ubuntu 3min, macos 2.5min, windows 7min).

**Active focus:** **Step 3c (bundling for distribution)**. Research prompt prepared for Claude web covering PyInstaller vs `uv` vs PyOxidizer under Loom's dep surface (Playwright + Chromium 150MB, aksharamukha transitive lxml + fontTools, fugashi + unidic-lite 250MB, fontconfig runtime dep on Linux, Tauri sidecar + web-service dual-deployment constraint). Better suited to web Claude than to here. After bundler choice: also need to bundle Noto fonts in Tauri resources (Linux distros ship them, macOS/Windows don't — affects subtitle rendering quality on installed app).

**Pre-3c hygiene shipped (2026-04-26 audit):** `mkv_handler.py` ffmpeg subprocess calls hardened against Windows cp1252 locale (`encoding="utf-8", errors="replace"`); `pgs.py` debug-dump opens given explicit `encoding="utf-8"`. None exercised by CI but all relevant for installed-Windows-app reliability.

R6b-fonts library primitive exists but is not yet wired into a UI warning path — secondary polish, can land any time.

**Test suite:** 567 tests across 19 files. Engine tests cover `loom_core` only — no `loom_api` tests yet (smoke-tested via cURL during 2a–2c).

---

## Project Structure

```
loom_app.py                # Streamlit entry point — kept as a dev/debug client through step 3b. Deletes when web app ships (step 4).
app/
  state.py                 # Streamlit session state (Streamlit-only, stays here)
  ui.py                    # Streamlit widgets, OCR buttons, native file picker (zenity/kdialog/tkinter fallback)
loom_api/                  # FastAPI service over loom_core. Hosted as Tauri sidecar (step 3) and production web service (step 4).
  main.py                  # FastAPI app + CORS middleware (allow_origins=["*"] for dev — tighten before prod)
  storage.py               # Storage Protocol + LocalFileStorage (in-process UUID→path map). S3FileStorage drops in at step 4.
  jobs.py                  # JobManager — in-process {id: JobStatus} dict + asyncio.Tasks. Swap for arq+Redis if web scaling demands it.
  deps.py                  # FastAPI dependency providers (get_storage, get_jobs)
  routes/
    health.py              # GET / and GET /health
    files.py               # POST /files (multipart upload) + GET /files/{id} (download)
    language.py            # GET /language/config/{code} → wire-safe LanguageMetadata
    generate.py            # POST /generate/ass (sync) + POST /generate/pgs (async → JobAccepted) + POST /generate/suggest-filename
    jobs.py                # GET /jobs/{id} → JobStatus
    video.py               # POST /video/scan → VideoMetadata + TrackInfo[]
    subs.py                # POST /subs/detect-language + POST /subs/detect-styles
    align.py               # POST /align → AlignResponse
    preview.py             # POST /preview → composite HTML + raw text fields
    styles.py              # GET /styles/fonts + GET /styles/presets?lang=
    mux.py                 # POST /mux → JobAccepted (writes ffmpeg output direct to client-supplied path)
apps/
  desktop/                 # Tauri 2 + Vite + React (TypeScript) — desktop shell. Step 3a foundation; step 3b builds out the UI.
    src-tauri/             # Rust shell. lib.rs spawns uvicorn loom_api.main:app as a child process; kills it on window close.
    src/                   # React frontend. App.tsx orchestrates file slots + scan; styles.ts holds StyleConfig wire types + defaults + preset apply; section components in src/sections/.
loom_core/                 # Pure engine — no Streamlit imports. Consumed by loom_app.py + loom_api.
  models.py                # Pydantic wire contracts: StyleConfig, TrackInfo, LanguageMetadata, Generate*Request, JobStatus, etc.
  language.py              # Language detection + Cantonese discriminator + script analysis + is_rtl_text
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese (MeCab/fugashi), Korean, Cyrillic, Thai (3 systems), Indic (6), Hebrew, Arabic/Persian/Urdu (shared walker)
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  color_presets.py         # Color preset system: 28 presets (classic/cultural/dark/adaptive), language-scoped
  korean_rr.py             # Standalone Korean Revised Romanization implementation
  fonts.py                 # validate_font() — fc-match + fontTools cmap glyph coverage (Linux-only backend)
  subs/
    utils.py               # Shared subtitle loading + mtime-based SSAFile caching + shift_events() + compute_subtitle_offset()
    processing.py          # ASS generation + PGS generation + union timeline + concurrent event merge + opencc + style mapping + output filename builder
    preview.py             # Composite HTML preview
  video/
    mkv_handler.py         # Video scan/extract/screenshot/mux — all ffmpeg calls (any container in, MKV out)
    ocr.py                 # PGS OCR: SUP parser + Tesseract + parallel thread pool
  rasterize/
    pgs.py                 # Playwright async full-frame subtitle rasterizer (N-worker parallel pool, batched streaming)
    sup_writer.py          # PGS/SUP binary writer (inverse of ocr.py parser); batch + streaming APIs; epoch state management
tests/                     # 567 tests across 19 files. See Test Corpus below for sample-data assumptions.
.github/workflows/
  ci.yml                   # CI matrix: Ubuntu + macOS green; Windows scaffolded (System deps step pre-written, intentionally no fontconfig). pytest + Playwright Chromium + font-validator self-check on every push to main/monorepo-restructure + PRs to main.
requirements.txt
CLAUDE.md
```

---

## Monorepo Restructure Roadmap

| Step | Status | Scope |
|------|--------|-------|
| 1 → 3b | ✅ | `loom_core` carved out, FastAPI service complete (sync + async + jobs + storage), Tauri shell + sidecar IPC, full UI parity with Streamlit (file pickers, video scan + track selector, dual-view style editor, preview, generate ASS/PGS, mux, timing offsets + auto-align, filename builder + audio-default selector). Streamlit kept as dev/debug client until step 4. |
| CI ph 1–3 | ✅ | GitHub Actions matrix on push to main/monorepo-restructure + PRs to main. Ubuntu + macOS + Windows all green. Includes pytest + Playwright Chromium rasterize + font-validator self-check. Windows phase intentionally skips fontconfig install — exercises `loom_core/fonts.py` "fontconfig unavailable" graceful-degradation path. |
| 3c | 🔲 | Bundling for distribution. PyInstaller / `uv` / PyOxidizer decision deferred — research prompt prepared for web Claude. Ships installers via GitHub Releases + Tauri auto-updater. |
| 4 | 🔲 | Next.js web on Vercel. Same Next.js build → either CNAMEd `loom.nerv-analytic.ai` or `apps/web/` workspace. Swap `LocalFileStorage` for `S3FileStorage`. Constrain to subtitle-only + YouTube URL flows (no large video uploads). Extract shared React components into `packages/ui/` once a second consumer exists. |
| 5 | 🔲 | WXT browser extension. YouTube + Netflix C/K-drama overlays. Reuses `@loom/api-client` (from FastAPI's OpenAPI). Major OCR data source — extension archives `(text, style, language)` tuples behind `opt_in_training` for the synthetic OCR pipeline to consume. |
| 6 | 🔲 (parallel) | OCR pipeline as separate `loom_ocr/` package. Closed-loop synthetic data → fine-tuned TrOCR. Runs as a batch process, not part of the API. Detailed in `Synthetic Visual Engine — Phase 1` doc; targets Sept 2026 demo for PhD applications. |

**Locked tech decisions for steps 3+:**
- Frontend: Vite + React (not Next.js) for desktop. Web app at step 4 may migrate to Next.js, with shared components in `packages/ui/`. Don't extract the package until a second consumer exists — premature shared libraries are how API ergonomics go bad.
- IPC: HTTP on localhost (not Tauri commands). Frontend stays deployment-agnostic — same code talks to localhost sidecar or `https://api.loom.nerv-analytic.ai`. One env var flips the base URL.
- Storage: `Storage` Protocol now, `LocalFileStorage` only impl until step 4. `S3FileStorage` drops in without route changes.
- Job runner: in-process dict + `asyncio.Task`. Migrate to arq+Redis only if/when web traffic outgrows one uvicorn worker. Tauri sidecar will never need persistence (process dies with the app).
- Python bundling: defer until step 3c. Dev mode uses the developer's existing Python (env vars `LOOM_UVICORN`, `LOOM_PROJECT_ROOT`, `LOOM_SIDECAR_PORT` override defaults).
- OCR data ingestion: `opt_in_training: bool = False` baked into request models from step 2c. No archival code yet — wires up at step 5 when the extension produces real data flow. Privacy-hedge in place from day one.

---

## Layer Terminology — CRITICAL

**Get this right. Every time. No exceptions.**

| Layer name | Screen position | Content | Variable names |
|------------|----------------|---------|----------------|
| **Bottom** | Lowest on screen | User's **native** language (the language the user speaks, e.g. English for an English speaker) | `native_file`, `native_subs`, `native_text`, `bottom_text`, `native_lang` |
| **Top** | Above Bottom | **Foreign / media** language (the language of the video, e.g. Japanese, Thai, Korean) — this is the "target" of the processing/romanization pipeline | `target_file`, `target_subs`, `target_text`, `top_html`, `target_lang_code` |
| **Romanized** | Above Top | Phonetic transcription of the Top/foreign text (Pinyin, Romaji, etc.) | `romaji_text` |
| **Annotation** | Above individual Top tokens | Per-token readings of the Top/foreign text (furigana, bopomofo, etc.) | via `\pos()` in ASS, ruby in PGS |

- "**Native**" = user's own language. NOT the language native to the media.
- "**Target**" = the foreign language being processed/romanized. It is the "target" of the pipeline, not the user's learning target.
- `content_key = (bottom, top, romaji, preserved)` — bottom is native, top is foreign.
- `_derive_region_keys` → region 0 = top (foreign), region 1 = bottom (native).
- In `build_output_filename()`: `native_lang` = user's language code, `target_lang` = media language code.

---

## Key Architectural Decisions

**Four-layer output, two independent pipelines.** `.ass` file has 3 or 4 text layers (Bottom / Top / Romanized / optionally Annotation with `\pos()`), controlled by `include_annotations` param. PGS `.sup` is a separate full-frame bitmap rasterization. PlayResX=1920, PlayResY=1080 set explicitly on all generated `.ass` files. All coordinates and font sizes in 1080-scale.

**`.ass` pipeline** (`generate_ass_file()`): no Playwright dependency. `supports_ass_annotation`: CJK=True, R4/Indic/Hebrew=False — gates `\pos()` annotation generation (non-CJK annotation is PGS-only because the layout math assumes CJK glyph widths).

**PGS pipeline** (`generate_pgs_file()` → `rasterize_pgs_to_file()`):
- Playwright async API, N-worker parallel pool (`num_workers`, default 1). Reorder heap preserves timestamp order; consumer writes sequentially via `SupWriter`. Memory-bounded streaming write.
- Nested event loop support (Streamlit) via background thread.
- ~50–100ms per screenshot; 300 events ≈ 15–30s.
- Requires `playwright install chromium`.
- **Union timeline** (`_build_pgs_timeline()`): union of all timing boundaries from native + target tracks. One interval per segment so when only one track changes, epoch system emits a Normal update (only changed region re-encoded). Fixes flicker when tracks have independently-timed line breaks.
- **Concurrent event merging** (`_merge_concurrent_target_events()`): groups target events by identical `(start, end)`. Drops music-only events (♪, ♫) when real dialogue is concurrent; stacks remaining concurrent events with `<br>` / `\N`.
- **Canvas-aware region splitting** (`split_regions(canvas_height=)`): gap midpoint must be in 25%–75% of canvas to allow 2-region split. Prevents subtitle dropout when only top-half content is rendered.
- **Epoch management** (`SupWriter.write(region_content_keys=...)`): Epoch Start (full redraw) / Acquisition Point (every 12 display sets, for seek safety) / Normal (only changed region re-encoded) / Skip (identical content). Reserved palette ranges: obj 0 → indices 1–127, obj 1 → 128–254. Fixed windows: top 45%, bottom 25%. Abutting threshold ≤ 50ms. Clears always Epoch Start. `region_content_keys=None` falls back to Epoch Start.

**Annotation infrastructure is language-agnostic.** `get_annotation_func(lang_code)` → span producer. `build_annotation_html(spans, mode)` with 3 render modes: `"ruby"`, `"interlinear"`, `"inline"`. `annotation_font_ratio`: CJK=0.5, alphabetic=0.4. Adding a new annotated script = new `get_annotation_func()` only.

**Container-agnostic input, MKV output.** ffprobe/ffmpeg accept any container. Output always `.mkv`. Subtitle upload accepts `.srt`, `.ass`, `.ssa`, `.vtt`. `loom_core/video/mkv_handler.py` is the only file that touches ffmpeg.

**MKV mux critical flags:** `-c:s:N ass` re-encodes ASS track (fixes timestamp conversion). `-max_interleave_delta 0` forces strict DTS-order interleaving (fixes subtitle clustering). PTS=0 anchor in `SupWriter`/`write_sup()` prevents ffmpeg timestamp rebasing. `merge_subs_to_mkv()` accepts optional `ass_path` + `sup_path`; `disposition:default` on PGS if both present; `default_audio_index` sets audio default; `keep_existing_subs`/`keep_attachments` for track stripping.

**Output filenames:** `build_output_filename()` → `{media}.{year}.{native_lang}.{target_lang}[.{annotation}][.{romanization}].{ext}`. Title/year from `get_video_metadata()`.

**No RAM-loading of video** — always local path + ffmpeg subprocess.

**Timing offsets** (`shift_events(subs, offset_ms)` in `loom_core/subs/utils.py`): deep-copies SSAFile, shifts all event start/end by `offset_ms`, clamps to >=0. Applied as `native_offset_ms`/`target_offset_ms` immediately after subtitle load in preview/processing call sites. Streamlit UI uses pending-key indirection (`_pending_top_offset_sec`/`_pending_bottom_offset_sec`) to avoid `StreamlitAPIException` on post-widget state mutation.

**Auto-alignment** (`compute_subtitle_offset(reference_subs, target_subs)`): returns `target_time - reference_time` (positive = reference earlier, shift source-A tracks later). Coarse pass = pairwise-difference histogram (N×M pairs, 100ms bins, `Counter`); fine pass = ±2s around peak in 10ms steps, ±500ms tolerance, midpoint of best plateau. Filters Comment events + `\p` drawings; minimum 5 dialogue events per track.

**Output resolution scaling:** `_PLAYRES_OPTIONS` (480p–2160p) + "Match source". `_scale = target_height / 1080` applied to all style attrs.

---

## Language Pipelines

Implementation lives in `loom_core/romanize.py` + `loom_core/language.py`. Read those for details — this section captures non-obvious gotchas only.

**Japanese:** `_make_japanese_pipeline()` returns `(resolve_spans, spans_to_romaji)` with closure state (`_romaji_meta` carries merge_mask + particle_ha across calls). fugashi (MeCab) + unidic-lite. Three-tier furigana: author inline `kanji(hiragana)` → pre-existing ASS furigana → MeCab fallback. Three long vowel modes: macrons (default) / doubled / unmarked. POS-aware verb chain merging via `_should_merge_for_romaji()`. Particle は → wa via `pos1=助詞, pos2=係助詞`.

**Chinese:** Three variants — `zh-Hans/zh-CN/chs/zh` → Pinyin, `zh-Hant/zh-TW/cht` → Zhuyin, `yue/zh-yue/CantoCaptions` → Jyutping. `_make_pinyin_romanizer()` uses `jieba.cut()` for word boundaries; Traditional → Simplified via OpenCC `t2s` for jieba (Simplified-oriented dict), boundaries mapped back to Traditional for pypinyin. CJK punctuation stripping via `_is_cjk_punct()` filters punctuation-only segments (covers U+3000–U+303F, fullwidth U+FF00–U+FF65, etc.).

**Korean:** `korean-romanizer` (Revised Romanization). Per-syllable annotation gives base reading per char (lookup aid); the romanization line uses full-word `Romanizer(text)` which captures liaison/tensification/nasalization (reading aid). Two layers, two purposes — by design.

**Cyrillic:** `cyrtranslit`. `_CYRILLIC_LANG_CODES` maps BCP-47 → cyrtranslit codes (ru, uk/ua, be/by, sr, bg, mk, mn). Ukrainian/Belarusian disambiguation via `_UKRAINIAN_UNIQUE`/`_BELARUSIAN_UNIQUE` frozensets.

**Thai:** `pythainlp`. 3 phonetic systems: `paiboon` (default, with tone diacritics, vowel remapping ae→ɛ ue→ɯ), `rtgs` (no tones, ASCII), `ipa`. Hybrid tokenizer `_thai_tokenize()`: `word_tokenize(engine='newmm')` → `syllable_tokenize()` on tokens >6 Thai chars. **Critical:** `royin` engine deprecated — mangles consonant clusters; all RTGS/Paiboon+ paths use `thai2rom`. Word boundaries via U+2009 thin space. `annotation_default_enabled: False`.

**Indic (R5-2/R5-3):** Six languages via `aksharamukha.transliterate.process(script, 'IAST', text)` — `_INDIC_SCRIPTS = {hi: Devanagari, bn: Bengali, ta: Tamil, te: Telugu, gu: Gujarati, pa: Gurmukhi}`. Aksharamukha preferred over `indic-transliteration`/sanscript because sanscript distorts Tamil ("vaṇakkam" → "vaṇaghghaṃ") by treating it as Sanskrit-subset. Aksharamukha auto-converts danda (।) and double-danda (॥) to ASCII periods. Per-akshara annotation: `_split_brahmic_aksharas()` accumulates consonant clusters across virama boundaries — runs aksharamukha per-akshara to get correct conjunct readings (Tamil க்க → "kka") that only whole-unit gives. Bengali Khanda Ta (U+09CE) classified as extender, not standalone — acceptable for reading fidelity. `has_phonetic_layer=True`, `supports_ass_annotation=False`.

**Hebrew (R5-4 phase a):** `_make_hebrew_romanizer()` is consonantal transliteration with two heuristics: (1) mater lectionis — ו/י are consonantal (v/y) at word-start or after vowel-letter, vocalic (o/i) after consonant; (2) default 'a' inserted between consecutive consonants. Strips nikud/cantillation (U+0591–U+05C7). Begadkefat (ב כ פ) defaults to soft form (v/kh/f) since unpointed Modern Hebrew has no dagesh marker. **Documented failure modes:** ברוך → varokh not baruch, חברים → chavarim not chaverim. Tests lock these in so a future nikud/dictionary-based pass shows up as test diff.

**Arabic / Persian / Urdu (R5-4 remaining):** `_make_arabic_romanizer` / `_make_persian_romanizer` / `_make_urdu_romanizer` share `_arabic_script_romanize_word()` walker. Same mater-lectionis rule as Hebrew on و/ي (vocalic ū/ī after consonant, consonantal w/y at word-start or after vowel-letter). Strips tashkil before transliteration (subtitle text rarely carries it). Three phonetic systems per language (Duolingo-to-academic hybrid):
- **Arabic** — `learner` (default; emphatics ṣ ḍ ṭ ẓ ḥ + long ā ī ū + ʿ/ʾ + digraphs sh/gh/th/dh/kh) / `din` (full DIN 31635: š ġ ṯ ḏ ḫ) / `loose` (ASCII-only, drops emphatic marks + ayn). Definite article ال handles sun-letter assimilation (14 sun letters double the following consonant: الشمس → ash-shams; 14 moon letters keep al-: القمر → al-qamar). Final ة (tāʾ marbūṭa) → pause-form "a". Alif maksūra (ى) → long ā.
- **Persian** — `learner` (default) / `dmg` (single-char digraph alternatives č ž š ġ ṯ ḏ ḫ). Persian-specific letters پ چ ژ گ. Persian uses Arabic script but ezāfe + vowel inventory differ; emphatic marks are typically collapsed (Persian-style) even in the learner default.
- **Urdu** — `learner` (default) / `ala-lc` (scholarly: candrabindu n̐ for nun-ghunnah, macron ē for yeh-barree). Layers on Persian + retroflexes ٹ ڈ ڑ → ṭ ḍ ṛ + nun-ghunnah ں + yeh-barree ے + aspiration marker ھ (heh doachashmee combines with preceding consonant: بھ → bh, ٹھ → ṭh).
- **Documented failure modes** locked in tests: unvocalized short vowels guessed as 'a' (yaktub → yaktab); no sun-letter assimilation outside ال; Pākistān → Pākasatān (default-'a' between k-s).

**RTL rendering (R5-4 phase b):** `is_rtl_text(text, threshold=0.4)` classifies as RTL when Hebrew/Arabic/Syriac/NKo/Samaritan/presentation-form codepoints > 40% of non-whitespace non-digit. `_build_fullframe_html(top_rtl, bottom_rtl)` injects `dir="rtl"` on relevant `#top`/`#bottom` divs; `unicode-bidi: isolate` on every `.layer` so directionality can't leak. Romanized never gets `dir="rtl"`. `generate_pgs_file()` derives: `top_rtl` from target `lang_cfg['rtl']` (authoritative), `bottom_rtl` from content scan over native events (covers arbitrary user languages without needing a `native_lang_code` API param). `.ass` path untouched — libass handles bidi internally.

**Universal romanization polish** (`_polish_romaji(text, *, capitalize=True)`): runs at every romanizer factory tail. Three passes — fullwidth CJK punctuation → ASCII via `_CJK_TO_LATIN_PUNCT` translate table; strip `\s+` before closing punctuation; uppercase line-start + first alpha after `.!?` when `capitalize=True`. **Capitalize disabled** for Cyrillic (cyrtranslit preserves source case) and Thai (no caps convention). Idempotent.

**Language detection** (`_dominant_script()`): script-specific paths — CJK via `_refine_cjk_detection()`, Cyrillic via `_detect_by_script_chars()` unique-char pre-detection → langdetect fallback, Thai/Indic by script directly, Latin via `_normalize_metadata_lang()` metadata preference over langdetect (fixes Romance language misidentification). Indic scripts mapped 1:1 via `_INDIC_SCRIPT_TO_CODE`. Hebrew detection: `_dominant_script() == 'Hebrew'` → 'he'. Arabic-script detection: when `_dominant_script() == 'Arabic'`, trust langdetect's raw_code if it's `ar`/`fa`/`ur`; otherwise default to `ar`. (No unique-letter pre-detection like Cyrillic — Persian-only letters پ چ ژ گ and Urdu-only ٹ ڈ ڑ ں ے ھ exist, but langdetect was found reliable enough that adding override logic was deferred.)

**Font validation (R6b-fonts):** `loom_core/fonts.py::validate_font(font_name, *, lang_code=None, text=None)` → `FontValidation` (resolved_path, resolved_family, is_fallback, coverage_ok, missing_chars, warnings). fc-match for resolution + `fontTools.ttLib.TTFont.getBestCmap()` for glyph coverage. Per-language samples in `_LANG_COVERAGE_SAMPLES` (zh-Hans uses 国, zh-Hant uses 國). TTC index routing: fc-match returns `%{index}` for collections. **Cross-platform:** fc-match is Linux-only; macOS/Windows returns `warnings=["fontconfig unavailable"]` and skips checks — 3c bundling will add fontTools-only scanner over a bundled font directory. UI integration deferred.

---

## Style System (R6a)

Per-layer controls (Bottom, Top, Romanized, Annotation): color, opacity, font size, font family, outline (toggle + thickness + color + opacity), shadow (toggle + distance, default 1.5), glow (radius 1–20, color, `\blur` ASS tag). "Top Stack Position": vertical offset (-100 to +100px), `annotation_gap` (-20 to +40px, default 2), `romanized_gap` (-20 to +40px, default 0). These are top-level ints in `styles` dict — `isinstance(config, dict)` guards skip them.

Default font sizes (1080-scale): Bottom=48, Top=52, Romanized=30, Annotation=22. Default outline: Bottom=3.0, Top=2.5, Romanized=1.5, Annotation=1.0.

`_hex_to_ass_color()` / `_ass_color_to_hex()` bridge `#RRGGBB` ↔ `pysubs2.Color`. ASS alpha inverted: `int((1 - opacity/100) * 255)`.

**Gap CSS:** `annotation_gap` uses `transform: translateY()` (not `margin-bottom` — broken in Chromium ruby layout) in preview/rasterize. ASS path uses `\pos()` Y-coordinate math.

---

## Style Mapping

`detect_ass_styles()`: two-pass — pattern match is final, not overridable by event count. Priority: (1) `_PRESERVE_PATTERNS` → preserve, (2) `_EXCLUDE_PATTERNS` → exclude, (3) literal "Dialogue"/"Default" → dialogue (`_DIALOGUE_NAME_RE`), (4) 0 events → exclude, (5) remaining → most-events = dialogue. OP/ED/song/karaoke patterns are preserved (not excluded).

`_iter_dialogue_events()`: selects layer with most non-drawing events (not highest-numbered). Excludes all non-main layers. Yields ALL events in the main layer including overlapping ones — concurrent merging is downstream.

`has_animation` detection per style. `_strip_animation_tags()` for PGS path strips `\k`, `\t()`, `\move()`, `\fad()`; preserves visual tags. `.ass` path passes all tags through.

`_dedup_preserved_for_pgs()`: groups by style + time overlap + text content (substring match). Keeps lowest non-drawing layer. Prevents garbled karaoke layer overlap in PGS.

---

## Test Corpus

| File | Languages | Purpose |
|------|-----------|---------|
| AoT S1E01 MKV | Taiwan CHT, CantoCaptions, Japanese, English | All three Chinese variants + Japanese |
| Three Body S01E01 KONTRAST | Simplified Chinese | Clean Mandarin |
| Three Body S01E01 AMZN | Simplified Chinese | HTML `<font>` tag edge case |
| Seven Samurai 4K MKV (94GB) | Japanese PGS, Trad Chinese, English ×2, Danish, Finnish, Norwegian, Italian, French PGS, German PGS | Large file perf, PGS OCR, European R4 |
| Inuyasha EP028 | Japanese DVD fansub | Legacy subtitle formatting |
| Death Whisperer 3 (non-MKV) | Thai, English (external SRT) | Non-MKV input, external subtitle upload, Thai R4 |

---

## How to Resume

1. `cd` into repo, run `claude`
2. Read this file — it is the authoritative state document
3. Older state (full session-by-session implementation history) lives in `/home/connor/Documents/projects/general_project_notes/notes/srtstitcher/CLAUDE*_ARCHIVE.md`
