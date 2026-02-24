# SRTStitcher — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (2026-02-23):** R1–R3c + R2b + R2c + R6a + **R4 (full: block + per-token annotation)** + **Thai Learner Upgrade (Paiboon+ tone diacritics, phonetic system selector, word boundaries)** + **Thai romanization bug fixes (consonant clusters, sara am, special cases)** + scan performance fix + PGS OCR pipeline + preview resolution-independence fix + PlayResY fix + output resolution scaling + annotation X-position alignment fix (Pillow) + remux target override + timestamp text input + PGS Ruby Rasterization Pipeline + **Separate .ass / PGS Output Pipelines** + **MKV mux fixes** + **UX: audio default + subtitle disposition + annotation toggle** + **Non-MKV video input support** + **Native file picker (zenity/kdialog)** + **Preview layout rearrangement (gap sliders)** + **Latin-script language detection fix** — all complete. Pipeline fully working end-to-end: video file scan (MKV/MP4/AVI/MOV/WebM/TS/M2TS) → track extraction (+ audio metadata) → language detection (CJK + Cyrillic + Thai script analysis) → style configuration (Thai: 3 phonetic systems) → composite preview → `.ass` generation (3 or 4 layers, CJK-only annotation toggle, Thai word boundaries) → PGS full-frame rasterization (separate pipeline, all languages with per-token annotation via pluggable render modes) → remux with descriptive track metadata + default audio selection. Output always `.mkv` regardless of input container. Both `.ass` and PGS tracks verified rendering correctly when muxed into MKV.

**Active focus:** Thai learner upgrade complete. Next: R5 — Indic scripts + RTL.

**Known broken / dead code:**
- `detect_language_from_file()` in `language.py` (lines 334–371) — legacy Simple Upload era function, unused, safe to delete. Also lacks the new Cyrillic/Thai detection paths added in R4.

**Speaker label post-processing (2026-02-20):** `_SPEAKER_LABEL_RE` + `_clean_speaker_labels()` in `romanize.py` — removes whitespace around `（name）`/`(name)` in romaji output and capitalizes first letter inside. Wired into `spans_to_romaji()`. Before: `（ arumin ） sono nichi` → After: `（Arumin）sono nichi`.

**Separate .ass / PGS Output Pipelines (2026-02-21):** The `.ass` and PGS `.sup` are now fully independent outputs. `generate_ass_file()` always produces a complete 4-layer `.ass` (Bottom, Top, Romanized, Annotation with `\pos()`) and returns `str`. `generate_pgs_file()` produces a full-frame PGS `.sup` with all enabled layers rasterized as bitmaps via Playwright async API with 4-page concurrency. Preview mode selector (`.ass` vs `PGS`). Structured output filenames from `build_output_filename()`. MKV remux with descriptive track titles via `_build_track_title()` and per-track include checkboxes. `get_video_metadata()` now returns `title` and `year`.

**MKV mux fixes (2026-02-22):** Three root causes found and fixed for muxed tracks not rendering:
1. **ASS mux timestamp bug**: ffmpeg `-c copy` for standalone `.ass` input doesn't convert ASS Dialogue timestamps to MKV block PTS/duration — most events invisible. Fix: `-c:s:N ass` re-encodes the ASS track, forcing ffmpeg to parse every Dialogue line. In `merge_subs_to_mkv()`.
2. **PGS mux timestamp rebase**: ffmpeg subtracts the first PTS when muxing `.sup` → MKV, shifting all events earlier by the gap between video start and first subtitle. Fix: `write_sup()` now emits a PTS=0 clear anchor display set when the first event starts after 0ms. In `sup_writer.py`.
3. **MKV interleaving**: ffmpeg bunches subtitle packets from separate input files into a few MKV clusters near the end of the file instead of spreading them across the timeline. Players read clusters sequentially — subtitle blocks not in the current cluster are invisible. Symptom: subs only render during the last ~10s of the video; for text subs (m.ass), scrubbing to the end and back "fixes" it because text events get cached in memory, but PGS bitmaps are too large to cache. Fix: `-max_interleave_delta 0` forces strict DTS-order packet writing. In `merge_subs_to_mkv()`.
4. **Layer selection**: `_iter_dialogue_events()` previously selected the highest-numbered ASS layer as main dialogue. For some fansub files the highest layer has only effect/title events while dialogue is on a lower layer. Fix: select the layer with the most non-drawing events. Exclusion logic also changed from `event.layer < main_layer` (only layers below) to `event.layer != main_layer` (all non-main layers — handles effect layers both above AND below the dialogue layer). In `processing.py`.
5. **Track stripping**: `merge_subs_to_mkv()` now accepts `keep_existing_subs` and `keep_attachments` params with UI checkboxes in "Advanced mux options" expander.
6. **OCR workers**: Capped at 4 (was 8) in `ocr.py` to prevent near-OOM on user's machine.

