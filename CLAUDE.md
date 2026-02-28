# SRTStitcher — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-02-28):** R1–R4 complete + R6a complete + R6b-presets complete + timing offsets + auto-alignment + all supporting infrastructure. Pipeline fully working end-to-end: video file scan (MKV/MP4/AVI/MOV/WebM/TS/M2TS) → track extraction (+ audio metadata) → language detection (CJK + Cyrillic + Thai + Latin-script metadata preference) → style configuration (Thai: 3 phonetic systems) → composite preview → `.ass` generation (3 or 4 layers, CJK-only annotation toggle, Thai word boundaries) → PGS full-frame rasterization (separate pipeline, all languages with per-token annotation via pluggable render modes, karaoke layer dedup, memory-bounded streaming, union timeline for multi-track sync, epoch-based incremental updates, concurrent event merging, canvas-aware region splitting) → remux with descriptive track metadata + default audio selection. Output always `.mkv` regardless of input container. Manual timing offsets per track + auto-alignment from reference file (cross-correlation algorithm).

**Active focus:** R5 — Indic scripts + RTL.

**Known broken / dead code:** None currently tracked.

**Test suite:** 209 tests across 9 files, all passing.

---

## Project Structure

```
srt_stitcher_app.py        # Main Streamlit entry point
app/
  mkv_handler.py           # Video scan/extract/screenshot/mux — all ffmpeg calls (any container in, MKV out)
  ocr.py                   # PGS OCR: SUP parser + Tesseract + parallel thread pool
  sup_writer.py            # PGS/SUP binary writer (inverse of ocr.py parser); batch + streaming APIs; epoch state management
  rasterize.py             # Playwright async full-frame subtitle rasterizer (N-worker parallel pool, batched streaming)
  state.py                 # Streamlit session state
  ui.py                    # UI helpers, OCR buttons, native file picker (zenity/kdialog/tkinter fallback)
  language.py              # Language detection + Cantonese discriminator + script analysis
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese (MeCab/fugashi), Korean, Cyrillic, Thai (3 systems)
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  processing.py            # ASS generation + PGS generation + union timeline + concurrent event merge + opencc + style mapping + output filename builder
  preview.py               # Composite HTML preview
  color_presets.py         # Color preset system: 28 presets (classic/cultural/dark/adaptive), language-scoped
  sub_utils.py             # Shared subtitle loading + mtime-based SSAFile caching + shift_events() + compute_subtitle_offset()
tests/
  test_sup_roundtrip.py    # SUP writer ↔ ocr.py parser round-trip + split_regions + epoch (33 tests)
  test_rasterize.py        # Playwright rasterizer smoke tests (10 tests)
  test_integration_pgs.py  # Full pipeline integration tests (4 tests)
  test_r4_romanization.py  # Korean, Cyrillic, Thai romanization + detection (34 tests)
  test_style_mapping.py    # Style mapping: detection, smart defaults, preserve/exclude, PGS dedup (28 tests)
  test_color_presets.py    # Color preset system tests (21 tests)
  test_union_timeline.py   # Union timeline + concurrent event merge + EVA scenarios (42 tests)
  test_epoch_diagnostic.py # PGS epoch binary structure diagnostic (1 test)
  test_chinese_romanization.py # Chinese Pinyin word segmentation + punctuation + annotation (36 tests)
requirements.txt
CLAUDE.md
```

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

**Modularity:** `mkv_handler.py` is the only file that touches ffmpeg.

**SSAFile caching:** `load_subs_cached(path, cache)` in `sub_utils.py`. Cache keyed by `(path, mtime)`. `generate_ass_file()` / `generate_pgs_file()` accept optional `lang_config=None` param to avoid redundant `get_lang_config()` calls across Streamlit reruns.

**Timing offsets:** `shift_events(subs, offset_ms)` in `sub_utils.py` — deep-copies an SSAFile and shifts all event start/end by offset_ms, clamped to >=0 (returns original when offset is 0). UI: collapsible "Timing Offsets" expander in Section 2 with two `number_input` widgets (`bottom_offset_sec`, `top_offset_sec`, 0.01s step) + a Link toggle for linked adjustment (delta-based: changing one shifts the other by the same amount). Offsets applied as `native_offset_ms`/`target_offset_ms` params via `shift_events()` immediately after `_load_subs()` in `preview.py` (`get_lines_at_timestamp`), `processing.py` (`generate_ass_file`, `generate_pgs_file`). Conversion: `int(round(sec * 1000))` at call sites.

