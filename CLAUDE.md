# SRTStitcher — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-02-24):** R1–R4 complete + R6a complete + all supporting infrastructure. Pipeline fully working end-to-end: video file scan (MKV/MP4/AVI/MOV/WebM/TS/M2TS) → track extraction (+ audio metadata) → language detection (CJK + Cyrillic + Thai + Latin-script metadata preference) → style configuration (Thai: 3 phonetic systems) → composite preview → `.ass` generation (3 or 4 layers, CJK-only annotation toggle, Thai word boundaries) → PGS full-frame rasterization (separate pipeline, all languages with per-token annotation via pluggable render modes, karaoke layer dedup, memory-bounded streaming) → remux with descriptive track metadata + default audio selection. Output always `.mkv` regardless of input container.

**Active focus:** R5 — Indic scripts + RTL.

**Known broken / dead code:**
- `detect_language_from_file()` in `language.py` (lines 334–371) — legacy, unused, safe to delete.

**Test suite:** 89 tests across 5 files, all passing.

---

## Project Structure

```
srt_stitcher_app.py        # Main Streamlit entry point
app/
  mkv_handler.py           # Video scan/extract/screenshot/mux — all ffmpeg calls (any container in, MKV out)
  ocr.py                   # PGS OCR: SUP parser + Tesseract + parallel thread pool
  sup_writer.py            # PGS/SUP binary writer (inverse of ocr.py parser); batch + streaming APIs
  rasterize.py             # Playwright async full-frame subtitle rasterizer (4-page concurrency, batched streaming)
  state.py                 # Streamlit session state
  ui.py                    # UI helpers, OCR buttons, native file picker (zenity/kdialog/tkinter fallback)
  language.py              # Language detection + Cantonese discriminator + script analysis
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese, Korean, Cyrillic, Thai (3 systems)
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  processing.py            # ASS generation + PGS generation + opencc + style mapping + output filename builder
  preview.py               # Composite HTML preview
tests/
  test_sup_roundtrip.py    # SUP writer ↔ ocr.py parser round-trip (16 tests)
  test_rasterize.py        # Playwright rasterizer smoke tests (7 tests)
  test_integration_pgs.py  # Full pipeline integration tests (4 tests)
  test_r4_romanization.py  # Korean, Cyrillic, Thai romanization + detection (34 tests)
  test_style_mapping.py    # Style mapping: detection, smart defaults, preserve/exclude, PGS dedup (28 tests)
requirements.txt
CLAUDE.md
```

---

## Key Architectural Decisions

**Four-layer output — two independent pipelines:** `.ass` file has 3 or 4 text layers (Bottom / Top / Romanized / optionally Annotation with `\pos()`), controlled by `include_annotations` param. PGS `.sup` is a separate full-frame bitmap rasterization of all enabled layers. PlayResX=1920, PlayResY=1080 set explicitly on all generated .ass files. All coordinates and font sizes in 1080-scale.

**`.ass` pipeline** (`generate_ass_file()` → `str|None`):
- 3 or 4 layers: Bottom, Top, Romanized, optionally Annotation (`\pos()`)
- `include_annotations: bool = True` param; UI checkbox defaults to off (PGS recommended)
- `supports_ass_annotation`: CJK=True, R4=False — gates `\pos()` generation (R4 annotation is PGS-only)
- No Playwright dependency

**PGS pipeline** (`generate_pgs_file()` → `str|None`):
- `rasterize_pgs_to_file()`: memory-bounded batched rendering (batches of 50), streaming write via `SupWriter`
- Playwright async API, 4 browser pages (created once, reused), `asyncio.gather()`
- Nested event loop support (Streamlit) via background thread
- ~50–100ms per screenshot; 300 events ≈ 15–30s. Memory constant regardless of frame count/resolution.
- Requires `pip install playwright && playwright install chromium`

**Annotation infrastructure is language-agnostic.** `get_annotation_func(lang_code)` → span producer. `build_annotation_html(spans, mode)` → HTML with 3 pluggable render modes: `"ruby"`, `"interlinear"`, `"inline"`. `annotation_render_mode` threaded through processing → rasterizer → preview. `annotation_font_ratio` (CJK=0.5, alphabetic=0.4). Adding a new annotated script = new `get_annotation_func()` implementation only; rendering unchanged.

**Container-agnostic input:** ffprobe/ffmpeg accept any video container. Output always `.mkv`. UI file pickers accept all formats; output extension forced to `.mkv`.

**MKV mux critical flags:** `-c:s:N ass` re-encodes ASS track (fixes timestamp conversion), `-max_interleave_delta 0` forces strict DTS-order interleaving (fixes subtitle clustering). PTS=0 anchor in `SupWriter`/`write_sup()` prevents ffmpeg timestamp rebasing.

**`merge_subs_to_mkv()`:** Accepts optional `ass_path` and `sup_path`. `disposition:default` on PGS if both present. `default_audio_index` sets audio disposition. `keep_existing_subs`/`keep_attachments` params for track stripping.

**Output filenames:** `build_output_filename()` → `{media}.{year}.{native}.{target}[.{annotation}][.{romanization}].{ext}`. Title/year from `get_video_metadata()`.

**No RAM-loading of large video files** — always local path + ffmpeg subprocess.

**Modularity:** `mkv_handler.py` is the only file that touches ffmpeg.

**Scan performance:** Single-pass ffmpeg extraction. Shared probe — `get_video_metadata()` returns `(metadata_dict, probe_data)` tuple; `scan_and_extract_tracks(probe_data=probe_data)` reuses it. `probesize='100M'` + `analyzeduration='100M'` on ffprobe.

**Native file picker:** `_native_file_dialog()` in `ui.py` — zenity → kdialog → tkinter fallback.

**Preview:** Resolution-independent CSS (`_REF_H=1080`). Font sizes scaled by `_FONT_SCALE = 600/1080` for 600px iframe. `.ass` vs `PGS` mode selector.

**Output resolution scaling:** `_PLAYRES_OPTIONS` (480p–2160p) + "Match source". `_scale = target_height / 1080` applied to all style attrs.

---

## Language Pipelines

**Japanese:** `_make_japanese_pipeline()` returns `(resolve_spans, spans_to_romaji)`. Three-tier furigana: (1) author inline `kanji(hiragana)`, (2) pre-existing ASS furigana, (3) pykakasi fallback. Three long vowel modes: macrons (default), doubled, unmarked.

**Chinese variants:**
- Simplified (`zh-Hans`/`zh-CN`/`chs`/bare `zh`) → Pinyin
- Traditional (`zh-Hant`/`zh-TW`/`cht`) → Zhuyin default (Bopomofo)
- Cantonese (`yue`/`zh-yue`/title "CantoCaptions"/2+ `_CANTONESE_MARKERS`) → Jyutping (annotation off by default)
- opencc script conversion (`s2tw`, `t2s`) in `processing.py`
- Metadata map: exact match first, then longest-prefix

**Korean:** `korean-romanizer`, Revised Romanization. Per-word annotation (space-split, `_has_hangul()` guard).

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

`_iter_dialogue_events()`: selects layer with most non-drawing events (not highest-numbered). Excludes all non-main layers.

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
| R6b: Font validation + preset themes | 🔲 |

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