46 tests across 4 test files all passing.

**Non-MKV video input support (2026-02-23):** Pipeline now accepts any video container format as input — MKV, MP4, AVI, MOV, WebM, TS, M2TS. Output is always `.mkv` (only format supporting ASS text subs + PGS bitmap subs + font attachments + multiple audio/subtitle tracks). Changes:
1. **File pickers**: `browse_callback()` and `render_path_input()` in `ui.py` accept all supported video formats. Label changed from "MKV Path" to "Video file path". Native desktop file picker via `_native_file_dialog()` — zenity (GNOME/GTK) → kdialog (KDE) → tkinter fallback.
2. **UI labels**: "Load & Scan MKV" → "Load & Scan Video", "MKV" → "video file" in input/remux target context. Output labels still say MKV.
3. **Output extension enforcement**: `srt_stitcher_app.py` forces `.mkv` extension on output filename regardless of input container (`os.path.splitext(name)[0] + '.mkv'`).
4. **ffmpeg `-map 0:s?` / `-map 0:t?`**: Verified working with containers that have zero subtitle/attachment streams (the `?` suffix makes mapping optional — no error). Tested with MP4 input → MKV output.
5. **No functional changes to `mkv_handler.py`**: ffprobe/ffmpeg already handle any container format. Only docstring updates for container-agnostic documentation.
6. **`mkv_scan_complete` state flag**: New `bool` in `state.py` (`initialize_state()`). Section 2 ("Select Subtitle Sources") now shows when scan is complete even with 0 embedded text tracks — enables external subtitle upload workflow for non-MKV videos with no embedded subs. Old condition: `mkv_tracks` (list non-empty); new condition: `mkv_scan_complete` (bool). Warning message updated: "You can upload external subtitle files below."

**UX improvements (2026-02-22):** Three remux UX improvements:
1. **Default audio track selector**: Audio stream metadata extracted from `probe_data` at scan time → `st.session_state.mkv_audio_tracks`. Selectbox in "Advanced mux options" with auto-selection matching `target_lang_code` via `langcodes.Language.get()`. "No change" option leaves audio dispositions untouched. `merge_subs_to_mkv()` accepts `default_audio_index: int | None` — clears all audio dispositions then sets the chosen track.
2. **Subtitle disposition flip**: PGS now gets `disposition:default` when both `.ass` and `.sup` are muxed (was `.ass`). PGS has pixel-perfect ruby; `.ass` `\pos()` annotation drifts. `.ass`-only mux still gets default.
3. **Annotation toggle for .ass**: `generate_ass_file()` accepts `include_annotations: bool = True`. When `False`: no `\pos()` events, Annotation style removed from output, 3-layer `.ass`. UI checkbox "Include annotations in .ass" (default off) with help text recommending PGS for annotations. Success message reflects "3 text layers" or "4 text layers (with annotations)".

