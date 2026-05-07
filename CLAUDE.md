# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (end of 2026-05-04 session, mid-step-4d):** **Step 4c fully shipped + 4d at 3/5 substeps done.**  Today's commits in order: `393f5cd` (4d-1 SSAFile parser/serializer), `e58b120` (4d-2 ASS generator port — Bottom + Top, romanized stub), `993dc2b` (4d-3 html2canvas bitmap rasterization).  Yesterday (4c shipped): `2070002` (4c-1 boot + WORKERFS), `ca870c2` (4c-2 FFmpegClient + COEP fix + drop dead health-check), `e876f09` (4c-3 + 4c-4 probe/extract/mux), `6a94cc7` (CLAUDE.md refresh).  All prior work (R1–R6a, R6b-presets/fonts, timing offsets, auto-alignment, R5 Hebrew/Arabic/Persian/Urdu, Step 3c desktop bundling for Linux) remains intact; CI green on Ubuntu / macOS / Windows for the test suite.  All step-4 work lands on `monorepo-restructure` branch (~57 commits ahead of `origin/main`); `monorepo-restructure → main` merge is a separate decision when Connor wants to cut a release.

**🎯 Active focus: Step 4d-4 — PGS `.sup` binary writer port (the long pole).**  Three of five 4d substeps shipped today: parser (4d-1), ASS generator (4d-2), rasterizer (4d-3).  Remaining: 4d-4 (this) + 4d-5 (LoomGenerator wrap + UI polish).  4d-4 ports `loom_core/rasterize/sup_writer.py` to TypeScript: palette quantization (median-cut to 256-color indexed bitmap per region), RLE encoding, PCS/WDS/PDS/ODS/END Display Set assembly, epoch state management (Epoch Start / Acquisition Point every 12 sets / Normal incremental updates / Skip identical frames), reserved palette ranges per object (obj 0 → indices 1–127, obj 1 → 128–254), region splitting (canvas-aware: gap midpoint must be in 25–75% of canvas to allow 2-region split, otherwise single-region fallback).  Consumer is `rasterizeFrames()` from `apps/web/lib/raster/rasterizer.ts` — async iterator yielding one full-frame RGBA per timeline interval; 4d-4 streams them into a `.sup` byte stream.  ~600 lines of dense binary-format code on the Python side; honestly sized as one full session.  4d-5 (UI polish + LoomGenerator wrap) is small after 4d-4 lands.

**Architecture (locked 2026-05-03 — Option B, all-client + romanization API):** browser runs ffmpeg.wasm for video probe/extract/mux + JS ports of ASS generation + PGS rasterization (via html2canvas — see Spike subsection for why not SVG-foreignObject).  Server (`api.loom.nerv-analytic.ai` on Railway) only handles romanization: text-in / text-out, ~100KB request.  Drops backend bandwidth ~99% vs upload-everything; target hosting cost $5/mo flat.  Tradeoffs accepted: ~50MB initial JS bundle (one-time, cached), JS reimplementations of `loom_core/subs/processing.py::generate_ass_file` + `loom_core/rasterize/sup_writer.py` that must track the Python reference (drift risk — single source of truth lives in Python; JS port is a transcription), weak-device fallback to a future server-mode toggle.

