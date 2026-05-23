# Loom — Claude Code Project Briefing

## ⚡ Session Quick-Start

> Update this section at the end of every session.

**Current state (end of 2026-05-23 session):** **5a → 5d all shipped, plus this session's stack of post-5d feature work: alternate-orthography under-ruby (Pass 1 + Pass 2), color presets, inline color wheel, full advanced per-layer styling (alpha + outline + glow).**  Extension renders dual subs on YouTube **with per-character annotation ruby** — furigana for Japanese, Pinyin / Zhuyin / Jyutping for Chinese variants (auto-routed via classifyLang's chineseVariant), Revised Romanization for Korean.  Annotation pipeline locked at a single `/annotate/batch` POST per (target_track, phonetic_system) on activation, ~3-4 sec wait then permanent quiet (production verified for `zh-Hans` → Pinyin).  **Per-tab activation:** every YouTube tab starts DORMANT with a tiny "Loom" pill; user clicks to activate the full pipeline; sessionStorage persists across same-tab reloads.  **Settings panel substantially complete** (this is what was queued as "5f" — landed organically as 5d-diagnostic + this session's polish): live track switching with manual/ASR badges + processing-tier indicators, per-layer tlang overrides, position picker (top/bottom × slot 1/2 with auto-swap), per-layer styles (color + font family + font size + alpha + outline color/alpha + glow radius/color/alpha for Bottom/Top/Annotation, mirroring desktop's `LayerColors`), annotation toggle + phonetic-system override per layer, alternate-orthography toggle + highlight tiers, color preset dropdown (28 thematic presets from /styles/presets, lang-aware), inline HSV color wheel via react-colorful in every ColorRow, native-language base preference.  All persisted to `browser.storage.local`.  Production live: `api.loom.nerv-analytic.ai` now serves `/annotate/batch` + `/styles/presets` (deployed via fast-forward of `main` from `monorepo-restructure` — Railway only tracks `main`).  Step 4f web deploy still live at `https://loom.nerv-analytic.ai`.  Tests: **609 passing** in `loom_core` (pytest) + **164 passing in `apps/extension`** (vitest across lang-code / lang-support / auto-pick / url-picker / orthography-tables / build-segments).

