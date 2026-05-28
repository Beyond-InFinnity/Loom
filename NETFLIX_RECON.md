# Netflix Port — Recon & Spike Plan

**Status:** Recon phase, started 2026-05-28.  Goal is a 2–3 day investigation that produces a binary go/no-go decision on porting Loom's dual-subs overlay from YouTube to Netflix.  No production code in this phase — `apps/extension/` stays YouTube-only until the spike validates the path.

**Why this exists:**  YouTube was the obvious first platform (open captions, large language-learning catalog, well-documented player API).  Netflix is the natural second because (a) most of Loom's code is platform-agnostic — overlay rendering, annotate/romanize batching, settings, presets, owner-key auth all carry over unchanged; (b) Netflix has by far the deepest Asian-language catalog (anime, K-drama, C-drama, J-drama, films) which directly maps to Loom's current testing matrix; (c) substantial community precedent (Language Reactor, Subadub) confirms the architectural shape works.

**Why not HBO Max:**  See `CLAUDE.md` discussion thread.  Short version: smaller Asian catalog, no community precedent, more aggressive obfuscation, more frequent platform re-architecture.  Netflix-then-Max is the path if there's ever demand; not Max-instead-of-Netflix.

---

## What we already know (or strongly believe)

These are assumptions to verify during recon, not facts.  Each gets confirmed/refuted in the **Findings log** below.

1. **Subtitle delivery is HTTP-fetchable plain text.**  Netflix serves subtitles as TTML/IMSC (XML-based) or WebVTT depending on locale.  Subtitles are *not* DRM-encrypted even though video is — they're standard HTTP fetches once you have the URL.
2. **Subtitle URLs live in the manifest.**  Each `/manifest` (or `/cadmium/playercache`) response enumerates all available audio + subtitle tracks with direct URLs.  No equivalent of YT's pot-token rigmarole.
3. **The player exposes a stable JS API.**  `netflix.appContext.state.playerApp.getAPI()` (or similar — exact path needs confirmation) returns a `videoPlayer` object with `getCurrentTime() / getDuration() / isPaused()`.  Stable across years per community implementations.
4. **All language tracks are first-class.**  No "lang-swap and pray" pattern — the manifest enumerates ja/en/zh/etc. URLs directly.  Auto-pick + per-layer track selection should port cleanly from our existing settings UI.
5. **DRM-only titles exist for some Originals.**  Some newer titles encrypt the subtitle path too, presumably as part of an anti-piracy push.  Our fallback would be a graceful "this title doesn't expose readable subtitles" message — not a crash.

---

## Architecture: what carries over vs. what needs writing

Based on the YouTube codebase survey:

**Reused verbatim (no changes):**
- `components/{caption-overlay, annotated-text, settings-panel, loom-pill, dormant-pill, loom-app}.tsx`
- `lib/annotate/`, `lib/romanize/`, `lib/presets/`, `lib/api-client.ts`, `lib/owner-key.ts`
- `lib/captions/{stream, auto-pick, lang-code, lang-support}.ts` (the playhead-tracking + classification logic is platform-agnostic by design)
- `components/caption-context.tsx` (with the addition of a `platform: "youtube" | "netflix"` discriminator in the payload)

**Refactored to be platform-agnostic:**
- `lib/captions/types.ts` — `CaptionEvent` already is; `CaptionTrack` mostly is.  May need a `platformSourceUrl` or similar generic field.
- `lib/captions/discover.ts` — the prefs / subscriber / cache infrastructure ports cleanly; the YT-specific MAIN-world plumbing splits out into a platform adapter.

