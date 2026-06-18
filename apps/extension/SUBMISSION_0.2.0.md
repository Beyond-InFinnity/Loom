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
- NEW: Netflix support. Loom now works on Netflix watch pages, not just YouTube,
  using the same dual-subtitle + romanization pipeline.
- Redesigned settings panel: one card per subtitle line (Bottom / Top /
  Annotation / Romanization), each with its own on/off, options, and styling.
- Per-line show/hide — use Loom purely as a subtitle customizer if you like
  (e.g. show only the foreign line plus furigana, hide your native line).
- Phonetic-system choices now appear for every language that has them (Thai
  Paiboon / RTGS / IPA; Arabic, Persian, Urdu systems), not just Chinese.
- Pastel color defaults so a new user sees a clear, color-coded layout instead
  of an all-white wall.

Loom only sends subtitle text out of your browser, and only for romanization.
See the privacy policy: https://loom.nerv-analytic.ai/privacy

# Notes for reviewers

WHAT THE ADD-ON DOES
Loom overlays a second subtitle track on YouTube and Netflix watch pages: the
video's original-language captions plus phonetic readings (furigana, Pinyin,
etc.). Subtitle text is sent to our API (api.loom.nerv-analytic.ai) for
romanization and per-character annotation, because the language tools required
(MeCab, pypinyin, aksharamukha, and others) cannot run in the browser. The API
returns JSON readings. No executable code is ever fetched or run from a remote
source — all JavaScript/WASM is contained in the package.

HOW TO TEST (YouTube)
1. Install the add-on.
2. Open a YouTube video that has captions (a Japanese music video, etc.).
3. Click the "Loom" pill over the player to activate Loom for that tab.
4. After ~3-4 s the extra subtitle line(s) render over playback.

HOW TO TEST (Netflix — new in this version)
1. Open a Netflix title whose ORIGINAL language has text subtitles — e.g. a
   Japanese anime (Japanese audio + Japanese subtitles) or a Chinese-language
   film. (Loom reads the title's own subtitle tracks; image-only subtitle
   tracks are out of scope and Loom degrades gracefully.)
2. Start playback, click the "Loom" pill, pick the foreign track.
3. The dual-subtitle overlay + romanization render over the Netflix player.

WHY NETFLIX NEEDS A MAIN-WORLD SCRIPT (entrypoints/netflix-main.content.ts)
On YouTube, Loom observes the caption-request URL via webRequest. Netflix is
different: its player manifest (the list of subtitle tracks and their URLs) is
delivered MSL-encrypted and is decrypted inside the page by Netflix's own
player, then handed to JSON.parse(). A normal observer never sees it. So on
Netflix only, Loom injects a small content script into the page's MAIN world at
document_start that wraps the page's own JSON.parse / JSON.stringify:
  - JSON.parse wrapper: reads the already-decrypted subtitle manifest object as
    the player parses it, to discover the available subtitle tracks and their
    (Netflix-signed) WebVTT URLs. It only READS; the original parsed value is
    returned unchanged.
  - JSON.stringify wrapper: adds the "webvtt-lssdh-ios8" profile string to the
    player's OWN outgoing manifest request so the server returns text (WebVTT)
    subtitle URLs rather than image-only ones. It appends one profile string and
    returns the original stringify result unchanged.
This touches ONLY subtitle-track metadata. It does not read, modify, or
exfiltrate video, DRM/Widevine material, account data, or request bodies, and it
fetches no remote code. The wrappers fall through to the native function on
anything that isn't the manifest.

BUILD INSTRUCTIONS (rebuild the add-on from source to verify it matches)
Environment used to build the submitted package:
  - Node.js 22.x (built with 22.22.0)
  - npm 10.x (built with 10.9.4)

This is an npm-workspaces monorepo. The extension (apps/extension) depends on
local workspace packages (@loom/api-client, @loom/orthography-tables), so the
build must run from the repository root using the included package-lock.json.

From the root of the provided source archive:
  1. npm ci
  2. cd apps/extension
  3. npm run build:firefox:prod
       -> output: apps/extension/.output/firefox-mv2/  (the unpacked add-on)
     Or, to produce the exact .zip that was uploaded:
       npm run zip
       -> output: apps/extension/.output/loomextension-0.2.0-firefox.zip

Build tooling: WXT 0.20.26 (https://wxt.dev), which uses Vite. The uploaded
package is the output of the command above; rebuilding from this source produces
the same extension code.

DEV/PROD BUILD SPLIT (why you may see references to "Loom (Dev)")
wxt.config.ts produces two variants keyed off the build mode. The PRODUCTION
build (this submission) is named "Loom" with gecko id loom@nerv-analytic.ai. A
separate DEVELOPMENT build ("Loom (Dev)", id loom-dev@nerv-analytic.ai) is used
only for local testing and is not part of this listing. A developer-only "owner
key" field exists solely in the dev build (gated behind an IS_DEV constant and
dead-code-eliminated from the production bundle); the production popup contains
only the on/off toggle.

PERMISSIONS
- storage: stores display preferences + the on/off toggle locally
  (browser.storage.local). Nothing is synced or transmitted.
- webRequest: OBSERVE MODE ONLY, used only for YouTube, listener filtered to
  *://*.youtube.com/api/timedtext*. The onBeforeRequest listener returns
  undefined — Loom never blocks, redirects, or modifies any request, and never
  reads request bodies. It reads only the request URL to obtain the per-session
  token YouTube requires to fetch a second-language caption track. (Netflix does
  not use this path — see the MAIN-world note above.)
- *://*.youtube.com/* : run the content script + render the overlay on YouTube
  watch pages.
- *://*.netflix.com/* : run the content scripts + render the overlay on Netflix
  watch pages (new in this version).
- *://*.nflxvideo.net/* : Netflix serves its signed WebVTT subtitle files from
  this CDN; the content script fetches the subtitle TEXT of the track the user
  selected from here (a read-only GET of the title's own, already-authorized
  subtitle file).
- https://api.loom.nerv-analytic.ai/* : call the romanization API (content
  scripts need an explicit host grant for this cross-origin fetch).

DATA / PRIVACY
The only data leaving the browser is subtitle text (+ a target language code),
sent to the romanization API. This matches the declared data collection
("websiteContent") and the privacy policy at
https://loom.nerv-analytic.ai/privacy.

Public source repository: https://github.com/Beyond-InFinnity/Loom
