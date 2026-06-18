# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session. Full session-by-session history lives in the dated archives at `general_project_notes/notes/srtstitcher/CLAUDE*_ARCHIVE.md`.

**Current state (end of 2026-06-15 session):** Steps 1–4 shipped (4f live; 4g Streamlit-deletion pending). Step 5 (browser extension): **5a–5f shipped; 5g (store distribution) is actively in submission.** The extension renders the full 4-layer stack on YouTube: native (Bottom) + foreign (Top) + per-token annotation ruby (furigana / Pinyin / Zhuyin / Jyutping, auto-routed via `classifyLang` / Korean RR) + a **secondary full-utterance romanization line** covering every phonetic-layer language (CJK + Korean get both ruby and the line; Cyrillic / Thai / Indic / Hebrew / Arabic-Persian-Urdu get the line as their whole phonetic surface). Both layers fetch as a single batch POST on activation — `/annotate/batch` per (target_track, phonetic_system) and `/romanize/batch` per (track, phonetic_system, long_vowel_mode), ~3–4 s, then quiet. **Per-tab activation** (every YouTube tab starts dormant with a "Loom" pill; click to activate; `sessionStorage` persists across same-tab reloads) **plus a global on/off kill switch** (`lib/enabled.ts`, `browser.storage.local`, defaults on) surfaced as a popup toggle — when off, `LoomApp` renders nothing AND the background `webRequest` listener early-returns (zero timedtext observation, not just visual). The settings panel covers live track switching (manual/ASR badges + processing-tier indicators), per-layer `tlang` overrides, a 4-slot position picker, full per-layer styling (color + font + size + alpha + outline + glow for Bottom/Top/Annotation/Romanization), annotation + romanization toggles, alternate-orthography ruby (zh-Hant → Simplified) with Distinct/Merged tier highlights, 28 lang-aware color presets (from `/styles/presets`), an inline HSV color wheel (react-colorful), and a ☕ "Support Loom" link at the top (→ `/donate`). All persisted to `browser.storage.local`. **The owner-key field is now dev-only** (gated behind `IS_DEV`, dead-code-eliminated from prod bundles — verified absent from `firefox-mv2` + `chrome-mv3`); the web app retains the Tier-A owner key. `logDev` is gated behind `IS_DEV` (prod ships quiet). **Extension at v0.1.7** — 0.1.6 was used as a self-distributed AMO test, so the public listed + Chrome version is 0.1.7 (AMO version numbers must be unique across channels). **Build-time dev/prod split** ("Loom" vs "Loom (Dev)", distinct IDs, API base + verbosity via `lib/env.ts`). **Netflix port: UNDER ACTIVE BUILD (step 5h).** Recon executed + corrected via live authenticated capture (2026-06-18 session): text (WebVTT) availability is governed by **origin language** — **ja/ko/zh/th/hi all serve text on native-origin content** (anime, K/C/J-drama, Thai/Indic), which IS the core learner use case; image-based (OCR-only) subs only hit the off-axis case (target language as a *foreign translation* of foreign-origin content). Acquisition is a **MAIN-world `JSON.parse` manifest hook** (not webRequest). **5h-1 + 5h-2 + 5h-3 built:** caption pipeline refactored platform-agnostic behind `lib/captions/platform/` (`CaptionPlatform` interface). **5h-2** added the Netflix data path — `netflix-main.content.ts` (MAIN-world `JSON.parse`/`JSON.stringify` manifest hook), `platform/netflix.ts` (signed-WebVTT-URL fetch, `supportsTranslate:false`), `netflix/parse-vtt.ts`. **5h-3** added the first Netflix overlay — `netflix.content.tsx` (ISO mount on `div[data-uia="video-canvas"]`) + an overlay seam on `CaptionPlatform` (`playerRootSelector`/`videoSelector`/`hideNativeCaptions`) that generalized `player-scale.ts`/`stream.ts`/`caption-context.tsx` off their YouTube-hardcoded selectors; YouTube behavior unchanged. 186 vitest green; firefox-mv2 + chrome-mv3 both build. **NOT yet visually verified on a live Netflix tab** — that's the next owed step. (`NETFLIX_RECON.md` + `spike/netflix/`). Production: `api.loom.nerv-analytic.ai` serves `/annotate/batch` + `/romanize/batch` + `/styles/presets`; web app live at `https://loom.nerv-analytic.ai` with `/privacy`, **`/support` (technical support/FAQ — the canonical store Support URL)**, and **`/donate` (PayPal + Venmo)**. Tests: **626** `test_` functions in `loom_core` (`tests/`) + **186** vitest cases (8 spec files) in `apps/extension`. _(static counts — re-run to confirm pass totals.)_

