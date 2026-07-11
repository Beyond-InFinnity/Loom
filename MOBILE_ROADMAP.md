# Loom on Mobile — Strategy & Plan of Record

**Decided 2026-07-11 (Connor signed off).** The mobile goal is the dream case: **local `.mkv` playback on a phone with the full 4-layer stack and tap-word definition cards** (the gloss function is the headline). Streaming platforms are explicitly out of scope for mobile apps (closed apps, no extension surface) — with one cheap exception (§5).

## 0. Why this is tractable at all

Two existing decisions make mobile a shell problem, not a port problem:

1. **Option B architecture** — clients ship subtitle *text* only (~100 KB/episode); the server computes annotate/romanize/define/presets. Nothing in the pipeline needs desktop-class client compute. Mobile bandwidth/battery cost is trivial.
2. **The entire interactive surface is DOM** — overlay, ruby, romanization line, glow, definition card with grammar + gloss picker. The extension is just one *host* for it. Any shell that provides a video decoder underneath a WebView can host Loom.

The 2026-07-11 coupling audit (§3) confirms this empirically: the render/data stack is mostly pure already; the host couplings are concentrated in six seams.

## 1. Sequencing (plan of record)

| # | What | Why this order |
|---|------|----------------|
| 1 | **`packages/player-ui` extraction** — host-agnostic WebView payload (overlay + card + settings) behind the seam interfaces in §3 | Single decision that makes every later shell a bridge project, not a rewrite. Extension becomes consumer #1 (no behavior change), desktop player consumer #2, Android #3. |
| 2 | **Loom Player desktop** (already decided, Path B) — grow the Tauri 2 shell, libmpv decode, `player-ui` payload on top | Proving ground for the local-file `CaptionPlatform` (track enumeration, sub extraction, playhead bridge) with fast iteration. Desktop was already the committed next player anyway (anime/fansub audience). |
| 3 | **Android app** — Kotlin shell + libmpv AAR + transparent WebView running the same payload | The mobile dream. Everything except on-device demux exists by this point. |
| 4 | **Chromecast custom Web Receiver** — output mode *of the Android app*, second-screen gloss UX | Receiver is literally a Chrome page → overlay ports near-verbatim; but codec wall (no software decode on cast hardware) + no TV interactivity make it an add-on, not a platform. |
| 5 | **iOS** — same architecture (VLC/mpv precedents exist; HEVC/EAC3 decode is native on Apple hw) | After Android proves the design; App Store friction + worse WebView-over-video story. |
| — | **Firefox-Android extension recon** — opportunistic, independent of all the above | Firefox for Android runs AMO extensions (open ecosystem since Dec 2023, most WebExtension APIs incl. MV2 webRequest). Possibly a near-free YouTube-on-mobile win. Needs live recon per `feedback_extension_caption_verification` — never assume acquisition works without devtools evidence. Add `gecko_android` to `browser_specific_settings` when tested. |

## 2. Tech recon verdicts (2026-07-11)

