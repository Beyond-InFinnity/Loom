# Loom Player — Build Plan (for sign-off)

> **Status:** DRAFT for Connor's review. Scope not yet approved. Nothing here is built beyond what §2 marks as the current baseline. This draft has been adversarially pressure-tested (feature-completeness, regression-safety, feasibility/sequencing) and revised; the verified findings are folded in.
> **Companion docs:** `MOBILE_ROADMAP.md` (§4 substeps 7a–8c, §5/§5a single-window decision — authoritative sequencing), `CLAUDE.md` (session state), `VOCAB_LOOKUP.md` (definition pipeline).
> **One-line goal:** a native, self-contained desktop media player in the class of VLC / ArcPlayer / mpv — plays *any* local file — that also renders Loom's full 4-layer live learning stack with pause-to-define, for the anime/fansub audience whose files (10-bit HEVC, AC3/EAC3/DTS/TrueHD, ASS softsubs) browsers can't decode.

---

## 0. Framing

**What this plan covers:** growing the existing Tauri 2 + libmpv single-window shell at `apps/desktop` into a player a real user would choose over VLC — *plus* the Loom learning layer no other player has.

**What is already done (the hard part).** The extension's entire caption/learning stack was extracted into `@loom/player-ui` (7a/7b/7c) and the player consumes the *same* modules. Live in the player today, driven by libmpv's clock: native line + foreign line + romanization line + per-token furigana/pinyin/RR ruby + pause→word→definition card (grammar breakdown, gloss-language picker, ~20 definable languages). **So "recreate the extension's caption abilities" is structurally complete** — what remains is the *player shell* around it and the rough edges below.

**Non-goals for this plan** (tracked elsewhere): streaming-platform playback (the browser extension), mobile/Android/Chromecast (`MOBILE_ROADMAP.md` 8a–8c), the OCR pipeline (Step 6), any server/API feature work.

**Hard constraints (standing, non-negotiable):**
1. **No regressions to the ~30-user browser extension.** Enforced by §4.
2. **No API/server change that affects the extension.** The player is a *pure new client* of the existing API (verified — §1).
3. **Mute is engine-level and default-on** (mpv `mute=yes` option before `mpv_initialize`, persisted). No feature may weaken this; volume is a *separate* control on top.
4. **Test media comes from `lexar/sources`, not `downloads`.**
5. **X11 is the reference session.** Wayland has a different GL/compositing + input-window model and is a separate later track (see P0.1 / P4); nothing here assumes Wayland behaves like X11.

---

## 1. Architecture & the regression firewall (baked into every phase)

The player reaches full functionality **without touching a line the extension depends on**, because two isolation layers already exist. An adversarial regression review verified all four load-bearing claims against the code and found **no forced firewall crossing** — every step below is honestly host-local.

### 1a. API isolation — two-base split, zero new server surface
- **Local sidecar** (`localhost:8765`, full `loom_api.main:app`): `POST /files/by-path`, `POST /video/scan`, `GET /files/{id}` — disk/video ops.
- **Prod** (`api.loom.nerv-analytic.ai`, `web.py`): `POST /annotate/batch`, `/romanize/batch`, `/define/batch`, `GET /define/capabilities`, `/styles/presets` — text ops.
- **The extension never calls `/files` or `/video`.** So even the `/video/scan` speed fix (P0.3) cannot touch the extension. The *only* other consumer of `scan_and_extract_tracks` is the web app's MKV UI → gate that change (new optional param or sidecar branch) and re-verify the web app.
- `ENGINE_VERSIONS` (Python-side) — the player changes no romanizer output, so **never bump it for player work**. Result cache is fail-open by construction.
- Player `ApiConfig.clientVersion = null` → `X-Loom-Version` omitted → extension telemetry stays clean. Keep it null.
- `/corpus/capture` (P3.3): request+response schema stays **byte-identical**; only the `platform` enum value `"player"` is new (a string). No route/response change.

### 1b. Package isolation — shared logic vs per-host seam impls
`@loom/player-ui` splits into **pure-shared logic** (both consumers) and **per-host seam impls** (swappable). The player registers its OWN `LoomHost` (Tauri settings-store storage · mpv `PlayheadSource` · prod `ApiConfig` · `navigator.language` locale). Every host difference is absorbed **host-locally**.

