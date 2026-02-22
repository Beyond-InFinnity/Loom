# SRTStitcher — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-02-21):** R1–R3c + R2b + R2c + R6a + scan performance fix + PGS OCR pipeline + preview resolution-independence fix + PlayResY fix + output resolution scaling + annotation X-position alignment fix (Pillow) + remux target override + timestamp text input + PGS Ruby Rasterization Pipeline + **Separate .ass / PGS Output Pipelines** — all complete. Pipeline fully working end-to-end: MKV scan → track extraction → language detection → style configuration → composite preview → `.ass` generation (always 4 layers) → PGS full-frame rasterization (separate pipeline) → remux with descriptive track metadata.

**Active focus:** Chunk R4 — Korean (`korean-romanizer`) + Cyrillic (`cyrtranslit` + `lingua`) + Thai (`pythainlp`).

**Known broken / dead code:**
- `detect_language_from_file()` in `language.py` (lines 280–316) — legacy Simple Upload era function, unused, safe to delete.

**Speaker label post-processing (2026-02-20):** `_SPEAKER_LABEL_RE` + `_clean_speaker_labels()` in `romanize.py` — removes whitespace around `（name）`/`(name)` in romaji output and capitalizes first letter inside. Wired into `spans_to_romaji()`. Before: `（ arumin ） sono nichi` → After: `（Arumin）sono nichi`.

**Separate .ass / PGS Output Pipelines (2026-02-21):** The `.ass` and PGS `.sup` are now fully independent outputs. `generate_ass_file()` always produces a complete 4-layer `.ass` (Bottom, Top, Romanized, Annotation with `\pos()`) and returns `str`. `generate_pgs_file()` produces a full-frame PGS `.sup` with all enabled layers rasterized as bitmaps via Playwright async API with 4-page concurrency. Preview mode selector (`.ass` vs `PGS`). Structured output filenames from `build_output_filename()`. MKV remux with descriptive track titles via `_build_track_title()` and per-track include checkboxes. `get_video_metadata()` now returns `title` and `year`. 19 tests across 3 test files all passing.

---

## Project Structure

```
srt_stitcher_app.py        # Main Streamlit entry point
app/
  mkv_handler.py           # MKV scan/extract/screenshot/mux — all ffmpeg calls here
  ocr.py                   # PGS OCR: SUP parser + Tesseract + parallel thread pool
  sup_writer.py            # PGS/SUP binary writer (inverse of ocr.py parser)
  rasterize.py             # Playwright async full-frame subtitle rasterizer (4-page concurrency)
  state.py                 # Streamlit session state
  ui.py                    # UI helpers, OCR buttons, tkinter file dialog
  language.py              # Language detection + Cantonese discriminator
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese pipeline
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  processing.py            # ASS generation + PGS generation + opencc + output filename builder
  preview.py               # Composite HTML preview
tests/
  test_sup_roundtrip.py    # SUP writer ↔ ocr.py parser round-trip tests
  test_rasterize.py        # Playwright rasterizer smoke tests
  test_integration_pgs.py  # Full pipeline integration tests
requirements.txt
CLAUDE.md
```

---

## Key Architectural Decisions

**Four-layer output — two independent pipelines:** `.ass` file always has all 4 text layers (Bottom / Top / Romanized / Annotation with `\pos()`). PGS `.sup` is a separate full-frame bitmap rasterization of all enabled layers. PlayResX=1920, PlayResY=1080 set explicitly on all generated .ass files. All coordinates and font sizes in 1080-scale.

**Annotation infrastructure is language-agnostic.** `get_annotation_func(lang_code)` → span producer. `build_annotation_html()` → CSS ruby. `annotation_system_name` in `get_lang_config()` drives UI labels. Adding a new annotated script = new `get_annotation_func()` implementation only; rendering unchanged.

**Separate .ass / PGS Pipelines (2026-02-21):** `.ass` and PGS `.sup` are independent outputs. `generate_ass_file()` always produces all 4 layers including `\pos()` Annotation. `generate_pgs_file()` renders full-frame composites (all enabled layers in one bitmap) via Playwright async API with 4-page concurrency (`asyncio.gather`). PGS plays everywhere: VLC, mpv, Plex, Jellyfin, hardware players. PGS generation requires Playwright; `.ass` generation has no Playwright dependency.

**Japanese pipeline:** `_make_japanese_pipeline()` returns `(resolve_spans, spans_to_romaji)` — one pykakasi instance, two consumers. Three-tier furigana sourcing: (1) author inline `kanji(hiragana)` annotations (ground truth), (2) pre-existing ASS furigana, (3) pykakasi fallback. Three long vowel modes: macrons (default, `ei` NOT collapsed per strict Hepburn), doubled, unmarked. Multi-line subtitles (`\N`) split before annotation — each line positioned independently.

