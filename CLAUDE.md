# SRTStitcher — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session alongside the rest of CLAUDE.md.

**Current state (2026-02-18):** Romanization architecture Chunks R1–R3 complete. End-to-end pipeline working: MKV scan → track extraction → language detection → style configuration → composite preview → generate `.ass` → remux into MKV. Three-layer output (Bottom / Top / Romanized) generates correctly. Chinese pinyin (R2) and Japanese Hepburn romaji (R3) both produce Romanized events in the generated .ass. Pre-existing furigana detection heuristic and hiragana-readings debug probe are also in place.

**Active focus:** Romanization architecture. Choose next from:
- **R3b** — character-aligned furigana `\pos()` stacking (requires `processing.py` to emit N events per line; complex)
- **R4** — Korean / Russian / Thai romanization (R4 is a good next chunk: simpler than R3b, continues the pattern)
- **R6** — Color picker UI per track (most visible missing UI feature; independent of romanization work)

**Known broken:**
- No color pickers — text colors are hardcoded defaults with no UI to change them
- Furigana (4th layer, character-aligned) not implemented — R3 adds flat Hepburn romaji only; `get_hiragana()` exposes the data path; `detect_preexisting_furigana()` is ready; actual `\pos()` stacking deferred to R3b
- Simple Upload (legacy) mode is a non-functional stub

---

## What This Project Is
A subtitle merging and language-learning tool. The core idea: take two subtitle files (e.g. English + Simplified Chinese), stitch them into a single `.ass` file that displays both tracks simultaneously, with phonetic annotations (pinyin, furigana, romaji) rendered above each corresponding character — similar to how Duolingo displays pinyin above hanzi.

Ultimate goal: browser extension that works on YouTube, Netflix, HBO, etc.
Current focus: local desktop tool (Streamlit-based Python app).

---

## Tech Stack
- **Language:** Python
- **UI:** Streamlit (`srt_stitcher_app.py`)
- **Video processing:** ffmpeg / ffmpeg-python
- **Subtitle formats:** Any text-based subtitle format — common extensions include `.srt`, `.ass`, `.ssa`, `.vtt`, `.sub`, `.sbv`, `.idx`, `.ttml`, `.dfxp`, `.stl`, `.smi`, but libraries may produce non-standard or unusual extensions; treat format detection by content/MIME type, not extension alone
- **AI/LLM:** Gemini CLI (previous), now transitioning to Claude Code

---

## Project Structure (known so far)
```
srt_stitcher_app.py        # Main Streamlit entry point
app/
  mkv_handler.py           # MKV scan/extract/screenshot/mux logic
  state.py                 # Streamlit session state vars
  ui.py                    # UI rendering helpers
  language.py              # Language detection logic
requirements.txt
CLAUDE.md                  # This file
```

---

## Development Roadmap

### ✅ Step 1 — English + Mandarin (complete, currently broken)
- Drag-and-drop two .srt/.ass files
- Name/label output for VLC / Put.io compatibility
- Stitch into .ass with English on bottom, Chinese on top
- Generate pinyin per hanzi, displayed above each character
- Full style customization: font, size, color, shadow/outline/glow, window opacity

> **Status note:** Step 1 was working but is currently broken — development jumped to Step 3 (MKV support) before completing Step 2 (language expansion). This was intentional: Step 3 unblocks a more practical workflow (rip sub tracks from MKV → stitch → remux back into MKV) and was prioritized over broadening language support. Step 1 will be stabilized as part of getting the Step 3 pipeline working end-to-end.

### 🔄 Step 2 — Expand language support

**Core principle: Language support must be generalizable, not hardcoded.** The system should intelligently detect and handle *any* language a user throws at it — not just a curated list. If someone wants to use Thai, Tagalog, Indonesian, Cherokee, Amharic, or any other language as their native/primary track, it should just work. Do not hardcode a language enum or whitelist.

**Priority languages** (these are the ones we most want to validate work well, in addition to the already-implemented Chinese Simplified/Pinyin):
- Japanese (hiragana above kanji, romaji above kana)
- Korean (Hangul)
- Hindi (Devanagari)
- Arabic, Persian, Urdu, Thai, Georgian, Armenian, Russian