**The one catch:** the package is imported *by source* (`"main":"./src/index.ts"`, no `dist` boundary) — a behavior-change to a shared module ships to the extension the instant `wxt build` runs. Therefore:

**DO-NOT-behavior-change (shared) for player work** — do player work in `apps/desktop/src/player/*` / `src/settings/*` / `src-tauri/*` instead:
`captions/stream.ts` (& its `pickPrimary` — *distinct* from `auto-pick.ts`'s same-named fn), `captions/auto-pick.ts` (incl. `pickTarget`/`sameBaseLang`/`classifyLang` in `lang-support.ts`), `annotate/build-map.ts` + `romanize/build-map.ts`, `annotate/capabilities.ts` + `annotate/define-lang.ts`, `components/annotated-text.tsx` + `components/definition-card.tsx`, `orthography/build-segments.ts` + `annotate/group-segments.ts`, `i18n/*`, `captions/types.ts`.

**Guardrails (with the verified escape hatches):**
- **Language-code normalization is host-local.** ISO-639-2→base (`jpn`→`ja`, `chi`→`zh`) belongs in `apps/desktop/src/player/tracks.ts` (normalize `CaptionTrack.audioLangCode` before it reaches the shared comparators). **Never** teach shared `sameBaseLang`/`classifyLang` about ISO-639-2 — that ships to the extension. (Note: the player selects the study track via the host's `selectStudyTracks()` in `tracks.ts`, not shared `pickTarget`.)
- **Caption delay/sync is host-local.** Shift `event.start/end` in `player-window/main.tsx` *before* `stream.start()` (per-track delay — the true `loom_core::shift_events` analog), or add an offset in the player's mpv `PlayheadSource` (global delay). A live slider re-calls `stream.start()` with re-shifted events. **Never** edit shared `captions/stream.ts`.
- **Font scaling / caption geometry is host-local.** The `ScaleSource` seam + `LoomHost.scale?` **already exist**; the player just doesn't register one yet (it uses a manual `styles.captionScale` multiplier). Registering a picture-measuring `ScaleSource` is a one-line host addition consumed in `main.tsx`. The extension has its own `usePlayerScale` and is unaffected.
- **Settings panel is already independent.** `apps/desktop/src/settings/SettingsPanel.tsx` is a self-contained transcription importing only read-only shared modules (`presets`, `i18n`, `lang-support`) + host-local `model`/`host`. Reparent *that* into the player window; **do not** import the extension's `components/settings-panel.tsx`.
- Keep **seam interface signatures fixed** (conforming impls only). Fix any WebKit-vs-Firefox render divergence in **player-local WebView CSS**, not shared components. Don't raise the build-map **chunk cap past 2000**.

**The gate for any unavoidable shared-package edit** (per `feedback_extension_caption_verification` — caption logic can't be unit-validated):
1. `cd apps/extension && npm run compile` (tsc through the shims into the package) — clean.
2. `cd apps/extension && npm test` (one vitest run covers extension + package specs) — green.
3. Build **both** `build:firefox` (MV2) **and** `build:chrome` (MV3).
4. Build the DEV variant (`LOOM_API_BASE=https://api.loom.nerv-analytic.ai npm run build:firefox:dev`).
5. **Live prod smoke** on YouTube + Netflix: activation→dual subs, playhead tracking, pause→word-glow→click→card (Latin *and* CJK), track switching; a Prime/Netflix positional cue if `stream.ts`/`pickPrimary` touched; Firefox specifically if ruby touched.

> **Upshot:** every phase is designed to live entirely in the host layer + local sidecar. If a task ever seems to need a shared-package or extension-visible API change, that's a design smell — stop and re-scope it host-locally (the escape hatches above show it's always possible for this plan).

---

## 2. Current baseline (verified)

**Works:**
- Single-window libmpv render (render API → `GtkGLArea`, transparent WebKit webview composited over it in one `GtkOverlay`); real video renders inside the Tauri window with the DOM caption stack on top.
- Mute: bulletproof, engine-level, default-on, persisted.
- The full Loom 4-layer learning stack + pause→word→definition card (shared package).
- Transport (minimal): play/pause, absolute-scrub seek, time/duration readout, subtitle-track select, audio auto-follows study language (blindly SETs `alang` — see gap below).
- Lifecycle: per-generation pump flag + ordered teardown (free render ctx before mpv destroy, on the GTK thread).
- Cross-window settings store (`settings_store.rs` → `~/.config/loom/player_settings.json`, `loom-settings-changed` broadcast).

**Broken / bare (the P0/M0 targets):**
- **#2 in-window UI buttons don't receive input** → *corrected* root cause (see P0.1): GtkOverlay child pass-through already defaults FALSE (the webview *should* get input), so the real suspect is **sibling native GdkWindow X11 stacking** — the `GtkGLArea`'s mandatory GL window vs the `WebKitWebView`'s accelerated-compositing window — where the GLArea's native window intercepts the pointer. Interim: the main-window `PlayerRemote` drives playback.
- **#1 subtitle load is slow (up to ~20s)** → `/video/scan` eagerly extracts *all* text tracks (one ffmpeg demux) + a langdetect pass per track.
- **#3 live-settings** → mostly a symptom of #2; color/size/position already broadcast + apply live.
- **No read-side FFI.** Rust exposes only `player_attach/load/command/stop/set_mute/is_muted`; the frontend receives only 4 observed scalar props (time-pos/pause/duration/eof). `mpv_get_property` is *declared* in `mpv_ffi.rs` but wired to nothing, and nothing decodes `MPV_FORMAT_NODE` → **no way to enumerate `track-list`/`chapter-list`/`aid`.** This blocks any real audio/subtitle/chapter picker (see P0.5).
- **Caption geometry ignores letterbox.** mpv renders video (with its own black bars) into the full `GtkGLArea`; the DOM overlay covers the whole area. Fonts scale off a manual multiplier, not the actual picture rect → captions can be oversized and float over the letterbox bars when video aspect ≠ window aspect (see P0.6).
- Two-window UX (main launcher/settings window + player window) — not VLC-like; a consequence of the input workaround.
- **Legacy `study-lang` read is per-window.** `main.tsx` reads `localStorage.getItem("loom_player_study_lang")||"ja"` — raw localStorage is per-window in Tauri, *not* the shared cross-window store, so a settings-window picker wouldn't propagate live (see P3.2).

**Dead / legacy code:** `src-tauri/src/mpv.rs` (IPC engine — truly superseded); `video_windows.rs` (dual-window — **superseded but the proven fallback**, keep until P0.1 lands); inert `MpvState`/`sync_overlay` hooks in `lib.rs`; `addLoomSubs` in `player/mpv.ts` (`sub-add … select Loom` — contradicts the `sid=no`/DOM-captions model; confirm unused + delete or repurpose for P3.4).

---

## 3. The build — phased

Each phase is a milestone with a **Connor live click-through acceptance** gate. Sizing is relative (S/M/L).

### Milestone M0 — Prove the interaction model *(gate before anything else)*
The single most important, riskiest decision. The player was just rebuilt dual→single and input is exactly what broke; do not build P0.2+/P1 on an unproven surface.

- **P0.1 — In-window pointer input (THE unlock; blocks all interactivity).** [L, highest risk]
  Everything interactive — the in-window transport bar (P1.1), keyboard focus (P1.6), settings-in-player (P3.1), and the headline pause→click-word→definition card — depends on this.
  - **Diagnose first (broadened):** (a) the existing `[Loom Player] pointerdown` capture log (did the webview get the event at all?); (b) does tao's own **edge-resize drag** fire at the player-window borders? (if even that's dead, it's X-level); (c) `xwininfo -tree` / `GDK_DEBUG=misc` to compare the GLArea vs webview **native-window stacking**; (d) temporarily remove the GLArea from the overlay → confirm clicks land → re-add → confirm they die (isolates the cause in minutes).
  - **Fix, correctly ordered:** LEAD with **native-GdkWindow X11 restacking** (e.g. `gdk_window_raise` on the webview's `GdkWindow` after `show_all`, or otherwise repairing overlay-child-vs-GLArea X stacking); ensure the overlay child (webview) is allocated **FILL / full-size** (halign/valign fill) so clicks land in every region. GtkOverlay child `pass_through` is a sanity check only (already FALSE).
  - **Two hard prohibitions (verified):**
    1. **No intermediate widget** may be inserted between the webview and the `GtkOverlay`/`Window`. Tauri's Linux edge-resize handler does `webview.parent().parent().downcast::<gtk::Window>().unwrap()` inside `connect_button_press_event` — it runs on **every mouse press**, so a wrapper/`GtkEventBox` would **panic on the first click**. Solve at the GdkWindow/X-stacking level or via child properties on the *existing* webview only.
    2. **Drop `set_ignore_cursor_events` / "pass-through-on-play".** That only made sense in the dual-window design (clicks passed through to a *separate* video window holding the controls). Single-window has only video below the webview — nothing to pass through *to* — so pass-through-on-play would kill the whole UI during playback and contradict P1.1. Webview input is **always-on**; clickable-vs-transparent is governed **per-element in DOM CSS** (`pointer-events: none/auto`, already used in `main.tsx`).
  - **Acceptance:** click a transport button in the player window → it acts; **click at least once** (surfaces any downcast panic immediately); pause → click a word on the video → definition card appears.

- **P0.1-FALLBACK — Dual-window revival (named branch, only if P0.1 can't be solved).** [M]
  `MOBILE_ROADMAP.md` §5 built and live-proved the dual-window path: mpv `--wid` into a Tauri-owned video window + a transparent, always-on-top Tauri overlay window carrying the DOM caption stack, position-synced from our own move/resize events, `setIgnoreCursorEvents` interactive-on-pause. Code still exists (`video_windows.rs`). If single-window input is intractable, revive this (accepting either a two-window UX or a pause-time overlay). **Do not delete `video_windows.rs` until M0 resolves one way or the other.**

**M0 gate:** *single-window input proven* **OR** *dual-window fallback chosen.* Only then commit P0.2+.

### Phase P0 — Stabilize the foundation *(make it usable + reliable)*
P0.3 is input-independent and can validate in parallel with M0.

- **P0.2 — Lifecycle hardening.** [M] open→load→close→reopen→load a *different* file is clean every time; close the `player_attach` guard-vs-teardown race; annotate the coupled teardown magic numbers (pump 0.1s tick vs 200ms destroy sleep). Test only with `lexar/sources`. **Acceptance:** 10× open/close/reopen across 3 files — no corruption, no audio leak, no stuck engine.
- **P0.3 — Fast subtitle load (sidecar-only).** [M] Lazy per-track extraction: extract the selected + auto-picked track on demand, background-extract the rest, defer/parallelize langdetect. Because langdetect no longer runs eagerly, **auto-pick must choose the target from container track-language metadata (ISO tags)** first, with background langdetect as correction/fallback; handle files whose sub tracks lack language tags. Scope strictly to the sidecar / a new optional `/video/scan` param; re-verify the web app's MKV-scan UI. Extension untouched. **Acceptance:** 1–2 track file shows subs in ≲3s; many-track file no longer blocks on all-track extraction.
- **P0.4 — Dead-code cleanup (partial; gated).** [S] Delete the truly-superseded `mpv.rs` (IPC engine) + its command registrations + inert `MpvState`/`mpv_stop_inner` hooks **now**. **Keep `video_windows.rs` + `setup_player_windows`/`set_overlay_interactive` until the M0 gate resolves**, then delete in a follow-up. Confirm `addLoomSubs` unused → delete or repurpose for P3.4.
- **P0.5 — Read-side FFI: `player_get_property`.** [M] New Tauri command calling `mpv_get_property` with `MPV_FORMAT_NODE`, serializing `track-list` / `chapter-list` / current `aid`/`sid` to JSON. **Prerequisite** for the audio-track picker (P1.3), subtitle-source toggle (P1.4b), and chapters (P2.3) — none are buildable without it. Host-local (Rust engine only).
- **P0.6 — Caption picture-geometry source.** [M] Read mpv's actual rendered picture rect (`osd-dimensions`, or `video-params` dw/dh + margins mt/mb/ml/mr) via P0.5, and drive **both** caption font scale **and** vertical anchoring from the real picture box (not the letterboxed `GtkGLArea`). This is an M1 *correctness* fix, not a fullscreen nicety — captions currently mis-size/mis-anchor over black bars in normal windowed playback. Register it as the player's `ScaleSource` (+ a geometry offset consumed in `main.tsx`). Host-local.

**Milestone M1 = M0 + P0 complete: a usable, reliable, correctly-positioned Loom Player.**

### Phase P1 — VLC-class transport & playback *(the core player feel)*
Most items are free via the generic `player_command` set-property channel; readers need P0.5. Requires M0.

- **P1.1 — In-player transport bar** (move controls from the main-window `PlayerRemote` into the player window as an on-hover overlay bar): play/pause, seek scrub + relative ±5/10s, time/duration, **speed** (0.25–4× UI clamp on `speed`), **frame-step**/**frame-back-step** (commands; note frame-back-step depends on demux cache and can lag on long-GOP HEVC), and **A-B loop** (`ab-loop-a`/`ab-loop-b`, keyboard `l`) — the highest-value *learner* transport control (repeat one line to shadow/parse). No new FFI for these. [M]
- **P1.2 — Volume + audio output** slider (`volume`, 0–130; `volume-max` default 130). Mute stays default-on + engine-level; volume is independent, audible only after unmute. Add a **stereo/headphone downmix** option (`audio-channels=stereo`) for 5.1/7.1 sources. [S]
- **P1.3 — Audio-track picker** (enumerate via P0.5, select `aid`) alongside auto-follow; finish the **ISO-639-2→base-lang normalization host-side in `tracks.ts`** so the study/audio match logic works (e.g. `jpn`→`ja`). Fix the auto-follow so it picks the media's spoken track and is user-overridable (a Korean learner watching JP anime must be able to keep JP audio). [S+, needs P0.5]
- **P1.4 — Subtitle sources.** Two independent tracks:
  - **(a) Loom layer delay/sync** — host-side event-shift or playhead offset (see §1b); external sub load (an explicit "load subtitle…" action beyond the sibling auto-discovery). [M]
  - **(b) Original embedded subtitle toggle** — a first-class subtitle-source selector **Loom DOM layer / the file's own track (real `sid`) / off**. mpv already ships libass and merely disables it via `--sid=no`; enabling original-sub rendering (incl. **fansub ASS typesetting, signs, karaoke**) is as cheap as selecting an `sid` — libass draws over the video, beneath the transparent webview. This is a baseline expectation for this audience and was previously mis-scoped as a heavy P3.4 stretch. [S, needs P0.5]
- **P1.5 — Fullscreen** (Tauri window fullscreen + auto-hide chrome). Caption scaling/anchoring already handled by P0.6's picture-geometry source. [S]
- **P1.6 — Keyboard shortcuts** (mpv-conventional: space, ←/→, ↑/↓, f, m, `[`/`]`, `,`/`.`, `l`, `s`). [S]
- **P1.7 — OSD** feedback (transient time/volume/speed/seek/loop overlay on action). [S]
- **P1.8 — Screenshot** (`screenshot-to-file`). **Note:** mpv's screenshot captures the decoded video frame only — **not** the Loom DOM overlay. If annotated screenshots (frame + captions/definitions) are wanted, capture/composite the WebView instead. [S]
- **P1.9 — Decode & video-filter options.** Evaluate and expose **hardware decode** (`hwdec=auto-copy` — safe with the render API; the current `hwdec=no` will stutter on 10-bit HEVC, especially 4K — *measure on a 10-bit 1080p and a 4K sample before choosing a default*), a **deinterlace** toggle (`deinterlace` — relevant to interlaced DVD fansubs, incl. the project's own Inuyasha test corpus), and an **aspect-ratio override** (`video-aspect-override`: Auto / 16:9 / 4:3 / custom, for anamorphic DVDs). [M]

**Milestone M2 = P1 complete: plays like VLC, one window, tuned for fansub content.**

### Phase P2 — Navigation & library *(the "player app" / binge workflow)*
- **P2.1 — Open UX & memory:** drag-and-drop a file/folder; **recent files**; **resume-last-position** per file; and **sticky per-file (or per-folder) audio/sub track choices** (a dual-audio jpn/eng binge shouldn't re-pick every episode). Persisted in the settings store. [M]
- **P2.2 — Playlist / queue** + next/prev + auto-advance (folder-open enqueues siblings in order — the anime-binge path). [M]
- **P2.3 — Chapters** (enumerate via P0.5, seek `chapter`). [S, needs P0.5]
- **P2.4 — Window state:** remember size/position; real media title in the title bar; single-window consolidation (the main launcher becomes an entry point or is absorbed once settings live in-player). [S]

**Milestone M3 = P2 complete: a player you'd binge a season in.**

### Phase P3 — Loom learning-layer polish (player context)
- **P3.1 — Settings-in-player:** reparent the **already-independent** desktop `SettingsPanel.tsx` into the player window as an over-video panel (VLC-style preferences). Host-local; depends on M0. [M]
- **P3.2 — Study-language picker:** the study lang already exists (`localStorage "loom_player_study_lang"`), but route it through the **shared cross-window store** (`settings_set`/StorageAdapter) so a settings-window pick propagates live to the player window like color/size. Add explicit auto-detect (from audio/subs) + manual override, remembered. [S]
- **P3.3 — Corpus capture + offline spool (7d):** mirror the desktop sidecar spool; opt-in consent UI; platform `"player"` (the richest source — full fansub ASS incl. signs/karaoke). Schema unchanged (§1a). [M]
- **P3.4 — Simultaneous original typesetting + Loom layer** (stretch): only if the user wants the file's ASS typesetting *and* the Loom learning layer at once — that's the JASSUB-in-DOM case (render libass output inside the webview alongside the DOM stack). The simple "show the original subs instead" case is already P1.4b. [L, optional]

### Phase P4 — Distribution & other platforms (later tracks — noted, not scheduled)
- Linux `.deb`/`.rpm` exist → add **AppImage**; **Windows** single-window embedded (host swap, payload identical) + **macOS**; **Wayland** (`--gpu-context` subsurface / offscreen bridge — its input-window model differs from the X11 P0.1 analysis); Tauri **auto-updater**; **Atmos/OAMD → binaural** software render (stretch, `ROADMAP.md` Path B).

---

## 4. Regression-safety checklist (reference — applies to every change)

- [ ] No behavior-change to a shared `@loom/player-ui` module (§1b list). If unavoidable → run the full gate (§1b) incl. live prod smoke on YT + Netflix.
- [ ] No new/changed server route or response the extension consumes. Sidecar-only changes are fine; `scan_and_extract_tracks` changes re-verify the web app.
- [ ] `ENGINE_VERSIONS` not bumped for player work; `ApiConfig.clientVersion` stays `null`; two-base split preserved (files/video → sidecar, text → prod, define never to sidecar).
- [ ] Language-code normalization, caption delay, and font/geometry scaling all done **host-local** (tracks.ts / main.tsx / player ScaleSource) — shared `sameBaseLang`/`classifyLang`/`stream.ts`/`annotated-text.tsx` untouched.
- [ ] Seam interface signatures unchanged; WebKit render tweaks in player-local CSS only.
- [ ] Mute default-on + engine-level intact.
- [ ] `cd apps/desktop && npx tsc --noEmit` clean; `cargo check` clean; extension `npm test` still green (only if any shared file was touched).

---

## 5. Open decisions for Connor

1. **M0 shape.** Confirm the input-proof gate (P0.1) is the first deliverable, with the §5 dual-window revival as the named fallback if single-window input proves intractable. (Recommend: yes — an unusable player can't be evaluated, and the fallback keeps M0 from being a dead end.)
2. **`hwdec` default (P1.9).** After measuring: default to `hwdec=auto-copy` for smooth 10-bit HEVC, or keep `no` for maximum compatibility and expose a toggle? (Recommend: measure first, likely `auto-copy` default + toggle.)
3. **Original-sub display priority (P1.4b).** Is "show the file's own ASS/signs via libass by selecting a real `sid`" a first-class P1 feature (recommended — it's near-free and expected), or deferred?
4. **Slow-load aggressiveness (P0.3).** Extract selected immediately + background-extract the rest (fast first paint, no later stall — recommended) vs. strictly on-demand?
5. **Study/audio-language precedence (P1.3/P3.2).** Auto-detect from audio, explicit picker, remember-per-file — or all three with a precedence order?
6. **Volume vs mute UX (P1.2).** Separate mute button + volume slider (VLC-style, recommended) or unified? Mute stays default-on regardless.
7. **P4 timing.** Windows/macOS/AppImage now vs. after M3? (Recommend: after M3 — one platform excellent first.)
8. **P3.4 (simultaneous typesetting + Loom).** In scope or explicitly deferred? (The one genuinely large, optional item.)

---

## 6. Suggested sequence

**M0 (prove input) → M1 (P0 stabilize + geometry) → M2 (P1 VLC transport) → M3 (P2 library) → P3 polish → P4 platforms.**
P0.1 (input) is the critical-path unlock and gates all interactivity; P0.3 (fast subs) is input-independent and validates in parallel; P0.5 (read FFI) precedes the track/chapter/sub pickers; P0.6 (picture geometry) is an M1 correctness fix. Every step stays in the host layer + local sidecar, so the extension and API are never in the blast radius.