**Step 4 substeps (Option B):**
| | Status | Ships | Goal |
|---|---|---|---|
| 4a | ✅ `fac632e` | npm workspaces + `apps/web/` Next.js scaffold + `packages/api-client/` from OpenAPI | Foundation. Both apps build, share typed client. |
| 4b | ✅ `c8b14ee` | PGS-in-browser rasterization spike — `spike/pgs-browser/` | Architecture validated. See "Spike: PGS-in-browser" below for the verdict + the constraint it imposes on 4d. |
| 4c | ✅ `2070002` `ca870c2` `e876f09` | ffmpeg.wasm wiring: probe / extract / mux via `FFmpegClient` (apps/web/lib/ffmpeg/) + smoke-test page at `/ffmpeg-test` | Video plumbing client-side.  Validated on real MKV (probe parses tracks, extract dumps .srt, mux re-encodes ASS into output and timestamps survive the roundtrip). |
| 4d-1 | ✅ `393f5cd` | `apps/web/lib/subs/{ssa,types,timestamp,color}.ts` — SSAFile class with fromString/fromAss/fromSrt + toAss + shifted | Pysubs2 minimal-surface port.  Validated on AoT real tracks (Japanese SRT 303 events, English ASS 1262 events + 7 styles, override tags preserved, UTF-8 round-trip OK). |
| 4d-2 | ✅ `e58b120` | `apps/web/lib/subs/{generate-ass,style-config}.ts` — `generateAssFile()` builds Bottom + Top layered .ass; Romanized only emitted when caller passes a `romanize` fn | Validated by playback in mpv: AoT English-as-native + Japanese-as-target → both layers render in correct positions. |
| 4d-3 | ✅ `993dc2b` | `apps/web/lib/raster/{timeline,build-html,rasterizer}.ts` — `rasterizeFrames()` async iterator yields RGBA per union-timeline interval via html2canvas | Visually validated via inline PNG previews on the test page; per-event RGBA matches expected layout. |
| **4d-4** | **🎯 next** | Port `loom_core/rasterize/sup_writer.py` → `apps/web/lib/raster/sup-writer.ts`.  Palette quantization + RLE + Display Set assembly + epoch state + region splitting | Browser-side `.sup` byte stream from `rasterizeFrames()` output. |
| 4d-5 | 🔲 | `LoomGenerator` class wraps 4d-1..4d-4 behind a single API; UI button "Generate ASS + SUP" downloads both | Subtitle outputs fully client-side, end-to-end. |
| 4e | 🔲 | Lean romanizer-only API endpoint (server-side) + web app full UX (drop-zone → tracks → editor → preview → generate → download) | Functional locally end-to-end. |
| 4f | 🔲 | Deploy: Vercel (frontend) + Railway (API) + DNS at Namecheap + IP rate-limit (slowapi, 3/IP/day) + ephemeral storage cleanup cron | Live at `loom.nerv-analytic.ai`. |
| 4g | 🔲 | Delete Streamlit (`loom_app.py` + `app/`) + update CLAUDE.md + capability matrix | Cleanup. |

**Hosting + domain:** frontend on Vercel as `loom.nerv-analytic.ai`, API on Railway as `api.loom.nerv-analytic.ai`. Namecheap is the registrar — DNS records (CNAME or A) point at the hosts; Connor sets these at deploy time.  Connor must provision Vercel + Railway accounts before 4f.  Auth: none in V1, IP rate-limit via slowapi (3 generations/IP/day budget per the bandwidth math).

**Step 4 deferred follow-ups:**
- **Desktop backfill onto `@loom/api-client`** — 4a-5 attempt surfaced 9 legitimate type errors (generated types are stricter than hand-written ones — proper literal unions like `phonetic_system`, `null` vs `undefined` distinctions on optional fields).  Needs per-call-site refactor, not a 5-min rewrite.  Drift risk bounded as long as backend changes propagate to `apps/desktop/src/api.ts` + `apps/desktop/src/styles.ts` in the same commit.

