# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session. Full session-by-session history lives in the dated archives at `general_project_notes/notes/srtstitcher/CLAUDE*_ARCHIVE.md`.

**Current state (end of 2026-06-19 session):** Steps 1–4 shipped (4f live; 4g Streamlit-deletion pending). Step 5 (browser extension): **5a–5i shipped; v0.2.0 (Netflix + UI overhaul) submitted to AMO + Chrome and in review.** The extension renders the full 4-layer stack on YouTube **and Netflix**: native (Bottom) + foreign (Top) + per-token annotation ruby (furigana / Pinyin / Zhuyin / Jyutping, auto-routed via `classifyLang` / Korean RR) + a **secondary full-utterance romanization line** covering every phonetic-layer language (CJK + Korean get both ruby and the line; Cyrillic / Thai / Indic / Hebrew / Arabic-Persian-Urdu get the line as their whole phonetic surface). Both layers fetch as a single batch POST on activation — `/annotate/batch` per (target_track, phonetic_system) and `/romanize/batch` per (track, phonetic_system, long_vowel_mode), ~3–4 s, then quiet. **Per-tab activation** (every YouTube tab starts dormant with a "Loom" pill; click to activate; `sessionStorage` persists across same-tab reloads) **plus a global on/off kill switch** (`lib/enabled.ts`, `browser.storage.local`, defaults on) surfaced as a popup toggle — when off, `LoomApp` renders nothing AND the background `webRequest` listener early-returns (zero timedtext observation, not just visual). The settings panel covers live track switching (manual/ASR badges + processing-tier indicators), per-layer `tlang` overrides, a 4-slot position picker, full per-layer styling (color + font + size + alpha + outline + glow for Bottom/Top/Annotation/Romanization), annotation + romanization toggles, alternate-orthography ruby (zh-Hant → Simplified) with Distinct/Merged tier highlights, 28 lang-aware color presets (from `/styles/presets`), an inline HSV color wheel (react-colorful), and a ☕ "Support Loom" link at the top (→ `/donate`). All persisted to `browser.storage.local`. **v0.2.0 settings-panel overhaul (shipped 2026-06-19):** the panel is now **four self-contained line-cards** (Bottom / Top / Annotation / Romanization), each owning its on/off, options, AND styling. New: per-line master **Show line** enable (Top off also hides its annotation / romanization / alt-orth — Loom doubles as a subtitle customizer); a **capability-driven phonetic-system picker** (`phoneticSystemsFor()` in `lib/captions/lang-support.ts` — Chinese / Thai / Arabic / Persian / Urdu systems, formerly CJK-only and the fix for "Thai paiboon not exposed"); language-gated controls (long-vowel → ja only, alt-orth → zh-Hant only); first-class per-line **opacity** with a linked Top-group (default linked; unlink toggle in Top's Advanced); dot-in-pill **Switch** toggles (greyed-gold off / neon-purple on) replacing the On/Off buttons; **pastel color defaults** (fresh installs) + Simplified-'same as Top'. Alt-orth Simplified ruby renders **ABOVE** the reading (prose corrected everywhere; language coding unchanged). Tracking doc: `apps/extension/UI_REVISIONS.md`. **The owner-key field is now dev-only** (gated behind `IS_DEV`, dead-code-eliminated from prod bundles — verified absent from `firefox-mv2` + `chrome-mv3`); the web app retains the Tier-A owner key. `logDev` is gated behind `IS_DEV` (prod ships quiet). **Extension at v0.2.1** (artifacts built 2026-06-22; Connor uploads to AMO + Chrome) — refinement release over 0.2.0: Netflix mid-episode track-switch fix (media-swap-anchored `manifest-tracker`), audio-language target default, smarter romanize/Pinyin defaults, outline + pill polish, collapsible settings, dev/prod channel namespacing. v0.2.0 was the FIRST public version with Netflix + the UI overhaul (submitted 2026-06-19). Prior public YouTube-only version was 0.1.7; AMO version numbers must be unique across channels. Reviewer field copy + Netflix MAIN-hook / permission justification: `SUBMISSION_0.2.1.md` (0.2.0's is `SUBMISSION_0.2.0.md`). **Build-time dev/prod split** ("Loom" vs "Loom (Dev)", distinct IDs, API base + verbosity via `lib/env.ts`). **Netflix port: FIRST PASS COMPLETE + live-verified (2026-06-19).** Same shared pipeline (overlay / annotate / romanize / settings / playhead) behind one `CaptionPlatform` impl + one MAIN entrypoint per site. Acquisition is a **MAIN-world `JSON.parse`/`JSON.stringify` manifest hook** (manifest is MSL-encrypted → not webRequest); each track carries its own signed WebVTT URL. Overlay anchors to `div[data-uia="player"]` (above Netflix's chrome). Text-vs-image is governed by **origin language** (ja/ko/zh/th/hi all serve WebVTT on native-origin content = the core learner case; image-only OCR is the off-axis foreign-translation case, gracefully degraded). Verified live on JJK (ja+furigana) + Crouching Tiger (zh-Hant+pinyin, EN-CC native), with furigana/romanize/presets served by the prod API. Detail in the **Step 5h** summary below + `NETFLIX_RECON.md` + `memory/reference_netflix_caption_acquisition_2026.md`. Production: `api.loom.nerv-analytic.ai` serves `/annotate/batch` + `/romanize/batch` + `/styles/presets`; web app live at `https://loom.nerv-analytic.ai` with `/privacy`, **`/support` (technical support/FAQ — the canonical store Support URL)**, and **`/donate` (PayPal + Venmo)**. Tests: **626** `test_` functions in `loom_core` (`tests/`) + **212** vitest cases (9 spec files) in `apps/extension`. _(static counts — re-run to confirm pass totals.)_

**🎯 Active focus next session — v0.2.1 ARTIFACTS BUILT, awaiting Connor's store upload; then pick the next major thrust:**

**v0.2.1 (Netflix track-switch fix + defaults/UI refinements) built 2026-06-22** — artifacts ready in `apps/extension/.output/` (`loomextension-0.2.1-{firefox,chrome}.zip`) + full-monorepo source zip. **Connor uploads to AMO + Chrome manually** (re-upload kit: `SUBMISSION_0.2.1.md`). The seven changes (all dev-verified live on Frieren + ko/zh titles): (1) **Netflix mid-episode track-switch fix** — Netflix prefetches the NEXT episode's manifest (and moves the URL) ~21 min in while still playing the current episode; the old logic adopted it → reverted to Chinese + garbled timing. Fix anchors "what's playing" to the `<video>`'s `loadstart`/`emptied` media-swap, holding any different-title manifest as `pending` until a real swap. Pure reducer in `lib/captions/netflix/manifest-tracker.ts` (11 unit tests). (2) **Target defaults to the title's audio language** (Netflix `audioLangCode` from manifest audio tracks → `pickTarget` priority). (3) **Outline**: corners-only → 8-direction ring + outline/glow opacity now coupled to the line's master opacity (intentional divergence from web PGS `build-html.ts` — see comment). (4) **Active pill auto-fades** after 3s idle. (5) **Romanization line default**: only Japanese among CJK+Korean (their ruby already romanizes); Cyrillic/Thai/Indic/Hebrew/Arabic stay on. (6) **zh-Hant defaults to Pinyin** (Zhuyin still selectable). (7) **Collapsible settings sections**. PLUS **dev/prod postMessage channel namespacing** (`MAIN_SOURCE`/`ISO_SOURCE` in `lib/env.ts`, `-dev` suffix when `IS_DEV`) — fixes a side-by-side test contamination where the installed prod build's MAIN leaked tracklists into the dev ISO over the shared `window` (this masqueraded as the fix not working). Tests: **212** vitest (9 spec files). **always ship the full-monorepo source zip** (`git archive --format=zip -o apps/extension/.output/loom-source-<ver>.zip HEAD`), never WXT's partial `*-sources.zip` (omits `@loom/*` + lockfile → unbuildable). Reviewer build = `npm ci` at root → `cd apps/extension && npm run build:firefox:prod`. **v0.2.0 remains in/through store review; 0.2.1 supersedes it.** UI issue log: `apps/extension/UI_REVISIONS.md`.

**Claude's recommended next thrust: Step 6 — OCR / Synthetic Visual Engine pipeline.** Rationale: the extension is now a mature, shipped data source on YouTube **and** Netflix — exactly what Step 6 consumes — and the OCR sub-project is the **demonstrable artifact for PhD applications (Dec 2026 – Jan 2027) with a Sept 2026 demo target**, so it carries the real deadline. The owed `opt_in_training` wire-up (from 5f) is the seam connecting the extension's data flow to Step 6. Detailed in the `Synthetic Visual Engine — Phase 1` doc + `memory/reference_ocr_roadmap.md` (ask Connor before assuming its contents). **This is a recommendation, not a decision — Connor picks the thrust.** Alternative: finish a UI-polish round 2 + close the extension loose-ends below first.

**Near-term extension backlog (cheap, opportunistic — handle as reviewer feedback lands / between larger work):**
1. **I-2 Hindi romanization not appearing** — capability exists end-to-end (`hi`→indic→`romanize`; backend IAST via aksharamukha; romanize fetch already carries `phonetic_system`). Needs ONE live prod test: load a Hindi title on the dev build, read the `[Loom Romanize]` devlog — it distinguishes fetch-fail / no-phonetic-layer / rendered-nothing (`UI_REVISIONS.md` I-2). Likely a lang-code-resolution or line-render gap, not missing impl.
2. **UI elicitation round 2** — Connor had "more" issues beyond batch 1 (C-1…C-8 all done); `UI_REVISIONS.md` is the running tracker. Known residue: the alt-orth settings **preview** still visually draws Simplified *below* the reading while the live overlay draws it *above* (C-7 residue, cosmetic).
3. **5h-5 Netflix settings-panel platform awareness** — hide `tlang=` UI when `!supportsTranslate`; drop the manual/ASR badge on Netflix; "image-only on this title" degradation (the `no-captions` path already emits). Plus run more native languages (ko / zh-Hans / th / hi) beyond ja / zh-Hant.
4. **Owed extension follow-ups:** **tlang=en parser anomaly** (`&tlang=en` → full ~64 kB body but json3 extracts only 1 event; hypothesis: word-level `segs`); **Chrome MV3 runtime verify** (`npm run build:chrome`; load-unpacked + re-verify — `world:"MAIN"` is MV3-native); **stale-URL on rapid SPA nav** (likely fine, keyed by id).
5. **4g** (delete Streamlit) — lands anytime: remove `loom_app.py` + `app/`, drop `streamlit`/`pandas`/`pyarrow`/`pydeck`/`altair` from `requirements.txt`.

**Dev-build testing gotcha (cost us a confused reload 2026-06-19):** `build:firefox:dev` writes to `.output/firefox-mv2-dev/` (identity "Loom (Dev)"); `build:firefox`/`:prod` write to `.output/firefox-mv2/` (identity "Loom"). Connor reloads the temp add-on from the **`-dev`** folder. When a change is for him to live-test, build the **dev** variant (`LOOM_API_BASE=https://api.loom.nerv-analytic.ai npm run build:firefox:dev`) — a prod build never updates the folder he reloads from. See `memory/feedback_dev_build_output_dir.md`.

**Deploy mechanism:** Railway tracks `main` only — push via `git push origin monorepo-restructure:main` (fast-forward; `monorepo-restructure` is always a strict ancestor of `main` after merge). The backend redeploys only when `loom_api`/`loom_core` paths change (Railway `watchPatterns`); extension-only commits don't trigger one. Vercel (web app) also tracks `main`.

**Extension dev build against the live API (backend diagnosis — `47b5fcf`):** `LOOM_API_BASE=https://api.loom.nerv-analytic.ai npm run build:firefox:dev` → a dev-identity build ("Loom (Dev)", id `loom-dev@nerv-analytic.ai`, separate storage, verbose logs, dev-only owner-key field) pointed at the LIVE Railway API instead of localhost. Install side-by-side with the daily-driver via `about:debugging` → Load Temporary Add-on; lets you test extension changes (incl. Netflix) against real backend behavior. `LOOM_API_BASE` overrides the `--mode` default in `wxt.config.ts` (host_permissions follows it so the cross-origin `/annotate`+`/romanize` fetches aren't CORS-blocked); unset = identical to before, so prod CI is unaffected.

**Step 5 substeps:** **5a–5f ✅ shipped** (YouTube extension end-to-end, commits `2bc507c`→`fa760f3`): WXT foundation + popup + background; `yt-main.content.ts` MAIN-world tracklist read + `background.ts` webRequest pot-capture + lang-swap acquisition; dual-subs overlay (`caption-overlay.tsx`, `inheritStyles:true`); `/annotate/batch` per-token ruby (`lib/annotate/`, `annotated-text.tsx`); `/romanize/batch` full-utterance phonetic line (`lib/romanize/`); full settings panel (`settings-panel.tsx` — track switching, per-layer tlang, position picker, per-layer styling, presets, color wheel). Load-bearing gotchas live in **Tripwires** below. _(Still owed from 5f: `opt_in_training` flag wire-up — lands with step 6's OCR pipeline.)_

**5g ✅ public launch (now superseded by 0.2.0):** dev/prod split (`4f96296`); store kit (`525c46b`+`e82bc7c`: privacy page, icons, AMO `data_collection: websiteContent`, `STORE_LISTING.md`+`SIGNING.md`); global on/off kill switch + dev-only owner key (`lib/enabled.ts`); `/support`+`/donate` pages. 0.1.7 was the first YouTube-only public version. **Current submission is v0.2.0** (Netflix + UI overhaul, `e3b098d`) — field copy `SUBMISSION_0.2.0.md`; artifacts `apps/extension/.output/loomextension-0.2.0-{firefox,chrome}.zip` + `loom-source-0.2.0.zip`. **In flight:** AMO + Chrome review of 0.2.0.

**5i ✅ UI/defaults overhaul (shipped, `d944b45`).** Settings panel reorganized into 4 self-contained line-cards. 5i-1 pastel defaults + Simplified-'same as Top'; 5i-2 dot-in-pill `Switch` + native-annotation under Advanced; 5i-3 capability-driven phonetic-system picker (`phoneticSystemsFor`) + language-gated long-vowel/alt-orth; 5i-4 consolidation (`LayerStyleBlock` `children` slot); 5i-5 first-class per-line opacity + linked Top-group; C-8 per-line `Show line` master enable. C-6 collapse-to-one-line shipped then reverted (confusing). Full log: `apps/extension/UI_REVISIONS.md`.

**Step 5h — NETFLIX PORT (first pass ✅, live-verified 2026-06-19).** Governing rule: text-vs-image tracks **origin language** (ja/ko/zh/th/hi serve WebVTT on native-origin content). One `CaptionPlatform` impl + one MAIN entrypoint per site; the shared pipeline carries over unchanged. Full recon + Findings log in `NETFLIX_RECON.md`.
- **5h-1** `lib/captions/platform/{types,youtube,index}.ts` — `CaptionPlatform` acquisition seam (`acquireSession`+`fetchTrackEvents`+`supportsTranslate`); YouTube's pot-capture relocated behind it.
- **5h-2** (`878886a`) `netflix-main.content.ts` MAIN-world `JSON.parse`/`JSON.stringify` manifest hook (`document_start`) → same `loom-main`/`tracklist` message; filters `!forced && !none && hasWebVtt`; `platform/netflix.ts` (`acquireSession`→`{ok,handle:null}`, signed-WebVTT fetch, `supportsTranslate:false`); `netflix/parse-vtt.ts`; netflix.com+nflxvideo.net host perms. Image-only titles emit `no-captions` (for 5h-5 degradation).
- **5h-3** (`8650984`+`7d3b355`) `netflix.content.tsx` overlay anchored to `div[data-uia="player"]` (LCA of video + Netflix chrome → pill clickable above the controls; `video-canvas` trapped it one stacking-context below); overlay seam on `CaptionPlatform` (`playerRootSelector`/`videoSelector`/`hideNativeCaptions`, generalizing `player-scale.ts`/`stream.ts`/`caption-context.tsx`); `netflix-player-anchor.ts`; pill repositioned off the report-flag (`pill-position.ts`); pill/panel click isolation from Netflix play/pause (`stop-player-events.ts`). Playhead reuses `<video>.timeupdate`.
- **5h-4** (`7d3b355`) per-track stable `id` (YT vssId / NF trackId) + `isCc` flag on `CaptionTrack`; `auto-pick` ranks manual>asr then standard `subtitles`>SDH `closedcaptions`, CC-fallback when CC-only; fixes same-language-duplicate collisions (picker key/highlight + events cache now keyed by `id`).
- **5h-5** 🔲 STILL DEFERRED (the UI overhaul shipped without it) — settings-panel platform awareness (hide `tlang=` when `!supportsTranslate`; no manual/ASR badge on Netflix) + "image-only on this title" degradation. Now in the near-term backlog above.

**Architecture (locked 2026-05-03 — Option B, all-client + romanization API):** browser runs ffmpeg.wasm for video probe/extract/mux + JS ports of ASS generation + PGS rasterization (via html2canvas — see `ROADMAP.md` for why not SVG-foreignObject).  Server (`api.loom.nerv-analytic.ai` on Railway) only handles romanization: text-in / text-out, ~100KB request.  Drops backend bandwidth ~99% vs upload-everything; target hosting cost $5/mo flat.  Tradeoffs accepted: ~50MB initial JS bundle (one-time, cached), JS reimplementations of `loom_core/subs/processing.py::generate_ass_file` + `loom_core/rasterize/sup_writer.py` that must track the Python reference (drift risk — single source of truth lives in Python; JS port is a transcription), weak-device fallback to a future server-mode toggle.

**Step 4 (Option B web app) — ✅ complete except 4g.** 4a–4f shipped: npm workspaces + `apps/web` Next.js + `@loom/api-client` from OpenAPI; ffmpeg.wasm probe/extract/mux (`FFmpegClient`); full client-side `.ass`+`.sup` generation (`apps/web/lib/{subs,raster}/`, `LoomGenerator`); slim text API (`loom_api/web.py` + `routes/{romanize,annotate}.py`); deployed live at `https://loom.nerv-analytic.ai` + `https://api.loom.nerv-analytic.ai` (Railway + Vercel, slowapi rate-limits, Tier-A bypass auth). **4g 🔲** (lands anytime): delete Streamlit — remove `loom_app.py` + `app/`, drop `streamlit`/`pandas`/`pyarrow`/`pydeck`/`altair` from `requirements.txt`, update Project Structure below.

**Hosting + domain (live):** frontend on Vercel as `https://loom.nerv-analytic.ai` (custom domain CNAME → `dfa544d4c362bfd9.vercel-dns-017.com`); API on Railway as `https://api.loom.nerv-analytic.ai` (custom domain CNAME → `xsbnnuf3.up.railway.app`, plus `_railway-verify.api.loom` TXT for SSL).  Namecheap is the registrar.  Cost: $5/mo Railway hobby tier + $0/mo Vercel hobby = $5/mo flat (per the original target).

**Auth + rate limiting (live):** slowapi `100/minute,2000/day` per IP (override via `LOOM_RATE_LIMIT` env), 5000-char `text` field cap on `/romanize` + `/annotate` request models.  Owner bypass via `LOOM_BYPASS_KEYS` env + `X-Loom-Auth` header — see Owner Auth Roadmap section.

**Step 4 deferred follow-ups:**
- **Desktop backfill onto `@loom/api-client`** — 4a-5 attempt surfaced 9 legitimate type errors (generated types are stricter than hand-written ones — proper literal unions like `phonetic_system`, `null` vs `undefined` distinctions on optional fields).  Needs per-call-site refactor, not a 5-min rewrite.  Drift risk bounded as long as backend changes propagate to `apps/desktop/src/api.ts` + `apps/desktop/src/styles.ts` in the same commit.

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
| 5 | 🟢 5a–5i ✅; v0.2.0 in store review; 5h (Netflix) first pass ✅ | WXT browser extension at `apps/extension/`. 5a–5f shipped May 2026 (`2bc507c`→`fa760f3`). **Netflix port (5h-1→5h-4) ✅ live-verified 2026-06-19** — MAIN-world JSON.parse manifest hook + `div[data-uia="player"]` overlay anchor. **UI/defaults overhaul (5i) ✅** (`d944b45`) — 4 line-cards, capability-driven phonetic picker, per-line enable, pastel defaults. **v0.2.0 (Netflix + overhaul) submitted to AMO + Chrome 2026-06-19** (`e3b098d`) — see Quick-Start + `SUBMISSION_0.2.0.md`. YouTube caption access uses webRequest interception + lang-swap (PO-token moat in `memory/reference_youtube_caption_acquisition_2026.md`). **Next: Connor picks the thrust — Claude recommends Step 6 OCR (the PhD-apps artifact).** Major OCR data source from 5f's `opt_in_training` toggle wire-up (still owed). |
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

Production rate limits (slowapi 100/min, 2000/day per IP; 5000-char per-request cap) protect the slim API from abuse but also block legitimate high-volume operator use — notably the Step 6 OCR synthetic-data pipeline, which will fan out tens of thousands of romanize/annotate calls. The owner-auth path lets Connor (and only Connor) bypass the limiter without weakening defenses for everyone else. Three additive tiers; A satisfies v1.

**Tier A — pre-shared bypass key (✅ shipped, live).** Secret(s) live in Railway env `LOOM_BYPASS_KEYS` (comma-separated, supports rotation). Visit `loom.nerv-analytic.ai/?owner_key=<secret>` once per device → `OwnerKeyBootstrap` (`apps/web/components/owner-key-bootstrap.tsx`) stashes it in `localStorage.loom_owner_key` and cleans the URL. Every API call then carries `X-Loom-Auth: <secret>` via the `openapi-fetch` middleware in `apps/web/lib/api/client.ts` (read per-request, so a fresh value takes effect immediately). Server-side, `BypassAwareSlowAPI` (`loom_api/web.py`) wraps `SlowAPIMiddleware` and skips the limiter *entirely* for allow-listed keys (`hmac.compare_digest`, constant-time). A floating "owner mode" pill shows when active. **Reset:** `localStorage.removeItem("loom_owner_key")` or visit `/?owner_key=`. **Rotate:** change `LOOM_BYPASS_KEYS` (invalidates all devices at once) and re-issue. Limitations (acceptable for v1): per-device not per-identity; key briefly appears in URL/history; no per-device revocation.

**Tiers B & C (planned / deferred).** B = Google OAuth identity binding (per-email allow-list + minted session JWT); C = Cloudflare Access network gate. Both are strictly additive over Tier A's `X-Loom-Auth` path. Full design, triggers, and cost in **`ROADMAP.md` → Owner Auth (Tiers B/C)**.

---

## Capability Matrix

**Purpose:** at-a-glance visibility into which features have reached which surfaces. Backend (`loom_core` + `loom_api`) is the single source of truth — frontends call the API, never reimplement engine logic. Frontend rows track UI affordance, not capability (a feature with backend ✅ is callable from any frontend the moment its UI lands).

**Update protocol:** when shipping a feature, add a row OR update an existing row's columns in the same commit as the code. Don't ship a backend change without updating the matrix — drift here is the failure mode this exists to prevent.

**Legend:** ✅ shipped · 🟡 partial · ⏳ planned · — N/A by design

| Feature | Engine | API | Desktop | Web | Extension |
|---|---|---|---|---|---|
| **Subtitle ingestion** | | | | | |
| `.srt` / `.ass` / `.ssa` / `.vtt` upload | ✅ | ✅ | ✅ | ✅ | ⏳ |
| Local file picker (zenity / native) | ✅ | ✅ | ✅ | — | — |
| External video file scan (MKV tracks) | ✅ | ✅ | ✅ | ✅ | — |
| Multi-style fansub classifier (signs / OP / ED / staff filtered out) | ✅ | ✅ | ✅ | ✅ | ⏳ |
| YouTube URL → subtitle pull (yt-dlp) | ⏳ | ⏳ | — | ⏳ | — |
| YouTube caption interception (webRequest + lang-swap; PO-token gated) | — | — | — | — | ✅ 5b |
| Real-time caption playhead tracking on streaming video | — | — | — | — | ✅ 5b |
| Dual-subs overlay above streaming-video caption area | — | — | — | — | ✅ 5c |
| Live track switching mid-playback (with cached events) | — | — | — | — | ✅ 5f-diag |
| Per-tab activation gate (dormant by default) | — | — | — | — | ✅ 5d-perf |
| Per-character annotation ruby (furigana / Pinyin / Zhuyin / Jyutping / RR) | — | — | — | — | ✅ 5d |
| `/annotate/batch` single-shot fetch | — | ✅ | — | — | ✅ 5d |
| `/romanize/batch` single-shot fetch (secondary phonetic line) | — | ✅ | — | — | ✅ 5e |
| Alternate-orthography ruby (zh-Hant ↔ Simplified) | ✅ table | — static client-side lookup | — | ⏳ | ✅ 5f |
| Distinct / Merged tier highlight (forward-collapse marker) | ✅ data | — | — | ⏳ | ✅ 5f |
| Inline live preview of orthography pair (語→语 + 髮→发+發) | — | — | — | — | ✅ 5f |
| **Romanization** (engine + API ✅ for all) | | | | | |
| Chinese (Pinyin / Zhuyin / Jyutping) | ✅ | ✅ | ✅ | ✅ | ✅ ruby + line (5e) |
| Japanese (MeCab + furigana, 3 long-vowel modes) | ✅ | ✅ | ✅ | ✅ | ✅ ruby + line (5e) |
| Korean (RR per-syllable + word-level) | ✅ | ✅ | ✅ | ✅ | ✅ ruby + line (5e) |
| Cyrillic (ru / uk / be / sr / bg / mk / mn) | ✅ | ✅ | ✅ | ✅ | ✅ line (5e) |
| Thai (paiboon / RTGS / IPA) | ✅ | ✅ | ✅ | ✅ | ✅ line (5e) |
| Indic (hi / bn / ta / te / gu / pa) | ✅ | ✅ | ✅ | ✅ | ✅ line (5e) |
| Hebrew | ✅ | ✅ | ✅ | ✅ | ✅ line (5e) |
| Arabic / Persian / Urdu | ✅ | ✅ | ✅ | ✅ | ✅ line (5e) |
| **Output generation** | | | | | |
| `.ass` 3- or 4-layer file | ✅ | ✅ | ✅ | ✅ | ⏳ |
| `.sup` (PGS) bitmap rasterization | ✅ | ✅ | ✅ | ✅ | — |
| Live HTML composite preview | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Output filename builder | ✅ | ✅ | ✅ | ⏳ | — |
| MKV mux (ffmpeg subtitle merge) | ✅ | ✅ | ✅ | ✅ | — |
| **Style customization** | | | | | |
| Per-layer color | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
| Per-layer font family + size | ✅ | ✅ | ✅ | ⏳ | ✅ Bottom/Top/Annotation/Romanization (5e) |
| Per-layer alpha (text color opacity) | ✅ | ✅ | ✅ | ⏳ | ✅ first-class opacity slider + linked Top-group (5i-5) |
| Per-line master show/hide enable | — | — | — | — | ✅ Top/Bottom (5i C-8); Top off hides its annotation+romanization+alt-orth |
| Per-language phonetic-system picker (capability-driven) | ✅ | ✅ | ✅ | — | ✅ Chinese/Thai/Arabic/Persian/Urdu via `phoneticSystemsFor` (5i-3) |
| Per-layer outline color + alpha | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
| Per-layer glow (radius + color + alpha) | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
| Per-layer shadow | ✅ | ✅ | ✅ | ⏳ | 🟡 hardcoded black @ 0.7; not yet user-controllable |
| Inline HSV color wheel | — | — | — | ⏳ | ✅ 5f (react-colorful) |
| Top stack position + layer gaps | ✅ | ✅ | ✅ | ⏳ | 🟡 4-slot picker (top-1/2 + bottom-1/2) |
| Color presets (28, 4 categories, lang-scoped) | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
| Per-layer tlang= machine translation | — | ✅ | — | — | ✅ 5f-diag |
| Output resolution scaling (480p–2160p + match) | ✅ | ✅ | ✅ | ⏳ | — |
| **Timing / sync** | | | | | |
| Manual offset (per-track ms shift) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Auto-alignment (histogram + fine pass) | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| **Fonts** | | | | | |
| Bundled Noto manifest (29 faces) | ✅ | ✅ | ✅ | 🟡 | ⏳ |
| `@font-face` CSS w/ unicode-range routing | ✅ | ✅ | ✅ | 🟡 | ⏳ |
| FontScanner (validate + missing-char warn) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ |
| **Deployment** | | | | | |
| Public web URL (`loom.nerv-analytic.ai`) | — | — | — | ✅ | — |
| Slim text-processing API (`api.loom.nerv-analytic.ai`) | — | ✅ | — | — | — |
| Rate limiting (slowapi 100/min, 2000/day per IP) | — | ✅ | — | — | — |
| Owner bypass auth (Tier A: `X-Loom-Auth`) | — | ✅ | — | ✅ | — |
| **Distribution / packaging** | | | | | |
| Linux desktop bundle (`.deb` + `.rpm`) | — | — | ✅ | — | — |
| AppImage | — | — | ⏳ | — | — |
| macOS desktop bundle (`.app` + `.dmg`) | — | — | ⏳ | — | — |
| Windows desktop bundle (`.msi` + `.nsis`) | — | — | ⏳ | — | — |
| Tauri auto-updater (multi-hundred-MB diffs) | — | — | ⏳ | — | — |
| **OCR data pipeline** (step 5 → step 6) | | | | | |
| `opt_in_training` flag on requests | ✅ | ✅ | — | ⏳ | ⏳ wire-up owed in 5f's settings UI |
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

## Tripwires — load-bearing, don't relearn these

**Extension (`apps/extension`):**
- **NO `backdrop-filter` anywhere.** The pill + panel render over YouTube's continuously-repainting player; `backdrop-filter` re-blurs the underlying pixels every frame → main-thread saturation → multi-second input lag. Use a solid `rgba(...)` background with opacity ≥ 0.94. (`components/loom-pill.tsx`, `components/settings-panel.tsx` headers.)
- **The pill MUST NOT depend on `target`/`native` from context.** A compact-mode toggle keyed on caption text re-rendered the pill every dialogue boundary, generating new inline styles that triggered overlapping CSS transitions that never settled. The pill reads only `status` and is wrapped in `React.memo`; compact mode was dropped.
- **The shadow host MUST be on its own compositor layer.** `transform: translateZ(0); will-change: transform; contain: layout paint style` on `loom-overlay-root` (`injectHostPositioningStyle` in `content.tsx`), else YT's progress-bar tick + control auto-hide cascade through our paint surface on the main thread. Same `translateZ(0)` on the pill button for defense-in-depth.
- **WXT `build` defaults to `chrome-mv3`.** `npm run build` → `.output/chrome-mv3/`; Firefox testing needs `npm run build:firefox` → `.output/firefox-mv2/`. If UI changes "aren't appearing" after a reload, check `.output/firefox-mv2/` mtime before hunting a logic bug.
- **Nested-`<ruby>` outer-rt position is inverted on Firefox MV2.** Per-rt `ruby-position` is honoured for flat single-rt rubies but ignored (forced to `over`) for the outer rt of a nested ruby. **In the live overlay the Simplified auxiliary ruby therefore renders ABOVE the reading/annotation line** — the desired, kept behavior (reads better pedagogically). Any prose calling it "Simplified below" is wrong; the language coding is unchanged, only the description. NOTE the settings-panel preview still uses flat single-rt rubies and so VISUALLY shows Simplified below the reading — a known preview-vs-live divergence to reconcile in the UI overhaul (`UI_REVISIONS.md` C-7). (`annotated-text.tsx` header.)
- **react-colorful's runtime CSS auto-inject doesn't reach the shadow root.** It `appendChild`s a `<style>` to `document.head`, which our shadow DOM doesn't inherit. The CSS is vendored verbatim in `settings-panel.tsx::REACT_COLORFUL_CSS` (pinned to 5.6.1; re-extract via the regex-walker noted there when bumping).
- **`tlang=` is intrinsically lock-step.** A `tlang` override makes YouTube emit one MT'd event per source event with identical timing — that's the API, not a regression. Visible only where source-event boundaries don't match English sentence boundaries (Chinese mid-clause splits being canonical). If "tracks are no longer independent" is reported, first check whether the native side is `(auto)`/tlang.

**Extension — Netflix (`apps/extension`, step 5h):**
- **Anchor the overlay to `div[data-uia="player"]`, NOT `div[data-uia="video-canvas"]`.** video-canvas is a child of player; Netflix's control chrome (back/flag/bottom bar) lives in `player`, ABOVE video-canvas's stacking context — so an overlay mounted in video-canvas (even at max z-index) is trapped *below* the controls and the pill is unclickable while the chrome is up. `player` is the lowest common ancestor of the `<video>` and the controls (confirmed via LCA probe), so our max-z wins there. It also wraps video-canvas as the same box (captions/scale unchanged) and is inside the fullscreen subtree. (`lib/overlay/netflix-player-anchor.ts`.)
- **Pill/panel clicks must `stopPropagation`.** Netflix toggles play/pause on a bubble-phase `click` on the player surface (and dblclick→fullscreen). Since the overlay lives inside `player`, every pill toggle / in-menu click leaked to it. Swallowed at the pill + panel boundary via `lib/overlay/stop-player-events.ts` (stopPropagation, not preventDefault). Safe because the panel's click-outside dismiss is a CAPTURE-phase document listener (fires first). YouTube doesn't pause on overlay clicks → harmless there.
- **Identify tracks by `id`, never `languageCode`.** Netflix exposes multiple tracks per language (plain "English" + "English (CC)"); matching on languageCode collapsed them → dual-highlight, duplicate React keys, events-cache collisions. `CaptionTrack.id` (YT vssId / NF manifest trackId) is the identity for picker key + selection + cache. `isCc` (`rawTrackType==="closedcaptions"`) lets `auto-pick` prefer standard subtitles while keeping CC selectable.
- **Manifest hook runs MAIN-world at `document_start`.** The hook must monkey-patch `JSON.parse`/`JSON.stringify` BEFORE the player fetches its (MSL-encrypted) manifest. The stringify hook injects the `webvtt-lssdh-ios8` profile so the server returns WebVTT URLs. (`entrypoints/netflix-main.content.ts`.)

**Web app (`apps/web`) — ffmpeg.wasm:**
- The `FFmpeg` class has no `worker.onerror` listener: a worker that fails to boot hangs `load()` forever. Hardened via `FFmpegClient.#init` → `withTimeout` + window-level error capture on the test page.
- `classWorkerURL` MUST be a fully-qualified URL with origin (`${window.location.origin}/ffmpeg`); a path-only string resolves against `import.meta.url` → `file://` and the browser blocks it.
- ffmpeg-core MUST be the ESM build (`@ffmpeg/core/dist/esm/`); the module worker does `(await import(coreURL)).default`. UMD has no default export and silently hangs `load()`.
- TS `moduleResolution: bundler` doesn't map `.js` → `.ts` for value imports — drop the `.js` suffix on imports across `apps/web/lib/`.
- **General rule** (`feedback_async_hang_prevention.md`): every promise from third-party code goes through `withTimeout()` with a labeled rejection. Silent hangs are a banned bug class.

**Desktop (`apps/desktop`):**
- **Dev-mode fonts:** Tauri 2's `resource_dir()` in dev returns the build-artifact dir, not `src-tauri/resources/`; during `npm run tauri dev` set `LOOM_FONT_DIR=$PWD/apps/desktop/src-tauri/resources/fonts` manually. Production bundles read the real resource dir.

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
3. Forward-looking plans (v1.5 / v2 / long-term backlog, Owner Auth Tiers B/C, the PGS-in-browser spike verdict) live in `ROADMAP.md`
4. Full session-by-session implementation history lives in the dated archives at `/home/connor/Documents/projects/general_project_notes/notes/srtstitcher/CLAUDE*_ARCHIVE.md`