**R4: Korean + Cyrillic + Thai (2026-02-23):** Block-level romanization + per-token annotation with pluggable render modes.
1. **Korean**: `korean-romanizer` library, Revised Romanization. `_make_korean_romanizer()` + `_make_korean_annotation_func()` (space-split words, per-word romanization). Confidence: 🟢 High.
2. **Cyrillic**: `cyrtranslit` library. `_make_cyrillic_romanizer(primary)` + `_make_cyrillic_annotation_func(primary)` (space-split words, per-word transliteration). `_CYRILLIC_LANG_CODES` BCP-47→cyrtranslit mapping (ru→ru, uk→ua, be→by, sr→sr, bg→bg, mk→mk, mn→mn). `_ROMANIZATION_META` entries for all 7 codes (incl. `be`/`mn` — "Latin transliteration", "high"). Ukrainian/Belarusian disambiguation via `_detect_by_script_chars()` in `language.py` — `_UKRAINIAN_UNIQUE` frozenset (і/ї/є/ґ→uk), `_BELARUSIAN_UNIQUE` frozenset (ў→be). Full `detect_language()` Cyrillic flow: `_dominant_script()→'Cyrillic'` → `_detect_by_script_chars()` unique-char pre-detection → langdetect fallback for known codes (ru/sr/bg/mk/uk/be/mn) → default 'ru'. `_has_cyrillic()` helper in `language.py` for script presence check. Confidence: 🟢 High.
3. **Thai**: `pythainlp` library, `engine='thai2rom'` (RTGS-compatible, correct consonant clusters). `_make_thai_romanizer()` + `_make_thai_annotation_func()` both use shared `_thai_tokenize()` hybrid tokenizer. `_dominant_script()` returns `'Thai'`. Confidence: 🟡 Good.
4. **Thai tokenization fix (2026-02-23)**: Hybrid two-pass tokenizer `_thai_tokenize()` — `word_tokenize(engine='newmm')` first for correct word boundaries, then `syllable_tokenize()` on any token >6 Thai chars to break compounds/idioms (e.g. `จองล้างจองผลาญ` → `จอง`+`ล้าง`+`จอง`+`ผลาญ`). Block romanizer now tokenizes-then-romanizes instead of monolithic romanization (was producing concatenated output with no spaces). Both block romanizer and annotation function share `_thai_tokenize()` for consistent segmentation.
5. **Per-token annotation**: All R4 languages now have `annotation_func` returning `(str) -> list[(str, str|None)]` spans. Korean: space-split words with `_has_hangul()` (Hangul Syllables `U+AC00–U+D7AF` + Jamo `U+1100–U+11FF`). Cyrillic: space-split words with `_has_cyrillic()` (`U+0400–U+04FF`). Thai: hybrid `_thai_tokenize()` with `_has_thai()` (`U+0E01–U+0E5B`). All helpers + `_strip_ass()` applied before tokenization in both block romanizer and annotation function.
6. **Pluggable render modes**: `build_annotation_html(spans, mode)` supports 3 modes — `"ruby"` (`<ruby><rt>`), `"interlinear"` (inline-block two-row `.ilb`/`.ilb-r`/`.ilb-b`), `"inline"` (parenthetical `base(reading)`). Default: `"ruby"` for all languages. CSS for interlinear mode in both `rasterize.py` and `preview.py`.
7. **`annotation_render_mode`**: Threaded from `get_lang_config()` → `processing.py` → `build_annotation_html()` + `rasterize_pgs_frames()` → `_build_fullframe_html()`. Also from `srt_stitcher_app.py` → `generate_unified_preview()`.
8. **`annotation_font_ratio`**: CJK=0.5, alphabetic=0.4. Stored in lang config for rendering pipeline.
9. **`supports_ass_annotation`**: CJK=True, R4=False. Guards `\pos()` generation in `generate_ass_file()` — R4 annotation is PGS-only. UI checkbox disabled with help text for non-CJK languages.
10. **`_annotation_system_name()`**: Korean→"Romanization", Cyrillic→"Transliteration", Thai→"Romanization".
11. **Romanization confidence UI**: Confidence badge with emoji: `🟢 Very High/High`, `🟡 Good/Moderate`, `🟠 Low`, `⚪ None`.
12. **Test suite**: 23 tests in `tests/test_r4_romanization.py` — romanizer output, per-token annotation spans, render mode HTML output, lang config validation (incl. new fields), script detection, disambiguation, `.ass` generation integration, `.ass` annotation guard, CJK vs R4 config comparison. Total: 46 tests across 4 files.

**Thai Learner Upgrade (2026-02-23):** Upgraded Thai from basic RTGS-only to a full learner-oriented system comparable to the Japanese pipeline.
1. **Phonetic system selector**: 3 romanization systems selectable in UI (like Chinese Pinyin/Zhuyin/Jyutping):
   - `"paiboon"` (default): Paiboon+-style with tone diacritics on vowel nucleus. RTGS base + per-syllable `tone_detector()` + combining diacritics (grave/acute/circumflex/caron). Vowel remapping: ae→ɛ, ue→ɯ. Syllables joined with hyphens within words. Mid tone unmarked.
   - `"rtgs"`: Royal Thai General System (no tones) — original R4 implementation, pure ASCII.
   - `"ipa"`: IPA via pythainlp engine auto-detection (`'ipa'` → `'thai2rom'` → `'royin'` fallback).