**Design requirements:**
- Language detection (`app/language.py`) must use a robust, general-purpose detection library (e.g., `langdetect`, `fasttext`, `lingua`) that covers hundreds of languages — not a manual mapping
- Phonetic annotation (pinyin, furigana, romaji, etc.) is a *per-script* feature that layers on top of language detection. Not every language has or needs a phonetic layer. The system should gracefully handle languages with no phonetic annotation by simply displaying the text as-is.
- Roman-script languages (French, Spanish, German, Portuguese, etc.) need no phonetic layer — just display the subtitle text directly
- The phonetic annotation system should be extensible: adding support for a new script's phonetic system (e.g., Thai romanization) should mean adding a new annotation module, not rewriting detection or stitching logic

### 🔄 Step 3 — MKV container support (IN PROGRESS — being done before Step 2)

#### The Workflow Vision
The intended pipeline: rip subtitle tracks from MKV → stitch them together → remux the stitched result back into the MKV. This is why Step 3 was prioritized over Step 2 — it's a more practical end-to-end workflow than requiring users to manually source separate subtitle files.

#### The Problem
We need to process massive video files (e.g., 64GB 4K movies). The previous approach using `st.file_uploader` failed catastrophically — Streamlit tries to load the entire file into RAM (crashing the app) or requires a full upload to the server (impractical for 64GB files). Neither is acceptable.

#### The Architecture Pivot: "Logic First, Delivery Second"
We adopted a deliberate two-phase strategy:

**Phase A (NOW — Step 3): Local File Path model.** The user pastes an absolute path string (e.g., `D:\Movies\Ghost_in_the_Shell.mkv`). Python's `subprocess` + `ffmpeg` operates on the file directly on disk — zero RAM spikes, zero upload time. This is explicitly a **prototype interface** that only works on localhost. We know this. It is intentional.

**Phase B (FUTURE — dedicated step): Client-side WebAssembly.** For public web deployment, we will use `ffmpeg.wasm` — the user's browser downloads a ~25MB miniature FFmpeg, processes the MKV client-side, extracts only the tiny `.srt`/`.ass` text tracks, and sends those to the Python backend. This is the only architecture that supports "Web App + Huge File + No Upload." But implementing WASM inside Streamlit requires custom JavaScript/React components and is complex — doing it now would derail the core stitching work.

**Why this ordering matters:** The Local Path input *simulates exactly* how the WASM input will behave later (instant file access, no upload wait). The code is written modularly so that when we're ready for web deployment, we swap `mkv_handler.py` (local ffmpeg) with a new frontend component (ffmpeg.wasm). The rest of the app — stitching logic, preview UI, language detection, style system — remains untouched.

#### Step 3 Feature Requirements
- User pastes absolute path to .mkv
- App probes with ffmpeg, extracts text-based subtitle tracks (any text codec — srt, ass, ssa, webvtt, ttml, etc.; filter by codec type, not file extension) to temp dir
- Language detection runs on extracted files to label each track (e.g., "Track 1: Japanese", "Track 2: English")
- Hybrid selector: dropdown lists MKV tracks + "📂 Upload Custom File" option (preserving old upload functionality)
- **Critical design rule:** The hybrid selector must *always return a file path string* — if the user uploads a file, save it to temp and return that path. This standardizes the input for all downstream processing logic.
- Screenshot extraction at arbitrary timestamp for subtitle preview UI
- Mux new .ass into MKV as default subtitle track (no video/audio re-encode)

#### Key files for Step 3
- `app/mkv_handler.py` — three core functions:
  - `scan_and_extract_tracks(mkv_path, temp_dir)` — probe MKV, identify subtitle streams, filter for text codecs (by codec type, not extension), extract to temp_dir, run language detection, return list of dicts: `{'id': index, 'label': "Track X - [Lang]", 'path': temp_file_path, 'source': 'mkv'}`
  - `extract_screenshot(mkv_path, timestamp_seconds)` — extract high-quality JPG at given second, return path
  - `merge_subs_to_mkv(input_mkv_path, new_sub_path, output_mkv_path)` — mux subtitle as default track without re-encoding
- `app/state.py` — add `mkv_path` (string), `mkv_tracks` (list), `temp_dir` (string)
- `app/ui.py` — two new functions:
  - `render_mkv_path_input()` — text input + "Load & Scan" button, validates with `os.path.exists`
  - `render_hybrid_selector(label, options, key)` — selectbox with MKV tracks + upload option, always returns a file path string
