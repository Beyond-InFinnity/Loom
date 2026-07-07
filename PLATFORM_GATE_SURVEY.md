# Platform Gate Survey — Prime Video · HBO Max · Apple TV+

Companion worksheet to `PLATFORM_RECON_PRIME_HBOMAX_ATV.md`. The gate
(CLAUDE.md "THE PLATFORM GATE"): a platform passes only if it serves
**same-language SOFT-TEXT subtitles** — a fetchable text track in the
language SPOKEN — verified empirically across ~15 titles.

**⚠️ The current Loom (Dev) build does NOT inject on these sites** (no
content scripts / host permissions for them yet). This survey is a manual
Firefox + devtools exercise on Connor's logged-in accounts. The extension
gets a platform impl only AFTER that platform passes.

**Title lists are CANDIDATES from Claude's knowledge (cutoff Jan 2026,
US-region assumption)** — catalogs shift; if a title is gone or lacks the
expected audio, substitute anything else with the same target language.
Coverage breadth matters more than the specific titles.

---

## Method (per platform, ~30–60 min)

**Pass 1 — menu sweep (all ~15 titles, ~2 min each):**
1. Open the title, start playback (subtitle menus often only populate once
   playing).
2. Open the audio/subtitle menu. Record: is there a subtitle track matching
   the AUDIO language? (e.g. 日本語 subs on Japanese audio.) Note SDH/CC
   vs plain variants — SDH is acceptable (Netflix SDH works today), plain
   is better.
3. Record in the table: ✅ same-lang track / ❌ translated-only / ⚠️ notes.

**Pass 2 — devtools deep-check (2–3 ✅ titles per platform):**
With the network tab open (filter below), select the same-language track
and confirm the wire format is TEXT, then save a HAR (`HAR export` — we
always want one early; platform-specific capture notes in each section).
Also grab the DOM answers (selectors) listed per platform — 5 extra
minutes now saves a recon session later.

**Pass threshold (matches prior platform decisions):** ≥ ~10/15 titles
with same-language text tracks in at least one priority language = GO.
A single language passing cleanly (e.g. ja on Prime anime) is enough to
justify a first-pass build scoped to that content, like Netflix was.

---

## 1. Prime Video (www.primevideo.com)

Priority languages: **ja** (anime — the audience prize), **hi** (huge
Prime India-origin catalog; Loom has IAST end-to-end), ko, zh.

> **Preliminary signal (Connor, 2026-07-07): Prime has foreign-language
> subs.** Still to pin down in the sweep: specifically SAME-language
> (ja subs on ja audio — not just many translated languages, which is
> the shape that failed Crunchyroll), and text-on-the-wire in the
> deep-check.

### ✅ DEEP-CHECK PASSED 2026-07-07 — Evangelion 3.33, from Connor's HAR

- **Same-language CONFIRMED:** TWO Japanese subtitle tracks
  (`xml:lang="jp"`; one appears SDH-style with （speaker） markers) on a
  ja-audio licensed anime film. 1,482 cues.
- **Wire format CONFIRMED (matches research):** whole-file **TTML2**
  (~170–195 KB per track) from `cf-timedtext.aux.pv-cdn.net`, fetched
  once per track at page load / track-select. Playback envelope:
  `POST atv-ps.primevideo.com/playback/prs/GetVodPlaybackResources`
  (200, ~30 KB JSON; params incl. `titleId=amzn1.dv.gti.…`,
  `deviceTypeID=AOAGZA014O5RE`). A DASH manifest (text/xml, ~80 KB)
  rides the `…vod-dash…pv-cdn.net` CDN for A/V.
- **NO AUTH on the timedtext CDN:** `.ttml2` fetches via plain curl →
  200; `Access-Control-Allow-Origin: *` — content-script re-fetch needs
  no proxy.
- **🎁 AUTHORED FURIGANA:** the ja TTML carries native ruby markup —
  `tts:ruby container/base/text` spans, e.g. `青[あお]葉[ば]` — plus
  tate-chu-yoko (`tts:textCombine`) and `tts:fontShear`. The TTML
  parser should EXTRACT authored ruby and feed it into the ja
  pipeline's pre-existing-furigana tier (higher quality than MeCab for
  names) rather than strip it.
- **Capture gotchas for the platform impl:** the GetVod call happens at
  PAGE LOAD (a play-press on an already-loaded page never re-fires
  it) — the MAIN-world hook must be in place at document_start, and the
  extension needs a graceful story for "activated on an already-loaded
  page" (re-select track to force a ttml2 fetch, or webRequest-observe
  the ttml2 URL directly since track-select refetches it). Firefox HAR
  exports came out body-less; not blocking (CDNs are open).
- Still owed for full gate: menu-sweep breadth (rows 1–15) — but the
  acquisition question is SETTLED.