- **Desktop shell: grow Tauri 2** (existing `apps/desktop`). Prior art now exists for the exact hard part: [`tauri-plugin-libmpv`](https://github.com/nini22p/tauri-plugin-libmpv) embeds mpv via libmpv under a transparent webview (plus a JSON-IPC sibling `tauri-plugin-mpv`); Jellyfin Media Player (mpv + web UI) validates the mpv-under-web-overlay architecture generally. Electron would add ~150 MB and has no better mpv story. libmpv owns A/V sync — the "separate video + Web Audio clocks" problem from the original Path B recon **does not exist** in this design. Rust host makes `libmpv-rs` natural for the playhead/pause/track-list bridge.
- **Android player core: `dev.jdtech.mpv:libmpv` AAR on Maven Central** (Findroid/Jellyfin's maintained libmpv build; 0.5.x current) — plain Gradle dependency, no NDK build of our own. `mpv-android` (`MPVLib`/`BaseMPVView`) is the reference implementation. Overlay = transparent `WebView` above the mpv `SurfaceView` (standard compositing). Tauri 2 *does* target Android, but Tauri-mobile + libmpv is unproven — the payload's shell-agnosticism means we don't have to bet on it; Kotlin shell is the safe call.
- **On-device subtitle demux (the one genuinely new piece):** ffmpeg-kit was **retired Jan 2025** (binaries pulled from Maven Central Apr 2025) — do NOT plan on it. Options, in preference order: (a) **Media3/ExoPlayer `MatroskaExtractor`** — pure-Java MKV demux, reads SSA/ASS/SRT text tracks, no native deps, Google-maintained; (b) libmpv itself (track-list enumeration is free; bulk text extraction through mpv is awkward); (c) a maintained community ffmpeg build if (a) hits a wall. Desktop doesn't have this problem (real ffmpeg via the sidecar / Rust).
- **Chromecast:** custom Web Receiver (CAF) is an HTML page in Chrome on the dongle → `player-ui` render layer ports. Phone serves the file over local HTTP + streams timed overlay data. **Codec wall applies in full** (no software decode: DTS/TrueHD audio and 10-bit HEVC on older sticks just fail) — works for the well-behaved subset only. Interactivity = second-screen: pause → current line's words on the phone → tap → card on the phone.
- **Offline gloss (flagged, not committed):** mobile means the API is a connectivity dependency (subway breaks the dictionary). The eventual answer is a client-bundled `dict.sqlite` subset for the user's active language pair — which is a real argument for choosing **SQLite-on-R2** over hosted Postgres when the off-site dictionary store decision (DICTIONARY_SOURCES.md) is made. Decide there, not here.

## 3. The `player-ui` seam spec (from the 2026-07-11 coupling audit)

Full audit detail lives in the session notes; summary of verdicts:

**Already pure (move as-is):** `annotated-text.tsx`, `caption-overlay.tsx` (once its two hooks are seamed), `lib/orthography/*`, `lib/annotate/{cache,group-segments,types}`, `lib/romanize/{cache,types}`, `lib/i18n/index.ts`, `lib/captions/{lang-support,lang-code}.ts`, `lib/overlay/stop-player-events.ts`, and the fetch-only modules (`presets/fetch`, `annotate/capabilities`, `annotate/build-map`, `romanize/build-map`).

**Deep couplings (where the seams go):** `caption-context.tsx` (~55 direct `browser.storage.local` calls + `getPlatform()` + module-level per-platform warm caches), `settings-panel.tsx` (storage + `getManifest` + vendored react-colorful CSS), `discover.ts` (MAIN-world postMessage + storage + platform), `stream.ts` (`<video>.timeupdate` — the playhead), `player-scale.ts` / `use-paused.ts` (DOM `<video>` + `document` listeners), `lib/captions/platform/*` (by design), `owner-key.ts` / `enabled.ts` / `corpus/consent.ts` (storage by purpose).

**Seven seams:**

1. **`StorageAdapter`** — `get/set/remove/onChanged`. Extension impl = `browser.storage.local`; native impl = host bridge (Tauri store / Android SharedPreferences via JS bridge). Keep the `loom_*` keyspace so extension users lose nothing. The module-level warm caches (`cachedSizeByPlatform` etc. — load-bearing for Prime remount races) become adapter-backed.
2. **`PlayerAdapter`** — replaces `getPlatform()`'s DOM surface: `{ id, resolvePlayerRoot(), resolveVideo(), hideNativeCaptions(), restoreNativeCaptions(), pillAnchor }`. Native player: fixed `id`, hide/restore no-ops.
3. **`PlayheadSource`** (+ pause state) — replaces `<video>.timeupdate` in `stream.ts` and subsumes `use-paused.ts`. Native impl: libmpv `time-pos`/`pause` property observation over the JS bridge. Plus a **`ScaleSource`** (rendered picture height) replacing `player-scale.ts`'s ResizeObserver-on-`<video>`.
4. **`CaptionTrackSource`** — replaces the MAIN-world postMessage discovery. Native player supplies `CaptionTrack[]` + parsed `CaptionEvent[]` directly (demuxed sub tracks). Downstream (`auto-pick`, batch fetches, `stream`) reuses as-is. This is the "local-file `CaptionPlatform`".
5. **`ApiConfig`** — inject API base URL + client-version string (replaces Vite `define` globals + the guarded `getManifest().version` header).
6. **`LocaleProvider`** — one function replacing `browser.i18n.getUILanguage()` (both call sites already try/catch-fallback to `en`).
7. **`MountAdapter`** (host-side, not in the package) — replaces `createShadowRootUi` + `injectHostPositioningStyle`. Package exposes `<LoomApp/>`; host mounts it. Note: react-colorful CSS vendoring + `composedPath` outside-click logic assume a shadow root — in a plain-document WebView, revisit both (simpler there, not harder).

**Also owed in a native WebView:** bundle the Noto font stack (the overlay's `DEFAULT_FONT_STACK` silently falls back otherwise — the fonts already ship with the desktop app's resources).

**Corpus capture from day one** on every new player surface (platform ids `player` / `player-android`), same consent posture as the extension; local files are the richest styled-ASS source (offline spool like the desktop sidecar).

## 4. Proposed substeps (for sign-off — sized like Step-5 substeps)

- **7a ✅ (2026-07-11)** `packages/player-ui` package skeleton + the seven seam interfaces + move the already-pure modules. Extension consumes them from the package (pure re-export shuffle, zero behavior change, vitest green). **As built:** `@loom/player-ui` (raw-TS-source workspace package, same style as `@loom/orthography-tables`; subpath exports incl. `./i18n` + the `.tsx` component). Moved: i18n (tables+resolve+strings), annotate/{types,cache,group-segments}, romanize/{types,cache}, orthography/{types,build-segments}, captions/{types,lang-code,lang-support}, overlay/stop-player-events, components/annotated-text — plus their 8 test files (extension `vitest.config.ts` now includes the package's tests, so one `npm test` still covers everything: 356 green). Seam interfaces live in `src/seams/` (types only, impls come in 7b) — except **LocaleProvider, which is already LIVE**: `resolveUiLocale` reads a registered provider instead of `browser.i18n`, and the extension registers the browser call in its `lib/i18n` shim at module load. Old extension paths hold one-line re-export shims (the ~25-importer type modules made import-site migration pointless churn ahead of 7b's rewiring — shims retire as 7b touches each consumer). tsc + firefox-mv2 + chrome-mv3 builds green.
- **7b** Rewire storage through `StorageAdapter` (biggest diff: `caption-context.tsx`, `settings-panel.tsx`, `discover.ts` prefs) + `PlayerAdapter`/`PlayheadSource`/`ScaleSource` behind the existing DOM impls. Extension still consumer #1; ship as a normal extension release to prove no regression.
- **7c** Desktop Loom Player MVP: Tauri shell + `tauri-plugin-libmpv` spike (play a 10-bit HEVC + EAC3 fansub `.mkv`), track enumeration + ASS/SRT extraction, `CaptionTrackSource` impl, payload mounted, gloss working on pause. (JASSUB/libass for original fansub typesetting = separate later substep, per the original Path B notes.)
- **7d** Corpus capture + offline spool on the desktop player (mirror the sidecar pattern).
- **8a** Android shell: Kotlin + `dev.jdtech.mpv:libmpv` + transparent WebView + JS bridge implementing the seams; Media3 MatroskaExtractor for sub tracks; SAF file access.
- **8b** Android polish: bundled Noto fonts, battery/perf pass, Play Store kit.
- **8c** Chromecast receiver (second-screen gloss), from the Android app.
- **R1** (anytime) Firefox-Android live recon: dev build on a phone, YouTube acquisition check, touch-size the pill/panel if it works.

## 5. What mobile explicitly does NOT cover

Netflix/Prime/iQIYI/WeTV on mobile — apps are closed, no injection surface. The only streaming-on-mobile play is the Firefox-Android extension probe (R1), and only for sites whose *web* players work in mobile Firefox (YouTube yes; Netflix mobile-web playback is doubtful — that's what the recon is for).
