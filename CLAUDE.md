# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-04-20):** R1–R4 + R6a + R6b-presets + timing offsets + auto-alignment complete in the original Streamlit pipeline. The monorepo restructure has reached **step 3b complete (full feature parity with Streamlit)** on the `monorepo-restructure` branch — full backend (`loom_core` engine + `loom_api` FastAPI service) + Tauri desktop shell covering the full pipeline: file picker → video scan → dual-view style editor → timing offsets + auto-align → live preview → generate .ass/.sup → mux into MKV. Preview posts to `/preview` (debounced ~200ms, stale-response guard) with annotation spans, Japanese `spans_to_romaji` + `long_vowel_mode`, and cached video screenshot background. `GenerateSection.tsx` hits `POST /generate/ass` (sync) and `POST /generate/pgs` (async → job poll 500ms); save dialog default built via `POST /generate/suggest-filename` (delegates to `build_output_filename`); saves results via `@tauri-apps/plugin-dialog.save()` + `@tauri-apps/plugin-fs.writeFile()`. `MuxSection.tsx` hits `POST /mux` (async job) which runs `merge_subs_to_mkv` via `asyncio.to_thread`; the sidecar writes ffmpeg's output directly to the user-picked `output_path` so multi-GB remux doesn't round-trip through HTTP. Track titles built server-side via `_build_track_title` from `{target_name} + {native_name} [{annotation} / {romanization}] [PGS] (Loom)`. `TimingOffsetsSection.tsx` exposes manual offsets (Bottom/Top, 0.01s step) with Link toggle + delta-based linked adjustment, plus a collapsible Auto-align-from-reference block (file picker → optional video scan + track select → Compare-to / Apply-to layer pickers → `POST /align` → signed-offset result → Apply). Offsets thread through `/preview`, `/generate/ass`, `/generate/pgs` as `native_offset_ms`/`target_offset_ms`.

**Active focus:** One remaining R5 sub-track (R5-4 remaining — Arabic/Persian/Urdu block romanization) before the R5 series closes out. Step 3c (bundling for distribution) is the next major track after that; research prompt prepared for Claude web covering PyInstaller vs `uv` vs PyOxidizer vs alternatives under Loom's specific dep surface (Playwright + Chromium 150MB, aksharamukha transitive lxml + fontTools, fugashi + unidic-lite 250MB, fontconfig runtime dep on Linux, Tauri sidecar + web-service dual-deployment constraint). R6b-fonts library primitive exists but not yet wired into a user-facing warning path — secondary polish.

**Session summary (2026-04-20 evening):** Shipped 9 chunks of romanization/language work. Commit chain: `5d4894f` (Zhuyin) → `2d1e660` (Thai IPA) → `74e91fa` (filename builder + audio selector) → `8261858` (R5-1 katakana-furigana) → `697e574` (universal polish) → `c055192` (R5-2 Indic block) → `4a20dde` (R5-3 Hindi per-akshara) → `c52691c` (R6b-fonts) → `8896682` (R5-3 full — all 6 Brahmic) → `e92c565` (R5-4 phase a — Hebrew romanization) → `af78729` (R5-4 phase b — RTL rendering, Hebrew visually verified via Playwright→PNG).

