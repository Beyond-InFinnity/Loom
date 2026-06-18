# Netflix Port — Recon & Spike Plan

**Status:** Recon **executed 2026-05-30** (started 2026-05-28).  Goal was a binary go/no-go on porting Loom's dual-subs overlay from YouTube to Netflix.  **Verdict: GO.**  Every load-bearing capability is confirmed in the current (2024–2026) source of three independently-maintained extensions, and the parse path is validated end-to-end (`spike/netflix/parse-test.mjs`, 24/24).  One assumption was **refuted and corrected** (manifest is MSL-encrypted → needs a MAIN-world `JSON.parse` hook, not `webRequest`), which actually makes the port *simpler*.  One real constraint surfaced (image-based subtitles for some CJK/Greek/Hebrew titles).  See the **Findings log** at the bottom.  `apps/extension/` stays YouTube-only until the port branch begins; the spike artifacts live in `spike/netflix/`.

**Why this exists:**  YouTube was the obvious first platform (open captions, large language-learning catalog, well-documented player API).  Netflix is the natural second because (a) most of Loom's code is platform-agnostic — overlay rendering, annotate/romanize batching, settings, presets, owner-key auth all carry over unchanged; (b) Netflix has by far the deepest Asian-language catalog (anime, K-drama, C-drama, J-drama, films) which directly maps to Loom's current testing matrix; (c) substantial community precedent (Language Reactor, Subadub) confirms the architectural shape works.

**Why not HBO Max:**  See `CLAUDE.md` discussion thread.  Short version: smaller Asian catalog, no community precedent, more aggressive obfuscation, more frequent platform re-architecture.  Netflix-then-Max is the path if there's ever demand; not Max-instead-of-Netflix.

---

## What we already know (or strongly believe)

These are assumptions to verify during recon, not facts.  Each gets confirmed/refuted in the **Findings log** below.

1. **Subtitle delivery is HTTP-fetchable plain text.**  Netflix serves subtitles as TTML/IMSC (XML-based) or WebVTT depending on locale.  Subtitles are *not* DRM-encrypted even though video is — they're standard HTTP fetches once you have the URL.
   - ✅ **CONFIRMED, with a caveat.**  The *subtitle documents* are plain text (WebVTT / TTML-DFXP) on plain HTTPS GETs, no auth header.  Caveat: the URLs are signed + ~12 h time-limited (`e=` expiry), so fetch-and-cache immediately, never persist the URL.  Caveat 2 is assumption #5 (image-based tracks).
2. **Subtitle URLs live in the manifest.**  Each `/manifest` (or `/cadmium/playercache`) response enumerates all available audio + subtitle tracks with direct URLs.  No equivalent of YT's pot-token rigmarole.
   - ⚠️ **HALF-RIGHT — and the wrong half is the load-bearing one.**  The URLs *do* live in the manifest (`result.timedtexttracks[].ttDownloadables['webvtt-lssdh-ios8'].urls[0].url`), but the manifest is **MSL-encrypted on the wire** (`Content-Encoding: msl_v1`) — `webRequest` interception sees an opaque blob, NOT JSON.  The player decrypts MSL in-page then calls `JSON.parse()`; the only way in is a **MAIN-world `JSON.parse` monkey-patch** (catch `{result:{movieId, timedtexttracks}}`) + a `JSON.stringify` patch to inject the `webvtt-lssdh-ios8` profile so WebVTT URLs are returned.  This is what Subadub / Language Reactor / the GreasyFork downloader all do.  **Net: no `background.ts` webRequest observer, no pot-token picker, no CC-toggle trigger — simpler than YouTube.**
3. **The player exposes a stable JS API.**  `netflix.appContext.state.playerApp.getAPI()` (or similar — exact path needs confirmation) returns a `videoPlayer` object with `getCurrentTime() / getDuration() / isPaused()`.  Stable across years per community implementations.
   - ✅ **CONFIRMED** (verbatim in easysubs code touched 2024).  Path: `netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0])` → `.getCurrentTime()`, `.seek(ms)`, `.isReady()`, `.getTimedTextTrack()`, `.addEventListener('timedtexttrackchanged'|'adsstatechanged')`.  Two corrections: (a) `getDuration()` on the player is **unverified — read `<video>.duration` instead**; (b) there is **no time/`currenttime` event** — sync by polling `document.querySelector('#appMountPoint video').currentTime` on `requestAnimationFrame` (same model as our YouTube playhead path).