2. **Tone diacritics implementation**: `_THAI_TONE_DIACRITICS` maps tone letters → combining Unicode diacritics: low→grave (à), falling→circumflex (â), high→acute (á), rising→caron (ǎ), mid→unmarked. `_add_tone_diacritic(romanized, tone)` places diacritic on first vowel (aeiouɛɔɯ). `_paiboon_remap_vowels()` applies `_PAIBOON_VOWEL_SUBS` (ae→ɛ, ue→ɯ). Note: RTGS doesn't distinguish /o/ from /ɔ/ — not remapped.
3. **Paiboon+ romanizer**: `_make_thai_paiboon_romanizer()` — per-syllable processing via `syllable_tokenize()` + `tone_detector()` from `pythainlp.util`. Each syllable: RTGS romanize → vowel remap → tone diacritic. Multi-syllabic words joined with hyphens (e.g. สวัสดี → swàt-di). Annotation func: `_make_thai_paiboon_annotation_func()` — same per-syllable logic.
4. **IPA romanizer**: `_make_thai_ipa_romanizer()` + `_make_thai_ipa_annotation_func()` — uses `_detect_thai_ipa_engine()` which tries `'ipa'`, `'thai2rom'`, falls back to `'royin'`.
5. **Word boundary markers**: `_apply_thai_word_boundaries(text)` in `romanize.py` — inserts U+2009 THIN SPACE between tokens (via `_thai_tokenize()`). Applied to Top line text in both `generate_ass_file()` and `generate_pgs_file()` via `word_boundary_func` in lang config. Separate from `display_text` used by romanization/annotation — no double-tokenization. Thai script shaping is not contextual so thin spaces don't alter glyph forms.
6. **Annotation default off**: `annotation_default_enabled: False` for Thai in `get_lang_config()`. Annotation replicates romaji line for Thai (every word annotated). Block romanization line is sufficient for most learners. Users can re-enable. Matches Cantonese pattern. `_ANN_DEFAULT_OFF = frozenset({'yue', 'th'})`.
7. **Phonetic system routing**: `get_romanizer(lang_code, phonetic_system=None)` — new parameter, backwards-compatible. Thai dispatch: `"paiboon"` → `_make_thai_paiboon_romanizer()`, `"ipa"` → `_make_thai_ipa_romanizer()`, default → `_make_thai_romanizer()` (RTGS). Same routing in `get_annotation_func()` via existing `system` param.
8. **Config changes**: `get_lang_config()` defaults Thai to `phonetic_system='paiboon'` when none specified. `_THAI_PHONETIC_META` overrides rom_name/confidence per system. `_annotation_system_name()` includes Thai systems in `_SYS_NAMES` dict (rtgs→"RTGS", paiboon→"Paiboon+", ipa→"IPA"). `_ROMANIZATION_META["th"]` updated to `("Paiboon+ (with tones)", "good")`.
9. **UI**: Thai Options subheader with phonetic system selectbox (Paiboon+/RTGS/IPA) — same pattern as Chinese. `annotation_default_enabled` from lang config replaces hardcoded `target_lang_code != "yue"` for annotation checkbox default (3 occurrences in `srt_stitcher_app.py`).
10. **Test suite**: 29 tests in `tests/test_r4_romanization.py` (+6 new): Paiboon+ diacritics, Paiboon+ annotation spans, IPA romanizer, phonetic system routing, word boundaries, updated lang config. Total: 52 tests across 4 files.

**Thai Romanization Bug Fixes (2026-02-23):** Audited 760 lines of Thai subtitle output — found 20.7% error rate (157/760 lines). Three root causes fixed:
1. **Consonant cluster loss (Bug 1, 128 lines)**: `royin` engine mangles clusters (กล→kn, ปร→pn, คร→khn, ตร→tn, สร→sn). Fix: switched all RTGS and Paiboon+ paths from `engine='royin'` to `engine='thai2rom'`. `thai2rom` produces RTGS-compatible output with correct clusters (กลับ→klap, ครับ→khrap). Verified no regressions on known-good words.
2. **Sara am decomposition (Bug 2, 101 lines)**: Source subtitles use decomposed sara am `ํา` (U+0E4D + U+0E32) instead of composed `ำ` (U+0E33). Fix: `_normalize_thai(text)` helper applied in all 7 Thai functions (6 romanizer/annotation factories + `_apply_thai_word_boundaries()`). Also added `_THAI_SPECIAL_CASES` lookup for `ก็`→`kɔ̂` (Paiboon+ only — both engines fail this particle).
3. **อยู่ → ù (Bug 3, 34 lines)**: `royin` drops the ย initial. Fix: `thai2rom` engine correctly produces `yu`. Resolved by Bug 1 fix (engine switch).
4. **Test suite**: 33 tests in `tests/test_r4_romanization.py` (+4 new regression tests: consonant clusters, sara am normalization, special cases, อยู่). Total: 56 tests across 4 files.