**This session's feature stack (2026-05-22 → 2026-05-23):**
- **Alternate-orthography under-ruby (Pass 1 `88d0a24`, Pass 2 `3e40952`).** Traditional Chinese characters render their Simplified form as a second `<rt>` paired with the base glyph (independent of, and composable with, the existing Pinyin/Zhuyin/Jyutping over-ruby).  Pass 1: new shared workspace `packages/orthography-tables/` (mirrors `packages/api-client/` shape) with a builder that reads OpenCC's `TSCharacters.txt` and emits a 4105-entry sorted-key JSON.  Each entry is `{to, collapse}` — `to` is the canonical simplified form; `collapse` lists OTHER trad chars that forward-map to the same simplified glyph (the pedagogically significant "identity-hidden" cases like 髮/發 → 发).  Generic, orthography-neutral `resolveOrthographyVariants(langCode)` resolver — today only Traditional Chinese (zh-Hant, zh-TW, zh-HK, zh-MO, yue, yue-Hant) resolves; future variants (Japanese kana, Serbian/Kazakh Cyrl↔Latn) slot in as one new descriptor + one new rule.  Reverse direction (simp→trad) is lossy + explicitly out of scope.  Pass 2: rendering + UI via a refactored `AnnotatedText` taking `RichSegment[]` (plain runs + annotated chars with optional over/under ruby + highlight tier).  Three-tier base-char highlight: absent (no styling) / "Distinct" (1:1 mapping, default cyan) / "Merged" (forward-collapse, default amber).  Settings-panel "Alternate orthography" section always visible (mirrors AnnotateRow's always-mounted dim-when-not-applicable pattern); inline preview shows 語→语 + 髮→发+發 so the merge case is visceral.  Per-layer enable + shared highlight toggle + shared colors.
- **Color presets — feature-parity with desktop (commit immediately before `b1e06a4`).**  `lib/presets/{fetch,types}.ts` hits `/styles/presets?lang=` (existing API endpoint, already deployed on Railway).  Module-level cache keyed by lang; in-flight dedup; 10s timeout; fail-soft to null.  `caption-context` triggers fetch when `selectedTarget.languageCode` changes — zh-Hant gets cultural Chinese presets ("Blue-and-White Porcelain"), ja gets Ukiyo-e / NERV Command / Neon Tokyo, English/French/German gets universal only.  `applyPreset()` writes Bottom + Top + Annotation colors atomically as well as the new alpha / outline / glow fields (see below) — a single click reproduces the desktop's full styling.  Settings-panel `PresetPicker` at the top of the Styles section, group-organized (Classic · Cultural · Dark · Adaptive) with banner-prefixed first entries.
- **Inline HSV color wheel (`react-colorful` ~2KB).**  Every `ColorRow` (6 locations: Bottom/Top/Annotation/variant under-rt/distinct-tier/merged-tier) grows a conic-gradient trigger button at the end of its swatch row.  Click → wheel pops out below with a saturation-value square + hue strip + hex text input that only commits on valid `#RRGGBB` (lets users type intermediates without state flicker).  **TRIPWIRE:** react-colorful's runtime auto-injects its CSS to `document.head`, which the shadow root doesn't inherit — vendored the library's 1.7KB CSS verbatim into `REACT_COLORFUL_CSS` + `width:100%` override.  Re-extract on dep bumps via the regex-walker pattern documented in the source-file comment near that constant.
- **Per-layer advanced styling — alpha + outline + glow (`b1e06a4`).**  18 new state fields (3 layers × 6 axes), all persisted.  `LayerStyleBlock` cards grow an "Advanced ▾" collapsible (default closed; casual users see the compact 3-row form they had before).  When opened: alpha slider 0–100, outline ColorRow + alpha slider, glow radius slider 0–20px with hint copy ("0 = no glow" / "Npx halo"), and glow color + glow alpha only appearing when radius > 0.  `caption-overlay`'s `layerStyle()` rewritten to take a full Layer struct + `hexToRgba(color, alpha)` for the base text color; `buildTextShadow()` reads outline + glow from the layer and appends a `0 0 Npx rgba(...)` halo as a 6th `text-shadow` component when `glowRadius > 0`.  Presets that carry `glow_color`/`glow_opacity` activate glow at 8px default radius (matches desktop); presets that omit glow turn it off explicitly so previously-applied glowy presets don't bleed in.
- **Alternate-orthography polish train (multiple post-Pass-2 fixes).**  Plain-English label rename "Clean (1:1)" → "Distinct char color" / "Forward-collapse" → "Merged char color" (`63a0021`).  Settings-panel section always-mounted instead of gated-out (`493a5ca`) — feature was undiscoverable on non-Chinese videos.  Five disjoint cards → one consolidated `layerStyleBlock`-styled card with live two-example preview (語→语 distinct + 髮→发+發 merged) (`2414fda`).  Nested-ruby pattern for double-sided rendering (`bb40051`) — Firefox stacks two `<rt>` siblings on the same side regardless of per-rt `ruby-position`; nest the rubies so each has exactly one rt.  Observed render order: variantForm → reading → base from top to bottom (Firefox ignores `ruby-position: under` on the outer rt of a nested ruby; happy accident — pedagogically reads better with Simplified floating above as supplementary).  Documented in `annotated-text.tsx` header (`a5199c7`).
- **Three Body 0-events diagnostic (`0580a00`).**  `fetchWithCache` was dropping the rich result from `fetchTrackEventsViaSwap` on the floor when events came back empty.  Now logs status / bodyLength / error / url so we can distinguish pot-rejection / HTTP failure / parse-zero / lang-swap-not-carrying without guessing.  The actual Three Body failure resolved itself on next reload — was a stale-URL situation from SPA navigation.