**Newly written for Netflix:**
| New file | Mirrors | LOC est. |
|---|---|---|
| `entrypoints/netflix-main.content.ts` | `yt-main.content.ts` (MAIN-world injection — reads `netflix.appContext` from page-world JS) | ~100 |
| `entrypoints/netflix.content.tsx` | `content.tsx` (ISOLATED world, mounts overlay above Netflix's `.watch-video` container) | ~150 |
| `lib/captions/netflix/discover.ts` | YT's `discover.ts` shape — manifest interception, track enumeration, payload emit | ~300 |
| `lib/captions/netflix/fetch.ts` | `lib/captions/fanout.ts` (track URL → text body) | ~150 |
| `lib/captions/netflix/parse-ttml.ts` | `parseJson3()` in `fanout.ts` — TTML/IMSC → `CaptionEvent[]` | ~200 |
| `lib/captions/netflix/parse-vtt.ts` | (same, if WebVTT path is hit) | ~100 |
| `lib/captions/netflix/player-time.ts` | YT's `timeupdate` listener path — subscribes to Netflix player API | ~80 |
| `lib/overlay/netflix-player-anchor.ts` | `lib/overlay/player-scale.ts` — finds Netflix's `<video>` container + scales typography to its height | ~100 |

Subtotal: **~1180 LOC of new code**.  Plus ~100 LOC of refactoring to split YT-specific bits behind a platform adapter interface.  Compared to the entire existing extension at ~5000 LOC, that's about a 25% additive — a reasonable port cost.

---

## Recon checklist

Work through these in order.  Each step has a small, concrete artifact — copy into the **Findings log** at the bottom as you go.

### Step 0 — Choose recon titles

Pick three Netflix titles spanning our language families.  Goal: cover the full surface (Originals vs licensed, anime vs live-action, multi-language vs limited).

- [ ] **Japanese + English** title.  Suggestion: *Alice in Borderland* (S1 has manual JA + EN), *Violet Evergarden* (anime, multi-lang), or any current Netflix Anime release.
- [ ] **Chinese + English** title.  Suggestion: *The 8 Years Engagement* (CN film with EN), or any Taiwanese drama in the catalog.  *Three-Body* on Netflix (the Netflix adaptation, not the Tencent one) has multi-language.
- [ ] **Korean + English** title.  Suggestion: any K-drama; *Squid Game*, *Crash Landing on You*, *Kingdom*.

Record the chosen titles in the Findings log so re-running the recon is reproducible.

### Step 1 — Confirm manifest interception is possible

Open one of the recon titles in Firefox with devtools → Network tab → filter "manifest".

- [ ] Find a request to `/nq/msl_v1/cadmium/pbo_manifests/...` or `/manifest` (URL pattern varies by region / A-B test bucket).
- [ ] Confirm the response is JSON (not encrypted binary).
- [ ] Save a sanitized version (redact `userId`, `playableId`, auth tokens) of the response showing the **subtitle tracks section** to `spike/netflix/sample-manifest.json` once we start the spike.
- [ ] Identify the field name(s) that enumerate subtitle URLs.  Historically: `timedtexttracks[].ttDownloadables[].downloadUrls`.  Confirm.

### Step 2 — Verify subtitle URLs are fetchable + parseable

From the manifest captured in Step 1, copy one subtitle URL into the address bar (or a `curl`).

- [ ] Does it return 200 OK without auth headers?  (It should — once the URL is signed by the manifest, the URL itself carries the auth.)
- [ ] Confirm the response format.  Expected: TTML XML starting with `<?xml version="1.0"?>` + `<tt xmlns="http://www.w3.org/ns/ttml">`, OR WebVTT starting with `WEBVTT\n\n`.
- [ ] Save one example response to `spike/netflix/sample-subs-ja.{ttml,vtt}`.

### Step 3 — Inspect the player API surface

On the watch page, in the console:

```js
// Try a few of these — exact path varies by Netflix's current code:
netflix.appContext.state.playerApp.getAPI().videoPlayer
netflix.appContext.getPlayerApp().getAPI().videoPlayer
window.player  // sometimes
```

- [ ] One of these (or a variant) returns a player object.  Record exactly which path works.
- [ ] On that object, confirm methods exist: `getCurrentTime()`, `getDuration()`, `seek()` (or equivalent), some `getPlayerStatus()` / `isPaused()`.
- [ ] Subscribe to `timeupdate`-equivalent — Netflix typically exposes `addEventListener('currenttime', cb)` or similar on the player.  Find the canonical event name.

### Step 4 — Confirm overlay can mount above Netflix's chrome

In devtools elements, find the Netflix `<video>` element and its containing `.watch-video` (or current-name) div.

- [ ] Identify the wrapper element that's the natural overlay anchor — equivalent to YouTube's `#movie_player`.  It should encompass the video + Netflix's own subtitle layer + the player chrome.
- [ ] Inject a test `<div style="position: absolute; background: red; ...">` via the console; confirm it renders ABOVE the video and BELOW the player chrome (or equivalent z-index layering).

### Step 5 — Smoke-test the parse path

Take the TTML/VTT response captured in Step 2.  Write (one-off) a Node script that:

- [ ] Parses it
- [ ] Emits a list of `{start_ms, end_ms, text}` tuples
- [ ] Confirms the count is reasonable (a 50-min episode should have 500–1500 events)
- [ ] Confirms the text matches what you see on-screen for at least 3 timestamps

Put the one-off script in `spike/netflix/parse-test.mjs`.  It'll seed the production parser.

### Step 6 — Recon writeup

Once Steps 1–5 are all checked, fill in the **Findings log** below with:

- What worked verbatim from the assumptions
- What needed adjustment (different field name, different player path)
- What broke or wasn't reachable
- Go / no-go recommendation with one paragraph of rationale

If go: open a tracking issue for the full port and start scaffolding the file structure above as a new branch.  If no-go: document why so we don't re-walk this path 6 months later.

---

## Decision framework — what would kill the port?

A go/no-go after the spike, not a sliding scale.  Three things would kill it:

1. **Subtitle URLs require active auth** (e.g., a session token that rotates per-request).  Then we'd need to either keep the auth alive ourselves (fragile) or read subs only from already-cached responses (covers ~0% of titles).  Likelihood low but possible.
2. **The player API has been newly obfuscated** to the point where MAIN-world JS can't reach the current time / duration / state reliably.  Likelihood low — Netflix has historically left this surface alone.
3. **TTML/VTT is no longer being served** for the recon titles — replaced by some encrypted-blob format only the official player can decode.  This would be a fundamental shift in how Netflix delivers subs; not impossible but no signs of it as of late 2025.

If none of the three trigger, port is a go.  The work is mechanical from there.

---

## Risks & open questions

**Anti-extension cat-and-mouse.**  Netflix has blocked specific extensions before (notably Teleparty, which crossed into watch-party UX manipulation).  Loom's surface is more conservative: we don't touch playback, we don't talk to friends, we don't bypass any rights enforcement — we just render a second subtitle line on top of subs Netflix is *already* sending to your browser.  Risk is real but the precedent for "subtitle augmentation" extensions surviving long-term is strong (Language Reactor has run for years).

**TOS.**  Same posture as the YouTube port: we don't reverse engineer DRM, we don't redistribute content, we don't enable downloads.  The activity is "browser-side rendering augmentation of content the user already has the right to watch."  Worth getting a paragraph from a lawyer if Loom ever monetizes, but blocking on legal review for a research spike would be premature.

**Locale variations.**  Netflix's subtitle delivery format isn't uniform globally — different regions get TTML vs VTT, different field names in the manifest.  We should plan to handle both parser paths.  The recon should hit at least 2 distinct title regions to catch this early.

**Player code minification.**  The `netflix.appContext` field path is stable in spirit (a player API exists and has these capabilities) but field names get rotated occasionally.  Maintenance burden is non-zero but matches what every Netflix-aware extension deals with.

**Open question — DRM-protected subtitle paths.**  Some Originals reportedly serve subtitles inside the same encrypted blob as video.  We need to find out during recon: is this a small minority of titles (acceptable; graceful degradation) or a growing trend (would impact the port's long-term value).

**Open question — manifest interception timing.**  YouTube's first /timedtext request fires reliably during page load; we capture it via webRequest.  Netflix's `/manifest` fires when the user actually clicks play (or auto-plays).  This means our discovery timing changes — we'd intercept on playback start, not on page load.  Settings UI needs to handle "manifest not yet fetched" gracefully.

---

## Tentative port plan (after spike validates path)

If the recon goes green, the work breaks into roughly:

- **5h-1** — Platform-adapter refactor.  Pull YT-specific bits behind a `CaptionPlatform` interface; the rest of `lib/captions/` stops importing YT-specific modules directly.  ~200 LOC churn, no behavior change for YouTube.
- **5h-2** — Netflix manifest discovery + track enumeration.  `entrypoints/netflix-main.content.ts` + `lib/captions/netflix/discover.ts`.  No overlay yet; just verify the payload looks right via console logs.
- **5h-3** — TTML parser + first overlay render.  `lib/captions/netflix/parse-ttml.ts` + wire the overlay onto Netflix's player container.  Static subs render correctly without playhead tracking.
- **5h-4** — Player API time sync.  Hook into Netflix's player events so the overlay tracks playhead.  Full overlay parity with YouTube.
- **5h-5** — WebVTT fallback for regions that get VTT instead of TTML.  ~100 LOC.
- **5h-6** — Settings polish.  Settings panel needs to know which platform it's on (subtle UI tweaks: track-picker terminology, ASR-track distinction may not apply on Netflix, etc.).

Total: ~2 weeks of focused work after the spike.  Roughly the same scope as Step 5d was.

---

## Findings log

> Fill in as recon progresses.  Each entry: date + step number + what we learned.  Failures are as valuable as successes — they tell us where the assumptions broke.

### 2026-05-28
- Document created.  Recon not started yet.
- Recon titles: TBD (pick during Step 0).

<!-- New entries below this line, newest at the bottom -->
