# SRTStitcher — Gemini Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session alongside the rest of GEMINI.md.

**Current state (2026-02-18):** Romanization architecture Chunks R1–R3 complete. End-to-end pipeline working: MKV scan → track extraction → language detection → style configuration → composite preview → generate `.ass` → remux into MKV. Chinese pinyin (R2) and Japanese Hepburn romaji (R3) both produce Romanized events. Pre-existing furigana detection heuristic and hiragana-readings debug probe are in place.

**Active focus:** Romanization architecture. Choose next from: R3b (character-aligned furigana `\pos()` stacking — complex), R4 (Korean/Russian/Thai — simpler, continues the pattern), or R6 (color picker UI — most visible missing UI feature, independent of romanization).

**Known broken:**
- No color pickers — text colors are hardcoded defaults with no UI to change them
- Furigana (4th layer, character-aligned) not implemented — R3 adds flat Hepburn romaji only; `get_hiragana()` and `detect_preexisting_furigana()` are ready; `\pos()` stacking deferred to R3b
- Simple Upload (legacy) mode is a non-functional stub

**Romanization R3 complete (2026-02-18):**
- `_make_japanese_romanizer()` in `app/romanize.py` — activated for `ja`. Single `pykakasi.kakasi()` instance captured in closure. Strips ASS tags before tokenization. Joins `item["hepburn"]` tokens with spaces (fallback to `item["orig"]` for Latin/punct passthrough). Lazy import.
- `get_hiragana(lang_code, text) -> str` — debug probe helper, exposes `item["hira"]` data path (furigana readings). Creates own instance (fine for probe; not for hot path).
- `detect_preexisting_furigana(source) -> (bool, str)` — heuristic: scans first 50 events for `\pos()+kana-only` events co-occurring with kanji events at the same timestamp. Exposed as `st.info()` in `srt_stitcher_app.py` when Japanese target is selected.
- Debug probe in `srt_stitcher_app.py` shows "Furigana (hiragana readings)" line for Japanese targets.
- Verified: AoT Japanese track → 303 Top + 303 Romanized events (e.g. "shingeki no kyojin"). Chinese pinyin unchanged. English pipeline unchanged.
- `pykakasi` added to `requirements.txt`.

**Romanization R2 complete (2026-02-18):**
- `_make_pinyin_romanizer()` in `app/romanize.py` — activated for all `zh-*` variants. Strips ASS tags + line-break markers before pypinyin. `errors='default'` passes non-CJK tokens through as units. Traditional Chinese confirmed working (過往 → guò wǎng). Lazy import.
- zh-cn pinyin regression from R1 is resolved.
- 340 Romanized events generated for AoT Traditional Chinese target. English+Japanese unchanged (266/303/0).
- Character-aligned `\pos()` generation deferred to R2b.

**Romanization R1 complete (2026-02-18):**
- Created `app/romanize.py` — `get_romanizer(lang_code)` returns None for all codes (stubs for R2–R5 are commented in-place)
- Refactored `app/styles.py` — replaced `LANG_CONFIG` with `get_lang_config(lang_code) -> dict` factory (keys: `romanize_func`, `has_phonetic_layer`, `romanization_name`, `romanization_confidence`, `default_font`, `rtl`); removed pypinyin import
- Wired `get_lang_config()` into `processing.py` and `srt_stitcher_app.py` (key rename: `romanize_function` → `romanize_func`)
- Chinese `zh-cn` pinyin temporarily regresses to None — re-implemented in R2

**Fixed 2026-02-18 (by Claude Code session):**
- ✅ ASS extraction format — `mkv_handler.py` correctly maps `ass`→`.ass`, `subrip`→`.srt`, `webvtt`→`.vtt`. Verified against AoT S1E01.
- ✅ Karaoke layer bleed — `processing.py` now uses `_iter_dialogue_events()` which filters multi-layer ASS files to the highest-numbered layer (main dialogue by convention). Vector path events (`\p1`) always stripped. Result: 266 English dialogue events vs 1262 raw.
- ✅ Native event mutation bug — `generate_ass_file()` now uses `line.copy()` for all events.
- ✅ Temp dir leak — `state.py` no longer calls `tempfile.mkdtemp()`; `temp_dir` initializes to `None`, owned by `srt_stitcher_app.py`.
- ✅ `language_data` package — added to `requirements.txt` so `langcodes` returns full language names.

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
CLAUDE.md                  # Claude Code briefing (kept in sync with this file)
GEMINI.md                  # This file — Gemini briefing
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
- Track numbering and language naming — subtitle-relative numbering (Subtitle 1, 2, 3...) with full language names via `langcodes`. This is correct.
- Bold, italic, size controls — functional
- Outline and shadow — functional (trailing comma CSS bug in text-shadow was fixed)
- Timestamp slider — reads actual video duration via `get_video_metadata()` in `mkv_handler.py`, stored in `st.session_state.mkv_duration`, used as slider max. Default position is `min(300, duration)`.
- UI flow — Sections 3+4 merged into single "3. Style & Preview" section. Order: timestamp slider + Grab Frame → style expanders → composite preview → generate/download/remux.
- `extract_screenshot()` — no `quiet=True`; ffmpeg errors surface to console. `screenshot_path` initialized to `None` in `state.py`.
- Dynamic aspect ratio — `get_video_metadata()` reads `width` and `height` from ffprobe; stored as `st.session_state.mkv_resolution`. `generate_unified_preview()` uses these to set `aspect-ratio` and constrain the frame div correctly.
- Preview frame fully visible, both subtitle tracks render — fixed 2026-02-18. Root cause was that `generate_unified_preview()` returned a bare `<div>` fragment, not a full HTML document. Without `html, body { height: 100% }`, `height: 100%` on inner divs resolved to the image's natural size (~1080px), overflowing the 600px iframe and clipping the bottom subtitle off-screen. Fix: function now returns a complete `<!DOCTYPE html>` document with proper `html/body` styles. Inner video-frame div uses `width: min(100%, calc(100vh * W / H)); height: auto; aspect-ratio: W / H` so it always fits the viewport regardless of video dimensions or screen width.
- Timestamp-synced subtitle preview — fixed 2026-02-18. Preview text now reflects the actual subtitle active at the slider's current timestamp, not an arbitrary middle-of-file line. `get_lines_at_timestamp(native_file, target_file, timestamp_seconds)` in `preview.py` converts seconds → ms (pysubs2 stores times in ms), then scans each file independently for the first event where `event.start <= ts_ms <= event.end`. Empty string is returned for dialogue gaps — correct behaviour. ASS override tags (`{...}` blocks) are stripped via regex before display. The old `get_preview_lines()` (middle-of-file hack) has been removed.
- Auto-updating video frame — fixed 2026-02-18. The "Grab Frame" button and its `update_screenshot_state()` callback have been removed. `extract_screenshot()` is now called automatically on every rerun when `screenshot_ts != last_extracted_ts` (a new state var). This fires once per slider release and once on first load (since `last_extracted_ts` starts as `None`). All other widget interactions (style expanders, checkboxes) do not re-extract because `screenshot_ts` hasn't changed. The slider now spans full width with no button column.
- Diagnostic probe collapsed — `PIPELINE INSPECTION` block wrapped in `st.expander("🔧 Debug: Pipeline Inspection", expanded=False)`. No longer clutters the main UI but still accessible.
- NameError guard — `native_text`, `target_text`, `pinyin_text` are now initialized to `""` before the `if preview_lines:` block, so the diagnostic probe and `generate_unified_preview()` never crash when subtitle parsing fails.