**Preview Layout Rearrangement (2026-02-23):** UI restructuring for better preview workflow + inter-layer gap controls.
1. **"Top Stack Position" expander**: Replaces the bare vertical offset slider. Groups all top-stack positioning controls: vertical offset slider (unchanged, -100 to +100px) plus two new gap sliders.
2. **Gap sliders**: `annotation_gap` (default 2, range -20 to +40px, step 1) controls vertical space between annotation layer and target script line. `romanized_gap` (default 0, range -20 to +40px, step 1) controls extra vertical space between romanized line and target script line. Positive values push layers further above target text.
3. **`st.empty()` preview placeholder**: `_preview_placeholder = st.empty()` declared between position controls and timestamp controls. Reserves the vertical slot in Streamlit page layout so preview appears after style controls even though preview HTML is computed later. Filled via `_preview_placeholder.container()` → `st.components.v1.html(preview_html, height=600)`.
4. **New `styles` dict keys**: `styles["annotation_gap"]` and `styles["romanized_gap"]` are top-level ints (like `vertical_offset`). `isinstance(config, dict)` guards in preview.py/processing.py/rasterize.py skip them. Injection guard in `srt_stitcher_app.py` for sessions predating this change.
5. **Gap threading**: `annotation_gap` → `processing.py` (scaled by `_scale`, subtracted from annotation `\pos()` Y coordinate via `ann_y = max(0, top_marginv - ann_fontsize - ann_gap)`). `romanized_gap` → `processing.py` (subtracted from Romanized style `marginv`), `preview.py` (subtracted from Romanized CSS `top` percentage), `rasterize.py` (subtracted from Romanized absolute pixel `top` in Playwright HTML).
6. **Stale styles KeyError fix**: Style initialization guard strengthened from `if not st.session_state.styles` to `if not st.session_state.styles or "Top" not in st.session_state.styles`. Prevents KeyError when a stale session has only scalar keys (e.g. `vertical_offset`) but lost the per-track dicts (`Bottom`, `Top`, `Romanized`, `Annotation`).

**Latin-Script Language Detection Fix (2026-02-23):** Castilian Spanish tracks were mislabeled as "English" — langdetect misidentifies Romance languages on short text samples.
1. **`_normalize_metadata_lang()` helper**: New function in `language.py` — resolves ffprobe ISO 639-2/3 metadata tags to BCP-47 codes via `langcodes.Language.get()`. Handles ISO 639-1 (`en`), 639-2 (`eng`/`fre`/`fra`/`spa`), 639-3, and BCP-47 tags. Rejects special codes: `und`, `mis`, `mul`, `zxx`. Rejects codes that stay 3+ chars with no `-` separator (obscure ISO 639-3 codes unlikely in real MKV metadata, e.g. `'cas'`=Tsimane).
2. **Latin-script metadata preference**: In `detect_language()`, when `_dominant_script()` returns `'Latin'` or `'Other'`, metadata wins over langdetect. If `_normalize_metadata_lang(metadata_lang)` returns a valid code that disagrees with langdetect's raw code, the metadata code is returned. Fixes: `spa`→`'es'` (not `'en'`), `fre`→`'fr'`, etc.
3. **CJK unaffected**: `_refine_cjk_detection()` still uses raw `metadata_lang.lower()` against hardcoded `chinese_meta_map` — does not go through `_normalize_metadata_lang()`.

---

## Project Structure

```
srt_stitcher_app.py        # Main Streamlit entry point
app/
  mkv_handler.py           # Video scan/extract/screenshot/mux — all ffmpeg calls here (any container in, MKV out)
  ocr.py                   # PGS OCR: SUP parser + Tesseract + parallel thread pool
  sup_writer.py            # PGS/SUP binary writer (inverse of ocr.py parser)
  rasterize.py             # Playwright async full-frame subtitle rasterizer (4-page concurrency)
  state.py                 # Streamlit session state
  ui.py                    # UI helpers, OCR buttons, native file picker (zenity/kdialog/tkinter fallback)
  language.py              # Language detection + Cantonese discriminator
  romanize.py              # Romanization: Pinyin, Zhuyin, Jyutping, Japanese pipeline
  styles.py                # get_lang_config() factory with variant + phonetic_system support
  processing.py            # ASS generation + PGS generation + opencc + output filename builder
  preview.py               # Composite HTML preview
tests/
  test_sup_roundtrip.py    # SUP writer ↔ ocr.py parser round-trip tests
  test_rasterize.py        # Playwright rasterizer smoke tests
  test_integration_pgs.py  # Full pipeline integration tests
  test_r4_romanization.py  # R4: Korean, Cyrillic, Thai romanization + detection
requirements.txt
CLAUDE.md
```

---

## Key Architectural Decisions

**Four-layer output — two independent pipelines:** `.ass` file has 3 or 4 text layers (Bottom / Top / Romanized / optionally Annotation with `\pos()`), controlled by `include_annotations` param. PGS `.sup` is a separate full-frame bitmap rasterization of all enabled layers. PlayResX=1920, PlayResY=1080 set explicitly on all generated .ass files. All coordinates and font sizes in 1080-scale.