4. **All language tracks are first-class.**  No "lang-swap and pray" pattern — the manifest enumerates ja/en/zh/etc. URLs directly.  Auto-pick + per-layer track selection should port cleanly from our existing settings UI.
   - ✅ **CONFIRMED.**  Each track carries `language`, `languageDescription`, `rawTrackType` (`subtitles` vs `closedcaptions`/SDH), `isForcedNarrative` (skip), `isNoneTrack` (skip).  `auto-pick.ts` ports cleanly; the only change is that "fan-out" becomes "fetch each track's own URL" rather than lang-swapping one URL.
5. **DRM-only titles exist for some Originals.**  Some newer titles encrypt the subtitle path too, presumably as part of an anti-piracy push.  Our fallback would be a graceful "this title doesn't expose readable subtitles" message — not a crash.
   - 🔁 **REFRAMED — not DRM, but image-based subs.**  There is *no* trend of encrypting subtitle text.  The real "unreadable text" case is **TTML v2 image-based (PNG bitmap) subtitles**, used by some **CJK / Greek / Hebrew** titles — i.e. exactly Loom's headline learner languages (Japanese subs on a Japanese title is the canonical hit).  Not a fringe case: it tracks *language*, not title age.  **Detect by the absence of `webvtt-lssdh-ios8` in `ttDownloadables`** and degrade gracefully ("this language ships image-only subtitles on this title").  English/Latin tracks are essentially always WebVTT.  (This is also the natural seam to the Step 6 OCR pipeline later.)

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

**Newly written for Netflix** (revised post-recon — the discovery mechanism changed from `webRequest` to a MAIN-world `JSON.parse`/`JSON.stringify` hook):
| New file | Mirrors | LOC est. |
|---|---|---|
| `entrypoints/netflix-main.content.ts` | `yt-main.content.ts` (MAIN world — installs the `JSON.parse`/`JSON.stringify` manifest hooks, reads `netflix.appContext` player API, postMessages tracklist + manifest to ISO) | ~180 |
| `entrypoints/netflix.content.tsx` | `content.tsx` (ISOLATED world, mounts overlay into `div[data-uia="video-canvas"]`) | ~150 |
| `lib/captions/netflix/discover.ts` | YT's `discover.ts` shape — receives the hooked manifest, enumerates tracks, emits the existing `CaptionPayload` | ~250 |
| `lib/captions/netflix/fetch.ts` | `lib/captions/fanout.ts` (per-track signed WebVTT URL → text body; no lang-swap — each track has its own URL) | ~120 |
| `lib/captions/netflix/parse-vtt.ts` | `parseJson3()` in `fanout.ts` — **PRIMARY**; WebVTT → `CaptionEvent[]`. Seeded by `spike/netflix/parse-vtt.mjs` (validated). | ~120 |
| `lib/captions/netflix/parse-ttml.ts` | fallback; TTML/DFXP → `CaptionEvent[]` + `imageBased` flag. Seeded by `spike/netflix/parse-ttml.mjs`. | ~180 |
| `lib/captions/netflix/player-time.ts` | YT's `timeupdate` path — but a `requestAnimationFrame` poll of `<video>.currentTime` (no Netflix time event exists) | ~80 |
| `lib/overlay/netflix-player-anchor.ts` | `lib/overlay/player-scale.ts` — anchors to `div[data-uia="video-canvas"]`, scales typography to its height | ~100 |