| # | Title | Audio | Same-lang sub? | Notes |
|---|-------|-------|----------------|-------|
| 1 | Vinland Saga (Amazon-exclusive seasons) | ja | | |
| 2 | Dororo | ja | | |
| 3 | Banana Fish | ja | | |
| 4 | Grand Blue | ja | | |
| 5 | Re:Zero | ja | | |
| 6 | Made in Abyss | ja | | |
| 7 | Any 2–3 more anime from the storefront's anime row | ja | | breadth check |
| 8 | The Family Man | hi | | Amazon original |
| 9 | Mirzapur | hi | | Amazon original |
| 10 | Panchayat | hi | | Amazon original |
| 11 | Made in Heaven | hi | | Amazon original |
| 12 | Any Korean series/film in catalog (e.g. My Man is Cupid) | ko | | |
| 13 | Any Chinese-language film in catalog | zh | | |
| 14 | A Japanese live-action film/drama (non-anime) | ja | | licensing may differ from anime |
| 15 | One foreign title RENTED/purchasable vs included | any | | store vs subscription licensing may differ |

**Devtools deep-check:** network filter `GetVodPlaybackResources` (also
try legacy `GetPlaybackResources`). Open the response JSON → confirm
`subtitleUrls[]` lists the same-language track with a URL; open that URL →
confirm TTML/DFXP text. Note the exact host (`atv-ps-*.primevideo.com`?)
and whether the response arrived via fetch or XHR.
**DOM grabs:** fullscreen-element chain (which element fullscreens?),
`<video>` selector, native-caption container selector (historically
`.atvwebplayersdk-captions-text`), what happens to the player DOM on
next-episode (rebuild vs reuse — decides autoMount vs state-based mount).

## 2. HBO Max (play.hbomax.com)

Priority languages: **ja** (Ghibli catalog is the marquee question), then
whatever foreign-origin content survives the menu sweep. HIGHEST gate
risk of the three — expect possible failure; that's a valid outcome.

> **Preliminary signal (Connor, 2026-07-07): HBO Max serves Chinese subs
> on Chinese media** — that IS the same-language passing shape. Add the
> specific zh titles to rows 11–15 and deep-check one of them alongside
> a Ghibli title.

### ✅ DEEP-CHECK PASSED 2026-07-07 — "Scent Time" (C-drama), from Connor's HAR

- **Same-language CONFIRMED:** audio `cmn-CN` (+ th, en-US dubs); text
  tracks **zh-Hans-CN, zh-Hant-HK, zh-Hant-TW** (+ th, id, ms-MY, en-GB,
  en-US SDH). Mandarin audio with THREE Chinese sub tracks, and Thai
  audio+subs — two phonetic-layer languages passing on one title.
- **Wire format CONFIRMED:** DASH MPD (`…_fallback.mpd` on
  `cf.asia.prd.media.max.com`) → `contentType="text"` AdaptationSets →
  `SegmentTemplate media="t/<hash>/tN/$Number$.vtt"` → **raw WebVTT**
  (`text/plain; charset=utf-8`) with `X-TIMESTAMP-MAP` header +
  `position:50%` cues. Verified by fetching a zh-Hans segment via curl.
- **NO AUTH on the media CDN:** both the MPD and the .vtt segments
  fetch with plain curl — no cookies, no token headers; the URL path
  (UUID) is the grant. `Access-Control-Allow-Origin: *` on segments →
  content-script re-fetch needs no proxy.
- **Segments are ~14 min each** (CMCD `d=840600`) → an episode is only
  ~3–5 subtitle segments. Stitching burden is trivial.
- **⚠️ Multi-Period DASH:** the MPD has 4 `<Period>`s (AdaptationSets
  repeat per period; text path hash differs per period). The stitcher
  must iterate periods and apply per-period time offsets.
- Playback API seen: `POST default.any-any.prd.api.hbomax.com/any/
  playback/v1/playbackInfo` (~49 KB JSON; body not captured — likely
  carries the manifest URL; the MAIN-world `.mpd`-URL hook makes its
  contents non-essential).
- Still owed for full gate: Ghibli/ja sweep + menu sweep breadth
  (rows 1–10) — but the acquisition question is SETTLED.

| # | Title | Audio | Same-lang sub? | Notes |
|---|-------|-------|----------------|-------|
| 1 | Spirited Away | ja | | Ghibli |
| 2 | Princess Mononoke | ja | | Ghibli |
| 3 | My Neighbor Totoro | ja | | Ghibli |
| 4 | Howl's Moving Castle | ja | | Ghibli |
| 5 | Grave of the Fireflies (if present) | ja | | |
| 6 | Tokyo Vice | en+ja | | mixed-language; ja portions |
| 7–10 | Any 4 non-English HBO originals/acquisitions surfaced by browsing (European, Latin American) | various | | es/fr/de aren't phonetic-layer langs but dual-sub still works |
| 11–15 | Anything Asian-origin found via search (HBO Asia originals, licensed K/C content) | ko/zh/th | | may be sparse — record absence too |