**🐛 Color options — missing:**
- There is no color picker in the UI. There should be a color wheel / color picker for each track. Currently Japanese text is yellow and cannot be changed. Every text layer (native, target, phonetic annotation, romaji) needs independent color control.

**🐛 Font selection — needs validation:**
- Font dropdown should only show fonts that are valid for the selected language/script. Don't offer Latin-only fonts for CJK text. Filter the font list based on what script the track contains.

**🐛 Furigana layer — flat romaji only (R3b deferred):**
- Three layers exist: Bottom, Top, Romanized. R3 adds flat Hepburn romaji to the Romanized layer. `get_hiragana()` exposes hiragana readings. Character-aligned `\pos()` stacking requires: (a) processing.py to emit N ASS events per source line, (b) preview.py per-span HTML — deferred to R3b.

**✅ All subtitle tracks extracted in native format — FIXED:**
- `mkv_handler.py` uses `CODEC_EXT` mapping: `subrip`→`.srt`, `ass`/`ssa`→`.ass`, `webvtt`→`.vtt`. Verified 2026-02-18.

**✅ Double temp dir creation / leak — FIXED 2026-02-18:**
- `state.py` no longer calls `tempfile.mkdtemp()`. `temp_dir` initializes to `None`.

**✅ LANG_CONFIG replaced — FIXED (R1):**
- `styles.py` LANG_CONFIG dict removed. `get_lang_config(lang_code)` factory returns full config for any BCP 47 code. Chinese and Japanese both have `romanize_func` set. R4/R5 languages return `romanize_func=None` gracefully.

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

## Key Constraints & Decisions
- **No RAM-loading of large video files** — always use local path + ffmpeg subprocess; `st.file_uploader` is not viable for MKV (confirmed failure mode: RAM crash or impractical upload times)
- **"Logic First, Delivery Second"** — build all core features (stitching, preview, language detection) against the Local Path prototype interface; swap to ffmpeg.wasm for web deployment later without touching core logic
- **ffmpeg.wasm** is the planned web deployment strategy (dedicated future step) — user's browser runs a ~25MB client-side FFmpeg, extracts only the tiny subtitle text tracks, sends those to the backend. This is the only viable architecture for "Web App + Huge File + No Upload"
- **Modularity is non-negotiable** — `mkv_handler.py` is the only file that touches ffmpeg directly; swapping it out for a WASM frontend component must not require changes to stitching, UI, or state logic
- **Output must be compatible** with VLC and Put.io (correct naming conventions matter)
- **Pinyin/furigana must be character-aligned** — not just appended as a block
- **Language support must be generalizable** — never hardcode a language whitelist or enum. Language detection must work for *any* language (Thai, Tagalog, Indonesian, Cherokee, etc.), not just the priority list. Phonetic annotation is a separate, optional, per-script layer that degrades gracefully (no annotation available = just show the text).
- **Style options** apply per-track and per-language (some options irrelevant for Roman scripts)
- **Hybrid selector always returns a file path string** — whether the source is an MKV track or a user upload, downstream code receives a uniform interface
- **Pre-existing furigana detection:** Some Japanese fansub tracks (common in anime) already include furigana/ruby text annotations (hiragana rendered above/below kanji), typically via ASS override tags or manual positioning. SRTStitcher must detect when a track already has phonetic annotations and avoid generating redundant ones. This detection should be general — identify the annotation layer correctly regardless of whether it's positioned above or below the main text, and reuse it in the stitched output rather than regenerating it

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
2. Run `gemini` to start a session
3. Gemini will read this file automatically
4. Reference specific steps or files you want to work on