- `srt_stitcher_app.py` — Mode toggle: Simple Upload vs MKV Workflow; MKV mode populates state via `mkv_handler`, passes resolved file paths to existing `process_subtitles`

#### Step 3 Current Bugs & Issues (as of 2026-02-18)

**✅ WORKING:**
- Track numbering and language naming — subtitle-relative numbering (Subtitle 1, 2, 3...) with full language names via `langcodes` + `language_data`.
- Bold, italic, size controls — functional
- Outline and shadow — functional (trailing comma CSS bug in text-shadow was fixed)
- Timestamp slider — reads actual video duration via `get_duration()`, used as slider max. Default position is `min(300, duration)`.
- UI flow — merged into single "3. Style & Preview" section.
- Frame preview + subtitle overlay — two-div CSS layout with dynamic aspect ratio. Full `<!DOCTYPE html>` document with `100vh` + `min()` scaling. Both English (bottom) and Japanese (top) tracks render correctly on the video frame.
- `extract_screenshot()` — errors surface properly. `screenshot_path` initialized in `state.py`.
- Dynamic aspect ratio — `get_video_metadata()` reads width/height from ffprobe, stored as tuple, used for CSS `aspect-ratio`.
- Timestamp-synced subtitle preview — `get_lines_at_timestamp()` in `preview.py` parses subtitle files via `pysubs2`, looks up entries at the slider timestamp. Gaps in dialogue show no text (correct behavior). `_clean_text()` strips ASS override tags.
- Auto-updating frame — frame re-extracts on every slider change (no "Grab Frame" button needed). First frame auto-extracts at default slider position on load.
- Debug probe — PIPELINE INSPECTION block wrapped in collapsed `st.expander`. NameError risk fixed with default variable initialization.
- .ass output verified — both tracks present, timestamps preserved accurately, correct alignment tags (Bottom=\an2, Top=\an8), separate named styles.
- Karaoke layer filtering — `_iter_dialogue_events()` in `processing.py` filters out vector drawings, karaoke syllable highlights, glow/shadow compositing layers. Keeps only highest-numbered layer (main dialogue by ASS convention). AoT English track went from 1262 events to 266.
- Event mutation fixed — native track events copied before style assignment, no longer mutated in-place.
- Temp dir leak fixed — removed orphaned `mkdtemp()` from `state.py`.
- ASS format preservation — tracks extracted with correct extension based on codec (ASS→.ass, SRT→.srt). CODEC_EXT mapping in `mkv_handler.py`.

**🐛 Color options — missing:**
- No color picker in UI. Should be a color wheel for each track. Currently Japanese text is yellow and cannot be changed.

**🐛 Font selection — needs validation:**
- Font dropdown shows same hardcoded 9-font list for every track regardless of language/script. Filter by script compatibility.

**🐛 Furigana layer — flat romaji only (R3b deferred):**
- The Romanized layer emits flat Hepburn romaji for Japanese (token-aligned). `get_hiragana()` and `detect_preexisting_furigana()` are ready in `app/romanize.py`. Character-aligned `\pos()` stacking is R3b.

**✅ LANG_CONFIG replaced (R1 complete):**
- `styles.py` LANG_CONFIG dict removed. `get_lang_config(lang_code)` factory returns full config for any BCP 47 code. Chinese and Japanese both have `romanize_func` set.

### 🔲 Step 4 — LLM-assisted reverse translation
- Input: English subs with timestamps
- Output: Generated original-language subs (context-aware, timestamp-aligned)
- Use Gemini or Claude with media context for coherent reverse translation

### 🔲 Step 5 — Audio transcription → subtitles
- Use Gemini/Whisper to transcribe audio
- Generate original-language subs from audio, timestamp-matched to perceived speech
- Context-aware (understands the show/film)

### 🔲 Step 6 — Browser extension
- Target: YouTube first, then Netflix/HBO
- Real-time subtitle overlay injection

### 🔲 Step 7 — Livestream support
- Twitch, YouTube Live, Rumble, Kick

---

## Romanization Architecture (designed 2026-02-18, not yet implemented)

### Architectural Decisions (confirmed by Opus consultation)