**Annotation infrastructure is language-agnostic.** `get_annotation_func(lang_code)` → span producer. `build_annotation_html(spans, mode)` → HTML with 3 pluggable render modes: `"ruby"` (`<ruby><rt>`), `"interlinear"` (inline-block `.ilb`), `"inline"` (parenthetical). `annotation_system_name` in `get_lang_config()` drives UI labels. `annotation_render_mode` threaded through processing → rasterizer → preview. `annotation_font_ratio` (CJK=0.5, alphabetic=0.4). `supports_ass_annotation` gates `\pos()` generation (CJK only; R4 is PGS-only). Adding a new annotated script = new `get_annotation_func()` implementation only; rendering unchanged.

**Separate .ass / PGS Pipelines (2026-02-21):** `.ass` and PGS `.sup` are independent outputs. `generate_ass_file()` produces 3 or 4 layers depending on `include_annotations` param (default `True`; UI default `False` — PGS recommended for annotations). `generate_pgs_file()` renders full-frame composites (all enabled layers in one bitmap) via Playwright async API with 4-page concurrency (`asyncio.gather`). PGS plays everywhere: VLC, mpv, Plex, Jellyfin, hardware players. PGS generation requires Playwright; `.ass` generation has no Playwright dependency.

**Japanese pipeline:** `_make_japanese_pipeline()` returns `(resolve_spans, spans_to_romaji)` — one pykakasi instance, two consumers. Three-tier furigana sourcing: (1) author inline `kanji(hiragana)` annotations (ground truth), (2) pre-existing ASS furigana, (3) pykakasi fallback. Three long vowel modes: macrons (default, `ei` NOT collapsed per strict Hepburn), doubled, unmarked. Multi-line subtitles (`\N`) split before annotation — each line positioned independently.

**Chinese variants:**
- Simplified (`zh-Hans`/`zh-CN`/`chs`/bare `zh`) → Pinyin
- Traditional (`zh-Hant`/`zh-TW`/`cht`) → Zhuyin default (Bopomofo)
- Cantonese (`yue`/`zh-yue`/title "CantoCaptions"/2+ `_CANTONESE_MARKERS`) → Jyutping (annotation off by default — block romanization sufficient)
- opencc script conversion (`s2tw`, `t2s`) in `processing.py` event loop — one conversion, two consumers (Top + annotation)
- Metadata map: exact match first, then longest-prefix — prevents `"zh"` eating `"zh-hant"`

**Annotation X-position (fallback only):** Pillow `ImageFont.getlength()` for pixel-accurate glyph measurement, font resolved via `fc-match` (LRU-cached). Falls back to improved `_char_display_width()` (space corrected 0.5→0.25em). Only used when Playwright is unavailable and `\pos()` ASS fallback is active.

**Container-agnostic input:** ffprobe/ffmpeg accept any video container (MKV, MP4, AVI, MOV, WebM, TS, M2TS). Output is always `.mkv` — only format supporting all required features (ASS text subs, PGS bitmap subs, font attachments, multiple audio/subtitle tracks). UI file pickers accept all formats; output filename extension forced to `.mkv`.

**Native file picker:** `_native_file_dialog(filetypes)` in `ui.py` — shared helper used by `browse_callback()` and `render_path_input()`. Tries zenity (`--file-selection`, GNOME/GTK) first, then kdialog (`--getopenfilename`, KDE), falls back to tkinter `filedialog.askopenfilename()`. Parses tkinter-format filetypes list into CLI filter syntax. tkinter import is deferred to fallback branch only.

**Scan performance (large files):** Single-pass ffmpeg extraction (all text tracks in one file open). Shared probe — `get_video_metadata()` returns `(metadata_dict, probe_data)` tuple; `scan_and_extract_tracks(probe_data=probe_data)` reuses it. Audio stream metadata also extracted from the same `probe_data` at scan time → `st.session_state.mkv_audio_tracks` (index, codec, channels, lang, title). `probesize='100M'` + `analyzeduration='100M'` on ffprobe. PGS/VobSub/DVB/XSUB → `selectable=False` immediately, never passed to ffmpeg.

**PGS OCR (reading):** `app/ocr.py` — binary SUP parser (PCS/WDS/PDS/ODS/END segments), YCbCr→RGB palette, RLE bitmap decode, PIL preprocessing, pytesseract with `--psm 6` (`--oem 1` for CJK). Parallel `ThreadPoolExecutor`. UI: "Extract Text (OCR)" button per PGS track → extract .sup → OCR → detect language → mutate track dict → `st.rerun()`. System prereq: `tesseract-ocr` + language packs.