**Devtools deep-check:** network filter `.mpd` — copy the manifest URL,
open it, search for `<AdaptationSet contentType="text"` /
`mediaGroups`-relevant `<Role>` entries and note codecs (`wvtt` = good,
`stpp`-only = flag it). Then filter `.vtt` and confirm plaintext WebVTT
segments flow when the track is on. ⚠️ The MPD arrives via
**XMLHttpRequest** — if the filtered list looks empty, check the XHR tab
specifically.
**DOM grabs:** fullscreen element, `<video>` selector, native-cue
container (expect `shaka-text-container` or similar), player-rebuild
behavior on episode advance.

## 3. Apple TV+ (tv.apple.com — Firefox ≥115)

Priority languages: **ko**, **ja**, plus **he/fa** (rare — Loom supports
both and almost nothing else exercises them). Gate expected to PASS —
the survey doubles as SDH-vs-clean cataloging and recon.

> **No-subscription head start:** Apple's title pages publicly list
> audio + subtitle languages (Languages section) — the whole Pass-1
> menu sweep can be done from browse/store pages before the TV+ sub
> arrives. Only the devtools deep-check needs a playable stream.
>
> **Store channel vs TV+ channel (2026-07 note):** the Toho Godzilla
> films on tv.apple.com (Godzilla '54, Minus One, Minus One/Minus Color)
> appear to be iTunes-store RENT/BUY listings, not TV+ inclusions
> (Apple×Toho relationship anchor is Monarch S2, TV+, Feb 2026;
> Godzilla Minus Zero is theatrical-only Nov 2026, no streamer
> announced). These are DIFFERENT playback channels: iSubRip pulls subs
> from the store channel's UNAUTHENTICATED preview hlsUrl, so a
> store-channel Godzilla page is the cheapest possible deep-check
> (subtitle m3u8 visible without renting, via the trailer/preview).
> If Loom later supports rented/purchased playback too, that's a bonus
> surface — but the gate we're deciding on is TV+ subscription
> streaming; survey both, record channel per title.

| # | Title | Audio | Same-lang sub? | Notes |
|---|-------|-------|----------------|-------|
| 1 | Pachinko | ko+ja | | research says ko SDH + ja SDH confirmed |
| 2 | Dr. Brain | ko | | first Korean original |
| 3 | KBO (or any current ko original) | ko | | |
| 4 | Drops of God | ja+fr | | |
| 5 | Sunny | ja+en | | Kyoto-set, ja dialogue |
| 6 | Monarch: Legacy of Monsters (S2 Feb 2026) | en+ja | | ja portions; the Toho-relationship title |
| 7 | Godzilla Minus One / Minus Color / Godzilla '54 | ja | | likely STORE rentals not TV+ — record channel; preview manifest = free deep-check |
| 8 | Tehran | fa+he | | fa/he — unique Loom coverage |
| 9 | Losing Alice | he | | |
| 10 | Acapulco | es+en | | non-phonetic control |
| 11 | La Maison | fr | | non-phonetic control |
| 12–15 | 4 more from the "originals in other languages" rows | various | | breadth |

**Devtools deep-check:** network filter `m3u8` — find the master playlist,
search its body for `EXT-X-MEDIA:TYPE=SUBTITLES` entries (note
`LANGUAGE=`, `CHARACTERISTICS=` for SDH, `FORCED=`); then filter `webvtt`
/ `vtt` and confirm plaintext segments with `X-TIMESTAMP-MAP` headers.
Note whether subtitle playlists load EAGERLY or only after selecting the
track (decides whether we need a track-select nudge like YouTube's
CC-click). Note any auth headers/tokens on segment URLs.
**DOM grabs:** fullscreen element + player root; **check for closed
shadow roots** on the player subtree (`el.shadowRoot === null` on an
element that visibly hosts children = closed — walk with devtools'
inspector, it shows `#shadow-root (closed|open)`); native-cue container.

---

## Recording results

Fill the tables in place (this file is the artifact), or paste raw notes
into the session and Claude will transcribe. Save HARs to
`~/loom-recon/<platform>-<title>.har` (they contain session tokens — DO
NOT commit; add nothing under `~/loom-recon` to the repo).

**Decision rule after all three surveys:** build order re-ranks by (gate
result × acquisition simplicity). Provisional: Prime → Apple TV+ → HBO
Max, per the recon doc — HBO Max drops out entirely if Ghibli+search
comes back translated-only.