**🎯 Active focus next session — NETFLIX PORT step 5h (active build; store review is in flight and out of our hands):**
1. **Netflix port — in build.** Recon is DONE and corrected (see the **Step 5h substeps** table below + `NETFLIX_RECON.md` Findings log + `memory/reference_netflix_caption_acquisition_2026.md`). Settled facts: manifest is **MSL-encrypted** → acquisition is a **MAIN-world `JSON.parse`/`JSON.stringify` hook** (NOT webRequest); player API (`netflix.appContext…getCurrentTime/getDuration`) + DOM anchor (`div[data-uia="video-canvas"]`) confirmed live; tracks carry **signed WebVTT URLs** (~12 h TTL) straight off the manifest, fetched directly (no pot/lang-swap). Text vs. image is governed by **origin language**, NOT language identity (an early "Korean = image everywhere" draft was JJK-anime over-fit; corrected by the Squid Game capture). **ja/ko/zh/th/hi all serve text on native-origin content** = the core use case. Spike parser validated on 4 real captures (`netflix-{ja,ko,th,hi}.vtt`, 371/1118/19/2836 cues). **`auto-pick` MUST exclude `forced`+`none` and prefer plain `subtitles` over SDH `closedcaptions`** (the `th` sample was the forced track → 19 cues; ko CC is full of `[음악]` SDH brackets). **5h-2 + 5h-3 BUILT this session** (5h-2 committed `878886a`; 5h-3 uncommitted). 5h-2: `netflix-main.content.ts` manifest hook + `platform/netflix.ts` + `netflix/parse-vtt.ts`. 5h-3: `netflix.content.tsx` ISO overlay mount + overlay seam on `CaptionPlatform` (`playerRootSelector`/`videoSelector`/`hideNativeCaptions`) + `netflix-player-anchor.ts`; generalized `player-scale.ts`/`stream.ts`/`caption-context.tsx` off their YT-hardcoded selectors; playhead reuses `<video>.timeupdate` (not rAF). tsc clean, 186/186 vitest, firefox+chrome build. **NEXT: 5h-4** — `auto-pick` refinements (exclude `forced`+`none` already done MAIN-side; still need: prefer plain `subtitles` over SDH `closedcaptions`, fall back to CC when CC-only, handle 2–4 per-lang variants). **BUT FIRST owed: live visual verify of 5h-2+5h-3 on an authenticated Netflix tab** — the whole overlay path (anchor positioning on `video-canvas`, `.player-timedtext` hide, scale, playhead sync, WebVTT fetch from `nflxvideo.net`) is untested on a real page; per `feedback_extension_caption_verification`, caption-acquisition can't be validated by unit tests.
2. **5g store review (in flight — monitor, don't re-do).** AMO listed + Chrome Web Store both submitted at **v0.1.7**. Waiting on reviewers; act only on approval/rejection feedback. If a re-upload is ever needed: field copy in `SUBMISSION_0.1.7.md`, disclosures/justifications in `STORE_LISTING.md`, and **always ship the full-monorepo source zip** (`git archive --format=zip -o apps/extension/.output/loom-source-<ver>.zip HEAD`) — never WXT's partial `*-sources.zip` (omits `@loom/*` workspace packages + lockfile → unbuildable). Reviewer build = `npm ci` at root → `cd apps/extension && npm run build:firefox:prod`.
3. **Owed extension follow-ups (carry over from 5b–5e):**
   - **tlang=en parser anomaly** — `&tlang=en` returns a full ~64 kB body but the json3 parser extracts only 1 event. Will bite JA-only videos that need MT for Bottom. Hypothesis: tlang responses use word-level `segs` / a different events structure than native tracks.
   - **Chrome MV3 verification** — developed on Firefox MV2 only. WXT builds both (`npm run build:chrome`); load-unpacked in Chrome and re-verify (`world: "MAIN"` is MV3-native, should "just work").
   - **Stale-URL on rapid SPA navigation** — likely fine (keyed by videoId); worth confirming on a busy navigation session.
4. **4g** (delete Streamlit) — unblocked, can land anytime: remove `loom_app.py` + `app/`, drop `streamlit`/`pandas`/`pyarrow`/`pydeck`/`altair` from `requirements.txt`.

**Deploy mechanism:** Railway tracks `main` only — push via `git push origin monorepo-restructure:main` (fast-forward; `monorepo-restructure` is always a strict ancestor of `main` after merge). The backend redeploys only when `loom_api`/`loom_core` paths change (Railway `watchPatterns`); extension-only commits don't trigger one. Vercel (web app) also tracks `main`.

**Step 5 substeps:**
| | Status | Ships | Goal |
|---|---|---|---|
| 5a | ✅ `2bc507c` | `apps/extension/` WXT workspace + content script + popup + owner-key + background service worker | Foundation.  Extension loads, pill renders on YouTube, popup `/health` smoke passes with owner bypass. |
| 5b | ✅ `2bc507c` + `b1d2a82` | `entrypoints/yt-main.content.ts` (MAIN world) + `entrypoints/background.ts` (webRequest + first-pot URL picker via `lib/captions/url-picker.ts`) + `lib/captions/{discover,fanout,stream,auto-pick,types}.ts`.  Natural-prefetch-first + CC-toggle-fallback trigger. | YouTube caption acquisition via webRequest interception + lang-swap, immune to multi-timedtext-request reality (incl. user manually clicking YT's CC). |
| 5c | ✅ `b1d2a82` | `components/caption-overlay.tsx` + `lib/overlay/{player-scale,hide-yt-captions}.ts` + `entrypoints/content.tsx` (**`inheritStyles: true`** to defeat WXT's `:host{all:initial!important}` reset) | Dual-subs overlay survives fullscreen + theater mode via player-anchoring; YT's caption box suppressed during tracking; typography scaled to player height. |
| 5d | ✅ `2ba8389` → `f7f4d66` | `/annotate/batch` backend endpoint (`loom_api/routes/annotate.py`) + `lib/annotate/{build-map,cache,types}.ts` + `components/annotated-text.tsx` + extended `discover.ts` payload (annotateMap fields).  Single-shot batch on activation, ~3-4s wait, then silence.  CJK + Korean shipped; non-CJK families (Thai/Indic/Cyrillic/Hebrew/Arabic) deferred. | The headline — per-token readings render live above the foreign text.  Browser-native `<ruby>` + `<rt>`; ratio-based size scaling. |
| 5e | ✅ `b35451d` + `fa760f3` | `/romanize/batch` backend endpoint (`loom_api/routes/romanize.py`, +17 tests in `tests/test_romanize_batch.py`) + `lib/romanize/{types,cache,build-map}.ts` (mirror of `lib/annotate/`) + 4th `LayerStyleBlock` in settings + 4th overlay slot (above Annotation) + `discover.ts` `targetRomanizeEnabled`/`nativeRomanizeEnabled`/`longVowelMode` state. | Secondary full-utterance romanization line — every phonetic-layer language. One `/romanize/batch` POST per (track, phonetic_system, long_vowel_mode) on activation; same lifecycle as 5d. Empty-string results for `has_phonetic_layer=False` langs (no mid-batch 400). |
| 5f | 🟢 effectively complete (sans `opt_in_training`) | `components/settings-panel.tsx` + `components/{loom-app,dormant-pill}.tsx` + extended `caption-context.tsx` + new `lib/{orthography,presets}/`.  Per-tab activation, live track switching, per-layer tlang, position picker, per-layer styles (color + font + size + alpha + outline color/alpha + glow radius/color/alpha), annotation toggle + phonetic-system picker, alternate-orthography ruby + tier highlights, 28 thematic color presets (lang-aware via `/styles/presets`), inline HSV color wheel via react-colorful, native lang preference.  Functionally on par with the desktop's Style editor.  **Pending:** `opt_in_training` flag wire-up (lands with step 6's OCR pipeline; no archival code yet). | User-controllable demo surface, ship-ready except for OCR data-flow toggle. |
| 5g | 🟡 in submission | Dev/prod split ✅ (`4f96296`), store kit ✅ (`525c46b` + `e82bc7c`: privacy page, icons, AMO `data_collection: websiteContent`, `STORE_LISTING.md` + `SIGNING.md`), screenshots ✅. Global on/off kill switch + dev-only owner key ✅ (`lib/enabled.ts`); `logDev` re-gated ✅. Web pages: `/support` (FAQ), `/donate`, `/help`→merged. Bumped to **0.1.7** for the public listing (0.1.6 was a self-distributed AMO test). Submission field copy in `SUBMISSION_0.1.7.md`. **In progress:** AMO listed review + Chrome Web Store review. **Source-upload rule:** ship the full-monorepo `loom-source-<ver>.zip` (`git archive HEAD`), never WXT's partial `*-sources.zip`. **Remaining after approval:** Chrome MV3 runtime verification; tlang=en parser; stale-URL fix. | Public launch. See PUBLISH_PLAN.md. |

**Step 5h substeps — NETFLIX PORT (active):** Recon GO, validated on real authenticated captures (2026-06-18). Governing rule: text-vs-image tracks **origin language** — ja/ko/zh/th/hi serve WebVTT text on native-origin content (the core learner use case); image-based (OCR-only) only hits the off-axis "target language as a foreign translation" case. The shared pipeline (overlay, annotate/romanize, settings, `CaptionEvent`/`CaptionTrack`, playhead) carries over unchanged; each platform is one `CaptionPlatform` impl + one MAIN entrypoint. Full plan + Findings log in `NETFLIX_RECON.md`.
| | Status | Ships | Goal |
|---|---|---|---|
| 5h-1 | ✅ done (this session) | `lib/captions/platform/{types,youtube,index}.ts` — `CaptionPlatform` interface (acquisition seam: `acquireSession` + `fetchTrackEvents` + `supportsTranslate`); YouTube's pot-capture + json3 lang-swap relocated behind it; `discover.ts` split `session.capturedUrl` → `acquired` (ready flag) + `acquisitionHandle` (opaque handle, null-OK for Netflix). | Caption acquisition platform-agnostic. **YouTube byte-for-byte unchanged; tsc clean; 172/172 vitest green; firefox:prod builds.** _(not yet committed.)_ |
| 5h-2 | ✅ done (this session) | `entrypoints/netflix-main.content.ts` (MAIN-world `JSON.parse`/`JSON.stringify` manifest hook at `document_start` → emits the same `{source:"loom-main", type:"tracklist", …}` message; filters `!forced && !none && hasWebVtt`; maps `language`→`languageCode`, signed WebVTT URL→`baseUrl`; movieId-dedup; responds to `request-tracklist`; no `trigger-cc`) + `lib/captions/platform/netflix.ts` (`acquireSession`→`{ok:true, handle:null}`; `fetchTrackEvents`→fetch `track.baseUrl` + `parseVtt`; `supportsTranslate:false`) + `lib/captions/netflix/parse-vtt.ts` (port of `spike/netflix/parse-vtt.mjs`, +14 vitest) + netflix.com branch in `platform/index.ts` + `wxt.config.ts` netflix.com/nflxvideo.net host perms + match. **tsc clean; 186/186 vitest green; firefox-mv2 + chrome-mv3 both build with `netflix-main.js` registered MAIN/document_start.** _(not yet committed.)_ Image-only titles surface `no-captions` (manifest had text tracks but no WebVTT) for 5h-5's graceful degradation. | Netflix discovery + track enumeration + WebVTT fetch/parse — the data path. Not visually verifiable alone (needs 5h-3's overlay subscriber). |
| 5h-3 | ✅ built (this session; live-verify owed) | `entrypoints/netflix.content.tsx` (ISO overlay mount on `div[data-uia="video-canvas"]`, mirrors `content.tsx`) + overlay seam on `CaptionPlatform` (`playerRootSelector` + `videoSelector` + `hideNativeCaptions`/`restoreNativeCaptions`, generalizing `player-scale.ts` + `stream.ts` + `caption-context.tsx`'s YT-hardcodes) + `lib/overlay/netflix-player-anchor.ts` (selectors + `.player-timedtext` hide + `ensureAnchorPositioned`). **Playhead reuses `<video>.timeupdate`** (platform-resolved `videoSelector`, ~4×/s — same cadence YouTube always used; rAF seam noted in `stream.ts` if live testing shows it's too coarse), NOT the rAF poll the recon sketched. tsc clean; 186/186 vitest; firefox-mv2 + chrome-mv3 both build with `netflix.js` (ISO, document_idle) + `netflix-main.js` registered. _(not committed yet.)_ | First Netflix overlay render; parity with YouTube. **Still owed: live visual verify of 5h-2+5h-3 together on an authenticated Netflix tab** (anchor positioning, `.player-timedtext` hide, scale, sync — all untested on a real page). |
| 5h-4 | 🔲 NEXT | `auto-pick` refinements the multi-track reality forces: exclude `forced`+`none`; prefer plain `subtitles` over SDH `closedcaptions` (fall back to CC when CC-only, e.g. JP-anime / Thai origin); handle 2–4 per-language variants (trackId tails `;0;0;0/3/4/13;`). | Correct track selection on real Netflix tracklists. |
| 5h-5 | 🔲 | Settings-panel platform awareness (`platform: "youtube" \| "netflix"` discriminator in `caption-context`): hide tlang= UI when `!supportsTranslate`; Netflix has no manual/ASR badge distinction. Graceful "image-only subtitles on this title" degradation (detect absent WebVTT). | Settings + degradation polish. |

**Architecture (locked 2026-05-03 — Option B, all-client + romanization API):** browser runs ffmpeg.wasm for video probe/extract/mux + JS ports of ASS generation + PGS rasterization (via html2canvas — see `ROADMAP.md` for why not SVG-foreignObject).  Server (`api.loom.nerv-analytic.ai` on Railway) only handles romanization: text-in / text-out, ~100KB request.  Drops backend bandwidth ~99% vs upload-everything; target hosting cost $5/mo flat.  Tradeoffs accepted: ~50MB initial JS bundle (one-time, cached), JS reimplementations of `loom_core/subs/processing.py::generate_ass_file` + `loom_core/rasterize/sup_writer.py` that must track the Python reference (drift risk — single source of truth lives in Python; JS port is a transcription), weak-device fallback to a future server-mode toggle.

**Step 4 substeps (Option B):**
| | Status | Ships | Goal |
|---|---|---|---|
| 4a | ✅ `fac632e` | npm workspaces + `apps/web/` Next.js scaffold + `packages/api-client/` from OpenAPI | Foundation. Both apps build, share typed client. |
| 4b | ✅ `c8b14ee` | PGS-in-browser rasterization spike — `spike/pgs-browser/` | Architecture validated. See "Spike: PGS-in-browser" in `ROADMAP.md` for the verdict + the constraint it imposes on 4d. |
| 4c | ✅ `2070002` `ca870c2` `e876f09` | ffmpeg.wasm wiring: probe / extract / mux via `FFmpegClient` (apps/web/lib/ffmpeg/) + smoke-test page at `/ffmpeg-test` | Video plumbing client-side.  Validated on real MKV. |
| 4d-1 | ✅ `393f5cd` | `apps/web/lib/subs/{ssa,types,timestamp,color}.ts` — SSAFile class | Pysubs2 minimal-surface port. |
| 4d-2 | ✅ `e58b120` | `apps/web/lib/subs/{generate-ass,style-config}.ts` — `generateAssFile()` | Bottom + Top + (optional) Romanized .ass output. |
| 4d-3 | ✅ `993dc2b` | `apps/web/lib/raster/{timeline,build-html,rasterizer}.ts` — `rasterizeFrames()` | html2canvas-based bitmap rasterization. |
| 4d-4 | ✅ `aa9315d` | `apps/web/lib/raster/{pgs-quantize,pgs-regions,pgs-segments,sup-writer}.ts` — full PGS encoder | `.sup` byte stream from `rasterizeFrames()`.  Includes the index-255 palette fix. |
| 4d-5 | ✅ `891829b` | `apps/web/lib/loom-generator.ts` — `LoomGenerator` class + "Generate ASS + SUP" UI button | Subtitle outputs fully client-side, end-to-end. |
| 4e-1 | ✅ `90598c1` | `loom_api/web.py` slim entry + `routes/{romanize,annotate}.py` | Lean text-processing API.  ~100KB per request worst-case. |
| 4e-2 | ✅ `e317a40` | `apps/web/app/globals.css` + `components/site-{nav,footer}.tsx` | Theme + chrome matched to nerv-analytic.ai. |
| 4e-3 | ✅ `1842c59` | `apps/web/app/generate/{page,generator-panel}.tsx` | Skinny drop-zone → tracks → generate-and-download UX. |
| 4e-4 | ✅ `6682c16` | `apps/web/lib/api/{client,romanize}.ts` | `/romanize` wired through `@loom/api-client` into `LoomGenerator`. |
| 4f | ✅ live | Procfile + railway.json + requirements-web.txt + vercel.json + slowapi rate-limits + Tier-A bypass auth + DNS at Namecheap (`api.loom` + `loom` CNAMEs) | Live at `https://loom.nerv-analytic.ai` and `https://api.loom.nerv-analytic.ai`.  **Production end-to-end verification still owed.** |
| 4g | 🔲 | Delete Streamlit (`loom_app.py` + `app/`) + drop streamlit/pandas/etc from `requirements.txt` + update CLAUDE.md Project Structure | Cleanup once 4f passes the end-to-end verification. |

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
| 5 | 🟡 5a–5f ✅; 5g in submission; 5h (Netflix) in build | WXT browser extension at `apps/extension/`. 5a-5c shipped 2026-05-20/21 (`2bc507c`, `b1d2a82`); 5d 2026-05-22 (`/annotate/batch`, `f7f4d66`); 5e 2026-05-26 (`/romanize/batch`, `b35451d` + `fa760f3`); 5f settings UI 2026-05-22/23. 5g (store distribution) **in submission** at **v0.1.7** (AMO listed + Chrome Web Store) — see Quick-Start Step 5 substeps table + `PUBLISH_PLAN.md` + `SUBMISSION_0.1.7.md`. YouTube caption access uses webRequest interception + lang-swap (PO-token moat in `memory/reference_youtube_caption_acquisition_2026.md`); **Netflix port now in active build (step 5h) — recon GO + corrected via live capture, 5h-1 platform-adapter refactor shipped** (see Quick-Start Step 5h table + `NETFLIX_RECON.md`). Major OCR data source from 5f's `opt_in_training` toggle wire-up (still owed). |
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
| Per-layer alpha (text color opacity) | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
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
- **Nested-`<ruby>` outer-rt position is inverted on Firefox MV2.** Per-rt `ruby-position` is honoured for flat single-rt rubies but ignored (forced to `over`) for the outer rt of a nested ruby. Alternate-orthography therefore renders Simplified above everything (reads better pedagogically — kept as-is). The settings-panel preview uses flat single-rt rubies and so correctly shows Simplified-below; this divergence is intentional. (`annotated-text.tsx` header.)
- **react-colorful's runtime CSS auto-inject doesn't reach the shadow root.** It `appendChild`s a `<style>` to `document.head`, which our shadow DOM doesn't inherit. The CSS is vendored verbatim in `settings-panel.tsx::REACT_COLORFUL_CSS` (pinned to 5.6.1; re-extract via the regex-walker noted there when bumping).
- **`tlang=` is intrinsically lock-step.** A `tlang` override makes YouTube emit one MT'd event per source event with identical timing — that's the API, not a regression. Visible only where source-event boundaries don't match English sentence boundaries (Chinese mid-clause splits being canonical). If "tracks are no longer independent" is reported, first check whether the native side is `(auto)`/tlang.

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