**PGS SUP Writer (writing):** `app/sup_writer.py` — exact inverse of the `_parse_sup()` parser in `ocr.py`. Accepts `DisplaySet` objects (RGBA PIL Image + position + timing) and produces valid `.sup` files. Internals: RGBA→quantize to 255 colors (index 0=transparent)→RLE encode→PGS segments (PCS/WDS/PDS/ODS/END). Each display set emits a "show" epoch at `start_ms` and a "clear" at `end_ms`. Full-range BT.601 YCbCr (0–255, matching `_ycbcr_to_rgb()` in `ocr.py`). RLE encoding uses 4 modes: `00NNNNNN` short transparent, `01NNNNNN+byte` extended transparent, `10NNNNNN+color` short color run, `11NNNNNN+byte+color` extended color run. **PTS=0 anchor**: when the first event starts after 0ms, `write_sup()` prepends a clear display set at PTS=0 — prevents ffmpeg from rebasing all timestamps when muxing `.sup` → MKV.

**Full-Frame PGS Rasterizer:** `app/rasterize.py` — Playwright async API renders full-frame subtitle composites (Bottom + Top with `<ruby><rt>` + Romanized) at target video resolution. `PGSFrameEvent` dataclass carries all 3 layer texts. `_build_fullframe_html()` creates viewport-sized container with 3 absolutely-positioned divs. CSS positions/fonts/shadows from all layer configs. 4-page async concurrency via `asyncio.gather()` — events partitioned round-robin across pages. Supports nested event loops (Streamlit) via background thread. `_build_text_shadow_css()` generalized for any layer config.

**Preview:** Resolution-independent — CSS margins use fixed `_REF_H=1080` reference (not actual video height). Font sizes scaled by `_FONT_SCALE = 600/1080` for 600px iframe.

**Output resolution scaling:** `_PLAYRES_OPTIONS` (480p–2160p) + "Match source". `_scale = target_height / 1080` applied to all style attrs. Design at 1080, output at any resolution.

**`generate_ass_file()` return value:** Returns `str` (ass_path) or `None` on error. Accepts `include_annotations: bool = True` — when `False`, skips `\pos()` Annotation events and removes the Annotation style (3-layer output). No PGS dependency.

**`generate_pgs_file()` return value:** Returns `str` (sup_path) or `None` on error. Pairs target events with native events by maximum temporal overlap. Requires Playwright.

**`merge_subs_to_mkv()` refactored:** Accepts optional `ass_path` and `sup_path` — either or both can be provided. Descriptive track titles via `_build_track_title()`. `disposition:default` on PGS if present, else on `.ass` (PGS preferred — pixel-perfect ruby). `default_audio_index: int | None` sets the default audio track (clears all audio dispositions then sets the chosen one; `None` = untouched). UI has per-track include checkboxes + audio selector with auto-match. Key ffmpeg flags: `-c:s:N ass` re-encodes ASS track (fixes timestamp conversion), `-max_interleave_delta 0` forces strict DTS-order interleaving (fixes subtitle clustering), `-map 0:v -map 0:a [-map 0:s?] -map N [-map 0:t?]` explicit type mapping (prevents stream-index confusion from interleaved font attachments). `keep_existing_subs` and `keep_attachments` params control track stripping.

**`build_output_filename()`:** Structured filenames: `{media}.{year}.{native}.{target}[.{annotation}][.{romanization}].{ext}`. Media title/year from `get_video_metadata()` (MKV format tags or filename fallback).

**No RAM-loading of large video files** — always local path + ffmpeg subprocess. Remux = full container rewrite (~94 GB I/O for large files).

**Modularity:** `mkv_handler.py` is the only file that touches ffmpeg. Accepts any container format as input; always outputs `.mkv`.

**Ukrainian ≠ Russian.** Different alphabet (і,ї,є,ґ unique to Ukrainian), different romanization standard (КМУ 2010 vs BGN/PCGN). Use `lingua` over `langdetect` for Slavic discrimination.

---

## Style Controls (R6a — complete)