**4c artifacts (where things live):**
- `apps/web/lib/ffmpeg/client.ts` — `FFmpegClient` class, public API: `create / probe / extractTrack / mux / terminate`.  Every public method takes `OperationOptions { signal?, timeoutMs? }`.  Concurrent ops on the same client are rejected (FFmpeg's in-memory FS isn't safe for parallel use).
- `apps/web/lib/ffmpeg/parse-probe.ts` — pure ffprobe-JSON → `ProbeResult` parser.  Mirrors `loom_core/video/mkv_handler.py::get_video_metadata` for shape; image-codec selectability rules match the desktop side.
- `apps/web/lib/ffmpeg/types.ts` — `TrackInfo`, `AudioTrackInfo`, `VideoMetadata`, `ProbeResult`, `OperationOptions`.  Field names mirror Python `loom_core/models.py` so 4e can use the same shapes.
- `apps/web/app/ffmpeg-test/page.tsx` — diagnostic smoke-test page kept long-term for browser/Chromium regression testing.  Exercises probe → extract (per-track Extract buttons) → mux (synthetic .ass injection) end-to-end.
- `apps/web/scripts/setup-ffmpeg-assets.sh` — postinstall hook that stages `@ffmpeg/core` ESM build + sibling ESM modules into `apps/web/public/ffmpeg/`.  Critical: must be the ESM build (worker is `type:"module"` and does `(await import(coreURL)).default`); UMD has no `export default`.  All ESM siblings (const.js, errors.js, classes.js, types.js, index.js, utils.js) must co-locate with worker.js because it imports them relatively.  `apps/web/public/ffmpeg/` is gitignored.
- `apps/web/next.config.ts` — sets `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` on every route.  `credentialless` (not `require-corp`) so cross-origin API fetches don't need CORP headers — important for prod where the API is at a different origin.  Trade-off: Safari support is partial.