Key decisions / new constraints recorded during session:
- aksharamukha was preferred over `indic-transliteration`/sanscript because sanscript produces phonologically distorted Tamil ("vaṇakkam" → "vaṇaghghaṃ"). Added to requirements.txt; pulls in lxml + fontTools transitively (size factor for 3c).
- Universal romanization polish (`_polish_romaji`) applied at every factory tail. Fixed silent pinyin CJK-punct-drop bug that was losing sentence boundaries. Cyrillic + Thai opt out of capitalization (respectively, cyrtranslit preserves source case; Thai has no caps convention).
- Hebrew was chosen as the RTL pilot over Arabic because (a) no contextual shaping — glyphs are position-independent, (b) no cursive connection, (c) bidi cooperation is heavily tested in browser stacks from Hebrew's use alongside English in Israeli tech, (d) DejaVu Sans already has Hebrew glyph coverage so fallback is graceful.
- Hebrew romanization without nikud has documented failure modes (baruch→varokh, bayit→vit, chaverim→chavarim); tests lock in the current outputs so a future nikud-aware or dictionary-based improvement shows up as a clear test diff.
- RTL rendering plumbing uses content-based `is_rtl_text(text)` heuristic on the Bottom layer (we don't track native_lang_code in APIs) + lang_cfg['rtl'] on the Top layer. `.ass` path untouched — libass handles bidi internally.
- R6b-fonts validator uses fc-match for resolution + fontTools.ttLib cmap for glyph coverage. Linux-only backend. Cross-platform story deferred to 3c bundling — likely a fontTools-only scanner over a bundled font directory.

**Known broken / dead code:** None tracked.

**Test suite:** **421 tests** across 14 files (started session at 237, finished at 421 = +184). Engine tests cover `loom_core` only — still no tests for `loom_api` (smoke-tested via cURL workflows during 2a–2c).

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
    generate.py            # POST /generate/ass (sync) + POST /generate/pgs (async → JobAccepted)
    jobs.py                # GET /jobs/{id} → JobStatus
    video.py               # POST /video/scan → VideoMetadata + TrackInfo[]
    subs.py                # POST /subs/detect-language + POST /subs/detect-styles
    align.py               # POST /align → AlignResponse
    preview.py             # POST /preview → composite HTML + raw text fields
    styles.py              # GET /styles/fonts + GET /styles/presets?lang= → wire-safe FONT_LIST/CJK_FONT_LIST + preset catalogue
apps/
  desktop/                 # Tauri 2 + Vite + React (TypeScript) — desktop shell. Step 3a foundation; step 3b builds out the UI.
    src-tauri/             # Rust shell. lib.rs spawns uvicorn loom_api.main:app as a child process; kills it on window close.
    src/                   # React frontend. App.tsx orchestrates file slots + scan; styles.ts holds StyleConfig wire types + defaults + preset apply; StyleSection.tsx renders the dual-view style editor (LayerView + PropertyView).
loom_core/                 # Pure engine — no Streamlit imports. Consumed by loom_app.py + loom_api.
  __init__.py
  models.py                # Pydantic wire contracts: StyleConfig, TrackInfo, LanguageMetadata, Generate*Request, JobStatus, etc.
  language.py              # Language detection + Cantonese discriminator + script analysis
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese (MeCab/fugashi), Korean, Cyrillic, Thai (3 systems)
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  color_presets.py         # Color preset system: 28 presets (classic/cultural/dark/adaptive), language-scoped
  korean_rr.py             # Standalone Korean Revised Romanization implementation
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
tests/
  test_sup_roundtrip.py    # SUP writer ↔ ocr parser round-trip + split_regions + epoch (33 tests)
  test_rasterize.py        # Playwright rasterizer smoke tests (10 tests)
  test_integration_pgs.py  # Full pipeline integration tests (4 tests)
  test_r4_romanization.py  # Korean, Cyrillic, Thai romanization + detection (34 tests)
  test_style_mapping.py    # Style mapping: detection, smart defaults, preserve/exclude, PGS dedup (28 tests)
  test_color_presets.py    # Color preset system tests (21 tests)
  test_union_timeline.py   # Union timeline + concurrent event merge + EVA scenarios (42 tests)
  test_epoch_diagnostic.py # PGS epoch binary structure diagnostic (1 test)
  test_chinese_romanization.py # Chinese Pinyin word segmentation + punctuation + annotation (36 tests)
  test_per_style_lang.py   # Per-style language detection (14 tests)
  test_ass_channels.py     # ASS channel detection + extraction (14 tests)
requirements.txt
CLAUDE.md
```

---

## Monorepo Restructure Roadmap

| Step | Status | Scope |
|------|--------|-------|
| 1 | ✅ | Carve `loom_core/` from `app/`. Pydantic wire contracts in `loom_core/models.py`. Streamlit keeps working as a dev client. |
| 2a | ✅ | Minimum FastAPI: `/health`, `/files`, `/language/config`, `/generate/ass`. |
| 2b-styles | ✅ | Audit + rewrite `StyleConfig` to mirror engine's actual dict shape. Hex colors + `*_enabled` toggles, `to_engine_dict()` adapter handles `pysubs2.Color` + `*_none` inversion. |
| 2b-coverage | ✅ | Sync endpoints: `/video/scan`, `/subs/detect-language`, `/subs/detect-styles`, `/align`, `/preview`. |
| 2c-jobs | ✅ | In-process `JobManager` + `/generate/pgs` (async) + `/jobs/{id}`. `Storage` Protocol + `LocalFileStorage`. `opt_in_training` baked into request models. CORS middleware. |
| 3a | ✅ | Tauri shell + Python sidecar IPC. `apps/desktop/` scaffolded; Rust spawns uvicorn, React probes `/health`. |
| 3b-1 | ✅ | File picker + `POST /files/by-path` fast path (no byte transfer). `tauri-plugin-dialog`, `apps/desktop/src/api.ts`, 3-slot UI (video / top / bottom). |
| 3b-2 | ✅ | Video scan + track selector. `scanVideo()` in `api.ts`; "Scan video" button on video card → `POST /video/scan` → results panel (metadata + subtitle tracks). Per-row dropdown assigns selectable tracks to Top/Bottom; PGS/VobSub greyed out with codec label. `FileSlot.path`/`size` made optional for track-derived slots. |
| 3b-3-1 | ✅ | Style controls **foundation**, dual-view. New `StyleSection.tsx` with `[ By layer · By property ]` segmented toggle persisted to localStorage. **LayerView**: stacked cards per layer with summary row (enable, color swatch, font, size) + expand-in-place editor. **PropertyView**: column-per-layer (each layer is its own bordered column with header + stacked sections, left-justified). Both views cover enable / text color+opacity / font / size / bold / italic across all 4 layers. Color preset selector (28 presets, language-scoped via `slots.target?.lang_code`) with 4-swatch strip. Backend: `routes/styles.py` exposes `GET /styles/fonts` (FONT_LIST + CJK_FONT_LIST) and `GET /styles/presets?lang=` (preset catalogue). Frontend: `styles.ts` mirrors `loom_core/models.py` `StyleConfig` + `LayerStyle` defaults; `applyPreset()` ports `get_preset_styles()` (color-only merge, never touches font/size/effects). `FileSlot` gained optional `lang_code`. |
| 3b-3-2 | ✅ | Style controls **effects** in both views. `OutlineControl` (toggle + width slider+number + color + opacity), `ShadowControl` (toggle + distance), `GlowControl` (toggle + radius slider + color swatch) — shared between LayerView and PropertyView. Disabled controls dim via `opacity: 0.4` + `disabled`. All 4 layers covered. `ColorRow` gained optional `disabled` prop. |
| 3b-3-3 | ✅ | Style controls **stack + extras** in both views, plus PropertyView restructure. Language helpers in `styles.ts`: `primaryLang()`, `isJapanese()`, `phoneticOptions(lang)` (yue→Jyutping-only; zh-Hant→Zhuyin-first; zh-Hans→Pinyin-first; th→Paiboon+/RTGS/IPA; empty otherwise), `LONG_VOWEL_MODES` constant. `LongVowelControl` (select over macrons/doubled/unmarked) renders only in Romanized column/card when target is JP. `PhoneticControl` (select with "— Default —" entry) renders only in Annotation column/card when `phoneticOptions` returns non-empty. `StackPositionBlock`: shared collapsible below the view with summary `offset {n}px · ann {n}px · rom {n}px`; `vertical_offset` (-100..100), `annotation_gap` (-20..40), `romanized_gap` (-20..40) as `StackSlider` rows (range + number, step 1). **PropertyView rewrite**: now column-per-layer. Each layer renders as a bordered column via `LayerColumn` with header (enable checkbox + label) and stacked `ColumnSection`s (Color / Typography / Effects / optional Language). Ditched the old `PropertyGroup` / `PropertyRow` / `EmptyCell` grid so Romanized/Annotation no longer produce em-dash cells across other layers; per-column vertical flow is naturally left-justified. |
| 3b-4 | ✅ | Preview pane end-to-end. `api.ts` gained `TimingOffsets` / `Resolution` / `PreviewMode` / `PreviewRequest` / `PreviewResponse` types + `renderPreview()` (POST `/preview`) + `formatTs()` / `parseTimeInput()` helpers (ports of `loom_app._fmt_ts` + `_parse_time_input`). `PreviewSection.tsx` renders when both native + target slots are assigned: mode select (`.ass` / PGS), timestamp slider `0..duration` (default `min(300, duration)`; 3600 fallback when no scan), flexible time text input, 400px iframe via `srcDoc` + `sandbox=""`. Debounced fetch (200ms) driven by a useEffect over `{fileIds, targetLang, timestamp, mode, styles, sourceResolution, videoFileId, offsets}` with a `seq` ref to drop stale responses. Raw Bottom/Top/Romanized text shown below the frame. Backend `/preview` rewired: computes `annotation_spans` via `lang_cfg["annotation_func"]` when the Annotation layer is enabled, runs the Japanese `spans_to_romaji_func` pipeline with the user's `long_vowel_mode` (reuses spans when annotation is on), threads `phonetic_system` into `get_lang_config()`, and accepts optional `video_file_id` → cached frame via new `loom_core.video.mkv_handler.extract_frame()` and a module-level `_FRAME_CACHE: dict[(path, int_ts), path]` so style-only changes reuse the existing JPG. |
| 3b-5 | ✅ | Generation + job polling. Tauri: added `tauri-plugin-fs` (Cargo dep + `tauri_plugin_fs::init()` in `lib.rs`) with scoped `fs:allow-write-file` to `$HOME / $DOWNLOAD / $DESKTOP / $DOCUMENT / $VIDEO` + `dialog:allow-save`. `api.ts` gained `GenerateAss/PgsRequest` + `JobAccepted` + `JobStatus` types and `generateAss()` / `generatePgs()` / `getJob()` / `downloadFileBytes()` helpers (binary `Uint8Array` from `GET /files/{id}`). New `GenerateSection.tsx`: Format radio (`.ass` / PGS / Both), `include_annotations` checkbox (ASS-only), output-resolution select (source + 480p/720p/1080p/1440p/2160p at 16:9), Generate button that runs the selected track(s) in parallel. PGS polled every 500ms; per-row progress bar + `phase` text (from `JobStatus.phase`) while running, `Save …` button on completion → `dialog.save()` + `writeFile()` to the user-picked absolute path. Per-row error display. `onResult` callback exposes the generated file_ids so section 6 (mux) can consume them without regenerating. |
| 3b-6 | ✅ | Mux flow. New `loom_api/routes/mux.py`: `POST /mux` → `JobAccepted`. Request takes `video_file_id` + optional `ass_file_id` / `sup_file_id`, an absolute `output_path`, language codes + `phonetic_system`, `annotation_enabled`, and the advanced flags. Worker resolves file_ids via `storage.path()`, derives track titles from `get_lang_config` + `_build_track_title` server-side (annotation name only when `annotation_enabled` + the language has an annotation_func), runs `merge_subs_to_mkv` via `asyncio.to_thread`, registers the output so clients can re-fetch. The sidecar writes ffmpeg's output straight to `output_path` — no HTTP round-trip of the remuxed MKV. `api.ts` gained `MuxRequest` + `muxVideo()`. `MuxSection.tsx`: shows source filename, Include .ass / Include PGS checkboxes (disabled when not generated), Advanced collapsible (keep_existing_subs / keep_attachments), "Choose output…" via `dialog.save()` (`{base}_stitched.mkv` default + mkv filter), Mux button polling `GET /jobs/{id}` at 500ms, success row shows the muxed path. `App.tsx` lifts `{assFileId, pgsFileId}` from GenerateSection via `onResult` (stable `useCallback`) and renders MuxSection once the video slot + at least one generated track are present. |
| 3b-7 | ✅ | Timing offsets + auto-align UI. `TimingOffsetsSection.tsx`: manual Bottom/Top offset inputs (0.01s step, seconds display / ms on wire) with Link toggle + delta-based linked adjustment. Auto-align collapsible: `open`/`Browse…` picker (video or subtitle extensions), subtitle → register direct, video → `Scan reference video` + track dropdown (`TrackSelect` disables non-selectable), Compare-to layer picker (Top/Bottom), `Compute offset` → `POST /align` via new `alignSubtitles()` in `api.ts`, signed-offset result row with workflow-guidance prose, Apply-to picker + `Apply` that calls `setOffsetWithLink()` so Link propagates. `App.tsx` holds `{bottom_ms, top_ms}` + `offsetsLinked` state, passes to Preview/Generate/Mux. Backend unchanged — `/preview`, `/generate/ass`, `/generate/pgs` already accepted `TimingOffsets` and threaded through as `native_offset_ms`/`target_offset_ms`. |
| 3b-polish | ✅ | Output filename builder + audio-default selector (74e91fa). `POST /generate/suggest-filename` wraps `build_output_filename` server-side; GenerateSection calls it right before `dialog.save()` with graceful `subtitles.{ext}` fallback. `AudioTrackInfo` added to `/video/scan` response; MuxSection Advanced renders "Default audio" select when tracks present, auto-picks track whose primary lang-subtag matches target. Mux filename kept as `{base}_stitched.mkv` (release tags in source name more useful than builder output). |
| 3b | ✅ | Frontend parity: all sections + timing/align + polish complete. Feature parity with Streamlit achieved. |
| 3c | 🔲 | Bundling for distribution. PyInstaller / `uv` / PyOxidizer decision deferred until 3b is solid. Ships installers via GitHub Releases + Tauri auto-updater. |
| 4 | 🔲 | Next.js web on Vercel. Same Next.js build → either CNAMEd `loom.nerv-analytic.ai` or `apps/web/` workspace. Swap `LocalFileStorage` for `S3FileStorage`. Constrain to subtitle-only + YouTube URL flows (no large video uploads). Extract shared React components into `packages/ui/` once a second consumer exists. |
| 5 | 🔲 | WXT browser extension. YouTube + Netflix C/K-drama overlays. Reuses `@loom/api-client` (from FastAPI's OpenAPI). Major OCR data source — extension archives `(text, style, language)` tuples behind `opt_in_training` for the synthetic OCR pipeline to consume. |
| 6 | 🔲 (parallel) | OCR pipeline as separate `loom_ocr/` package. Closed-loop synthetic data → fine-tuned TrOCR. Runs as a batch process, not part of the API. Detailed in `Synthetic Visual Engine — Phase 1` doc; targets Sept 2026 demo for PhD applications. |

**Locked tech decisions for steps 3+:**
- Frontend: Vite + React (not Next.js) for desktop. Web app at step 4 may migrate to Next.js, with shared components in `packages/ui/`. Don't extract the package until a second consumer exists — premature shared libraries are how API ergonomics go bad.
- IPC: HTTP on localhost (not Tauri commands). Frontend stays deployment-agnostic — same code talks to localhost sidecar or `https://api.loom.nerv-analytic.ai`. One env var flips the base URL.
- Storage: `Storage` Protocol now, `LocalFileStorage` only impl until step 4. `S3FileStorage` drops in without route changes.
- Job runner: in-process dict + `asyncio.Task`. Migrate to arq+Redis only if/when web traffic outgrows one uvicorn worker. Tauri sidecar will never need persistence (process dies with the app).
- Python bundling: defer until step 3c. Dev mode uses the developer's existing Python (env vars `LOOM_UVICORN`, `LOOM_PROJECT_ROOT`, `LOOM_SIDECAR_PORT` override defaults).
- OCR data ingestion: `opt_in_training: bool = False` baked into request models from step 2c. No archival code yet — actual ingestion wires up at step 5 when the extension produces real data flow. Privacy-hedge in place from day one.

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

**Four-layer output — two independent pipelines:** `.ass` file has 3 or 4 text layers (Bottom / Top / Romanized / optionally Annotation with `\pos()`), controlled by `include_annotations` param. PGS `.sup` is a separate full-frame bitmap rasterization of all enabled layers. PlayResX=1920, PlayResY=1080 set explicitly on all generated .ass files. All coordinates and font sizes in 1080-scale.

**`.ass` pipeline** (`generate_ass_file()` → `str|None`):
- 3 or 4 layers: Bottom, Top, Romanized, optionally Annotation (`\pos()`)
- `include_annotations: bool = True` param; UI checkbox defaults to off (PGS recommended)
- `supports_ass_annotation`: CJK=True, R4=False — gates `\pos()` generation (R4 annotation is PGS-only)
- No Playwright dependency

**PGS pipeline** (`generate_pgs_file()` → `str|None`):
- `rasterize_pgs_to_file()`: memory-bounded batched rendering, streaming write via `SupWriter`
- Playwright async API, N-worker parallel pool (`num_workers` param, default 1). Workers render in parallel, reorder heap preserves timestamp order, consumer writes sequentially via `SupWriter`. Falls back to sequential when `num_workers=1`.
- Nested event loop support (Streamlit) via background thread
- ~50–100ms per screenshot; 300 events ≈ 15–30s. Memory constant regardless of frame count/resolution.
- Requires `pip install playwright && playwright install chromium`
- **Union timeline:** `_build_pgs_timeline()` computes union of all timing boundaries from native + target tracks. Creates one interval per segment so that when only one track changes, the epoch system can emit a Normal update (only changed region re-encoded). Fixes subtitle flicker when English and Japanese tracks have independently-timed line breaks.
- **Concurrent event merging:** `_merge_concurrent_target_events()` runs after Phase A collection. Groups target events by identical `(start, end)`. Drops music-only events (♪, ♫) when real dialogue is concurrent; stacks remaining concurrent events with `<br>` / `\N`. `_is_music_only()` strips HTML tags + ASS overrides before checking `_MUSIC_CHARS` frozenset.
- **Canvas-aware region splitting:** `split_regions(canvas_height=)` guards against splitting when both content clusters are in the same screen half. Gap midpoint must be in 25%–75% of canvas height to allow a 2-region split. Prevents subtitle dropout when only top-half content is rendered (e.g. romaji + Japanese with no English).
- **Epoch management:** `SupWriter.write()` accepts `region_content_keys` for epoch-aware path. Composition states: Epoch Start (full redraw), Acquisition Point (periodic for seek safety, every 12 display sets), Normal (incremental, only changed region re-encoded), Skip (identical content). Reserved palette ranges: obj 0 → indices 1–127, obj 1 → 128–254. Generous fixed windows: top 45%, bottom 25%. Abutting threshold ≤ 50ms. Clears always Epoch Start. `region_content_keys=None` → backward-compatible Epoch Start path.

**Annotation infrastructure is language-agnostic.** `get_annotation_func(lang_code)` → span producer. `build_annotation_html(spans, mode)` → HTML with 3 pluggable render modes: `"ruby"`, `"interlinear"`, `"inline"`. `annotation_render_mode` threaded through processing → rasterizer → preview. `annotation_font_ratio` (CJK=0.5, alphabetic=0.4). Adding a new annotated script = new `get_annotation_func()` implementation only; rendering unchanged.

**Container-agnostic input:** ffprobe/ffmpeg accept any video container. Output always `.mkv`. UI file pickers accept all formats; output extension forced to `.mkv`. Subtitle upload accepts `.srt`, `.ass`, `.ssa`, `.vtt`.

**MKV mux critical flags:** `-c:s:N ass` re-encodes ASS track (fixes timestamp conversion), `-max_interleave_delta 0` forces strict DTS-order interleaving (fixes subtitle clustering). PTS=0 anchor in `SupWriter`/`write_sup()` prevents ffmpeg timestamp rebasing.

**`merge_subs_to_mkv()`:** Accepts optional `ass_path` and `sup_path`. `disposition:default` on PGS if both present. `default_audio_index` sets audio disposition. `keep_existing_subs`/`keep_attachments` params for track stripping.

**Output filenames:** `build_output_filename()` → `{media}.{year}.{native_lang}.{target_lang}[.{annotation}][.{romanization}].{ext}` where `native_lang` = user's language code (e.g. "en") and `target_lang` = foreign/media language code (e.g. "ja"). Title/year from `get_video_metadata()`.

**No RAM-loading of large video files** — always local path + ffmpeg subprocess.

**Modularity:** `loom_core/video/mkv_handler.py` is the only file that touches ffmpeg.

**SSAFile caching:** `load_subs_cached(path, cache)` in `loom_core/subs/utils.py`. Cache keyed by `(path, mtime)`. After step 1 the engine is pure: pass an explicit dict to enable caching (`st.session_state` from the Streamlit shell, a per-request dict from the API layer), or `None` to skip. `generate_ass_file()` / `generate_pgs_file()` accept optional `lang_config=None` param to avoid redundant `get_lang_config()` calls across Streamlit reruns.

**Timing offsets:** `shift_events(subs, offset_ms)` in `loom_core/subs/utils.py` — deep-copies an SSAFile and shifts all event start/end by offset_ms, clamped to >=0 (returns original when offset is 0). UI: collapsible "Timing Offsets" expander in Section 2 with two `number_input` widgets (`bottom_offset_sec`, `top_offset_sec`, 0.01s step) + a Link toggle for linked adjustment (delta-based: changing one shifts the other by the same amount). Offsets applied as `native_offset_ms`/`target_offset_ms` params via `shift_events()` immediately after `_load_subs()` in `loom_core/subs/preview.py` (`get_lines_at_timestamp`), `loom_core/subs/processing.py` (`generate_ass_file`, `generate_pgs_file`). Conversion: `int(round(sec * 1000))` at call sites.

**Auto-alignment from reference:** `compute_subtitle_offset(reference_subs, target_subs)` in `loom_core/subs/utils.py` → `(float, str|None)`. Sign convention: returns `target_time - reference_time` (positive = reference earlier, shift source-A tracks later). Algorithm: coarse pass = pairwise-difference histogram (N×M pairs, 100ms bins, `collections.Counter`); fine pass = ±2s around peak in 10ms steps, ±500ms tolerance with `bisect`, midpoint of best-scoring plateau. Filters out Comment events and `\p` drawing events; minimum 5 dialogue events per track. UI: inside "Timing Offsets" expander below manual controls. File picker (video+subtitle via `render_path_input`), video scanning via `get_video_metadata()` + `scan_and_extract_tracks()` into `{temp_dir}/ref_align/` subdir, track selectbox, "Compare against" (Bottom/Top), "Compute Offset" button, result display with workflow help text, "Apply to" + "Apply" button. Apply uses deferred pending keys (`_pending_top_offset_sec`/`_pending_bottom_offset_sec`) drained at top of script before `number_input` widgets bind — avoids Streamlit's `StreamlitAPIException` on post-widget state mutation. Linked adjustment propagated through pending path.

**Scan performance:** Single-pass ffmpeg extraction. Shared probe — `get_video_metadata()` returns `(metadata_dict, probe_data)` tuple; `scan_and_extract_tracks(probe_data=probe_data)` reuses it. `probesize='100M'` + `analyzeduration='100M'` on ffprobe.

**Native file picker:** `_native_file_dialog()` in `app/ui.py` — zenity → kdialog → tkinter fallback. (Streamlit-specific, lives outside `loom_core/`.)

**Preview:** Resolution-independent CSS (`_REF_H=1080`). Font sizes scaled by `_FONT_SCALE = 600/1080` for 600px iframe. `.ass` vs `PGS` mode selector.

**Output resolution scaling:** `_PLAYRES_OPTIONS` (480p–2160p) + "Match source". `_scale = target_height / 1080` applied to all style attrs.

---

## Language Pipelines

**Japanese:** `_make_japanese_pipeline()` returns `(resolve_spans, spans_to_romaji)`. Uses `fugashi` (MeCab backend) + `unidic-lite` for morpheme analysis. Three-tier furigana: (1) author inline `kanji(hiragana)`, (2) pre-existing ASS furigana, (3) MeCab reading fallback. Three long vowel modes: macrons (default), doubled, unmarked. POS-aware verb chain merging via `_should_merge_for_romaji()` (conjugation suffixes, progressive い, 準体助詞 ん). Particle は → wa via `pos1=助詞, pos2=係助詞` detection. `_merge_katakana_fragments()` rejoins MeCab splits. Closure state `_romaji_meta` dict carries merge_mask + particle_ha between `resolve_spans()` → `spans_to_romaji()` calls.

**Chinese variants:**
- Simplified (`zh-Hans`/`zh-CN`/`chs`/bare `zh`) → Pinyin
- Traditional (`zh-Hant`/`zh-TW`/`cht`) → Zhuyin default (Bopomofo)
- Cantonese (`yue`/`zh-yue`/title "CantoCaptions"/2+ `_CANTONESE_MARKERS`) → Jyutping (annotation on by default)
- **Word-segmented Pinyin:** `_make_pinyin_romanizer(variant=)` uses `jieba.cut()` for word boundaries → syllables joined within words (e.g. "nǐhǎo shìjiè" not "nǐ hǎo shì jiè"). Traditional text converted to Simplified via OpenCC `t2s` for jieba segmentation (Simplified-oriented dictionary), word boundaries mapped back to original Traditional characters for pypinyin processing.
- **CJK punctuation stripping:** `_is_cjk_punct()` / `_is_cjk_punct_segment()` filter punctuation-only segments from romanization output. Covers U+3000–U+303F, fullwidth forms U+FF00–U+FF65, CJK compatibility U+FE30–U+FE4F, general punctuation U+2000–U+206F.
- Per-character annotation spans for all three variants (Pinyin/Zhuyin/Jyutping ruby)
- opencc script conversion (`s2tw`, `t2s`) in `loom_core/subs/processing.py` + `t2s` in `_make_pinyin_romanizer()` for jieba segmentation
- Metadata map: exact match first, then longest-prefix

**Korean:** `korean-romanizer`, Revised Romanization. Per-syllable annotation — each Hangul syllable block (가–힣) gets its own ruby with individual RR reading via `Romanizer(char)`. Loses inter-syllable phonological rules (liaison 연음, tensification 경음화, nasalization 비음화) in ruby, but the romanization line uses full-word `Romanizer(text)` which captures them correctly. Two layers, two purposes: ruby = base reading per character (lookup aid), romanization line = actual pronunciation (reading aid).

**Cyrillic:** `cyrtranslit`. `_CYRILLIC_LANG_CODES` BCP-47→cyrtranslit mapping (ru, uk/ua, be/by, sr, bg, mk, mn). Ukrainian/Belarusian disambiguation via `_UKRAINIAN_UNIQUE`/`_BELARUSIAN_UNIQUE` frozensets in `loom_core/language.py`.

**Thai:** `pythainlp`. 3 phonetic systems:
- `"paiboon"` (default): Paiboon+-style with tone diacritics. `thai2rom` base + `tone_detector()` + combining diacritics. Vowel remapping (ae→ɛ, ue→ɯ). Syllables hyphenated within words.
- `"rtgs"`: Royal Thai General System (no tones), pure ASCII.
- `"ipa"`: IPA via pythainlp engine auto-detection.
- Hybrid tokenizer `_thai_tokenize()`: `word_tokenize(engine='newmm')` → `syllable_tokenize()` on tokens >6 Thai chars.
- `_normalize_thai()` for decomposed sara am (`ํา` → `ำ`). `_THAI_SPECIAL_CASES` for `ก็`.
- Word boundary markers: `_apply_thai_word_boundaries()` inserts U+2009 thin space via `word_boundary_func` in lang config.
- `annotation_default_enabled: False` (block romanization sufficient for most learners).
- **Engine note:** `royin` engine deprecated — mangles consonant clusters. All RTGS/Paiboon+ paths use `thai2rom`.

**Indic scripts (R5-2, R5-3):** `_make_indic_romanizer(primary)` via `aksharamukha.transliterate.process(script, 'IAST', text)`. Six languages via `_INDIC_SCRIPTS = {hi: Devanagari, bn: Bengali, ta: Tamil, te: Telugu, gu: Gujarati, pa: Gurmukhi}`. Aksharamukha preferred over `indic-transliteration`/sanscript because sanscript produces phonologically distorted Tamil ("vaṇakkam" → "vaṇaghghaṃ") by treating Tamil as a subset of Sanskrit phonology. Aksharamukha also auto-converts the Devanagari danda (।) and double danda (॥) to ASCII periods. Output flows through `_polish_romaji(capitalize=True)` — sentence-initial caps, no space before punct. `has_phonetic_layer=True`, `supports_ass_annotation=False` (alphabetic script, not CJK glyph-width-math), `annotation_system_name="Transliteration"`.

**Font validation (R6b-fonts):** `loom_core/fonts.py::validate_font(font_name, *, lang_code=None, text=None)` → `FontValidation` (resolved_path, resolved_family, is_fallback, coverage_ok, missing_chars, warnings). Backend: `fc-match` for path + family resolution (Linux-only), `fontTools.ttLib.TTFont.getBestCmap()` for glyph coverage. Per-language representative char samples in `_LANG_COVERAGE_SAMPLES` — small (3–6 chars) sets that distinguish the script, e.g. zh-Hans uses 国 (Simplified) and zh-Hant uses 國 (Traditional). Covers: every language in `_ROMANIZATION_META` (guarded by regression test). TTC index routing: fc-match returns `%{index}` for collections so CJK JP/KR/TC faces are each checked against their correct face. Cross-platform note: fc-match is Linux-only; macOS/Windows returns `warnings=["fontconfig unavailable"]` and skips both checks — 3c bundling will add a fontTools-only scanner over a bundled font directory. Library primitive only for now; UI integration (warning badge next to font picker) deferred.

**Hebrew (R5-4 phase a):** `_make_hebrew_romanizer()` is a consonantal transliteration with two heuristics layered on top: (1) a mater lectionis rule — ו and י are consonantal (v / y) at word-start and after another vowel-letter, vocalic (o / i) after a consonant; (2) default 'a' inserted between consecutive consonants. Nikud/cantillation (U+0591–U+05C7) is stripped before transliteration. Begadkefat (ב כ פ) defaults to the soft/spirantized form (v / kh / f) because unpointed Modern Hebrew has no dagesh marker. Handles common words well (שלום → shalom, עולם → olam, תודה → todah) but has documented failure modes (ברוך → varokh not baruch; חברים → chavarim not chaverim). Test suite locks in these known-wrong cases so a future nikud-aware or dictionary-based pass shows up as a clear test-regression signal. Script detection: `_dominant_script()` returns 'Hebrew' → maps to 'he'.

**RTL rendering (R5-4 phase b):** `loom_core.language.is_rtl_text(text, threshold=0.4)` classifies a string as RTL when Hebrew/Arabic/Syriac/NKo/Samaritan/presentation-form codepoints exceed 40% of non-whitespace non-digit chars. `_build_fullframe_html(..., top_rtl, bottom_rtl)` injects `dir="rtl"` on the corresponding `#top` / `#bottom` divs; `unicode-bidi: isolate` is applied to every `.layer` unconditionally so directionality can't leak between layers. Romanized never gets `dir="rtl"` — its output is always Latin-script. `rasterize_pgs_frames` + `rasterize_pgs_to_file` thread the flags through. `generate_pgs_file` derives: `top_rtl` from target lang_cfg['rtl'] (authoritative for known RTL langs), `bottom_rtl` from a content scan over native events (covers arbitrary user languages without needing a native_lang_code API param). `generate_unified_preview(..., top_rtl=None, bottom_rtl=None)` accepts explicit booleans or infers from `native_text`/`target_text` via `is_rtl_text`; `loom_api/routes/preview.py` passes `top_rtl` from target lang_cfg and lets the Bottom auto-infer. Visually verified with Playwright rasterize: pure Hebrew renders RTL with sentence-terminal periods on the left; mixed "אני גר ב Tel Aviv כל חיי." preserves embedded-LTR for "Tel Aviv" within an RTL paragraph (bidi algorithm does its job). The `.ass` output path is unchanged — libass handles bidi internally at render time.

**Brahmic per-akshara annotation (R5-3):** All 6 Indic scripts (hi/bn/ta/te/gu/pa). `_BrahmicBlock(name, base)` dataclass + `_BRAHMIC_BLOCKS` dispatch. `_classify_brahmic(cp, block)` maps codepoint-offsets within the block (offset 0x01–0x03 signs → extender; 0x05–0x14 vowels → starter; 0x15–0x39 consonants → starter; 0x3C nukta → extender; 0x3E–0x4C matras → extender; 0x4D → halant; 0x51–0x57 accents → extender; 0x58–0x5F additional consonants → starter; 0x60–0x61 vocalic independent vowels → starter; 0x62–0x63 vocalic matras → extender). `_split_brahmic_aksharas(text, block)` accumulates consonant clusters across virama boundaries, emits (akshara, True) for grouped chars and (char, False) for non-Brahmic passthrough. `_make_brahmic_annotation_func(primary)` runs aksharamukha per akshara — getting correct conjunct readings like Tamil க்க→"kka" that only the whole-unit approach gives. Wired into `get_annotation_func` for all 6 primaries. Bengali's Khanda Ta (U+09CE) is imperfectly classified as extender rather than a standalone letter — acceptable for reading fidelity but a linguistics tool would special-case it. Backward-compat: `_split_devanagari_aksharas` + `_make_devanagari_annotation_func` still exist as thin wrappers.

**Universal romanization polish:** `_polish_romaji(text, *, capitalize=True)` runs at the tail of every romanizer factory. Three passes: (1) Fullwidth CJK punctuation → ASCII via `_CJK_TO_LATIN_PUNCT` translate table (。→. ，→, ？→? ！→! ; : ( ) [ ] « » 、 ・→space); (2) strip `\s+` before closing punctuation (`.,!?;:)]"}`); (3) when `capitalize=True`, uppercase line-start + first alpha char after any `.!?`. Capitalize enabled for ja/zh/yue/ko/Indic (source script has no case); disabled for Cyrillic (cyrtranslit preserves source case — respecting it distinguishes continuation lines from sentence starts) and Thai all three systems (no caps convention). Idempotent.

**Language detection flow:** `_dominant_script()` → script-specific path. CJK: `_refine_cjk_detection()`. Cyrillic: `_detect_by_script_chars()` unique-char pre-detection → langdetect fallback. Thai: `_dominant_script()→'Thai'`. Indic: `_dominant_script()` returns `'Devanagari'|'Bengali'|'Tamil'|'Telugu'|'Gujarati'|'Gurmukhi'` → mapped 1:1 to `hi|bn|ta|te|gu|pa` via `_INDIC_SCRIPT_TO_CODE`. Latin: metadata preference via `_normalize_metadata_lang()` over langdetect (fixes Romance language misidentification).

---

## Style System (R6a)

Per-layer controls (Bottom, Top, Romanized, Annotation): color, opacity, font size, font family, outline (toggle + thickness + color + opacity), shadow (toggle + distance, default 1.5), glow (radius 1–20, color, `\blur` ASS tag). "Top Stack Position" expander: vertical offset (-100 to +100px), `annotation_gap` (-20 to +40px, default 2), `romanized_gap` (-20 to +40px, default 0). These are top-level ints in `styles` dict — `isinstance(config, dict)` guards skip them.

Default font sizes (1080-scale): Bottom=48, Top=52, Romanized=30, Annotation=22. Default outline: Bottom=3.0, Top=2.5, Romanized=1.5, Annotation=1.0.

`_hex_to_ass_color()` / `_ass_color_to_hex()` bridge `#RRGGBB` ↔ `pysubs2.Color`. ASS alpha inverted: `int((1 - opacity/100) * 255)`.

**Gap CSS:** `annotation_gap` uses `transform: translateY()` (not `margin-bottom` — broken in Chromium ruby layout) in preview/rasterize. ASS path uses `\pos()` Y-coordinate math.

---

## Style Mapping

`detect_ass_styles()`: two-pass — pattern match is final, not overridable by event count. Priority: (1) `_PRESERVE_PATTERNS` → preserve, (2) `_EXCLUDE_PATTERNS` → exclude, (3) literal "Dialogue"/"Default" → dialogue (`_DIALOGUE_NAME_RE`), (4) 0 events → exclude, (5) remaining → most-events = dialogue. OP/ED/song/karaoke patterns are preserved (not excluded).

`_iter_dialogue_events()`: selects layer with most non-drawing events (not highest-numbered). Excludes all non-main layers. Yields ALL events in the main layer including overlapping ones — concurrent event merging is handled downstream by `_merge_concurrent_target_events()` (PGS path) or left for the player (ASS path).

`has_animation` detection per style. `_strip_animation_tags()` for PGS path (strips `\k`, `\t()`, `\move()`, `\fad()`, etc.; preserves visual tags). `.ass` path passes all tags through.

`_dedup_preserved_for_pgs()`: groups by style + time overlap + text content (substring match). Keeps lowest non-drawing layer. Prevents garbled karaoke layer overlap in PGS.

---

## Roadmap

| Chunk | Status |
|-------|--------|
| R1: Foundation (romanize.py + styles.py refactor) | ✅ |
| R2: Chinese (Pinyin + Zhuyin + Jyutping + opencc) | ✅ |
| R3: Japanese (Hepburn + furigana + resolved-kana + long vowel modes) | ✅ |
| R4: Korean + Cyrillic + Thai (block + per-token annotation) | ✅ |
| R6a: Color pickers + style controls | ✅ |
| R5-1: Katakana-as-furigana (author glosses) | ✅ |
| R5-2: Indic block romanization (6 langs via aksharamukha) | ✅ |
| R5-3: Brahmic per-akshara annotation (all 6 scripts) | ✅ |
| R5-4 phase (a): Hebrew block romanization | ✅ |
| R5-4 phase (b): RTL rendering (PGS + preview, Hebrew-verified) | ✅ |
| R5-4 remaining: Arabic/Persian/Urdu block romanization | 🔲 |
| R6b-presets: Color preset system | ✅ |
| R6b-fonts: Font validation (library primitive) | ✅ |

**R5 remaining details:**
- R5-4 remaining: Arabic/Persian/Urdu block romanization. RTL rendering plumbing is already in place (phase b), so adding ar/fa/ur is limited to their transliteration factories + detection. Arabic has contextual shaping (isolated/initial/medial/final glyph forms) but that's handled by the font + HarfBuzz/Chromium shaping — no Loom code changes needed there. The transliteration schemes for Arabic are dialect-sensitive (MSA vs Egyptian vs Levantine vs Gulf); picking one as default + allowing override is the design question when we tackle it.

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
3. Use `@filename` to reference files, `!command` for shell commands