**Chinese variants:**
- Simplified (`zh-Hans`/`zh-CN`/`chs`/bare `zh`) → Pinyin
- Traditional (`zh-Hant`/`zh-TW`/`cht`) → Zhuyin default (Bopomofo)
- Cantonese (`yue`/`zh-yue`/title "CantoCaptions"/2+ `_CANTONESE_MARKERS`) → Jyutping (annotation off by default — block romanization sufficient)
- opencc script conversion (`s2tw`, `t2s`) in `processing.py` event loop — one conversion, two consumers (Top + annotation)
- Metadata map: exact match first, then longest-prefix — prevents `"zh"` eating `"zh-hant"`

**Annotation X-position (fallback only):** Pillow `ImageFont.getlength()` for pixel-accurate glyph measurement, font resolved via `fc-match` (LRU-cached). Falls back to improved `_char_display_width()` (space corrected 0.5→0.25em). Only used when Playwright is unavailable and `\pos()` ASS fallback is active.

**Scan performance (large MKV):** Single-pass ffmpeg extraction (all text tracks in one file open). Shared probe — `get_video_metadata()` returns `(metadata_dict, probe_data)` tuple; `scan_and_extract_tracks(probe_data=probe_data)` reuses it. `probesize='100M'` + `analyzeduration='100M'` on ffprobe. PGS/VobSub/DVB/XSUB → `selectable=False` immediately, never passed to ffmpeg.

**PGS OCR (reading):** `app/ocr.py` — binary SUP parser (PCS/WDS/PDS/ODS/END segments), YCbCr→RGB palette, RLE bitmap decode, PIL preprocessing, pytesseract with `--psm 6` (`--oem 1` for CJK). Parallel `ThreadPoolExecutor`. UI: "Extract Text (OCR)" button per PGS track → extract .sup → OCR → detect language → mutate track dict → `st.rerun()`. System prereq: `tesseract-ocr` + language packs.

**PGS SUP Writer (writing):** `app/sup_writer.py` — exact inverse of the `_parse_sup()` parser in `ocr.py`. Accepts `DisplaySet` objects (RGBA PIL Image + position + timing) and produces valid `.sup` files. Internals: RGBA→quantize to 255 colors (index 0=transparent)→RLE encode→PGS segments (PCS/WDS/PDS/ODS/END). Each display set emits a "show" epoch at `start_ms` and a "clear" at `end_ms`. Full-range BT.601 YCbCr (0–255, matching `_ycbcr_to_rgb()` in `ocr.py`). RLE encoding uses 4 modes: `00NNNNNN` short transparent, `01NNNNNN+byte` extended transparent, `10NNNNNN+color` short color run, `11NNNNNN+byte+color` extended color run.

**Full-Frame PGS Rasterizer:** `app/rasterize.py` — Playwright async API renders full-frame subtitle composites (Bottom + Top with `<ruby><rt>` + Romanized) at target video resolution. `PGSFrameEvent` dataclass carries all 3 layer texts. `_build_fullframe_html()` creates viewport-sized container with 3 absolutely-positioned divs. CSS positions/fonts/shadows from all layer configs. 4-page async concurrency via `asyncio.gather()` — events partitioned round-robin across pages. Supports nested event loops (Streamlit) via background thread. `_build_text_shadow_css()` generalized for any layer config.

**Preview:** Resolution-independent — CSS margins use fixed `_REF_H=1080` reference (not actual video height). Font sizes scaled by `_FONT_SCALE = 600/1080` for 600px iframe.

**Output resolution scaling:** `_PLAYRES_OPTIONS` (480p–2160p) + "Match source". `_scale = target_height / 1080` applied to all style attrs. Design at 1080, output at any resolution.

**`generate_ass_file()` return value:** Returns `str` (ass_path) or `None` on error. The `.ass` file always contains all enabled layers including `\pos()` Annotation events. No PGS dependency.

**`generate_pgs_file()` return value:** Returns `str` (sup_path) or `None` on error. Pairs target events with native events by maximum temporal overlap. Requires Playwright.

**`merge_subs_to_mkv()` refactored:** Accepts optional `ass_path` and `sup_path` — either or both can be provided. Descriptive track titles via `_build_track_title()` (e.g. "Japanese + English [Furigana / Hepburn] (SRTStitcher)"). `disposition:default` on `.ass` if present, else on `.sup`. UI has per-track include checkboxes.

**`build_output_filename()`:** Structured filenames: `{media}.{year}.{native}.{target}[.{annotation}][.{romanization}].{ext}`. Media title/year from `get_video_metadata()` (MKV format tags or filename fallback).