Per-layer controls (Bottom, Top, Romanized, Annotation): color picker, opacity slider (0–100%), font size, font family, outline toggle + thickness + color + opacity, shadow toggle + distance (default 1.5), glow (radius 1–20, color, `\blur` ASS tag). "Top Stack Position" expander groups: vertical offset slider (-100 to +100px, shifts Top+Romanized+Annotation as a unit), `annotation_gap` slider (-20 to +40px, default 2, controls annotation-to-target spacing), `romanized_gap` slider (-20 to +40px, default 0, controls romanized-to-target spacing). `styles["vertical_offset"]`, `styles["annotation_gap"]`, `styles["romanized_gap"]` are top-level ints — `isinstance(config, dict)` guards in preview.py/processing.py/rasterize.py skip them.

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
| R4: Korean + Cyrillic + Thai | ✅ |
| R5: Indic scripts + RTL (experimental) | 🔲 Next |
| R6b: Font validation + preset themes | 🔲 |

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
| Korean | `korean-romanizer` | Revised Romanization; per-word annotation (space-split) |
| Cyrillic | `cyrtranslit` | Lang-code aware; per-word annotation (space-split) |
| Thai | `pythainlp` | 3 engines: `thai2rom` (RTGS + Paiboon+ base — `royin` engine deprecated due to consonant cluster bugs), Paiboon+ (custom: `thai2rom` + `tone_detector` + diacritics), `ipa`/`thai2rom`. `_normalize_thai()` for decomposed sara am. `_THAI_SPECIAL_CASES` for ก็. Hybrid tokenizer + `syllable_tokenize` for per-syllable tone. `_apply_thai_word_boundaries()` for U+2009 thin space insertion. |
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
| Death Whisperer 3 (non-MKV) | Thai, English (external SRT) | Non-MKV container input, external subtitle upload, Thai R4 |

---

## Community Credits

- **Furretar** (GitHub) — AoT MKV test files, [Mandarin-Subtitles-Archive](https://github.com/Furretar/Mandarin-Subtitles-Archive), [Hardsub-Extract-OCR](https://github.com/Furretar/Hardsub-Extract-OCR)

---

## Separate .ass / PGS Output Pipelines

**Design:** `.ass` and PGS `.sup` are fully independent outputs. Users can generate either or both.

**`.ass` pipeline** (`generate_ass_file()` → `str`):
- Produces 3 or 4 layers: Bottom, Top, Romanized, optionally Annotation (`\pos()`)
- `include_annotations: bool = True` param controls Annotation layer; UI checkbox defaults to off (PGS recommended)
- When `include_annotations=False`: no `\pos()` events, Annotation style removed from output
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

**Output filenames:** `build_output_filename()` → `{media}.{year}.{native}.{target}[.{annotation}][.{romanization}].{ext}`. Media title/year from video metadata (MKV format tags or filename fallback). Output extension always `.mkv`.

**MKV track metadata:** `_build_track_title()` → `"Japanese + English [Furigana / Hepburn] (SRTStitcher)"`. Per-track include checkboxes in UI. `merge_subs_to_mkv()` accepts optional `ass_path` and `sup_path`. Track stripping via `keep_existing_subs`/`keep_attachments` params with UI checkboxes in "Advanced mux options" expander. Default audio track selector in same expander — auto-matches `target_lang_code` via `langcodes`, "No change" option. `default_audio_index` param sets audio disposition. Subtitle disposition: PGS preferred over `.ass` when both present.

**Dependencies:** PGS requires `pip install playwright && playwright install chromium`. `.ass` generation has no Playwright dependency.

**Performance:** ~50–100ms per screenshot. 300 events ≈ 15–30 seconds (4x concurrency reduces wall time). Progress callback drives UI bar.

**Test suite (56 tests across 4 files):**
- `tests/test_sup_roundtrip.py` (12 tests): RLE encode/decode round-trip, YCbCr color round-trip, palette quantization, full SUP write→parse round-trip, ODS fragmentation, PGS seek safety, PTS anchor (late start + zero start).
- `tests/test_rasterize.py` (7 tests): Playwright availability, single full-frame raster, multi-event batch, empty text skip, progress callback, full pipeline (rasterize→SUP→parse), 2x output scale.
- `tests/test_integration_pgs.py` (4 tests): `generate_ass_file()` returns str with all 4 layers, annotation-disabled has 3 layers, `generate_pgs_file()` produces valid `.sup`, `build_output_filename()` tests.
- `tests/test_r4_romanization.py` (33 tests): Korean/Cyrillic/Thai romanizer output, Thai Paiboon+ diacritics, Thai IPA, Thai phonetic system routing, Thai word boundaries, per-token annotation spans (incl. Paiboon+), 3 render mode HTML output (ruby/interlinear/inline), lang config validation (incl. `supports_ass_annotation`, `annotation_font_ratio`, `annotation_system_name`, `annotation_default_enabled`, `word_boundary_func`), Cyrillic/Thai script detection, Ukrainian/Belarusian disambiguation, `.ass` generation integration (Thai: word boundaries in Top line), `.ass` annotation guard, CJK vs R4 config comparison, Thai consonant cluster regression, sara am normalization, special-case lookup (ก็), อยู่ regression.

---

## How to Resume

1. `cd` into repo, run `claude`
2. Read this file — it is the authoritative state document
3. Use `@filename` to reference files, `!command` for shell commands