Subtotal: **~1180 LOC of new code** (unchanged net estimate — the parsers grew, but **`background.ts` needs NO Netflix webRequest observer at all**, and `url-picker.ts` / the pot-token + CC-trigger machinery has no Netflix equivalent, so the discovery side is *smaller* than YouTube's).  Plus ~100–200 LOC of refactoring to split YT-specific bits behind a `CaptionPlatform` adapter.  ~25% additive on the ~5000-LOC extension.

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

### 2026-05-30 — Recon executed. **Verdict: GO.**

Done as a desk-research + parser-build spike (no live authenticated capture yet — that's the one owed owner step, see below).  Sources: current source of **Subadub** (`page_script.js`), **easysubs** (Nitrino, pushed 2026-01), **NflxMultiSubs** (gmertes fork, pushed 2025-09), the **GreasyFork "Netflix - subtitle downloader"** (v4.2.8, Dec 2024), plus `sshh12`'s reverse-engineering gist and CastagnaIT's MSL writeup.

**What worked verbatim from the assumptions:** the player API path (#3), all-tracks-first-class (#4), and plain-text fetchable subtitle docs (#1) are all confirmed in code maintained through 2025–2026.  The architecture maps ~1:1 onto Loom's existing MAIN-world + rAF-playhead model.

**What needed adjustment:**
- **#2 refuted (the big one).**  Manifest is MSL-encrypted on the wire → `webRequest` can't read it.  Replaced by the MAIN-world `JSON.parse` hook (+ `JSON.stringify` profile injection).  This *removes* the `background.ts` observer, the pot-token picker, and the CC-trigger fallback — the Netflix discovery path is **simpler** than YouTube's.
- **#3 two corrections:** use `<video>.duration` (player `getDuration()` unverified); sync via `requestAnimationFrame` polling `<video>.currentTime` (no Netflix time event).
- **DOM anchor:** prefer `div[data-uia="video-canvas"]` (durable QA hook) over the churning `.watch-video--*` class names.

**What broke / the one real constraint:** **image-based (PNG bitmap) subtitles** for some CJK/Greek/Hebrew titles — Loom's headline languages.  No text to parse; out of scope without OCR.  Detect via absence of the `webvtt-lssdh-ios8` profile and degrade gracefully.  This is a per-title/per-language degradation, not a port-killer (English + most tracks remain WebVTT).

**Decision-framework killers (from the section above):** (1) auth-gated URLs — **no** (signed but unauthenticated GET, ~12 h TTL, refreshed free on next play); (2) player API obfuscated — **no** (stable, in current code); (3) TTML/VTT replaced by encrypted blob — **no** (only the image-sub case, which is narrow + non-growing).  None triggered.

**Risk:** LOW legally/enforcement-wise (Language Reactor ~7.5 yrs, Subadub ~7 yrs, neither ever legally targeted; Teleparty enforcement was about the *name* + watch-party UX, not subtitle augmentation).  The real cost is **maintenance fragility** — Netflix rotates field/class names, so build the manifest hook + selectors to fail gracefully and be quickly re-pointable.

**Spike artifacts (`spike/netflix/`):** `parse-vtt.mjs` (primary) + `parse-ttml.mjs` (fallback, with image-sub detection) + `parse-test.mjs` (**24/24 passing** against synthetic JA samples, output contract matches `parseJson3`) + `capture-kit.js` (paste-in-console kit to capture a real manifest/VTT + probe the player API & DOM on an authenticated session) + `README.md`.

**Owed before the port branch (one owner step):** run `capture-kit.js` on a live authenticated Netflix watch page for the three recon titles (Step 0), confirm the manifest shape + player API + anchors on the real page, save a real `.vtt`/`.ttml` over the synthetic samples, and re-run `parse-test.mjs`.  Everything else is mechanical and seeded.

**Knock-on for `PUBLISH_PLAN.md` open question ("one extension or two?"):** GO + ~75% shared code argues for **one extension, two domain activations** (YouTube + Netflix host_permissions in one listing) rather than two listings.  Doesn't block the YouTube-only first release.

<!-- New entries below this line, newest at the bottom -->

### 2026-06-18 — Live authenticated capture (owed owner step). **GO holds; ja/ko/zh all served on native-origin content.**

Ran `capture-kit.js` on a live **Philippines-region** account across **~12 titles** (incl. `81740601`, `83073843`, `81911181`, `81921822`, `81910940`, `81910533`, `81343468`, `81154150`, `81748512`, `81921809`, `82045417`, `82032509`, **`81616251` Squid Game**). Hooks installed cleanly, manifest captured on play every time, no page breakage. Player API + DOM + parser all confirmed on real data.

**Confirmed verbatim:**
- **DOM anchors:** `div[data-uia="video-canvas"]` ✅, `.watch-video--player-view` ✅, `#appMountPoint video` ✅, `[data-videoid]` → videoId ✅. (`div[data-uia="controls-standard"]` returned **false** — stale selector, but not load-bearing for us.)
- **Player API:** `netflix.appContext.state.playerApp.getAPI().videoPlayer…getVideoPlayerBySessionId(...)` works. `getCurrentTime()` = `1005609` matched `<video>.currentTime` to the **ms**. **Correction to recon:** `getDuration()` **DOES work** (`1412035` vs `<video>.duration` `1412036`, off by 1 ms) — recon had it "unverified, use `<video>`." Either is fine; `<video>` stays the safer default.
- **Parser:** real `netflix-ja.vtt` (51,843 bytes, `webvtt-lssdh-ios8`) fetched 200 OK from a signed `oca.nflxvideo.net` URL, no auth header. Format has `NOTE Netflix`/`Profile`/`SegmentIndex` header blocks, a whitespace-only padding block, comma-bearing cue settings (`position:50.00%,middle align:middle size:80.00% line:84.67%`), and `<c.japanese>…</c.japanese>` class wrappers. The spike parser handles all of it — locked as a regression fixture (`sample-subs-ja-real.vtt`, +6 assertions in `parse-test.mjs`, 30/30 green). **Bonus finding:** the JA CC track ships **inline furigana in parens** for some words (`（金田(かなだ)）`) — a gift for the annotation layer (inconsistent, but free where present).

**The finding that reshapes the port — text vs. image is governed by ORIGIN LANGUAGE, not language identity. (A first draft of this entry, from JJK-family anime titles only, wrongly concluded "Korean = image-based everywhere." The Squid Game capture corrected it — see below.)**

Expanded the capture to ~12 titles incl. **Squid Game** (`81616251`, 97 tracks), `82032509` (61), `82045417` (40). The governing rule is now solid and **symmetric**:

> **WebVTT (text) is served for: the title's ORIGIN/primary language (as `closedcaptions` and/or full `subtitles`) + English (always) + Chinese zh-Hans/zh-Hant (consistently, even as a foreign translation — genuine outlier) + some lingua-franca tracks (es-LatAm; `fil` on this PH account) + `forced` tracks (partial, signs only). IMAGE-BASED is served for: most FULL FOREIGN-TRANSLATION tracks.**

The symmetric proof that it's origin-language, not language identity:

| Title (origin) | `ja` track | `ko` track | `zh-*` track |
|---|---|---|---|
| **JJK** (JP-origin anime) | CC = **text** ✓ | full subs = **image** ✗ | **text** ✓ |
| **Squid Game** (KR-origin) | full subs = **image** ✗ | CC **and** full subs = **text** ✓ | **text** ✓ |

Japanese is text on a Japanese title and image on a Korean one; Korean is the exact mirror. Chinese is text on both. `await __loomNflx.fetchSample('ko')` on Squid Game returned a real **201 kB** Korean WebVTT, 200 OK.

**What this means for Loom — the canonical learner flow IS the text-track case:**
- Learning **Japanese** → watch anime / J-drama (JP-origin) → `ja` track is text ✅
- Learning **Korean** → watch K-drama (KR-origin) → `ko` track is text ✅
- Learning **Chinese** → text essentially everywhere ✅✅

Image-based only bites the **off-axis** case — wanting your target language as a *translation of foreign-origin content* (Korean subs on a Japanese anime). That isn't how people learn a language, so it's a far smaller hit than the first draft implied. **Practical reach: Chinese, Japanese, and Korean are all well-served on native-origin content** — i.e. exactly Loom's headline catalog (anime, K-drama, C-drama).

**Remaining genuine constraints (smaller than the first draft):**
1. **Must watch native-origin content.** Cross-language (target-as-foreign-translation) subs are image-based → OCR-only (Step 6 seam).
2. **Origin-language text confirmed for ja/ko/en/zh/th/hi.** Added native **Thai** ("My Safe Zone" `82126920` — `th` CC = WebVTT, only `ms`/`vi` image) and native **Hindi** (a 509 kB `netflix-hi.vtt`, **2,836** cues of clean Devanagari) titles. So the origin-language rule holds across JP/KR/CN/TH/IN. Like JP-anime, Thai's origin track is **CC-only** (no plain `th subtitles`) → `auto-pick` must fall back to CC when that's the only text track for the origin language. Only **Arabic**-origin remains unconfirmed (low priority).
3. **`auto-pick` needs two refinements** the multi-track reality forces: (a) **exclude `forced` + `none`, prefer the non-forced full `webvtt` track** — concretely demonstrated: `fetchSample('th')` on "My Safe Zone" grabbed the **forced** track (first WebVTT in list) → only 19 cues of signs, not the 1000s-cue dialogue CC. Naive "first WebVTT" picks the wrong track. (b) For the origin language, prefer plain **`subtitles` over SDH `closedcaptions`** — the real `netflix-ko.vtt` CC track is full of `[음산한 음악]`-style non-speech SDH brackets, clutter for a learner (Squid Game ships *both* `ko` CC and `ko` subtitles as webvtt, so the choice exists; but JP-anime/Thai are CC-only, so fall back to CC). Many languages show 2–4 variants (trackId tails `;0;0;0/3/4/13;` = SDH/version variants).

**Parser validated at scale on real data.** All 4 real captures parse clean through `parse-vtt.mjs`: `ja` 371 cues, `ko` 1,118, `th` 19 (forced-track artifact, see 3a), `hi` 2,836 — **0 empty cues, 0 reversed timings, all sorted**, Devanagari/Hangul/Thai/kana all intact. Real files saved in `spike/netflix/netflix-{ja,ko,th,hi}.vtt`; head fixtures (`sample-subs-{ja,ko}-real.vtt`) locked into `parse-test.mjs`.

**Image-sub capture wired (for Step-6 OCR, not the port).** `capture-kit.js` now injects `dfxp-ls-sdh` + `imsc1.1` alongside WebVTT and adds `fetchAnySample(lang)` — image-only tracks return empty `ttDownloadables` when only WebVTT is requested, so the broad request is what makes an image track fetchable. The helper sniffs the body (→ `.vtt`/`.ttml`), flags PNG/`<image>` refs, and saves `netflix-<lang>-<profile>.<ext>`. Netflix image subs are **IMSC1.1/TTML carrying PNG bitmaps** (embedded base64 or external segments) — no text, hence OCR-only. Owed: actually run `fetchAnySample('vi')` (or `'ko'` on a JP title) once to capture a real sample over `sample-subs-image.ttml`.

**Region caveat (downgraded).** `fil` being text is PH-specific, but the **origin-language + EN + ZH** pattern is structural, not regional — it held across every title. A second-region capture is still nice-to-have for the lingua-franca edges, no longer load-bearing for the core conclusion.

**Player API reconfirmed** on Squid Game: `getCurrentTime()`/`getDuration()` both work and match `<video>` to the ms (`2379` / `3775229` vs `3775230`). (The all-`false` `dom()`/`time()` at the very top of the log was the kit's eager probe firing on the browse page *before* playback — expected, `player object: undefined` there.)

**Net:** GO, and the language story is **better** than the first draft — Chinese + Japanese + Korean all served on native content.

**Still owed before the port branch:** (1) save the full real `netflix-ja.vtt` + `netflix-ko.vtt` over the samples and re-run `parse-test.mjs` against whole files (cue-count sanity); (2) one real **image-based** track's TTML over `sample-subs-image.ttml` to validate the absence-of-webvtt detection on real data (synthetic-only so far). _(Thai origin-text now confirmed via "My Safe Zone" — was owed item #2, resolved.)_