**No RAM-loading of large video files** — always local path + ffmpeg subprocess. Remux = full container rewrite (~94 GB I/O for large files).

**Modularity:** `mkv_handler.py` is the only file that touches ffmpeg.

**Ukrainian ≠ Russian.** Different alphabet (і,ї,є,ґ unique to Ukrainian), different romanization standard (КМУ 2010 vs BGN/PCGN). Use `lingua` over `langdetect` for Slavic discrimination.

---

## Style Controls (R6a — complete)

Per-layer controls (Bottom, Top, Romanized, Annotation): color picker, opacity slider (0–100%), font size, font family, outline toggle + thickness + color + opacity, shadow toggle + distance (default 1.5), glow (radius 1–20, color, `\blur` ASS tag). Top Stack vertical offset slider (-100 to +100px) shifts Top+Romanized+Annotation as a unit. `styles["vertical_offset"]` is a top-level int — `isinstance(config, dict)` guards in preview.py/processing.py skip it.

Default font sizes (1080-scale): Bottom=48, Top=52, Romanized=30, Annotation=22. Default outline thickness: Bottom=3.0, Top=2.5, Romanized=1.5, Annotation=1.0.

`_hex_to_ass_color()` / `_ass_color_to_hex()` in `srt_stitcher_app.py` bridge `#RRGGBB` ↔ `pysubs2.Color`. ASS alpha is inverted: `int((1 - opacity/100) * 255)`.

---

## Track Dict Schema

```python
{
    'id': int,              # ffmpeg stream index
    'sub_num': int|None,    # subtitle-relative number (None for image tracks)
    'label': str,
    'path': str|None,       # extracted file path (None for image tracks)
    'lang_code': str|None,
    'source': 'mkv',
    'selectable': bool,     # False for PGS/VobSub/DVB/XSUB
    'codec': str,           # raw ffprobe codec name (PGS tracks only)
    'metadata_lang': str,   # ffprobe language tag (PGS tracks only)
    'track_title': str,     # ffprobe title tag (PGS tracks only)
}
```

---

## Roadmap

| Chunk | Status |
|-------|--------|
| R1: Foundation (romanize.py + styles.py refactor) | ✅ |
| R2: Chinese pinyin block romanization | ✅ |
| R2b: Per-character pinyin + annotation generalization | ✅ |
| R2c: Chinese variant handling (Zhuyin, Jyutping, opencc) | ✅ |
| R3: Japanese Hepburn romaji | ✅ |
| R3b: Japanese furigana layer | ✅ |
| R3c: Resolved-kana pipeline + long vowel modes | ✅ |
| R6a: Color pickers + style controls | ✅ |
| R4: Korean + Cyrillic + Thai | 🔲 Next |
| R5: Indic scripts + RTL (experimental) | 🔲 |
| R6b: Font validation + preset themes | 🔲 |

**R4 details:**
- Korean: `korean-romanizer`, Revised Romanization, block only
- Cyrillic: `cyrtranslit` + `_detect_by_script_chars()` pre-detection override (і/ї/є/ґ→uk, ў→be) + `_has_cyrillic()` Serbian guard + `lingua` upgrade in `language.py`
- Thai: `pythainlp` `engine="royin"`, block only
- Add `romanization_confidence` display in UI

**R5 details:**
- `indic-transliteration` for Hindi, Bengali, Tamil, Telugu, Gujarati, Punjabi
- Hindi/Devanagari: per-akshara annotation via `get_annotation_func()`
- Arabic/Persian/Urdu: opt-in/experimental, RTL + abjad, block only
- Katakana furigana e.g. `重力(グラビティ)` (deferred from R3-hotfix)

---

## Library Reference

| Language | Library | Notes |
|----------|---------|-------|
| Chinese Mandarin | `pypinyin` | `Style.TONE` (Pinyin) or `Style.BOPOMOFO` (Zhuyin) |
| Chinese Cantonese | `pycantonese` | `characters_to_jyutping()` → per-char via `[a-z]+[1-6]` regex |
| Chinese script conversion | `opencc-python-reimplemented` | `s2tw`, `t2s` |
| Japanese | `pykakasi` | Token-level; shared pipeline |
| Korean | `korean-romanizer` | Revised Romanization |
| Cyrillic | `cyrtranslit` | Lang-code aware |
| Thai | `pythainlp` | `engine="royin"` |
| Hindi + Indic | `indic-transliteration` | `sanscript` module |
| Arabic/Persian/Urdu | `camel-tools`/`urduhack` | Opt-in/experimental |
| PGS OCR | `pytesseract` | `--psm 6 --oem 1` for CJK |
| PGS annotation raster | `playwright` | Headless Chromium, `<ruby><rt>` → transparent PNG → SUP |
| Annotation positioning (fallback) | `Pillow` | `ImageFont.getlength()` + `fc-match` (only without Playwright) |