**Decision 1: Japanese library → `pykakasi` (pure Python).**
The accuracy gap vs MeCab/cutlet is minor for anime subtitle vocabulary (common words, standard grammar). MeCab's system binary dependency (apt install on Linux, manual install on Windows) is a real deployment blocker for a desktop app and a hard blocker for the eventual browser extension. If users hit accuracy issues with specific content, MeCab can be added later as an optional "advanced mode" behind a feature flag. No pure-Python alternative matches MeCab quality; pykakasi is the best option without system dependencies.

**Decision 2: Chinese = character-aligned, Japanese = token-aligned.**
Chinese pinyin maps 1:1 to hanzi — `pypinyin` returns per-character data, so each hanzi gets its own pinyin positioned directly above it using `\pos()` tags in the .ass file. Japanese furigana is token-aligned: `pykakasi` tokenizes at the word/morpheme level, and the hiragana reading spans the full compound (e.g., 東京 → とうきょう as one span, not と above 東 + きょう above 京). This is correct and expected — it matches how ruby text works in HTML, manga, and standard Japanese typography. The ASS rendering uses manual `\pos()` stacking: a separate dialogue line with smaller font positioned above the kanji compound. There is no standard `\ruby` tag in mainstream ASS renderers (libass, VSFilter).

**Decision 3: RTL scripts (Arabic/Persian/Urdu) → opt-in/experimental romanization.**
These are abjad scripts — short vowels are omitted from written text, making romanization inherently ambiguous. For a language-learning tool, wrong phonetics can actively harm pronunciation acquisition. Romanization for these scripts is off by default, with a toggle: "Show romanization (experimental — short vowels may be inaccurate)." Other languages with high-confidence romanization have it on by default.

**Decision 4: Stateful romanizers via closure pattern.**
`get_romanizer()` is called once per track, returns a closure or bound method that captures an already-initialized tokenizer instance. The closure is called per subtitle line during processing. Do not reinstantiate the tokenizer per line — pykakasi initialization is lightweight but this pattern also supports heavier tokenizers (MeCab) if added later.

### New module: `app/romanize.py`

```python
def get_romanizer(lang_code: str) -> callable | None:
    """
    Returns a function (str) -> str for phonetic romanization.
    Returns None for Roman-script languages or unsupported scripts.
    """
```

Downstream code calls `get_romanizer("ja")` and gets a callable — never needs to know which library is behind it. Adding a new script = adding one branch in `romanize.py`, nothing else.

### `styles.py` refactor: `get_lang_config()` factory

Replace the stub `LANG_CONFIG` dict with:

```python
def get_lang_config(lang_code: str) -> dict:
    romanizer = get_romanizer(lang_code)
    return {
        "romanize_func": romanizer,
        "has_phonetic_layer": romanizer is not None,
        "default_font": _font_for_script(lang_code),
        "rtl": lang_code in ("ar", "fa", "ur", "he"),
        "romanization_confidence": _confidence_for_lang(lang_code),
    }
```

This means the config is never incomplete — adding Thai support to `romanize.py` automatically gives Thai a phonetic layer everywhere in the app.

### Romanization Confidence Score

A static per-language/script property displayed as a red-green color scale in the UI, so users can gauge how reliable the phonetic annotations will be:

| Confidence | Color | Languages | Reason |
|-----------|-------|-----------|--------|
| **Very High** | 🟢 Dark green | Chinese/Pinyin | 1:1 character mapping, standardized phonetic system |
| **High** | 🟢 Green | Korean (Revised Romanization), Russian/Cyrillic | Rule-based transliteration, well-defined standards |
| **Good** | 🟡 Yellow-green | Japanese romaji (pykakasi), Thai (Royal Institute) | Good for common vocabulary, occasional context-dependent errors |
| **Moderate** | 🟡 Yellow | Hindi/Indic scripts | Reliable transliteration but multiple valid romanization schemes |
| **Low** | 🟠 Orange-red | Arabic, Persian, Urdu | Abjad scripts — missing short vowels, inherently ambiguous |
| **None** | ⚪ Grey | Roman-script languages, unsupported scripts | No romanization needed or available |

This score is a property of the romanization method, not computed per-line. Stored in `get_lang_config()` as `romanization_confidence` and displayed in the UI near the romanization toggle.

### Library selections

