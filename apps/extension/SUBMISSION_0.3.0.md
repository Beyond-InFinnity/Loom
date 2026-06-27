# Release notes

Loom shows a second, learner-facing subtitle line on top of streaming video:
the original-language captions plus phonetic readings — furigana for Japanese,
Pinyin / Zhuyin / Jyutping for Chinese, Revised Romanization for Korean, and a
full romanization line for Cyrillic, Thai, Indic scripts, Hebrew, and Arabic /
Persian / Urdu.

How to use it: open a video that has captions, click the small "Loom" pill over
the player to activate it for that tab, then pick your languages and styling in
the settings panel.

In this version:
- NEW PLATFORMS: Loom now works on iQIYI (iq.com) and WeTV (wetv.vip), in
  addition to YouTube and Netflix. Both are excellent for Chinese learners —
  most of their dramas carry a selectable Chinese subtitle track, which Loom
  reads and annotates with Pinyin.
- Clearer wording: settings now say "Video language" / "User language", the
  popup notes Loom appears on "compatible videos", and platform-specific hints
  name the site you're on.
- Traditional Chinese (zh-Hant) now shows its Simplified reading by default.
- New default layout: the video-language line sits at the top of the player and
  your-language line at the bottom — easier to read at a glance.
- First-run hint: the (inactive) Loom pill now glows gold when you move your
  mouse over the player, so it's easy to find and click to activate.

Loom only sends subtitle text out of your browser, and only for romanization.
See the privacy policy: https://loom.nerv-analytic.ai/privacy

Known limitation: Loom's overlay can't appear in the browser's native
Picture-in-Picture window (PiP shows only the raw video frame — no extension
can draw into it). Windowed and fullscreen playback are fully supported.

# Notes for reviewers

WHAT CHANGED SINCE 0.2.1 / 0.2.2
This release adds two streaming platforms — iQIYI (iq.com) and WeTV (wetv.vip)
— plus settings/wording polish. The YouTube and Netflix mechanisms are
UNCHANGED. No remote code is ever fetched or executed; all JS/WASM ships in the
package. The only data leaving the browser is subtitle text (+ a target
language code) sent to the romanization API, exactly as in prior versions.

NEW HOST PERMISSIONS (and why each is needed)
- *://*.iq.com/*      iQIYI play pages (overlay) + the subtitle track list,
                      which iQIYI server-side-renders into the page itself.
- *://*.iqiyi.com/*   iQIYI serves its subtitle files (WebVTT) from
                      meta.video.iqiyi.com; the content script GETs the
                      selected track's text from there.
- *://*.wetv.vip/*    WeTV play pages (overlay) + the player's playback-info
                      request that lists subtitle tracks.
- *://*.wetvinfo.com/* WeTV serves its subtitle files (WebVTT, sometimes as an
                      HLS .vtt.m3u8) from this CDN (e.g. cffaws.wetvinfo.com).
- *://*.video.qq.com/*, *://*.myqcloud.com/*  Tencent VOD CDN hosts that may
                      serve WeTV subtitle/segment files depending on region.
No new API permissions: `permissions` is still only `storage` + `webRequest`
(observe-mode, YouTube-only — see below). The romanization API origin
(api.loom.nerv-analytic.ai) was already granted.

HOW LOOM ACQUIRES SUBTITLES ON THE NEW SITES (read-only; no remote code)
- iQIYI (entrypoints/iqiyi-main.content.ts): iq.com is a Next.js app that
  SERVER-SIDE-RENDERS the playback descriptor — including the subtitle track
  list (language + WebVTT URL per track) — into the page's
  `<script id="__NEXT_DATA__">`. Loom READS that JSON from the DOM to discover
  tracks; there is no network interception. It then GETs the chosen track's
  WebVTT file from meta.video.iqiyi.com (an unauthenticated, read-only fetch of
  the title's own subtitle file). A MAIN-world script is used only to read the
  page's own `__NEXT_DATA__` / observe in-app navigation; it injects nothing
  into iQIYI's data and fetches no code.
- WeTV (entrypoints/wetv-main.content.ts): WeTV's player requests its playback
  info from play.wetv.vip/getvinfo via JSONP (the response invokes a global
  callback the page defines). Loom OBSERVES the player's own response by
  wrapping that callback, reads the subtitle track list (language + URL), and
  GETs the chosen WebVTT file from the Tencent CDN. The getvinfo request is
  signed by WeTV's own player (a "cKey"); Loom never forges or originates that
  request — it only reads the response the player already received. Some
  subtitle URLs are HLS playlists (.vtt.m3u8) wrapping a single WebVTT file,
  which Loom resolves and parses. This touches ONLY subtitle metadata/text — no
  video, DRM, account data, or request bodies; no remote code is fetched.

HOW TO TEST (iQIYI)
1. Install the add-on. Open a Chinese-language drama on iq.com that offers a
   Chinese subtitle track (most do — check the player's subtitle menu for
   "中文(简体)").
2. Click the "Loom" pill over the player; pick the Chinese track.
3. The dual-subtitle overlay + Pinyin render over playback. Works in windowed
   and fullscreen; in-app navigation between episodes keeps Loom active.

HOW TO TEST (WeTV)
1. Open a Chinese-language drama on wetv.vip with a Chinese subtitle option.
2. Click the "Loom" pill, pick the Chinese track.
3. Dual subtitles + Pinyin render. The player's "resume to where you left off"
   re-initialization is handled — the overlay persists. Windowed + fullscreen
   supported.

PERMISSIONS (unchanged from 0.2.2 except the new hosts above)
- storage: display preferences + the on/off toggle (browser.storage.local).
  Nothing synced or transmitted.
- webRequest: OBSERVE MODE, YouTube only, listener filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks/redirects/
  modifies). Reads only the request URL for the per-session token YouTube
  requires to fetch a second caption track. (Netflix / iQIYI / WeTV do not use
  this path.)
- host grants: per-site overlay + read-only subtitle fetches (see the host
  list above); https://api.loom.nerv-analytic.ai/* for the romanization API.

DATA / PRIVACY
The only data leaving the browser is subtitle text (+ a target language code),
sent to the romanization API. Matches the declared data collection
("websiteContent") and the privacy policy at
https://loom.nerv-analytic.ai/privacy.

KNOWN LIMITATION
Native Picture-in-Picture shows no Loom overlay: the PiP window renders only
the decoded video frame and the browser does not project page DOM into it, so
no extension can draw there. Windowed + fullscreen are fully supported.

BUILD INSTRUCTIONS (rebuild from source to verify it matches)
Environment: Node.js 22.x, npm 10.x. This is an npm-workspaces monorepo; the
extension (apps/extension) depends on local workspace packages, so build from
the repository root.
  1. npm ci
  2. cd apps/extension
  3. npm run build:firefox:prod   -> .output/firefox-mv2/   (unpacked add-on)
     or  npm run zip               -> .output/loomextension-0.3.0-firefox.zip
  Chrome: npm run build:chrome:prod -> .output/chrome-mv3/
Build tooling: WXT 0.20.26 (https://wxt.dev), which uses Vite.

DEV/PROD BUILD SPLIT (why you may see "Loom (Dev)")
wxt.config.ts builds two variants by mode. PRODUCTION (this submission) is
"Loom" (gecko id loom@nerv-analytic.ai). A separate "Loom (Dev)" build is for
local testing only and isn't part of this listing; the dev-only "owner key"
field is gated behind an IS_DEV constant and dead-code-eliminated from prod.

Public source repository: https://github.com/Beyond-InFinnity/Loom