---

## Romanization Confidence Scale

| Level | Languages |
|-------|-----------|
| 🟢 Very High | Chinese Mandarin (Pinyin/Zhuyin) |
| 🟢 High | Cantonese (Jyutping), Korean, Cyrillic variants |
| 🟡 Good | Japanese (pykakasi), Thai |
| 🟡 Moderate | Hindi/Indic |
| 🟠 Low (opt-in) | Arabic, Persian, Urdu |
| ⚪ None | Roman-script languages |

---

## Test Corpus

| File | Languages | Purpose |
|------|-----------|---------|
| AoT S1E01 MKV | Taiwan CHT, CantoCaptions, Japanese, English | Primary — all three Chinese variants + Japanese |
| Three Body S01E01 KONTRAST | Simplified Chinese | Clean Mandarin |
| Three Body S01E01 AMZN | Simplified Chinese | HTML `<font>` tag edge case |
| Seven Samurai 4K MKV (94GB) | Japanese PGS, Traditional Chinese, English ×2, Danish, Finnish, Norwegian, Italian, French PGS, German PGS | Large file perf, PGS OCR, Traditional Chinese negative Cantonese test, European R4 |
| Inuyasha EP028 | Japanese DVD fansub | Legacy subtitle formatting |

---

## Community Credits

- **Furretar** (GitHub) — AoT MKV test files, [Mandarin-Subtitles-Archive](https://github.com/Furretar/Mandarin-Subtitles-Archive), [Hardsub-Extract-OCR](https://github.com/Furretar/Hardsub-Extract-OCR)

---

## Separate .ass / PGS Output Pipelines

**Design:** `.ass` and PGS `.sup` are fully independent outputs. Users can generate either or both.

**`.ass` pipeline** (`generate_ass_file()` → `str`):
- Always produces all 4 enabled layers: Bottom, Top, Romanized, Annotation (`\pos()`)
- No Playwright dependency — works everywhere
- `\pos()` annotation may drift (Pillow/libass layout mismatch) — acceptable for `.ass`-only use

**PGS pipeline** (`generate_pgs_file()` → `str`):
```
1. Load native + target subtitles                           [processing.py]
2. Pair events by maximum temporal overlap                  [processing.py]
3. Build PGSFrameEvent(bottom_text, top_html, romaji_text)  [processing.py]
4. _build_fullframe_html(styles) → viewport-sized template  [rasterize.py]
5. 4 async Playwright pages → screenshot per event           [rasterize.py]
6. PIL crop → DisplaySet → write_sup()                       [sup_writer.py]
7. Mux .sup into MKV alongside .ass                          [mkv_handler.py]
```

**Parallelism:** Playwright async API, 4 browser pages, events partitioned round-robin, `asyncio.gather()`. Nested event loop support (Streamlit) via background thread with fresh loop.

**Preview mode selector:** `.ass` vs `PGS` — both visible regardless of Playwright install. PGS mode shows inline `<ruby><rt>` with Annotation config styling (text-shadow, color, size ratio).

**Output filenames:** `build_output_filename()` → `{media}.{year}.{native}.{target}[.{annotation}][.{romanization}].{ext}`. Media title/year from MKV metadata.

**MKV track metadata:** `_build_track_title()` → `"Japanese + English [Furigana / Hepburn] (SRTStitcher)"`. Per-track include checkboxes in UI. `merge_subs_to_mkv()` accepts optional `ass_path` and `sup_path`.

**Dependencies:** PGS requires `pip install playwright && playwright install chromium`. `.ass` generation has no Playwright dependency.

**Performance:** ~50–100ms per screenshot. 300 events ≈ 15–30 seconds (4x concurrency reduces wall time). Progress callback drives UI bar.

**Test suite (19 tests across 3 files):**
- `tests/test_sup_roundtrip.py` (8 tests): RLE encode/decode round-trip, YCbCr color round-trip, palette quantization, full SUP write→parse round-trip.
- `tests/test_rasterize.py` (7 tests): Playwright availability, single full-frame raster, multi-event batch, empty text skip, progress callback, full pipeline (rasterize→SUP→parse), 2x output scale.
- `tests/test_integration_pgs.py` (4 tests): `generate_ass_file()` returns str with all 4 layers, annotation-disabled has 3 layers, `generate_pgs_file()` produces valid `.sup`, `build_output_filename()` tests.

---

## How to Resume

1. `cd` into repo, run `claude`
2. Read this file — it is the authoritative state document
3. Use `@filename` to reference files, `!command` for shell commands