| Language | Library | pip-installable | Notes |
|----------|---------|----------------|-------|
| Chinese (all variants) | `pypinyin` | ✅ | Per-character data for alignment |
| Japanese | `pykakasi` | ✅ | Token-level; `item["hira"]` for furigana, `item["hepburn"]` for romaji |
| Korean | `korean-romanizer` | ✅ | Revised Romanization standard |
| Hindi + Indic scripts | `indic-transliteration` | ✅ | Covers Devanagari, Bengali, Tamil, Telugu, Gujarati, Gurmukhi via `sanscript` |
| Russian + Cyrillic | `cyrtranslit` | ✅ | Lang-code aware; handles Serbian/Macedonian variants |
| Thai | `pythainlp` | ✅ | `engine="royin"` for Royal Institute standard |
| Arabic | `camel-tools` | ⚠️ | Best-effort; experimental/opt-in |
| Persian | `arabic-romanizer` | ⚠️ | Best-effort; experimental/opt-in |
| Urdu | `urduhack` | ⚠️ | Best-effort; experimental/opt-in |

All primary libraries are pip-installable with no system binary dependencies.

### Chunked Implementation Plan

**✅ Chunk R2: Chinese pinyin (COMPLETE 2026-02-18)**
- Implemented `_make_pinyin_romanizer()` in `app/romanize.py`. Activated `if primary == "zh"` branch covering all `zh-*` variants (zh-cn, zh-tw, zh-hk, zh-Hans, zh-Hant, etc.).
- Strips ASS override tags (`{...}`) and line-break markers (`\N`, `\n`) before calling pypinyin, preventing garbage tokens in output.
- Uses `pypinyin.pinyin(text, style=Style.TONE, errors='default')`: tone marks enabled; non-CJK tokens (punctuation, numerals, Latin words) pass through unchanged as units — e.g. `"AI"` stays `"AI"`, not `"A I"`. Confirmed pypinyin handles Traditional Chinese correctly (過往 → guò wǎng, 恥辱 → chǐ rǔ).
- Returns flat space-joined string per the `(str) -> str` contract. Character-aligned `\pos()` generation deferred to R2b (requires `processing.py` to emit N ASS events per source line + `preview.py` per-span HTML).
- Verified: `get_lang_config("zh-Hant")` → `has_phonetic_layer=True`. AoT Traditional Chinese target: 340 Romanized events in generated .ass, pinyin timestamps match source. English+Japanese pipeline unchanged (Bottom=266, Top=303, Romanized=0). zh-cn regression from R1 resolved.
- `pypinyin` import is lazy (inside factory) — users who never select Chinese are not affected by a missing installation.

**✅ Chunk R1: Foundation — `romanize.py` + `styles.py` refactor (COMPLETE 2026-02-18)**
- Created `app/romanize.py` with `get_romanizer(lang_code)` returning `None` for all codes (stubs for R2–R5 are commented in-place)
- Replaced `LANG_CONFIG` dict in `styles.py` with `get_lang_config(lang_code) -> dict` factory. Keys: `romanize_func`, `has_phonetic_layer`, `romanization_name`, `romanization_confidence`, `default_font`, `rtl`. Added `_font_for_script()`, `_ROMANIZATION_META`, `_RTL_CODES` helpers. Removed `pypinyin` import from `styles.py` (moves to `romanize.py` in R2).
- Wired `get_lang_config()` into `processing.py` and `srt_stitcher_app.py`. Key rename: `romanize_function` → `romanize_func` everywhere.
- `preview.py` had no `LANG_CONFIG` references — no changes needed.
- Verified: AoT English+Japanese pipeline unchanged (Bottom=266, Top=303, Romanized=0). All codes including unknown/empty/None handled gracefully.
- **Note:** Chinese `zh-cn` pinyin temporarily regresses to `None` in R1 (was a live lambda in old `LANG_CONFIG`). Will be re-implemented correctly in R2 via `romanize.py`.

**✅ Chunk R2: Chinese pinyin (COMPLETE — see above)**