**Auto-alignment from reference:** `compute_subtitle_offset(reference_subs, target_subs)` in `sub_utils.py` → `(float, str|None)`. Sign convention: returns `target_time - reference_time` (positive = reference earlier, shift source-A tracks later). Algorithm: coarse pass = pairwise-difference histogram (N×M pairs, 100ms bins, `collections.Counter`); fine pass = ±2s around peak in 10ms steps, ±500ms tolerance with `bisect`, midpoint of best-scoring plateau. Filters out Comment events and `\p` drawing events; minimum 5 dialogue events per track. UI: inside "Timing Offsets" expander below manual controls. File picker (video+subtitle via `render_path_input`), video scanning via `get_video_metadata()` + `scan_and_extract_tracks()` into `{temp_dir}/ref_align/` subdir, track selectbox, "Compare against" (Bottom/Top), "Compute Offset" button, result display with workflow help text, "Apply to" + "Apply" button. Apply uses deferred pending keys (`_pending_top_offset_sec`/`_pending_bottom_offset_sec`) drained at top of script before `number_input` widgets bind — avoids Streamlit's `StreamlitAPIException` on post-widget state mutation. Linked adjustment propagated through pending path.

**Scan performance:** Single-pass ffmpeg extraction. Shared probe — `get_video_metadata()` returns `(metadata_dict, probe_data)` tuple; `scan_and_extract_tracks(probe_data=probe_data)` reuses it. `probesize='100M'` + `analyzeduration='100M'` on ffprobe.

**Native file picker:** `_native_file_dialog()` in `ui.py` — zenity → kdialog → tkinter fallback.

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
- opencc script conversion (`s2tw`, `t2s`) in `processing.py` + `t2s` in `_make_pinyin_romanizer()` for jieba segmentation
- Metadata map: exact match first, then longest-prefix

**Korean:** `korean-romanizer`, Revised Romanization. Per-syllable annotation — each Hangul syllable block (가–힣) gets its own ruby with individual RR reading via `Romanizer(char)`. Loses inter-syllable phonological rules (liaison 연음, tensification 경음화, nasalization 비음화) in ruby, but the romanization line uses full-word `Romanizer(text)` which captures them correctly. Two layers, two purposes: ruby = base reading per character (lookup aid), romanization line = actual pronunciation (reading aid).

**Cyrillic:** `cyrtranslit`. `_CYRILLIC_LANG_CODES` BCP-47→cyrtranslit mapping (ru, uk/ua, be/by, sr, bg, mk, mn). Ukrainian/Belarusian disambiguation via `_UKRAINIAN_UNIQUE`/`_BELARUSIAN_UNIQUE` frozensets in `language.py`.

**Thai:** `pythainlp`. 3 phonetic systems:
- `"paiboon"` (default): Paiboon+-style with tone diacritics. `thai2rom` base + `tone_detector()` + combining diacritics. Vowel remapping (ae→ɛ, ue→ɯ). Syllables hyphenated within words.
- `"rtgs"`: Royal Thai General System (no tones), pure ASCII.
- `"ipa"`: IPA via pythainlp engine auto-detection.
- Hybrid tokenizer `_thai_tokenize()`: `word_tokenize(engine='newmm')` → `syllable_tokenize()` on tokens >6 Thai chars.
- `_normalize_thai()` for decomposed sara am (`ํา` → `ำ`). `_THAI_SPECIAL_CASES` for `ก็`.
- Word boundary markers: `_apply_thai_word_boundaries()` inserts U+2009 thin space via `word_boundary_func` in lang config.
- `annotation_default_enabled: False` (block romanization sufficient for most learners).
- **Engine note:** `royin` engine deprecated — mangles consonant clusters. All RTGS/Paiboon+ paths use `thai2rom`.

**Language detection flow:** `_dominant_script()` → script-specific path. CJK: `_refine_cjk_detection()`. Cyrillic: `_detect_by_script_chars()` unique-char pre-detection → langdetect fallback. Thai: `_dominant_script()→'Thai'`. Latin: metadata preference via `_normalize_metadata_lang()` over langdetect (fixes Romance language misidentification).

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
| R5: Indic scripts + RTL (experimental) | 🔲 Next |
| R6b-presets: Color preset system | ✅ |
| R6b-fonts: Font validation | 🔲 |

**R5 details:**
- `indic-transliteration` for Hindi, Bengali, Tamil, Telugu, Gujarati, Punjabi
- Hindi/Devanagari: per-akshara annotation via `get_annotation_func()`
- Arabic/Persian/Urdu: opt-in/experimental, RTL + abjad, block only
- Katakana furigana e.g. `重力(グラビティ)` (deferred from R3-hotfix)

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
