# Platform Recon — Prime Video · HBO Max · Apple TV+ (desk research, 2026-07-07)

Exploratory feasibility research for the next platform-expansion round.
Scope: acquisition tractability ONLY (Connor has already validated the
audience/content-value side). Method: parallel web research over existing
open-source tools, extensions, and player-tech documentation. **Nothing
here replaces the live devtools recon** required by the platform gate
(memory `feedback_extension_caption_verification`) — this doc tells us
where to spend that recon effort and what to look for.

**Verdict summary: all three are MODERATE — none blocked, none free.**

| | Prime Video | HBO Max | Apple TV+ |
|---|---|---|---|
| Verdict | MODERATE (leans easy) | MODERATE | MODERATE |
| Subtitle format | **Whole-file TTML2/DFXP** | Segmented WebVTT (DASH) | Segmented WebVTT (HLS) |
| Acquisition | MAIN-world fetch/XHR hook on `GetVodPlaybackResources` (plain JSON) | MAIN-world `XMLHttpRequest.prototype.open` hook → `.mpd` URL → `mpd-parser` → stitch segments | webRequest on HLS master/subtitle m3u8 + segments (YouTube-style); `uts/v3` JSON assist |
| Working prior art | 2025 userscript + Kodi plugin + wayneclub downloader + Trancy/SLL extensions | **asbplayer v1.10.0 (2025), in-browser, MIT** + Trancy + Immersive Translate | Python rippers only (iSubRip, APPLE-TV-4K-Downloader); **no learning extension supports it → first-to-market** |
| Net-new code | **TTML→events parser** | mpd-parser dep + segment stitcher | segment stitcher (X-TIMESTAMP-MAP strip, boundary-cue dedup) |
| Same-lang gate risk | ⚠️ per-title/region licensing — MUST survey | ⚠️⚠️ highest — English-heavy catalog | ✅ best — 40+ sub langs incl. originals' own language (Pachinko: ko+ja SDH confirmed); check SDH-only caveat |
| DRM on subs | None (video-only) | None (video-only) | None (video-only) |
| Biggest unknown | gate survey | gate survey; `stpp`-only titles? | auth-gating on segment URLs; closed shadow DOM in player |

---

## 1. Prime Video (www.primevideo.com / amazon.com) — MODERATE, leans easy

**Transport (near confirmed-by-code):** each track is ONE whole TTML2/`.dfxp`
text document fetched via XHR. Track URLs live in the **plain-JSON** response
of `POST …/playback/prs/GetVodPlaybackResources` (regional hosts
`atv-ps-eu.primevideo.com` / `atv-ps.primevideo.com` / `atv-ps.amazon.com`;
superseded the old `GET /cdp/catalog/GetPlaybackResources`). Response carries
`subtitleUrls[]` + `forcedNarratives[]` (lang code, display name, url, type).
Request selects format via `supportedTimedTextFormats`/`subtitleFormat:
["TTMLv2","DFXP"]`. No segmentation, no encryption (unlike Netflix MSL).