**✅ Chunk R3: Japanese Hepburn romaji (COMPLETE 2026-02-18)**
- Implemented `_make_japanese_romanizer()` in `app/romanize.py`. Activated `if primary == "ja"` branch.
- Uses `pykakasi.kakasi().convert()`: single kakasi instance captured in closure, called per subtitle line. Tokens joined with spaces via `item["hepburn"]`, falling back to `item["orig"]` for punctuation/Latin passthrough.
- ASS override tags stripped via `_strip_ass()` before tokenization (same helper used by Chinese romanizer).
- Implemented `get_hiragana(lang_code, text) -> str` — debug/probe helper that exposes `item["hira"]` data path (furigana readings) without touching the Romanized layer. Creates its own pykakasi instance (fine for probe use; shared instance is the romanizer closure for hot-path use).
- Implemented `detect_preexisting_furigana(source) -> (bool, str)` — heuristic scans first 50 dialogue events for `\pos()+kana-only` events sharing a timestamp with kanji events. Low false-positive rate. Exposed in `srt_stitcher_app.py` as an `st.info()` banner when target is Japanese and furigana is detected.
- Debug probe in `srt_stitcher_app.py` now shows a "Furigana (hiragana readings)" line for Japanese targets.
- Verified: AoT Japanese track → 303 Top events + 303 Romanized events (e.g. `"shingeki no kyojin"`). Chinese pinyin unchanged. English-only pipeline unchanged. `get_hiragana("zh", ...)` and `get_hiragana("en", ...)` return empty string.
- `pykakasi` import is lazy (inside factory) — users who never select Japanese are not affected.
- `pykakasi` added to `requirements.txt`.
- Character-aligned furigana `\pos()` stacking deferred to R3b.

**Chunk R4: Korean + Cyrillic + Thai**
- Implement `get_romanizer()` for `ko`, `ru`/Cyrillic variants, `th`
- Add `romanization_confidence` scoring and UI display (red-green scale)
- Test each

**Chunk R5: Indic scripts + RTL (experimental)**
- Implement `get_romanizer()` for Hindi/Indic and Arabic/Persian/Urdu
- Add the opt-in/experimental toggle for RTL scripts with accuracy caveat
- Test each

**Chunk R6: Color picker + font validation**
- Add color wheel per track in the UI
- Filter font dropdown by script compatibility
- These were deferred from earlier and can land alongside or after romanization

---

## Key Constraints & Decisions
- **No RAM-loading of large video files** — always use local path + ffmpeg subprocess; `st.file_uploader` is not viable for MKV (confirmed failure mode: RAM crash or impractical upload times)
- **"Logic First, Delivery Second"** — build all core features (stitching, preview, language detection) against the Local Path prototype interface; swap to ffmpeg.wasm for web deployment later without touching core logic
- **ffmpeg.wasm** is the planned web deployment strategy (dedicated future step) — user's browser runs a ~25MB client-side FFmpeg, extracts only the tiny subtitle text tracks, sends those to the backend. This is the only viable architecture for "Web App + Huge File + No Upload"
- **Modularity is non-negotiable** — `mkv_handler.py` is the only file that touches ffmpeg directly; swapping it out for a WASM frontend component must not require changes to stitching, UI, or state logic
- **Output must be compatible** with VLC and Put.io (correct naming conventions matter)
- **Phonetic annotation alignment:** Chinese pinyin = character-aligned (one pinyin per hanzi via `\pos()` tags). Japanese furigana = token-aligned (hiragana reading spans the full kanji compound, matching standard ruby text conventions). These are different strategies handled by the same `get_romanizer()` interface — the ASS generator respects the data shape each romanizer returns.
- **Language support must be generalizable** — never hardcode a language whitelist or enum. Language detection must work for *any* language (Thai, Tagalog, Indonesian, Cherokee, etc.), not just the priority list. Phonetic annotation is a separate, optional, per-script layer that degrades gracefully (no annotation available = just show the text).
- **Style options** apply per-track and per-language (some options irrelevant for Roman scripts)
- **Hybrid selector always returns a file path string** — whether the source is an MKV track or a user upload, downstream code receives a uniform interface
- **Pre-existing furigana detection:** Some Japanese fansub tracks (common in anime) already include furigana/ruby text annotations (hiragana rendered above/below kanji), typically via ASS override tags or manual positioning. SRTStitcher must detect when a track already has phonetic annotations and avoid generating redundant ones. This detection should be general — identify the annotation layer correctly regardless of whether it's positioned above or below the main text, and reuse it in the stitched output rather than regenerating it

---

## Language-Specific Technical References

### Japanese Writing System (Kanji-kana-majiri-bun)
Japanese is a multi-script writing system — not a single alphabet. A typical Japanese sentence contains a blend of three scripts simultaneously:

| Script | Type | Function | Recognition |
|--------|------|----------|-------------|
| **Kanji** (漢字) | Logographic | Core concepts and meanings (inherited from Chinese Hanzi) | Complex, high stroke-density characters |
| **Hiragana** (平仮名) | Phonetic | Grammatical particles, native words, verb endings | Curvy, simplified characters |
| **Katakana** (片仮名) | Phonetic | Foreign loanwords, technical terms, emphasis, names | Sharp, angular characters |

**Key terminology for SRTStitcher:**
- **Kana** = collective term for Hiragana + Katakana (the two phonetic scripts)
- **Furigana** = small phonetic helpers (usually Hiragana) placed *above or beside* Kanji to show the reading/pronunciation. Furigana is supplemental annotation, not a separate text layer or language. It is often omitted in adult-targeted text but is very common in anime subtitles and manga.
- **CJK** = Chinese, Japanese, Korean — the technical grouping used in OCR, font rendering, and NLP due to shared use of Chinese-origin characters

**Implications for SRTStitcher's detection and processing pipeline:**
- A single Japanese subtitle line will contain kanji + hiragana + katakana mixed together. This is normal, not an error or mixed-language content.
- Katakana is used for English/foreign loanwords (e.g., コンピューター = "computer"). A Japanese line with katakana loanwords is still Japanese — do not let loanword presence affect language classification. This reinforces the proportion-based detection principle.
- When fansub .ass files already contain furigana (small hiragana positioned above kanji via ASS override tags or `\pos()` commands), SRTStitcher must recognize this as existing phonetic annotation and avoid generating redundant furigana. The furigana is *not* a separate subtitle track — it's inline annotation within the same track.
- "Kanji and Kana" is the most accurate shorthand for 100% of the Japanese writing system. "JP Text" is the recommended concise identifier for language packs or subtitle format labels.

---

## Community Credits & Test Data

### Furretar (GitHub: [Furretar](https://github.com/Furretar))
- **Test files:** Furretar's Attack on Titan (Shingeki no Kyojin) MKV releases are our primary test fodder for Step 3 development. These files contain multiple subtitle tracks (Traditional Chinese variants, Japanese, English) and multiple audio tracks, making them ideal for testing track detection, language identification, and CJK disambiguation. Available on [nyaa.si/user/Furretar](https://nyaa.si/user/Furretar).
- **Hardsub OCR tool:** [Furretar/Hardsub-Extract-OCR](https://github.com/Furretar/Hardsub-Extract-OCR) — uses VideoSubFinder + Google Cloud Vision to extract hardcoded subtitles from video frames and OCR them into `.srt` files. Not directly used in our current softsub pipeline, but highly relevant for a future capability: handling videos that have *only* burned-in subtitles (no extractable text tracks). If we ever add a "hardsub extraction" mode, this repo is the reference implementation to study.
- **Subtitle archive:** [Furretar/Mandarin-Subtitles-Archive](https://github.com/Furretar/Mandarin-Subtitles-Archive) — a collection of soft CC Mandarin subtitles for Chinese shows, especially those originally hardsub-only. Potential source of test `.srt` files for language detection and stitching validation.

---

## Previous Work Context
- This project was previously developed with **Gemini CLI** (Gemini 3 Pro)
- The Step 3 MKV architecture pivot was designed collaboratively on 2025-02-17 between the developer and Gemini 3 Pro
- The Streamlit `st.file_uploader` model was abandoned for MKV after confirmed failure: RAM crash on large files, impractical upload times for 64GB+
- The "Logic First, Delivery Second" strategy was an explicit decision: use the Local Path prototype to unblock stitching/preview/language work *now*, defer WASM complexity to a dedicated future step
- The Local Path method was chosen specifically because it *simulates* the WASM behavior (instant local file access) — making the future swap straightforward
- Authentication with Claude was completed via claude.ai browser flow
- Transition from Gemini CLI to Claude Code is in progress; Claude should treat the Gemini-era design decisions as established and build on them

---

## How to Resume Work
1. `cd` into this repo
2. Run `claude` to start a session
3. Claude will read this file automatically
4. Reference specific steps or files you want to work on
5. Use `@filename` to point Claude at specific files, `!command` to run shell commands inline