**Highlights this session (2026-05-22):**
- **5d shipped — but only after four architectural iterations.**  Worth remembering, because each step exposed a load-bearing constraint:
  - First cut (`2ba8389`): per-text fan-out, parallel `/annotate` POSTs with concurrency 5.  Worked on the short Japanese test video but rate-limit-bombed on a 43-min `zh-Hans` test (707 unique texts → slowapi 100/min ceiling hit after the first ~100, the rest 429'd, worker pool stalled forever because no per-request timeout).
  - Diagnostic logs + per-request timeout (`5304759`, `284736f`): surfaced the rate-limit reality with structured counters (ok / empty / 429 / errors) + owner-key-presence marker in the start log.
  - Rolling window (`a4cd883`): ~12-event window prefetched at each playhead boundary instead of all 707 at once.  Better but still a constant network trickle for the whole video + per-boundary React re-renders + Map copies.  User complaint: "constantly running annotations is just killer."
  - Per-tab activation (`aaa6d13`): dormant default on every YT tab.  Addressed cumulative cost across many tabs but didn't fix the per-tab "constant work" complaint.
  - **`/annotate/batch` backend endpoint + single-shot fetch (`f7f4d66`).**  THE architecture lock.  Backend takes a list of texts in one request, returns positional results.  Frontend: one POST per (track, phonetic-system), ~3-4 sec wait then silence for the rest of playback.  One slot of the 100/min budget per video instead of ~700.  Production-verified for zh-Hans → Pinyin via curl + extension reload.
- **Per-layer styles (`aee664b`):** mirrored desktop's `StyleConfig` per-layer surface.  Each of Bottom / Top / Annotation now has color picker + font family dropdown (16 options including Auto + per-script Notos + system serif/sans/mono + Arial/Helvetica/Georgia/Times/Courier) + font size input.  Annotation uses RATIO (0.2–1.0) instead of absolute px — matches desktop's `annotation_font_ratio` convention so annotations scale with the parent target font.  Romanization stub deferred to 5e — drops in trivially as a 4th `LayerStyleBlock` when the secondary phonetic line lands.
- **Slot bouncing fix (`b31a725`):** when both layers share a zone (e.g., both bottom) and one has text while the other doesn't, the populated layer was falling to the zone anchor (where its sibling would normally sit).  Fixed with `LayerPlaceholder` — `visibility: hidden` + nbsp + `layerStyle` — that reserves one line of vertical space at the configured fontSize.  Only kicks in when BOTH slots in a zone are configured; solo-in-zone case unchanged.
- **Per-tab activation model (`aaa6d13`):** every YouTube tab starts DORMANT with a small power-icon `DormantPill`.  Click → activate; `LoomApp` mounts the active tree (`CaptionStreamProvider` + overlay + full pill).  Click "Turn off Loom on this tab" in the settings panel → React unmounts the active tree, subscriber count drops to 0, `handleMessage` in `discover.ts` starts dropping MAIN's tracklists.  `sessionStorage`-persisted so same-tab reloads stay active.  `discover.ts` gained `activeSubscriberCount` gate that early-returns from `handleMessage` when no subscribers — even though the window message listener stays attached (cheap), tracklists arriving during dormant state are dropped silently.
- **5f settings panel — substantially complete this session** (came in as a series of "5d-diagnostic" commits 1b5d6c4 → aee664b):
  - Live target/native track switching with per-track manual/ASR badges + processing-tier indicator showing the actual downstream system (Pinyin/Zhuyin/Jyutping/Romaji/RR/Cyrillic translit/etc.)
  - Per-layer tlang dropdowns (any source track → any supported language MT; bidirectional, not just native-side)
  - Custom `LangSelect` dropdown with fading-scrollbar list (`webkit-scrollbar` opacity transition + JS-toggled `.scrolling` class + `scrollbar-width: thin` for Firefox).  49 alphabetized Loom-compatible languages.  10 items visible at a time.
  - Position picker: top-1 / top-2 / bottom-1 / bottom-2 with auto-swap on collision; placeholder space when both slots in a zone are configured.
  - Annotation: per-track on/off + phonetic-system override (Auto / Pinyin / Zhuyin / Jyutping).
  - Styles: per-layer color (swatch row + native color input) + font family dropdown + font size (px for Top/Bottom, ratio for Annotation).
  - Native language preference (auto-pick base) — controls regional-variant collapse: `en` matches `en-US`/`en-GB`/`en-AU`/etc.
  - "Turn off Loom on this tab" red-tinted deactivate button at the bottom.
- **Major perf tripwires established this session (LOAD-BEARING — see file-header comments for details):**
  - **NO `backdrop-filter` ANYWHERE.**  Pill + panel are always rendered on top of YT's continuously-repainting player area; `backdrop-filter` forces re-blur of underlying pixels every frame → main-thread saturation → multi-second input lag (user reported "3-second click delay").  Solid `rgba(...)` background with opacity ≥ 0.94 instead.  Documented in `components/loom-pill.tsx` + `components/settings-panel.tsx` headers.
  - **Pill MUST NOT depend on `target` / `native` from context.**  Earlier compact-mode toggle (`captionsShowing = !!(target?.text || native?.text)`) caused the pill to re-render every dialogue boundary, generating new inline styles that triggered CSS transitions on padding / gap / background / box-shadow.  On rapid-fire dialogue those transitions overlapped and never settled.  Pill now reads only `status` from context and is wrapped in `React.memo`.  Compact mode dropped entirely — slight UX cost (pill stays at full size during dialogue) for the perf win.
  - **Shadow host MUST be on its own compositor layer.**  `transform: translateZ(0); will-change: transform; contain: layout paint style` on `loom-overlay-root` (in `injectHostPositioningStyle` in `content.tsx`).  Without this, YT's progress-bar tick + control auto-hide cascade through our paint surface on the main thread.  Same `translateZ(0) + willChange: transform` on the pill button itself for defense-in-depth.
- **NEW tripwires (2026-05-23):**
  - **WXT `build` defaults to `chrome-mv3`.**  `npm run build` writes to `.output/chrome-mv3/`; Firefox testing requires `npm run build:firefox` writing to `.output/firefox-mv2/`.  Cost three reload cycles this session — UI changes "weren't appearing" because the Firefox-loaded build was hours stale.  Whenever a session is iterating on extension UI and the user reloads but sees no change, **first check `.output/firefox-mv2/` mtime** before assuming a logic bug.
  - **Nested-`<ruby>` outer-rt position is INVERTED on Firefox MV2.**  The CSS Ruby spec says per-rt `ruby-position` is honoured; Firefox honours it for FLAT single-rt rubies but ignores it (effectively forces `over`) for the outer rt of a nested ruby.  Pass-2 intended Simplified-below-Traditional; what actually renders is Simplified-above-everything-else.  Visual outcome reads better pedagogically — kept as-is; documented in `annotated-text.tsx` header so future readers don't trust the "under-ruby" terminology blindly.  The settings-panel preview uses FLAT single-rt rubies so it correctly shows Simplified-below — divergence is documented so it doesn't confuse a future tweak.
  - **react-colorful auto-inject doesn't reach the shadow root.**  Library calls `document.head.appendChild(<style>)` at runtime; our overlay tree is in a shadow DOM that doesn't inherit document-level styles.  Inlined the library's CSS verbatim in `settings-panel.tsx::REACT_COLORFUL_CSS` (1.7 KB) so it renders properly.  Pinned to 5.6.1 — re-extract via the regex-walker pattern noted in the source-file comment when bumping.
  - **`tlang=` is intrinsically lock-step.**  When the user picks "(auto: tlang=en when no native track)" or any tlang= override, YouTube generates one MT'd event per source event with identical timing.  That's how the API works — not a regression.  User-visible only on videos where the source track's event boundaries don't line up with English sentence boundaries (Chinese mid-clause splits being the canonical case).  If the user reports "tracks are no longer independent," first check whether the native side is `(auto)` / tlang.
- **BCP-47 language expansion (`1916291`):** `auto-pick.ts` replaced its hardcoded `PREFERRED_LANGS` list with a script-family tier system.  `lib/captions/lang-code.ts` (BCP-47 parser, disambiguates subtags by shape — 4-letter Title = script, 2-letter / 3-digit = region) + `lib/captions/lang-support.ts` (`SCRIPT_FAMILY` → `Processing` tier map: latin → native-display, cjk-han/kana/hangul → annotate-romanize, cyrillic/thai/hebrew/arabic/indic → romanize).  Regional dialects (`en-US`/`en-GB`/`en-AU`/`pt-BR`/`pt-PT`/`es-419`/`es-MX`/`es-ES`/`zh-Hans`/`zh-Hant`) collapse via canonical base language; processing tier derived from ISO 15924 script.  Adding a Roman-alphabet language is zero LOC; adding a non-Latin script is one entry in `SCRIPT_FAMILY`.  87+19+23 = 129 vitest cases cover the surface.
- **Deploy mechanism (operator note):** Railway only tracks `main`, never `monorepo-restructure`.  Push to `main` via `git push origin monorepo-restructure:main` (fast-forward — `monorepo-restructure` is always a strict ancestor of `main` after merge).  Verified working this session — `/annotate/batch` deployed and live within ~5 minutes of push.

**🎯 Active focus next session:**
1. **5e — `/romanize` secondary phonetic line.**  The 4th caption layer above Annotation, plain Latin-letter full-utterance romanization (e.g., "Kyou wa..." above the kanji+ruby).  Backend `/romanize` exists; **add a `/romanize/batch` endpoint** that mirrors `/annotate/batch` shape (texts list + lang + phonetic_system → list of results).  Frontend: 4th `LayerStyleBlock` in the settings panel + 4th slot in the caption overlay's bunch.  Same activation flow as 5d — single batch on activation, silent for the rest.
2. **Owed follow-ups (carry over from 5b/5c/5d):**
   - **tlang=en parser anomaly** — still owed.  `&tlang=en` returns full body (~64 kB) but the json3 parser extracts only 1 event.  Will bite on JA-only videos that need MT for Bottom.  Hypothesis: tlang responses use word-level `segs` or a different events structure than native tracks.
   - **Chrome MV3 verification** — 5a-5d developed on Firefox MV2 only.  WXT builds both; need to load-unpacked in Chrome and re-verify.  `world: "MAIN"` is MV3-native so should "just work."
   - **Stale-URL on rapid SPA navigation** — likely fine since we key by videoId, worth confirming on a busy navigation session.
3. **4g** (delete Streamlit) — can land anytime; not blocked.  `loom_app.py` + `app/` + drop `streamlit/pandas/pyarrow/pydeck/altair` from `requirements.txt`.
4. **5g** — Chrome MV3 verification + cross-browser smoke + store-distribution prep.  Final ship-readiness polish before public announcement.

**Pending state (next session check):** working tree clean.  Many unpushed commits on `monorepo-restructure` since the 2026-05-22 `origin/main` fast-forward at `50271a4`.  ALL of them touch only `apps/extension/` / `packages/orthography-tables/` / `apps/extension/lib/presets/` / `CLAUDE.md` — zero `loom_api/` or `loom_core/` changes, so Railway's `watchPatterns` would not redeploy on push.  Push to `main` whenever you want the archive caught up; backend stays put.  Roughly: Pass 1 + Pass 2 of orthography (`88d0a24` + `3e40952`), four AO polish/fix commits, the Three Body diagnostic, the orthography docs-only nested-ruby clarification, color-presets + color-wheel, and per-layer alpha/outline/glow (`b1e06a4`).

**Step 5 substeps:**
| | Status | Ships | Goal |
|---|---|---|---|
| 5a | ✅ `2bc507c` | `apps/extension/` WXT workspace + content script + popup + owner-key + background service worker | Foundation.  Extension loads, pill renders on YouTube, popup `/health` smoke passes with owner bypass. |
| 5b | ✅ `2bc507c` + `b1d2a82` | `entrypoints/yt-main.content.ts` (MAIN world) + `entrypoints/background.ts` (webRequest + first-pot URL picker via `lib/captions/url-picker.ts`) + `lib/captions/{discover,fanout,stream,auto-pick,types}.ts`.  Natural-prefetch-first + CC-toggle-fallback trigger. | YouTube caption acquisition via webRequest interception + lang-swap, immune to multi-timedtext-request reality (incl. user manually clicking YT's CC). |
| 5c | ✅ `b1d2a82` | `components/caption-overlay.tsx` + `lib/overlay/{player-scale,hide-yt-captions}.ts` + `entrypoints/content.tsx` (**`inheritStyles: true`** to defeat WXT's `:host{all:initial!important}` reset) | Dual-subs overlay survives fullscreen + theater mode via player-anchoring; YT's caption box suppressed during tracking; typography scaled to player height. |
| 5d | ✅ `2ba8389` → `f7f4d66` | `/annotate/batch` backend endpoint (`loom_api/routes/annotate.py`) + `lib/annotate/{build-map,cache,types}.ts` + `components/annotated-text.tsx` + extended `discover.ts` payload (annotateMap fields).  Single-shot batch on activation, ~3-4s wait, then silence.  CJK + Korean shipped; non-CJK families (Thai/Indic/Cyrillic/Hebrew/Arabic) deferred. | The headline — per-token readings render live above the foreign text.  Browser-native `<ruby>` + `<rt>`; ratio-based size scaling. |
| 5e | 🔲 | `/romanize/batch` backend endpoint + frontend mirror of the 5d batch flow.  Add 4th `LayerStyleBlock` to settings panel + 4th slot in the overlay bunch (above Annotation). | Secondary phonetic line for full-utterance pronunciation.  Same activation lifecycle as 5d. |
| 5f | 🟢 effectively complete (sans `opt_in_training`) | `components/settings-panel.tsx` + `components/{loom-app,dormant-pill}.tsx` + extended `caption-context.tsx` + new `lib/{orthography,presets}/`.  Per-tab activation, live track switching, per-layer tlang, position picker, per-layer styles (color + font + size + alpha + outline color/alpha + glow radius/color/alpha), annotation toggle + phonetic-system picker, alternate-orthography ruby + tier highlights, 28 thematic color presets (lang-aware via `/styles/presets`), inline HSV color wheel via react-colorful, native lang preference.  Functionally on par with the desktop's Style editor.  **Pending:** `opt_in_training` flag wire-up (lands with step 6's OCR pipeline; no archival code yet). | User-controllable demo surface, ship-ready except for OCR data-flow toggle. |
| 5g | 🔲 | Chrome MV3 verification, cross-browser smoke, store-distribution prep, tlang=en parser anomaly resolution, stale-URL fix. | Ship-readiness polish before public announcement. |

**Architecture (locked 2026-05-03 — Option B, all-client + romanization API):** browser runs ffmpeg.wasm for video probe/extract/mux + JS ports of ASS generation + PGS rasterization (via html2canvas — see Spike subsection for why not SVG-foreignObject).  Server (`api.loom.nerv-analytic.ai` on Railway) only handles romanization: text-in / text-out, ~100KB request.  Drops backend bandwidth ~99% vs upload-everything; target hosting cost $5/mo flat.  Tradeoffs accepted: ~50MB initial JS bundle (one-time, cached), JS reimplementations of `loom_core/subs/processing.py::generate_ass_file` + `loom_core/rasterize/sup_writer.py` that must track the Python reference (drift risk — single source of truth lives in Python; JS port is a transcription), weak-device fallback to a future server-mode toggle.

**Step 4 substeps (Option B):**
| | Status | Ships | Goal |
|---|---|---|---|
| 4a | ✅ `fac632e` | npm workspaces + `apps/web/` Next.js scaffold + `packages/api-client/` from OpenAPI | Foundation. Both apps build, share typed client. |
| 4b | ✅ `c8b14ee` | PGS-in-browser rasterization spike — `spike/pgs-browser/` | Architecture validated. See "Spike: PGS-in-browser" below for the verdict + the constraint it imposes on 4d. |
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
| 5 | 🟡 5a–5d ✅ + 5f substantially ✅ | WXT browser extension at `apps/extension/`. 5a-5c shipped 2026-05-20/21 (`2bc507c`, `b1d2a82`); 5d shipped 2026-05-22 via 4 iterations landing at `/annotate/batch` single-shot architecture (`f7f4d66` + `b31a725` + `aee664b`); 5f settings UI substantially shipped in the same session (per-tab activation, live track switching, per-layer tlang, position picker, per-layer styles). 5e (`/romanize` secondary phonetic) + 5g (Chrome MV3 + ship-readiness) queued — see Quick-Start Step 5 substeps table. YouTube caption access uses webRequest interception + lang-swap (PO-token moat documented in `memory/reference_youtube_caption_acquisition_2026.md`); Netflix path TBD post-5g. Major OCR data source from 5f's `opt_in_training` toggle wire-up (still owed). |
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

## Roadmap Beyond Step 4

**Purpose:** capture every forward-looking item that surfaced during step-4 build-out but didn't ship in v1.  Three buckets — v1.5 follow-ups (the immediate next deltas after the public deploy), v2 (UX expansion that requires real design work), and long-term (deeper architectural moves that wait for a real signal).  Each item lists a trigger ("ship when") so future sessions don't relitigate scope.

### v1.5 — Closing the gaps the survey exposed

These are the items that v1's "skinny scope" intentionally left for the first iteration after deploy.  None block production today, but each is on the critical path to a polished tool.

**1. PGS rendering of preserved events.**  Currently `iterPreservedEvents()` in `apps/web/lib/subs/style-classify.ts` yields signs / karaoke / typesetting events from multi-style fansub tracks.  `generate-ass.ts` copies those events through to the `.ass` output with original styling intact, but the rasterizer (`apps/web/lib/raster/timeline.ts::buildPgsTimeline`) filters them out — so they appear in mpv from the `.ass` track but are missing from the `.sup` bitmap track.
- **Port `_dedup_preserved_for_pgs`** from `loom_core/subs/processing.py` (lines 453-555) — handles overlapping karaoke compositing layers.  Critical because raw karaoke layers (sweep + shadow + base) all render simultaneously when animation tags are stripped.
- **Wire `stripAnimationTags()`** (already in `style-classify.ts`) into a separate raster pass.  Render preserved events with motion tags removed; visual-styling tags (font / color / pos / outline / shadow) preserved.
- **Add second timeline pass** for preserved events.  Lives alongside the dialogue timeline; raster output composites both into one `.sup`.
- **Ship when:** any production user complains that signs/karaoke don't appear in the muxed output, or before the first 3rd-party demo.  Estimated ~300 LOC.

**2. `/annotate` API client wiring.**  The endpoint exists and works (verified live: `/annotate ja` returns furigana ruby HTML; `/annotate zh-Hant` returns per-character Zhuyin).  No client consumer.  Required for furigana in the `.sup` rasterizer — currently `build-html.ts` renders plain target text, so the bitmap output has no per-character readings.  ASS path uses `\pos()` annotation but only for CJK (the `supports_ass_annotation` gate); non-CJK languages need PGS-rendered annotation.
- **Add `buildAnnotateMap()`** in `apps/web/lib/api/`, parallel to `buildRomanizeMap()`.  Same fan-out + memo pattern.
- **Update `build-html.ts`** to accept an optional `annotation_html` parameter and inject it as a third `.layer` div above the Top layer.
- **Ship when:** v1.5 PGS preserved-event work lands (same code path).  Estimated ~150 LOC.

**3. Concurrent dialogue event merging.**  Python's `_merge_concurrent_target_events()` handles dual-speaker overlapping lines (one character speaking while another's line still on screen).  Web port currently does first-overlap match — picks one, drops the other.  Rare in practice for single-speaker anime but common in dramas / multi-character ensemble work.
- **Port `_merge_concurrent_target_events`** from `loom_core/subs/processing.py`.  Music-only event filtering (`_is_music_only`) already in scope of the port.
- **Ship when:** anyone reports dialogue dropouts during ensemble scenes.  Estimated ~100 LOC.

**4. SRT crawl-bait + episode-card skip heuristic.**  Survey caught spam in multiple SRTs: `"For best IPTV provider..."` (DW3 across 5 languages), `"Created and Encoded by Bokutox"` (Gran Torino YIFY), `"=Three-Body=" / "=Episode 1="` (Tencent Three Body title cards).  These get fanned to `/romanize` as dialogue and pollute the Romanized layer.
- **Heuristic regex skip** for events matching `/(www\.|provider|encoded by|^=.+=$|^\[.+\]$)/i` BEFORE the unique-text collection in `buildRomanizeMap`.
- **Estimated:** ~10 LOC.  Could ship as a dedicated 4f-followup commit any time.

**5. Speaker-tag stripping toggle.**  Japanese SRTs commonly prepend speaker names: `（アルミン）...`, `(花澤香菜)...`.  Currently the speaker tag survives romanization (`(Arumin)yatsura ni shihai...`).  Generally desirable for following dialogue, but some users may want it stripped.
- **Add `strip_speaker_tags: bool` to `StyleConfig`** (off by default).
- **Pre-process target text** in `generateAssFile` and `buildRomanizeMap` to strip leading `(...)` / `（...）` when toggle is on.
- **Ship when:** UI editor lands (v2) — meaningless without a UI control.  Estimated ~30 LOC.

**6. HI-track auto-detection warning.**  Squid Game's HI Korean track has bracket-tagged sound descriptions (`[흥미로운 음악]`, `[Music]`) interspersed with dialogue.  These count as dialogue events and produce technically-correct-but-noisy romaji.
- **Heuristic:** if a track has >20% events matching `/^\[.+\]$/`, surface a warning in the track picker UI: "This looks like a hearing-impaired track — sound descriptions will be romanized too.  Pick the non-HI track for cleaner output."
- **Estimated:** ~50 LOC including UI.  Polish-tier; defer until UI editor.

### v2 — Style editor + live preview

The big v1-deferred bucket.  v1 ships defaults-only generation (`defaultStyleConfig()`); v2 brings the full UI parity with the desktop app's style controls.  All of this is "additional UX surface" rather than new pipeline work — the engine already supports everything below.

**Per-layer style editor** matching the desktop's Section components in `apps/desktop/src/sections/`:
- Color + opacity per layer (Bottom, Top, Romanized, Annotation)
- Font family + size per layer (with the FontScanner's missing-glyph warning wired)
- Outline (toggle + thickness + color + opacity)
- Shadow (toggle + distance)
- Glow (toggle + radius + color, emits `\blur`)
- Top stack position (vertical offset, annotation/romanized gaps)

**Color presets** — 28 presets across classic / cultural / dark / adaptive groups, language-scoped.  Already in `loom_core/color_presets.py`; need API endpoint exposure + UI dropdown.

**Output resolution scaling** — 480p / 720p / 1080p / 1440p / 2160p / Match source.  Server side already handles `_PLAYRES_OPTIONS` + `_scale = target_height / 1080`; client needs a selector.

**Timing offsets** — manual per-track ms shift via `shift_events()`; auto-alignment via `compute_subtitle_offset()`.  Both already in `loom_core/subs/utils.py`.  Needs UI sliders + an "Auto-align" button that fires the histogram pass.

**Live preview pane** — single-frame composite preview at a chosen timestamp.  Backend already has `POST /preview` (`loom_api/routes/preview.py`); web frontend skips it in v1.  Wire it up alongside the style editor so users see changes in real time without running a full generate.

**Ship when:** real users start using the v1 default-styles output and ask for customization.  Until then, "use the desktop app for fine control" is an acceptable answer per memory `project_pgs_web_priority.md`.

### Long-term — Architectural moves

**Web Worker for rasterization.**  Currently `rasterizeFrames()` runs on the main thread; html2canvas + canvas processing block UI for ~1437 frames on a Frieren episode.  We mitigated with `setTimeout(0)` yields in commit `e6f2be7`, but a real fix is moving the whole pipeline into a Web Worker so the main thread stays responsive.  Cost: html2canvas's DOM walker needs the live document, which workers don't have — would need a different rendering path entirely.  Probably the same code shift as the next item.

**Canvas2D direct draw bypassing html2canvas.**  The 4b spike validated html2canvas as the architectural choice — but at the cost of ~0.6% pixel divergence vs native Chromium.  A direct Canvas2D drawer (taking ASS-style text + position math + outline/glow shaders) would be byte-identical and could run in a Web Worker.  Cost: substantial — would reimplement layered text positioning, outline emulation, ruby layout.  ~1500 LOC minimum.  Memory `project_pgs_web_priority.md` documents the tradeoff: this ships only when a user genuinely needs byte-perfect web PGS output AND can't fall back to the desktop bundle.

**Hardening / observability before public announcement.**
- **Cloudflare in front of Railway** — free-tier WAF + bot detection.  Catches the abuse modes that get past slowapi (rotating IP scraping, especially).  Easy add: change `LOOM_CORS_ORIGINS` + Cloudflare DNS proxy toggle + verify Tier-B Cloudflare Access compatibility.
- **Sentry (or similar) error tracking** — currently `/generate` failures only surface in the user's browser; we have no aggregated view of production errors.  Add `@sentry/nextjs` to the web app + `sentry-sdk` to the API.
- **Analytics** — Plausible (privacy-respecting, $9/mo) or Vercel Analytics (free tier).  Tracks `/generate` start/complete rates, language breakdowns, file-size distributions.  Useful signal for prioritizing v1.5 work.
- **Multi-region Railway** — only relevant if traffic outside the US/EU starts mattering.  Not on the radar yet.

**Ship when:** before the first non-Connor-only public link; or when an outage happens and we realize we can't see it.

### Closing 4f / 4g

**4f production verification (owed).**  We pushed all the deploy fixes (`1af8a9d`, `e6f2be7`, `e340380`, `96e6148`) but the post-fix end-to-end test still owed: drop an AoT episode at the live `loom.nerv-analytic.ai/generate`, watch a successful complete generation, confirm `.ass` + `.sup` download, mux back into source, play in mpv, verify subs render.  This is the canonical "deploy actually works" gate.  Once this passes once, 4f is closed.

**4g Streamlit deletion (not started).**
- Delete `loom_app.py` + `app/` directory entirely.
- Update `CLAUDE.md` Project Structure section to drop the Streamlit references.
- Update Capability Matrix to drop the Streamlit column (it's currently absent — already done).
- Drop `streamlit`, `pandas`, `pyarrow`, `pydeck`, `altair` from `requirements.txt` (the desktop venv).
- Verify `apps/desktop` still works without those (uvicorn sidecar shouldn't need any of them).
- **Ship when:** 4f production verification passes.  Once the web app is reachable + working, the Streamlit prototype's job is done.

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
| Alternate-orthography ruby (zh-Hant ↔ Simplified) | ✅ table | — static client-side lookup | — | ⏳ | ✅ 5f |
| Distinct / Merged tier highlight (forward-collapse marker) | ✅ data | — | — | ⏳ | ✅ 5f |
| Inline live preview of orthography pair (語→语 + 髮→发+發) | — | — | — | — | ✅ 5f |
| **Romanization** (engine + API ✅ for all) | | | | | |
| Chinese (Pinyin / Zhuyin / Jyutping) | ✅ | ✅ | ✅ | ✅ | 🟡 annotation only |
| Japanese (MeCab + furigana, 3 long-vowel modes) | ✅ | ✅ | ✅ | ✅ | 🟡 annotation only |
| Korean (RR per-syllable + word-level) | ✅ | ✅ | ✅ | ✅ | 🟡 annotation only |
| Cyrillic (ru / uk / be / sr / bg / mk / mn) | ✅ | ✅ | ✅ | ✅ | ⏳ |
| Thai (paiboon / RTGS / IPA) | ✅ | ✅ | ✅ | ✅ | ⏳ |
| Indic (hi / bn / ta / te / gu / pa) | ✅ | ✅ | ✅ | ✅ | ⏳ |
| Hebrew | ✅ | ✅ | ✅ | ✅ | ⏳ |
| Arabic / Persian / Urdu | ✅ | ✅ | ✅ | ✅ | ⏳ |
| **Output generation** | | | | | |
| `.ass` 3- or 4-layer file | ✅ | ✅ | ✅ | ✅ | ⏳ |
| `.sup` (PGS) bitmap rasterization | ✅ | ✅ | ✅ | ✅ | — |
| Live HTML composite preview | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| Output filename builder | ✅ | ✅ | ✅ | ⏳ | — |
| MKV mux (ffmpeg subtitle merge) | ✅ | ✅ | ✅ | ✅ | — |
| **Style customization** | | | | | |
| Per-layer color | ✅ | ✅ | ✅ | ⏳ | ✅ 5f |
| Per-layer font family + size | ✅ | ✅ | ✅ | ⏳ | 🟡 Bottom/Top/Annotation only; Romanization stub for 5e |
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
