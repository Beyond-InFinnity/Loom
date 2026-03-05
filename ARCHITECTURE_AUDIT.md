# Loom Architecture Audit

**Date:** 2026-02-25
**Scope:** Full codebase analysis — data flow, memory, performance, technical debt
**Codebase:** ~7,900 lines across 12 source files

---

## Part 1 — End-to-End Data Flow

### Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    loom_app.py (1199 lines)                  │
│                    ═══════════════════════════════                    │
│                                                                      │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐       │
│  │ 1. FILE     │───>│ 2. PROBE +   │───>│ 3. PARSE +        │       │
│  │    INPUT     │    │    EXTRACT    │    │    DETECT LANG    │       │
│  └─────────────┘    └──────────────┘    └───────────────────┘       │
│       │                   │                      │                   │
│       │ user types path   │ get_video_metadata() │ pysubs2.load()    │
│       │ or browses        │ scan_and_extract()   │ detect_language()  │
│       │                   │ → ffprobe + ffmpeg   │ → langdetect       │
│       │                   │                      │                   │
│       ▼                   ▼                      ▼                   │
│  session_state:      session_state:         session_state:           │
│   mkv_path           mkv_tracks[]           target_lang_code         │
│   mkv_path_input     mkv_duration           native_sub_path          │
│                      mkv_resolution         target_sub_path          │
│                      mkv_metadata           native_style_info        │
│                      mkv_audio_tracks       target_style_info        │
│                      temp_dir               native_style_mapping     │
│                                             target_style_mapping     │
│                                                                      │
│  ┌───────────────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │ 4. CONFIGURE      │───>│ 5. PREVIEW   │───>│ 6. GENERATE     │   │
│  │    STYLES          │    │              │    │    OUTPUT        │   │
│  └───────────────────┘    └──────────────┘    └─────────────────┘   │
│       │                        │                     │               │
│       │ get_lang_config()      │ get_lines_at_ts()   │ A: .ass      │
│       │ → romanize.py          │ → pysubs2.load() ×2 │ B: .sup/PGS  │
│       │ → styles.py            │ generate_preview()   │ C: MKV mux   │
│       │                        │ → base64 JPEG        │              │
│       │                        │ extract_screenshot()  │              │
│       ▼                        ▼                      ▼              │
│  session_state:           Every rerun:          generate_ass_file()  │
│   styles{} (large)         pysubs2.load() ×2    → pysubs2.load() ×2 │
│   4 layer configs          → full parse          → iterate events    │
│   pysubs2.Color objs       base64 encode JPEG   → .ass to tempfile  │
│   scalar controls          HTML string gen                           │
│                                                 generate_pgs_file()  │
│                                                 → pysubs2.load() ×2 │
│                                                 → build PGSFrameEvt │
│                                                 → Playwright render  │
│                                                 → .sup to tempfile   │
│                                                                      │
│                                                 merge_subs_to_mkv()  │
│                                                 → ffmpeg subprocess  │
└──────────────────────────────────────────────────────────────────────┘
```

### Stage-by-Stage Detail

#### Stage 1: File Input
- **Functions:** `render_mkv_path_input()`, `browse_callback()`
- **Data created:** A path string in `session_state.mkv_path`
- **Memory:** Negligible (~100 bytes)
- **Lifecycle:** Kept in session_state forever

#### Stage 2: Probe + Extract
- **Functions:** `get_video_metadata()` → `_probe()` → `ffmpeg.probe()`, then `scan_and_extract_tracks(probe_data=...)`
- **Data created:**
  - `probe_data` dict: full ffprobe JSON (~5-50KB depending on track count). Passed to `scan_and_extract`, then **falls out of scope** (not stored in session_state)
  - `mkv_tracks[]`: list of dicts with stream info, paths to extracted .srt/.ass files on disk
  - `mkv_metadata`: dict with duration, width, height, title, year
  - `mkv_audio_tracks[]`: list of audio stream dicts
  - Extracted subtitle files: written to `temp_dir` on disk (text files, KB-range)
- **Memory:** ~10-100KB in session_state for track metadata. Extracted files are on disk.
- **Lifecycle:** All stored in session_state permanently. `probe_data` is GC'd after scan (good).

#### Stage 3: Parse + Detect Language
- **Functions:** `detect_language()` → `pysubs2.load()` → `_sample_text()` → `_dominant_script()` + `langdetect.detect()`
- **Data created:**
  - Loads full subtitle file into a `pysubs2.SSAFile` object
  - Extracts a 50-line text sample (~2-5KB)
  - Returns a language code string
- **Memory:** The SSAFile is loaded and **immediately discarded** after sampling. Good.
- **Lifecycle:** Only the language code persists in session_state.

#### Stage 4: Configure Styles
- **Functions:** `get_lang_config()` → `get_romanizer()`, `get_annotation_func()`, `get_japanese_pipeline()`
- **Data created:**
  - `styles` dict: 4 layer configs (Bottom/Top/Romanized/Annotation) each with ~20 keys including `pysubs2.Color` objects, plus 3 scalar controls. ~5KB total.
  - `lang_config` dict: holds function references (romanizer, annotation_func, resolve_spans_func, etc.)
  - **Japanese pipeline:** Creates a single pykakasi instance shared between annotation and romaji. ~50-100MB memory for the pykakasi dictionary.
  - **Thai:** Loads pythainlp models on first call. ~20-50MB.
  - **Chinese:** Loads pypinyin data. ~10-30MB.
- **Memory:** Language model loading is the first major memory consumer. These models stay in module-level caches (not session_state) and persist for the Python process lifetime.
- **Lifecycle:** `styles` dict in session_state persists. `lang_config` is recreated every rerun (but the underlying NLP models are cached at module level via closures and `lru_cache`).

#### Stage 5: Preview (runs on every Streamlit rerun)
- **Functions:** `get_lines_at_timestamp()` → `_load_subs()` ×2, `extract_screenshot()`, `generate_unified_preview()`
- **Data created per rerun:**
  - **TWO full pysubs2.SSAFile parses** of both subtitle files (native + target) — `preview.py:_load_subs()`
  - Text sample extraction (searches by timestamp)
  - Screenshot JPEG: `extract_screenshot()` → ffmpeg → ~50-200KB JPEG on disk
  - **Base64-encoded JPEG** in preview HTML: duplicates the JPEG in memory as a base64 string (~130-270KB)
  - **Preview HTML string**: ~2-10KB of generated HTML
  - Annotation spans: list of (str, str|None) tuples
  - Romanized text: string
- **Memory:** The two SSAFile objects are the problem — they're loaded from disk on **every single rerun** (any widget interaction triggers this). A typical 1500-line ASS file is ~500KB-2MB in pysubs2's object model. Combined with style mapping iteration, preserved event collection, etc., this is **~2-4MB of parsing work on every click**.
- **Lifecycle:** All preview data is local variables — GC'd after the rerun. But they're recreated every time.

#### Stage 6a: Generate .ass
- **Functions:** `generate_ass_file()` → `_load_subs()` ×2, `_iter_dialogue_events()`, `get_lang_config()`, `_make_annotation_events()`
- **Data created:**
  - **Two more full pysubs2.SSAFile parses** (third time parsing the same files in a session)
  - New `pysubs2.SSAFile` with stitched events: all Bottom + Top + Romanized + Annotation events
  - For a 1500-line target file with annotations: ~6000-8000 ASS events created in memory
  - Output written to tempfile on disk
- **Memory:** Peak ~10-30MB for the stitched SSAFile with all events, plus the two source files. Released after generation.
- **Lifecycle:** The generated file path stored in `session_state.generated_ass_path`. SSAFile objects GC'd.

#### Stage 6b: Generate PGS (.sup)
- **Functions:** `generate_pgs_file()` → `_load_subs()` ×2, builds `PGSFrameEvent[]`, calls `rasterize_pgs_to_file()`
- **Data created:**
  - **Two more full pysubs2.SSAFile parses** (fourth time if both .ass and .sup generated)
  - `pgs_events[]`: list of PGSFrameEvent dataclasses. For 1500 target events: ~1500 objects, each with 5 string/None fields. ~1-3MB.
  - `_preserved_htmls[]`: list of (start_ms, end_ms, html_str) tuples
  - **Playwright browser**: ~300-500MB for Chromium process
  - **Per-frame**: full-frame PNG screenshot (~5-15MB at 1080p RGBA), then cropped + quantized
  - **Frame cache** (`frame_cache` dict): stores cropped PIL Images at render resolution. For 1500 events with ~800 unique frames: ~200-400MB of cached PIL images
  - **SupWriter**: streams to disk, releases images after writing (good)
- **Memory:** This is the big one. Peak memory during PGS generation:
  - Base Python + Streamlit: ~200-400MB
  - NLP models (pykakasi/pypinyin/pythainlp): ~50-100MB
  - Chromium: ~300-500MB
  - Frame cache: ~200-400MB (grows throughout generation, never cleared)
  - Per-batch PIL images: ~50-100MB (50 frames × 1-2MB each)
  - **Total: ~800-1500MB peak**
- **Lifecycle:** Chromium closes after generation. Frame cache released. Generated .sup path stored in session_state.

#### Stage 6c: MKV Remux
- **Functions:** `merge_subs_to_mkv()` → ffmpeg subprocess
- **Data:** Just command construction and subprocess execution. ~negligible Python memory.

### Dependency Graph

```
probe_data ────────> scan_and_extract ────> mkv_tracks[]
                                               │
                                               ├──> native_sub_path ──┐
                                               └──> target_sub_path ──┤
                                                                      │