**4c tripwires (don't repeat these):**
- The FFmpeg class has no `worker.onerror` listener — if the worker fails to boot (broken import, parse error, security policy block), `FFmpeg.load()` hangs forever.  Hardened against by `FFmpegClient.#init` going through `withTimeout` and `apps/web/app/ffmpeg-test/page.tsx` having window-level error capture + an "abort" button + a "probe worker only" diagnostic.
- `classWorkerURL` MUST be a fully-qualified URL with origin.  The FFmpeg class does `new URL(classWorkerURL, import.meta.url)` and Next dev's `import.meta.url` for that bundled module resolves to `file:///...`, so a path-only string like `/ffmpeg/worker.js` resolves to `file://` and the browser blocks it.  `FFmpegClient.#init` builds the URL with `${window.location.origin}/ffmpeg`.
- ffmpeg-core MUST be the ESM build (`@ffmpeg/core/dist/esm/`), not UMD — the module worker does `(await import(coreURL)).default`.  Worker-side imports are silent-fail: a missing default export hangs `load()` instead of throwing.
- TS `moduleResolution: bundler` doesn't map `.js` → `.ts` for value imports (only type-only imports get stripped before reaching the bundler).  Drop the `.js` suffix on all imports across `apps/web/lib/`.

**General lesson codified:** see `feedback_async_hang_prevention.md` — every promise from third-party code goes through `withTimeout()` with a labeled rejection.  Silent hangs are a banned bug class.

**4d artifacts so far (where things live):**
- `apps/web/lib/subs/types.ts` — `SSAEvent`, `SSAStyle`, `Color`, `SSAFileShape`, `defaultStyle()` factory.  Field names match pysubs2's snake_case so 4d-2's port is mechanical.
- `apps/web/lib/subs/timestamp.ts` — ASS (centisecond) ↔ SRT (millisecond) ↔ ms-int helpers.
- `apps/web/lib/subs/color.ts` — `&HAABBGGRR` ↔ `Color` (alpha INVERTED per ASS file format).
- `apps/web/lib/subs/ssa.ts` — `SSAFile` class.  `fromString()` auto-detects ASS vs SRT.  `splitAssRow()` handles the embedded-comma-in-Text quirk (Text field is always last; gets the verbatim remainder).
- `apps/web/lib/subs/style-config.ts` — `StyleConfig` mirrors `apps/desktop/src/styles.ts::StyleConfig` exactly (lowercase keys: bottom/top/romanized/annotation).  Bounded drift acknowledged.
- `apps/web/lib/subs/generate-ass.ts` — `generateAssFile()`.  Skips annotation / opencc / preserved-styles / romanized-when-no-fn (TODO comments mark each).
- `apps/web/lib/raster/timeline.ts` — `buildPgsTimeline()`.  Union of native + target boundary timestamps → disjoint intervals.  First-overlap match per track (concurrent-event merging from Python's `_merge_concurrent_target_events` not yet ported).
- `apps/web/lib/raster/build-html.ts` — `buildSubtitleHtml()`.  Per-event HTML mirrors desktop's `_build_fullframe_html` structure (frame container + absolutely-positioned .layer divs).  `textShadowCss()` faithfully ports the 4-corner offset shadow technique for ASS-outline emulation.
- `apps/web/lib/raster/rasterizer.ts` — `rasterizeFrames()` async generator.  Lazy by design (full-episode = ~12GB of RGBA in aggregate).  Mounts offscreen container at `left: -100000px`, swaps innerHTML per frame, calls html2canvas, yields full-frame RGBA + transparency-detection-as-clear-marker.  Per-frame timeout via `withTimeout()` per `feedback_async_hang_prevention.md`.

**4d-4 design notes (read before starting):**
- The Python source is `loom_core/rasterize/sup_writer.py` — read it whole before porting; it's ~600 lines and the binary format details (PCS/WDS/PDS/ODS structure, Display Set framing, palette/object segment numbering) are not obvious without that read.
- PGS spec reference: a Display Set = `[PCS, WDS, PDS, ODS, END]` segments.  Each segment is `<type:1><size:2><payload>`.  PCS holds presentation timestamp + composition state; WDS defines window rectangles; PDS holds the indexed palette; ODS holds the RLE-compressed bitmap data.  END is a zero-payload terminator.
- Critical timestamp anchor: PTS=0 anchor in `SupWriter` prevents ffmpeg timestamp rebasing during mux.  Don't change this unless 4c mux output starts misbehaving.
- Epoch types: **Epoch Start** = full redraw (all segments).  **Acquisition Point** = full redraw at every 12th set so a player seeking can pick up mid-stream.  **Normal** = only changed regions re-encoded (relies on `region_content_keys` to detect "did this region change since last frame?").  **Skip** = identical frame, emit nothing.
- Reserved palette ranges: object 0 → indices 1–127, object 1 → 128–254 (255 = transparent).  Two-region max per Display Set per the PGS spec.
- Region splitting (`split_regions(canvas_height=)`): try a 2-region split when the gap midpoint between top + bottom non-transparent regions falls within 25–75% of canvas height.  Otherwise fall back to single-region covering both.
- Consumer pattern: `for await (const frame of rasterizeFrames(...)) { writer.write(frame) }`.  Writer streams bytes out; caller (4d-5) wires those into a download.
- Validation plan when 4d-4 lands: emit a .sup, test mux it back into the source MKV via `FFmpegClient.mux({ sup: bytes })` (already shipped from 4c-3), play in mpv, confirm subs appear at the right times + positions.  Round-trip: source → extract → 4d port → mux back → play.

**Spike: PGS-in-browser (4b verdict, 2026-05-03):** `spike/pgs-browser/` validates that the browser can capture rendered subtitle pixels for PGS encoding. **Direct path is blocked by canvas-tainting:** drawing an SVG `<foreignObject>` (which would have been the pixel-perfect approach) to canvas marks it origin-opaque, so `getImageData` throws. Workaround that survived the spike: **html2canvas** library (~200KB) walks the DOM and draws text/shapes via Canvas2D primitives — no SVG, no taint. Both phases (Latin+Japanese, then Hebrew RTL + ruby furigana + Japanese) showed ~0.6% pixel divergence vs the desktop's Playwright reference, with the diff concentrated as 1–2px sub-pixel offsets at glyph edges (html2canvas's text-layout heuristics differ slightly from native Chromium's). **The "byte-identical SUP file" goal is not achievable with this approach** — the web app's PGS bytes will differ from the desktop's. **Visual equivalence is achievable** — both render the same content, same fonts, same positioning at viewer-perceptible scale. Step 4d (JS port of `sup_writer`) needs to operate on whatever pixels html2canvas produces, not match a reference byte-stream. Spike artifacts kept under `spike/pgs-browser/` for re-running on Chromium upgrades; raw `.bin` buffers + per-run `stats.txt` are gitignored, but `reference.png`, `browser.png`, `diff.png` are committed as evidence.

**Step 3c — what shipped:**
- **Track A:** `scripts/fetch_noto_fonts.sh` pulls the full Noto manifest (~48MB across 29 face files: Sans CJK SC/TC/JP/KR, Sans Thai, Naskh Arabic, Nastaliq Urdu, Sans Devanagari/Bengali/Tamil/Telugu/Gujarati/Gurmukhi, Sans for Latin/Cyrillic/Greek). `loom_core/fonts.py::build_font_face_css(scanner)` emits one `@font-face` per face with cmap-coalesced `unicode-range`; injected at the top of `_build_fullframe_html`'s `<style>`. Chromium picks the correct family per codepoint without fontconfig fallback. **Dev-mode caveat:** Tauri 2's `resource_dir()` in dev returns the build artifact dir, not `src-tauri/resources/`, so during `npm run tauri dev` you must set `LOOM_FONT_DIR=$PWD/apps/desktop/src-tauri/resources/fonts` manually. Production bundles read from the actual resource dir.
- **Track B:** `scripts/setup_bundle.sh` is the single idempotent build-time script. Steps: (1) Noto fonts via fetch_noto_fonts.sh, (2) python-build-standalone CPython 3.11 via `uv python install`, (3) `uv venv --relocatable --seed` + CPU-only torch + requirements.txt + strip dev-only stack (streamlit/pyarrow/pydeck/altair/pandas), (4) Playwright Chromium via the bundled venv. Final cleanup pass prunes `__pycache__` / `.pyc` / `.pyo`. Bundle layout under `apps/desktop/src-tauri/resources/`: `fonts/` (48M), `python/{runtime,venv,source}/` (1.6G), `playwright-browsers/chromium-1217/` (374M). Total ~2GB raw → 1.2G compressed in .deb/.rpm.
- **Sidecar spawn (`apps/desktop/src-tauri/src/lib.rs`):** three-way resolution in `BundlePaths::is_complete()` → (1) `LOOM_UVICORN` env set ⇒ dev mode, (2) bundle complete (python_bin + source_dir + a `chromium-*` under browsers_dir) ⇒ spawn `python -m uvicorn` from the bundled venv with PYTHONHOME/PYTHONPATH/VIRTUAL_ENV stripped + PLAYWRIGHT_BROWSERS_PATH set, (3) fallback to legacy hardcoded dev defaults. Browsers check prevents partial bundles from silently falling into "production" mode and triggering Playwright's `~/.cache/` fetch.

**Step 3c — known limitations (not blocking 3c, parked for later):**
- **AppImage target dropped from `tauri.conf.json`.** AppDir is 3.8G uncompressed; `linuxdeploy` consistently fails to squashfs it into a single AppImage. `.deb` + `.rpm` cover Linux distribution; AppImage was nice-to-have, not critical-path. Fixable later by manual `linuxdeploy --appimage-extract-and-run` invocation or alternative AppImage tooling.
- **macOS / Windows desktop bundling not done.** `setup_bundle.sh` is Linux-only as written (uses GNU `realpath --relative-to=`, `find -executable`, POSIX `bin/python` paths). `tauri.conf.json` lists `app`, `dmg`, `msi`, `nsis` targets but no equivalent setup script exists for those platforms. Whole-step follow-up; not needed for Connor's own use.
- **Bundle size 2GB raw** dominated by torch CPU (~200MB), unidic-lite Japanese dictionary (~250MB), Playwright Chromium (~374MB). Tauri auto-updater handling of multi-hundred-MB resource diffs is untested.

**Pre-3c hygiene shipped (2026-04-26 audit):** `mkv_handler.py` ffmpeg subprocess calls hardened against Windows cp1252 locale (`encoding="utf-8", errors="replace"`); `pgs.py` debug-dump opens given explicit `encoding="utf-8"`. None exercised by CI but all relevant for installed-Windows-app reliability.

R6b-fonts library primitive exists but is not yet wired into a UI warning path — secondary polish, can land any time.

**Test suite:** 603 tests across 19 files. Engine tests cover `loom_core` only — no `loom_api` tests yet (smoke-tested via cURL during 2a–2c).

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
  fonts.py                 # FontScanner (fontTools-only directory walker) + validate_font() + module-level default scanner; LOOM_FONT_DIR env var override
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
| CI ph 1–3 | ✅ | GitHub Actions matrix on push to main/monorepo-restructure + PRs to main. Ubuntu + macOS + Windows all green. Includes pytest + Playwright Chromium rasterize + font-validator self-check. fontconfig is no longer installed on any platform — `loom_core/fonts.py` is fontTools-only, same code path everywhere. |
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

## Owner Auth Roadmap

**Why this exists.** Production rate limits (100/minute, 2000/day per IP, 5000-char per-request cap) protect the slim API from abuse, but they also block legitimate operator use — especially the OCR synthetic-data generation pipeline (Step 6) which will fan out tens of thousands of romanize/annotate calls during training-data assembly. The owner auth path lets *Connor* (and only Connor) skip the limiter without weakening defenses for everyone else.

**Three layers, additive.** Each tier builds on the previous. Don't skip ahead — A satisfies v1; B and C are upgrades when the use case demands.

### Tier A — Pre-shared bypass key (✅ shipped)

**How it works:**
- Operator generates a long random secret: `python -c "import secrets; print(secrets.token_hex(32))"`
- Secret(s) live in Railway as `LOOM_BYPASS_KEYS` (comma-separated list, supports rotation).
- Operator visits `loom.nerv-analytic.ai/?owner_key=<secret>` once per device — `OwnerKeyBootstrap` (`apps/web/components/owner-key-bootstrap.tsx`) intercepts the param, stashes it in `localStorage` under `loom_owner_key`, and rewrites the URL clean.
- Every API call from that device gets `X-Loom-Auth: <secret>` via the `openapi-fetch` middleware in `apps/web/lib/api/client.ts` (reads `localStorage` per-request so a fresh value takes effect immediately).
- `BypassAwareSlowAPI` (`loom_api/web.py`) wraps `SlowAPIMiddleware`: requests carrying a key in the allow-list bypass the limiter ENTIRELY (not "given a higher bucket" — the request never reaches slowapi). `hmac.compare_digest` for constant-time match.

**Indicator:** floating "owner mode" pill in the bottom-right of every page when `localStorage.loom_owner_key` is set. The only visible signal that bypass is in effect.

**Reset:** `localStorage.removeItem("loom_owner_key")` from devtools, or visit `/?owner_key=` (empty value).

**Rotation:** change `LOOM_BYPASS_KEYS` in Railway → old keys instantly invalid → re-issue new key via `?owner_key=...` to the operator's devices. Frontend code unchanged.

**Limitations (acceptable for v1):**
- Devices, not identities: same key on all of Connor's devices. Doesn't differentiate `infinnity12@gmail.com` from `connor.m.finnerty@nerv-analytic.ai` — Tier B addresses this if we ever care.
- Key-in-URL exposure: the `?owner_key=...` URL ends up in browser history + any HTTP referer logs upstream of `?owner_key=` getting stripped. Mitigated by short URL lifespan (`replaceState` immediately after) but not eliminated.
- No revocation per-device: rotating the env var nukes ALL devices simultaneously.

### Tier B — Google OAuth identity binding (planned, post-Step 5)

**Trigger:** when the synthetic-data pipeline (Step 6) starts attributing training samples to specific operator emails — e.g., for cleaner provenance in training-set documentation, or if Connor wants per-email rate budgets ("I'm OK with anyone reading 100k samples/day from `connor.m.finnerty@nerv-analytic.ai` but only 1k/day from secondary accounts").

**Design:**
- "Sign in with Google" button in `apps/web/app/owner/page.tsx`.
- Frontend uses `@react-oauth/google` to obtain a Google ID token (JWT).
- ID token sent to a new `POST /auth/session` endpoint on `loom_api.web`.
- Backend verifies the JWT signature against Google's public keys + checks `email_verified=true` + checks `email` claim against `LOOM_OWNER_EMAILS` env-var allow-list (`infinnity12@gmail.com,connor.m.finnerty@gmail.com,connor.m.finnerty@nerv-analytic.ai`).
- On success, backend mints a short-lived session token (HS256-signed JWT, 24h TTL).
- Frontend stores session token in `localStorage` (replaces `loom_owner_key`).
- `BypassAwareSlowAPI` updated: accept either `X-Loom-Auth: <bypass-key>` (Tier A) OR `X-Loom-Auth: Bearer <session-jwt>` (Tier B). The internal predicate becomes "is this request authenticated as the operator?" — same bypass behavior, broader auth backends.
- Token refresh on 401: frontend silently retries Google sign-in.

**Migration from A:** strictly additive. Tier A keys keep working forever; Tier B adds a second authentication backend. No frontend rewrite — `X-Loom-Auth` header path stays unchanged, just carries a different secret format.

**Cost:** ~2-3 hours setup (Google Cloud OAuth client + redirect URIs for prod custom domain + Vercel preview wildcards), two new deps (`google-auth` server-side, `@react-oauth/google` client-side), one new endpoint, +~100 lines.

### Tier C — Cloudflare Access network gate (deferred indefinitely)

**Trigger:** if Tier B's email-binding still isn't enough — e.g., we want zero-trust gating with device posture checks, or want to put `loom.nerv-analytic.ai` itself behind auth (not just the API).

**Design:**
- Cloudflare in front of both `api.loom.nerv-analytic.ai` and `loom.nerv-analytic.ai`.
- Cloudflare Access policy: `email in {infinnity12@gmail.com, ...}`.
- Visitors hit the Cloudflare-issued login page (Google/email magic-link), get a Cloudflare Access JWT cookie, then their request reaches Railway/Vercel.
- Backend optionally re-validates the `CF-Access-Jwt-Assertion` header for defense-in-depth.

**Why deferred:** putting the public site itself behind auth defeats the purpose (it's a tool for general use; only the bypass path is auth-gated). Could selectively gate `/api/*` paths if we proxy through Cloudflare Workers, but that's complexity for what Tier B already handles.

**Cost:** ~30 min setup, free tier covers it, but the routing complexity (which paths gated, which not) doesn't pay for itself unless Tier B is also somehow inadequate.

### Implications for the synthetic data pipeline (Step 6)

The OCR closed-loop pipeline runs as a batch process — it'll generate millions of `(rendered_image, text, language, style)` tuples by:
1. Sampling text from the extension's archived corpus (`opt_in_training=true` path),
2. Calling `/romanize` + `/annotate` to enrich each sample with phonetic + annotation ground-truth,
3. Rendering through the same html2canvas / Playwright pipeline used in production,
4. Feeding the resulting bitmap + text pairs to TrOCR fine-tuning.

Steps 2–3 will hit the slim API hard (one call per sample, potentially fan-out for varied phonetic systems). Tier A's bypass key is the v1 enabler — without it the pipeline would either rate-limit itself to a crawl or need a separate "internal" deployment path. With Tier A, the pipeline runs from Connor's laptop / a CI runner with `X-Loom-Auth` set and slowapi never sees it.

Tier B becomes relevant if we want to attribute generated samples to specific operator identities for dataset documentation (e.g., "this 50k-sample subset was assembled by `connor.m.finnerty@nerv-analytic.ai` on 2026-09-15"). Not strictly required for the pipeline to function.

---

## Capability Matrix

**Purpose:** at-a-glance visibility into which features have reached which surfaces. Backend (`loom_core` + `loom_api`) is the single source of truth — frontends call the API, never reimplement engine logic. Frontend rows track UI affordance, not capability (a feature with backend ✅ is callable from any frontend the moment its UI lands).

**Update protocol:** when shipping a feature, add a row OR update an existing row's columns in the same commit as the code. Don't ship a backend change without updating the matrix — drift here is the failure mode this exists to prevent.

**Legend:** ✅ shipped · 🟡 partial · ⏳ planned · — N/A by design

| Feature | Engine | API | Desktop | Web | Extension |
|---|---|---|---|---|---|
| **Subtitle ingestion** | | | | | |
| `.srt` / `.ass` / `.ssa` / `.vtt` upload | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Local file picker (zenity / native) | ✅ | ✅ | ✅ | — | — |
| External video file scan (MKV tracks) | ✅ | ✅ | ✅ | — | — |
| YouTube URL → subtitle pull (yt-dlp) | ⏳ | ⏳ | — | ⏳ | ⏳ |
| Page-DOM subtitle scrape (YT/Netflix) | — | — | — | — | ⏳ |
| **Romanization** (engine + API ✅ for all) | | | | | |
| Chinese (Pinyin / Zhuyin / Jyutping) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Japanese (MeCab + furigana, 3 long-vowel modes) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Korean (RR per-syllable + word-level) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Cyrillic (ru / uk / be / sr / bg / mk / mn) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Thai (paiboon / RTGS / IPA) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Indic (hi / bn / ta / te / gu / pa) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Hebrew | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Arabic / Persian / Urdu | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| **Output generation** | | | | | |
| `.ass` 3- or 4-layer file | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| `.sup` (PGS) bitmap rasterization | ✅ | ✅ | ✅ | ⏳ | — |
| Live HTML composite preview | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Output filename builder | ✅ | ✅ | ✅ | ⏳ | — |
| MKV mux (ffmpeg subtitle merge) | ✅ | ✅ | ✅ | — | — |
| **Style customization** | | | | | |
| Per-layer color / opacity / font / size | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Per-layer outline / shadow / glow | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Top stack position + layer gaps | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Color presets (28, 4 categories, lang-scoped) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Output resolution scaling (480p–2160p + match) | ✅ | ✅ | ✅ | ⏳ | — |
| **Timing / sync** | | | | | |
| Manual offset (per-track ms shift) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Auto-alignment (histogram + fine pass) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| **Fonts** | | | | | |
| Bundled Noto manifest (29 faces) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| `@font-face` CSS w/ unicode-range routing | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| FontScanner (validate + missing-char warn) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ |
| **Distribution / packaging** | | | | | |
| Linux desktop bundle (`.deb` + `.rpm`) | — | — | ✅ | — | — |
| AppImage | — | — | ⏳ | — | — |
| macOS desktop bundle (`.app` + `.dmg`) | — | — | ⏳ | — | — |
| Windows desktop bundle (`.msi` + `.nsis`) | — | — | ⏳ | — | — |
| Tauri auto-updater (multi-hundred-MB diffs) | — | — | ⏳ | — | — |
| **OCR data pipeline** (step 5 → step 6) | | | | | |
| `opt_in_training` flag on requests | ✅ | ✅ | — | ⏳ | ⏳ |
| `(text, style, language)` tuple archive | — | ⏳ | — | — | ⏳ |
| Synthetic OCR training pipeline | ⏳ | — | — | — | — |

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

**Font validation (R6b-fonts):** `loom_core/fonts.py` — `FontScanner` walks one or more font directories, indexes every TTF/OTF/TTC face via `fontTools.ttLib.TTFont`, builds `family → (path, ttc_index)` + per-face cmap maps. Reads `name` records 16/1/4 (typographic family / family / full name, prioritised, Windows-Unicode platform preferred over Mac Roman) plus OS/2 `usWeightClass` so `resolve()` returns Regular weight when multiple weights of the same family are indexed. Mtime-based lazy rebuild; thread-safe. `validate_font(font_name, *, lang_code=None, text=None, scanner=None)` → `FontValidation` (resolved_path, resolved_family, resolved_index, is_fallback, coverage_ok, missing_chars, warnings). Per-language samples in `_LANG_COVERAGE_SAMPLES` (zh-Hans uses 国, zh-Hant uses 國). Module-level `get_default_scanner()` consults `LOOM_FONT_DIR` (`os.pathsep`-separated) then falls back to platform-conventional system font dirs; `set_default_scanner()` for tests / Tauri startup wiring. **`is_fallback=True` semantics in the new backend** = "requested family not in any scanned dir" (the renderer will pick a system / engine fallback at draw time). UI integration deferred.

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