**Acquisition (confirmed-by-code):** MAIN-world hook wrapping `fetch` +
`XMLHttpRequest`, match `/GetVodPlaybackResources`, read the JSON body,
postMessage tracklist to ISO — directly parallel to `netflix-main.content.ts`
but simpler (body is plain JSON). `webRequest` alone is insufficient (can't
read response bodies; the URLs are IN the body). **Observe, never forge** —
the POST needs a device/playback envelope we sidestep by hooking the
player's own response. Reference implementation: greasyfork "Amazon Prime
Video Subtitle Downloader" (2025), which does exactly this
(https://greasyfork.org/en/scripts/562565 — see `/code`). Corroborating:
wayneclub/Subtitle-Downloader, Sandmann79/xbmc Kodi plugin, asbplayer
(supported; its open issues are rendering-side, not acquisition).
Commercial proof of the overlay use case: "Subtitles for Language Learning
(Prime Video)", Trancy, Sabi.

**Net-new code:** a **TTML→CaptionEvent parser** (XML, `<p begin= end=>` +
`<span>` styling) — we only have VTT parsers today. This is the main build
cost.

**DOM (needs live recon):** SPA; historic selectors `atvwebplayersdk-*`
(e.g. `.atvwebplayersdk-captions-text`); native captions are DOM text →
CSS-hideable. Single MSE `<video>`, standard `timeupdate` playhead.
Class-name churn is a known maintenance hazard (Language Reactor's Prime
support periodically breaks).

**Gate risk (the decisive unknown):** Prime serves original-language tracks
on SOME foreign-origin content, but availability is per-title and
region-gated by licensing much more than Netflix. The big anime catalog is
the prize; whether JP subs ride JP audio there must be settled by the
~15-title survey.

**Live-recon checklist:**
1. GATE SURVEY FIRST: ~15 target-language titles (weight toward anime) — does
   a same-language soft-text track exist?
2. Confirm current `GetVodPlaybackResources` shape in Connor's region; verify
   a MAIN-world hook captures the body (HAR early if not).
3. Selectors: player root / fullscreen element (LCA rule!), `<video>`,
   native-captions node; SPA nav behavior (expect state-based mount
   reconciliation à la WeTV).
4. Chrome MV3: subtitle-CDN CORS on the TTML GETs; add page origin via
   `LOOM_CORS_ORIGINS`.

## 2. HBO Max (play.hbomax.com) — MODERATE

**Transport (confirmed-by-code):** Shaka Player over DASH `.mpd`. Subtitles
advertised in the MPD's `mediaGroups.SUBTITLES`; the usable delivery is
**segmented WebVTT** (many small `.vtt` segment URLs via `SegmentTemplate`).
The spec-side `stpp` (TTML-in-fMP4) variant exists but the working
interceptors ride the WebVTT path — **no mp4box/TTML demux needed**
(asbplayer's dependency tree has none).

**Acquisition (confirmed-by-code — asbplayer v1.10.0, 2025, MIT):**
1. MAIN-world hook on **`XMLHttpRequest.prototype.open`** capturing the URL
   matching `/https:\/\/.+\.mpd/`. ⚠️ **HBO Max fetches the MPD via XHR, not
   `fetch`** — a fetch-only or JSON.parse-only hook misses it.
2. Re-fetch that `.mpd` from page context; parse with **`mpd-parser`** (npm,
   videojs).
3. Per `[language, info]` in `mediaGroups.SUBTITLES.subs`: collect
   `playlists[].segments[].resolvedUri` → fetch all → concatenate → parse
   with our existing `parseVtt`.
Reference files: asbplayer `extension/src/entrypoints/hbo-max-page.ts` +
`extension/src/pages/mpd-util.ts`. Trancy + Immersive Translate also ship
HBO Max support (technique unpublished). Subtitle segments are plaintext
(DRM covers A/V AdaptationSets only — ottball.com/hbo-max-dissected).

**Net-new code:** `mpd-parser` dependency + N-segment fan-out/stitcher.
(The stitcher is shareable with Apple TV+ — build once.)

**DOM (inference — needs live recon):** Shaka-based SPA; expect Shaka's
`shaka-text-container` DOM-text rendering unless overridden. Anchor
selectors unknown.

**Gate risk (HIGHEST of the three):** catalog is English-origin-heavy;
international titles typically play original audio + English subs, with
original-language tracks present on only part of the catalog. Unlike
Crunchyroll it's not a blanket fail, but the survey pool is thinner.

**Live-recon checklist:**
1. GATE SURVEY FIRST — this is the go/no-go; if it fails, nothing else
   matters.
2. Confirm the XHR-hook captures the MPD URL; check whether any priority
   title is `stpp`-only (would force mp4box.js — reassess).
3. Selectors: player root/fullscreen anchor, native-cue node (DOM vs
   canvas), SPA nav.
4. Segment-CDN CORS from Chrome MV3; add `play.hbomax.com` via
   `LOOM_CORS_ORIGINS`.

## 3. Apple TV+ (tv.apple.com) — MODERATE

**Transport (confirmed-by-code via rippers):** standard Apple HLS —
**segmented WebVTT** media playlists; segments are plaintext (video/audio
FairPlay/Widevine-protected, subs not). Segments carry `X-TIMESTAMP-MAP`
(strip during assembly); forced/CC-SDH/normal variants per language need
dedup. References: iSubRip (github.com/MichaelYochpaz/iSubRip — iTunes-store
channel only, and currently broken by a backend change: don't hard-code its
endpoints) and APPLE-TV-4K-Downloader/appletv.py (authenticated streaming
path; concatenates plaintext segments).

**Browser support (multiple-sources):** Firefox plays Apple TV+ since FF115
(Bugzilla 1724027 RESOLVED — Widevine CBCS). Chrome/Firefox get Widevine
(FairPlay is Safari-only). Since neither plays HLS natively, the player is
an **MSE+JS engine** → subtitle playlist/segment fetches go through
fetch/XHR → **`webRequest`-visible** (YouTube-style), unlike Netflix's
encrypted manifest. Track enumeration assist: the `tv.apple.com/api/uts/v3`
playback JSON (live-confirmed firing on page load; authenticated for the
TV+ channel; shape churns — prefer observing over replaying).

**Acquisition (recommended):** webRequest capture of the HLS master playlist
(`EXT-X-MEDIA TYPE=SUBTITLES` → per-track media-playlist URIs) → fetch the
subtitle media playlist → fetch+stitch segments (strip headers/timestamp
maps, dedupe boundary cues) → `parseVtt`. Fall back to a MAIN-world hook or
the `uts/v3` JSON if webRequest proves flaky.

**Gate (BEST of the three — multiple-sources):** Apple TV+ originals carry
40+ subtitle languages including the original language (Pachinko confirmed:
ko SDH + ja SDH + zh-Hans/Hant + yue + th + hi + ta + te + vi + id + ms +
tl…). Caveat to verify live: many same-language tracks are **SDH** (sound
descriptions in brackets) — acceptable but worth confirming per title
whether clean dialogue tracks also exist.

**First-to-market:** no language-learning extension (Trancy, Language
Reactor, Migaku, asbplayer) supports Apple TV+ today. Only prior art is
"Apple TV SubStyler" (CSS restyle of native subs — which also implies
native subs are DOM text, hence hideable and NOT in an unreachable
closed shadow root, though the player DOM needs live confirmation).

**Live-recon checklist:**
1. Logged-in session: are subtitle m3u8/segment fetches visible to
   webRequest on Firefox MV2 AND Chrome MV3? Are URLs auth-token-gated
   (matters only if we re-fetch rather than observe)?
2. Player root/fullscreen anchor; closed-shadow-root check on the player
   subtree; native-cue node.
3. Eager vs on-track-select playlist fetching (affects acquisition timing —
   may need a track-select nudge like YouTube's CC-click trigger).
4. SDH-vs-clean same-language tracks on target titles (Pachinko, Drops of
   God, etc.).
5. CDN CORS if re-fetching; add `tv.apple.com` via `LOOM_CORS_ORIGINS`.

---

## Shared engineering notes

- **Segmented-VTT assembly is needed by BOTH HBO Max and Apple TV+** —
  build one stitcher (fetch list → concat → strip `WEBVTT`/`X-TIMESTAMP-MAP`
  headers → dedupe boundary-overlap cues) and share it.
- **Prime is the only one needing a TTML parser** — but TTML is also what
  several future platforms (Disney+) serve, so it's a durable investment.
- **CORS is now env-only** (`LOOM_CORS_ORIGINS` appends since 0.3.0) — new
  page origins need a Railway env edit, not a redeploy.
- All three respect the established playbook: LCA/fullscreen-element anchor
  rule, state-based mount reconciliation for churny players, observe-never-
  forge acquisition, HAR early when a hook sees nothing.

## Recommended sequencing (Claude's read; Connor decides)

Desk research clears all three for live recon. The gate survey is cheap
(~30–60 min/platform with devtools) — do all three surveys before building
anything, since HBO Max in particular could still fail its gate.

Provisional build order if all gates pass:
1. **Prime Video** — simplest acquisition (one JSON hook, whole-file
   tracks), strongest audience overlap (anime), most prior art.
2. **Apple TV+** — best confirmed same-language coverage, first-to-market,
   but carries the most live-recon unknowns (auth gating, shadow DOM).
3. **HBO Max** — technique fully proven (asbplayer is a working blueprint),
   but weakest catalog fit; build only if its gate survey surprises us.