detect_language(target_sub_path) ──> target_lang_code ──┐             │
                                                        │             │
get_lang_config(target_lang_code) ──> lang_config ──────┤             │
                                                        │             │
                                    styles{} ───────────┤             │
                                                        │             │
                              ┌─────────────────────────┤             │
                              │                         │             │
                    get_lines_at_timestamp() ◄──────────┴─────────────┤
                              │                                       │
                    generate_unified_preview()                        │
                                                                      │
                              ┌────────────────────────────────────────┤
                              │                                        │
                    generate_ass_file(native, target, styles, lang)    │
                    generate_pgs_file(native, target, styles, lang)    │
                              │                                        │
                    merge_subs_to_mkv(input, ass_path, sup_path)       │
```

**Key observation:** `native_sub_path` and `target_sub_path` are re-parsed from disk on every rerun (preview) and again for every generation call. The same data is read 4-6 times without caching.

---

## Part 2 — Memory Audit

### Memory Profile by Component

| Component | Estimated RSS | When Loaded | When Released |
|-----------|--------------|-------------|---------------|
| Python + Streamlit runtime | 150-200MB | App start | Never |
| pykakasi dictionary (Japanese) | 50-100MB | First `get_lang_config('ja')` | Never (module-level) |
| pypinyin data (Chinese) | 10-30MB | First `get_lang_config('zh')` | Never (module-level) |
| pythainlp models (Thai) | 20-50MB | First `get_lang_config('th')` | Never (module-level) |
| langdetect profiles | 5-10MB | First `detect_language()` | Never (module-level) |
| Subtitle files (pysubs2 parse) | 1-4MB each | Every rerun (preview) | After rerun (but re-created next rerun) |
| Preview JPEG (base64 in HTML) | 0.1-0.3MB | Every rerun | After rerun |
| Playwright Chromium process | 300-500MB | PGS generation start | PGS generation end |
| Frame cache (PIL images) | 200-400MB | During PGS rendering | After PGS generation |
| Session state (styles, tracks, paths) | ~0.1MB | After scan | Never |

### How We Get to 1372MB Before Rendering

The 1372MB RSS before PGS rendering starts is explained by:

1. **Python + Streamlit + imports**: ~200MB
2. **NLP model loading** (pykakasi or equivalent): ~50-100MB
3. **langdetect profiles**: ~10MB
4. **Previous rerun residue**: Python's memory allocator (`pymalloc`) doesn't always return freed memory to the OS. After many reruns, each parsing 2 SSAFiles + generating preview HTML + base64 encoding JPEGs, the RSS watermark climbs even though the objects are GC'd
5. **Module-level caches**: `lru_cache` on `_resolve_font_path`, `_load_measurement_font`, `get_japanese_pipeline` closures
6. **Streamlit's internal state**: widget state, component cache, websocket buffers (~100-200MB for a complex app)

**The missing ~500-700MB is likely Python heap fragmentation** from repeated allocation/deallocation cycles during many reruns. `pymalloc` allocates in 256KB arenas that are only released when completely empty — interleaved allocations from different reruns prevent arena reclamation.

### Specific Memory Issues

**1. Repeated pysubs2 parsing (HIGH impact)**
- `get_lines_at_timestamp()` in `preview.py` calls `_load_subs()` on both files **every rerun**
- `_detect_styles_if_ass()` in `loom_app.py` calls `detect_ass_styles()` which calls `_load_subs()`
- `generate_ass_file()` calls `_load_subs()` on both files
- `generate_pgs_file()` calls `_load_subs()` on both files
- The same 2 files are parsed from disk **3-4+ times per session**, with 2 parses on every click

**2. Frame cache never bounded (MEDIUM impact)**
- In `rasterize_pgs_to_file()`, `frame_cache` dict accumulates cropped PIL images for the entire render
- For a file with 800 unique frames at 1080p, each cropped image is ~200-500KB → **200-400MB total**
- The cache is useful (dedup saves ~30-50% of renders) but unbounded
- It's released after generation completes, but during rendering it's a major consumer

**3. Base64 JPEG duplication (LOW impact)**
- `generate_unified_preview()` reads the screenshot JPEG, base64-encodes it, embeds it in an HTML string
- This creates 3 representations: file on disk, raw bytes, base64 string (~1.33× the file size)
- ~0.5MB per rerun — low absolute impact but wasteful

**4. `get_lang_config()` called redundantly**
- Called once in `loom_app.py` for UI setup
- Called again in `generate_ass_file()`
- Called again in `generate_pgs_file()`
- Each call to `get_lang_config('ja')` triggers `get_japanese_pipeline()` which creates closures. The pykakasi instance is cached, but the closure objects and pipeline setup are recreated.

**5. Dead `memory_manager.py`**
- 16KB file (`app/memory_manager.py`) exists but is never imported anywhere in the codebase
- Contains `PlaywrightMemoryManager` with 6 recycling strategies — all unused since `rasterize.py` was rewritten to use single-page batched rendering

---

## Part 3 — Top Optimization Opportunities

### Ranked by Bang-for-Buck (Impact × 1/Effort)

#### 1. Cache parsed subtitle files in session_state
- **What:** `pysubs2.load()` is called on the same 2 files repeatedly — on every rerun (preview), on style detection, and on each generation call
- **Problem:** Each parse reads from disk, tokenizes, builds SSAEvent objects. For a 1500-line ASS file this is ~50-100ms and ~1-2MB of allocations that contribute to heap fragmentation
- **Fix:** After selecting subtitle sources, parse once and store the `SSAFile` objects in `session_state`. All downstream consumers read from the cached objects. Invalidate on path change.
- **Effort:** Small — add a `_get_cached_subs(path)` helper
- **Impact:** HIGH — eliminates 2 disk reads + full parses per rerun, ~3-6 parses per generation
- **Risk:** Low — SSAFile objects are not mutated by preview/generation code (they use `.copy()` for events)

#### 2. Eliminate dead `memory_manager.py`
- **What:** 16KB file with `PlaywrightMemoryManager` class — never imported
- **Problem:** Dead code, confusing to maintainers
- **Fix:** Delete the file
- **Effort:** Trivial
- **Impact:** Low (code hygiene only)
- **Risk:** None

#### 3. Delete dead `detect_language_from_file()` in language.py
- **What:** Lines 379-415 — legacy function for Streamlit uploaded file objects, unused since the MKV workflow replaced direct uploads
- **Problem:** Dead code, already noted in CLAUDE.md
- **Fix:** Delete the function
- **Effort:** Trivial
- **Impact:** Low (code hygiene)
- **Risk:** None

#### 4. Bound the frame cache in PGS rasterizer
- **What:** `frame_cache` in `rasterize_pgs_to_file()` grows unbounded during rendering
- **Problem:** For files with many unique frames (800+), the cache holds ~200-400MB of PIL images. This is on top of Chromium's ~400MB.
- **Fix:** Implement an LRU eviction policy. Keep the most recent N entries (e.g., 200). Subtitle content is temporally clustered — a frame that appeared 500 frames ago is unlikely to recur. Alternatively, store cached images as compressed PNG bytes instead of PIL Image objects (~4-10× compression).
- **Effort:** Medium
- **Impact:** HIGH — could reduce peak PGS rendering memory by 200-300MB
- **Risk:** Low-medium — cache miss rate may increase slightly, adding ~5-10% render time

#### 5. Avoid re-calling `get_lang_config()` in generation functions
- **What:** `loom_app.py` calls `get_lang_config()` to set up UI, then `generate_ass_file()` and `generate_pgs_file()` each call it again
- **Problem:** Redundant work. For Japanese, each call creates new closure objects (though the underlying pykakasi instance is cached). More importantly, it's a confusing API — the caller has the config but the callee re-derives it.
- **Fix:** Pass `lang_config` dict to `generate_ass_file()` and `generate_pgs_file()` instead of `target_lang_code`. The generation functions already extract everything they need from it.
- **Effort:** Small-medium (API change, update all call sites)
- **Impact:** MEDIUM — cleaner API, eliminates redundant work, prevents potential config divergence
- **Risk:** Low — straightforward refactor

#### 6. Deduplicate `_load_subs()` and `_clean_text()` across modules
- **What:** `_load_subs()` is defined identically in both `processing.py` and `preview.py`. `_clean_text()` is in `preview.py`, `_ass_bgr_to_css()` exists in both `processing.py` and `preview.py`, `_get_playres()` exists in both as `_get_source_playres()` and `_get_playres()`.
- **Problem:** Code duplication — bugs fixed in one copy may not be fixed in the other
- **Fix:** Move shared utilities to a common module (e.g., `app/utils.py` or `app/ass_utils.py`)
- **Effort:** Small
- **Impact:** MEDIUM (code quality, reduces bug surface)
- **Risk:** Low

#### 7. Avoid base64-encoding screenshots for preview
- **What:** `generate_unified_preview()` reads the screenshot JPEG from disk, base64-encodes it, and embeds it in an HTML `<img src="data:...">`
- **Problem:** Base64 encoding inflates the data by ~33% and requires reading the file into Python memory. The HTML string with the embedded image is ~200-400KB.
- **Fix:** Use Streamlit's `st.image()` or serve the file via a local URL instead of data URI. Alternatively, keep the data URI but read the file only when the screenshot changes (currently it's re-read every rerun because `generate_unified_preview` is called every time).
- **Effort:** Medium
- **Impact:** LOW-MEDIUM — reduces per-rerun memory churn by ~0.5MB
- **Risk:** Low

#### 8. Move NLP model loading to background / lazy initialization
- **What:** `get_lang_config()` triggers synchronous loading of NLP models (pykakasi, pypinyin, pythainlp) on first call
- **Problem:** First load of Japanese config takes 2-5 seconds, blocks the UI thread
- **Fix:** Pre-load models in a background thread after language detection, before the user reaches the style configuration UI
- **Effort:** Medium
- **Impact:** MEDIUM (perceived performance — faster style section rendering)
- **Risk:** Low — models are thread-safe after initialization

#### 9. Reduce Streamlit rerun overhead with `st.fragment` or callbacks
- **What:** Any widget interaction triggers a full rerun of the entire `loom_app.py` (1199 lines of top-level code)
- **Problem:** Every slider drag, checkbox toggle, or color picker change re-executes the entire script. This includes re-parsing subtitles for preview, re-computing annotation spans, re-generating HTML, etc.
- **Fix:** Use `@st.fragment` (Streamlit 1.33+) to isolate the preview section and style editors. Only the fragment re-runs on widget changes within it, avoiding the full script re-execution.
- **Effort:** Medium-large (requires restructuring the linear script into fragments)
- **Impact:** HIGH — dramatic perceived performance improvement. Style changes would update in ~100ms instead of ~500-1000ms.
- **Risk:** Medium — requires Streamlit ≥1.33, needs careful state management across fragments

#### 10. O(n) temporal pairing in PGS generation
- **What:** `generate_pgs_file()` pairs each target event with native events by iterating the full `native_events[]` list to find maximum overlap
- **Problem:** O(n×m) complexity where n=target events, m=native events. For 1500×1500 events, this is 2.25 million overlap calculations.
- **Fix:** Sort native events by start time, use binary search to find candidates within the time window. Or build an interval tree.
- **Effort:** Small-medium
- **Impact:** MEDIUM — reduces pairing time from ~seconds to ~milliseconds for large files
- **Risk:** Low

#### 11. Store frame cache as compressed bytes instead of PIL Images
- **What:** `frame_cache` stores cropped PIL Image objects
- **Problem:** An RGBA PIL Image at e.g., 600×80 pixels = 192KB uncompressed. The same data as PNG is ~5-20KB.
- **Fix:** Store `(png_bytes, x, y, width, height)` in the cache. Decompress on cache hit. PNG decompression is ~1ms — negligible vs the ~100ms render time saved by a cache hit.
- **Effort:** Small
- **Impact:** MEDIUM — reduces frame cache memory by ~5-10×
- **Risk:** Low

#### 12. `_dominant_script()` uses `unicodedata.name()` per character
- **What:** `language.py:_dominant_script()` calls `unicodedata.name(char, "")` for every non-space character, then does string containment checks ("CJK" in name, "HANGUL" in name, etc.)
- **Problem:** `unicodedata.name()` returns the full Unicode character name (e.g., "CJK UNIFIED IDEOGRAPH-4E00") — this is a relatively expensive string lookup + allocation per character.
- **Fix:** Use Unicode category and code point ranges directly (e.g., `0x4E00 <= ord(c) <= 0x9FFF` for CJK). This is ~10× faster.
- **Effort:** Small
- **Impact:** LOW — only affects language detection (~50ms savings). But it's called on every rerun if detection is retriggered.
- **Risk:** Low

#### 13. `loom_app.py` is a 1200-line monolith
- **What:** The entire application logic — UI, state management, style editing, preview, generation dispatch, remux — lives in one flat script
- **Problem:** Hard to maintain, test, or refactor. Every function defined at module level is re-evaluated on every Streamlit rerun. The file has 151 references to `st.session_state`.
- **Fix:** Extract into logical sections: `app/ui_styles.py` (style expanders), `app/ui_generate.py` (generation buttons), `app/ui_preview.py` (preview section). Each becomes a function called from the main script.
- **Effort:** Large
- **Impact:** MEDIUM (maintainability, testability)
- **Risk:** Medium — Streamlit's top-to-bottom execution model makes refactoring tricky

#### 14. Preserved event HTML is computed per-frame in PGS generation
- **What:** `generate_pgs_file()` assigns preserved HTML to each PGS frame event by iterating all preserved events
- **Problem:** O(p×f) where p=preserved events, f=PGS frame events. This nested loop is inefficient for files with many preserved events (karaoke tracks with 200+ events).
- **Fix:** Sort preserved events by time and use a sweep-line algorithm
- **Effort:** Small-medium
- **Impact:** LOW — only matters for files with many preserved events
- **Risk:** Low

#### 15. `_EXCLUDE_PATTERNS` regex is a no-op
- **What:** `_EXCLUDE_PATTERNS = re.compile(r'(?!)', re.IGNORECASE)` — a negative lookahead that never matches
- **Problem:** The regex is compiled and tested against every style name for no effect. Confusing to read.
- **Fix:** Replace with `None` and guard with `if _EXCLUDE_PATTERNS and _EXCLUDE_PATTERNS.search(...)`, or remove the pattern check entirely since no styles default to exclude.
- **Effort:** Trivial
- **Impact:** Negligible (code clarity)
- **Risk:** None

#### 16. PGS rasterizer duplicates CSS building logic from preview.py
- **What:** `rasterize.py:_build_text_shadow_css()`, `_color_css()`, `_build_fullframe_html()` duplicate the CSS generation logic from `preview.py:generate_unified_preview()`
- **Problem:** Two independent implementations of the same visual styling. If a style feature is added/changed, both must be updated.
- **Fix:** Extract shared CSS builders into a `app/css_utils.py` module used by both preview and rasterizer
- **Effort:** Medium
- **Impact:** MEDIUM (maintenance, consistency)
- **Risk:** Low-medium — must ensure preview scaling (`_FONT_SCALE`) vs rasterizer scaling (`scale`) are handled correctly

#### 17. The debug diagnostic probe is always rendered
- **What:** Lines 824-861 of `loom_app.py` — a "Pipeline Inspection" expander with debug info
- **Problem:** Even collapsed, this expander executes its body on every rerun (checking file existence, reading file headers, calling `get_hiragana()`, etc.)
- **Fix:** Gate behind an environment variable or `st.secrets` flag, or use `@st.fragment` to isolate it
- **Effort:** Trivial
- **Impact:** LOW — minor per-rerun savings
- **Risk:** None

#### 18. `_refine_cjk_detection()` duplicates character counting from `_dominant_script()`
- **What:** Both functions iterate the entire text sample counting Unicode character categories
- **Problem:** When `_dominant_script()` returns "CJK", `_refine_cjk_detection()` re-iterates the same text counting kana/hangul proportions — work already partially done by `_dominant_script()`
- **Fix:** Have `_dominant_script()` return the full count breakdown, pass it to `_refine_cjk_detection()`
- **Effort:** Small
- **Impact:** LOW
- **Risk:** Low

---

## Part 4 — Technical Debt and Fragility

### Shared Mutable State

**1. `st.session_state.styles` is mutated in-place by widget callbacks**
- The style expander loop (`for track_name in track_names`) directly mutates `config["fontname"]`, `config["bold"]`, etc. — where `config` is a reference into `session_state.styles[track_name]`
- This works but is fragile: any downstream code that reads `styles` during the same rerun sees partially-updated state (widgets above the current one have new values, widgets below still have old values)
- The guard chain (lines 539-590) that migrates old session formats is growing complex and order-dependent

**2. `pysubs2.Color` objects in session_state are mutable**
- `pysubs2.Color` is a `namedtuple` — actually immutable. This is fine.

### Implicit Dependencies Between Modules

**3. `processing.py` imports from `styles.py` which imports from `romanize.py`**
- But `loom_app.py` also imports directly from all three
- `processing.py` calls `get_lang_config()` internally, creating a hidden dependency on the same NLP model state that `loom_app.py` already initialized
- If `get_lang_config()` behavior changes (e.g., caching semantics), both callers are affected

**4. `_PLAY_RES_X/Y` in processing.py must match `_REF_H` in preview.py**
- This is documented but enforced only by convention. A change in one breaks the other silently (WYSIWYG preview drift).

**5. `_FONT_SCALE = 600 / 1080` in preview.py is coupled to the iframe height of 600px**
- If the iframe height changes (e.g., for responsive layout), the scale breaks

### Race Conditions in Async Code

**6. `rasterize_pgs_frames()` uses `asyncio.gather()` with 4 parallel pages sharing a mutable `frame_cache` dict and `results` list**
- The `frame_cache` is a plain Python dict accessed from multiple concurrent coroutines
- In CPython with the GIL, dict operations are atomic, so this **works by accident** — but:
  - A cache miss could trigger two concurrent renders of the same content (TOCTOU race on `if content_key in frame_cache`)
  - If Python ever removes the GIL (free-threading), this breaks
  - The 4-page parallel path (`rasterize_pgs_frames`) is used by tests; the production path (`rasterize_pgs_to_file`) uses a single page and is safe

**7. `rasterize_pgs_to_file()` spawns a background thread for the asyncio event loop**
- The thread communicates results via a closure over `exc_holder`, `frame_cache`, `progress_counter` — all shared mutable state
- The `progress_callback` is called from the background thread but invokes Streamlit's `st.progress()` — Streamlit is not thread-safe for widget updates
- This **works in practice** because Streamlit's progress bar update goes through a session-scoped queue, but it's technically a race condition

### Assumptions That Could Break

**8. ffmpeg/ffprobe assumed to be in PATH**
- `subprocess.run(["ffmpeg", ...])` and `ffmpeg.probe()` both assume the binaries are on PATH
- No version checking — different ffmpeg versions handle edge cases differently (e.g., `max_interleave_delta` behavior)

**9. Chromium rendering assumed deterministic**
- The PGS rasterizer assumes that Playwright's Chromium renders fonts identically across platforms
- CJK font rendering varies between Linux (fontconfig/FreeType) and macOS (CoreText) — `Noto Sans CJK JP` may render with different metrics

**10. `_quantize_image()` assumes PIL's quantize produces ≤255 colors**
- `img.quantize(colors=255)` should respect this, but PIL's quantize with method=2 (median cut) can sometimes produce fewer colors than requested, or the palette may have unexpected entries
- The code correctly handles this with index shifting, but there's no validation that `q_data[i] + 1` stays ≤255

**11. PGS segment payload size assumption**
- `_MAX_SEG_PAYLOAD = 65535` is correct per spec, but the ODS fragmentation code doesn't handle the case where a single continuation fragment exceeds 65535 bytes (theoretically possible with very large RLE data)
- In practice, subtitle bitmaps are small enough that this doesn't occur

**12. `output_path` forced to `.mkv` by convention, not validation**
- `merge_subs_to_mkv()` doesn't validate that `output_path` ends in `.mkv` — the UI enforces this, but API callers could pass `.mp4`, which would silently produce a broken file (MP4 doesn't support PGS)

### Error Handling Gaps

**13. `generate_ass_file()` and `generate_pgs_file()` catch all exceptions and show `st.error()`**
- The broad `except Exception as e` swallows all errors including programming bugs
- Stack traces are lost — only the exception message is shown
- The functions return `None` on error, which the caller handles, but debugging is difficult

**14. `_probe()` and `scan_and_extract_tracks()` use `print()` for error reporting**
- These functions use `print()` instead of `logging` or `st.error()` — output goes to the terminal, invisible in the Streamlit UI

**15. No timeout on ffmpeg subprocess calls**
- `scan_and_extract_tracks()` and `merge_subs_to_mkv()` call `subprocess.run()` without a timeout
- A malformed file could cause ffmpeg to hang indefinitely

**16. `tempfile.NamedTemporaryFile(delete=False)` creates files that may never be cleaned up**
- `generate_ass_file()` and `generate_pgs_file()` create tempfiles with `delete=False`
- If the user generates multiple times, old tempfiles accumulate
- The `atexit` handler cleans up `temp_dir` but generated files outside that dir persist

---

## Prioritized Roadmap

### Immediate Wins (Small effort, High impact)

| # | Change | Effort | Impact | Risk |
|---|--------|--------|--------|------|
| 1 | **Cache parsed SSAFile objects in session_state** | S | HIGH | Low |
| 2 | **Delete `memory_manager.py`** (dead code) | Trivial | Low | None |
| 3 | **Delete `detect_language_from_file()`** (dead code) | Trivial | Low | None |
| 5 | **Pass `lang_config` to generation functions** instead of re-deriving | S | MED | Low |
| 6 | **Extract shared `_load_subs`, `_ass_bgr_to_css`, `_get_playres`** to common module | S | MED | Low |
| 12 | **Use code point ranges** in `_dominant_script()` instead of `unicodedata.name()` | S | LOW | Low |
| 15 | **Remove no-op `_EXCLUDE_PATTERNS`** | Trivial | Neg | None |
| 17 | **Gate debug diagnostic probe** behind env var | Trivial | LOW | None |

### Medium-Term Improvements (Medium effort, Medium-High impact)

| # | Change | Effort | Impact | Risk |
|---|--------|--------|--------|------|
| 4 | **Bound frame cache** in PGS rasterizer (LRU or compressed storage) | M | HIGH | Low-Med |
| 11 | **Store frame cache as PNG bytes** instead of PIL Images | S-M | MED | Low |
| 9 | **Use `@st.fragment`** for preview + style editing sections | M-L | HIGH | Med |
| 10 | **Binary search for temporal pairing** in PGS generation | S-M | MED | Low |
| 8 | **Background-load NLP models** after language detection | M | MED | Low |
| 16 | **Extract shared CSS builders** into common module | M | MED | Low-Med |

### Longer-Term Refactors (Large effort, structural improvements)

| # | Change | Effort | Impact | Risk |
|---|--------|--------|--------|------|
| 13 | **Break up `loom_app.py`** into logical sections | L | MED | Med |
| — | **Add structured error handling** — replace bare `except Exception` with typed catches + logging | M-L | MED | Low |
| — | **Add timeouts to all `subprocess.run()` calls** | S | LOW | Low |
| — | **Consolidate `print()` calls to `logging`** across mkv_handler, language, etc. | S-M | LOW | Low |
| — | **Fix thread-safety** of progress callbacks during PGS rendering (use Streamlit's thread-safe API) | M | LOW | Med |
| — | **Validate output container format** in `merge_subs_to_mkv()` | S | LOW | Low |

### Recommended First Sprint

If I were choosing 5 changes to do first, maximizing impact with minimal risk:

1. **Cache parsed SSAFile objects** (#1) — biggest single win
2. **Pass `lang_config` to generation functions** (#5) — clean API, prevent redundant work
3. **Bound + compress frame cache** (#4 + #11) — reduce peak PGS memory by 200-400MB
4. **Extract shared utilities** (#6) — reduce bug surface from duplicated code
5. **Delete dead code** (#2, #3, #15) — zero risk, cleaner codebase
