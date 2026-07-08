# Release notes

Loom shows a second, learner-facing subtitle line on top of streaming video:
the original-language captions plus phonetic readings — furigana for Japanese,
Pinyin / Zhuyin / Jyutping for Chinese, Revised Romanization for Korean, and a
full romanization line for Cyrillic, Thai, Indic scripts, Hebrew, and Arabic /
Persian / Urdu. Works on YouTube, Netflix, Prime Video, iQIYI (iq.com), and
WeTV (wetv.vip).

How to use it: open a video that has captions, click the small "Loom" pill over
the player to activate it for that tab, then pick your languages and styling in
the settings panel.

In this version (0.4.0):
- NEW: Prime Video support. Loom now renders its learning subtitles on
  primevideo.com the same way it does on the other supported sites.
- NEW: per-word dictionary lookup (Japanese & Chinese). Pause the video and
  click a word in the top line — a small card shows its reading (furigana or
  Pinyin), its Hepburn romaji for Japanese (e.g. "Tōkyō (Toukyou)"), and its
  dictionary definition. Definitions come from the JMdict (Japanese) and
  CC-CEDICT (Chinese) community dictionaries, used under CC BY-SA 4.0.
- NEW: faithful on-screen caption placement. Vertical captions, on-screen
  "signs", and stacked/simultaneous cues now render in their original position
  and orientation instead of being flattened into one line.
- NEW: per-platform sizing & positioning. A "Subtitle size" slider, a
  top/bottom vertical nudge (to lift text off the letterbox bars), and line
  spacing — each remembered separately per site. Text now also scales to the
  visible video picture, so sizes look consistent across sites.
- POLISH: the clickable-word highlight is now a soft glow that hugs the text
  (not a box), plus assorted card and default-styling refinements.

Loom only sends subtitle text out of your browser — for romanization always,
for a per-word definition when you click a word, and (only if you opt in) for
the quality-improvement corpus. No account, no browsing history, no personal
identifiers.
Privacy policy: https://loom.nerv-analytic.ai/privacy

Known limitation: Loom's overlay can't appear in the browser's native
Picture-in-Picture window (PiP shows only the raw video frame — no extension
can draw into it). Windowed and fullscreen playback are fully supported.

# Notes for reviewers

WHAT CHANGED SINCE 0.3.1 (three things)
1. Prime Video support — the only new host permissions in this release.
2. Per-word dictionary lookup — a new API call to the SAME origin already
   granted; no new host permission, no new data category.
3. Faithful caption placement + per-platform sizing/position controls — purely
   local rendering/UI; no data or permission impact.

1) PRIME VIDEO (entrypoints/prime-main.content.ts, lib/captions/prime/)
Prime serves its subtitles as plain-JSON playback resources plus TTML2 caption
files. Loom's MAIN-world hook reads the playback-resources response the player
already fetches, takes the signed TTML URL for the same-language track, fetches
it read-only, and parses it — exactly the shape of the existing YouTube/Netflix
readers. The overlay anchors to Prime's video surface element.
NEW HOST PERMISSIONS (the reason to flag this release):
  - *://*.primevideo.com/*  — inject the overlay + read the in-page player
    playback-resources response on the watch page.
  - *://*.pv-cdn.net/*      — read-only fetch of the signed WebVTT/TTML caption
    file, which Prime serves from this CDN (cf-timedtext.aux.pv-cdn.net).
Both are used only to render the same learning overlay Loom already provides on
the other sites. No blocking, no redirect, no modification of site requests.

2) PER-WORD DICTIONARY LOOKUP (components/definition-card.tsx,
   lib/annotate/, routes/define.py server-side)
While the video is PAUSED, the user can click a Japanese or Chinese word in the
top caption line; Loom sends just that word (and its dictionary form) to
https://api.loom.nerv-analytic.ai/define — the SAME origin already granted for
romanization — and shows the returned definition in a card.
  - NO new host permission (same API origin as romanization).
  - NO new declared data category — it is subtitle-derived text, the existing
    "websiteContent". It is sent only on an explicit click, never in the
    background, and only while paused.
  - The dictionaries live server-side; the extension ships no dictionary data.
Dictionary sources & licensing: definitions are from JMdict (© the Electronic
Dictionary Research and Development Group, EDRDG) and CC-CEDICT, both used under
CC BY-SA 4.0. Every definition card names its source dictionary, and the privacy
policy carries the full attribution + license links.

3) CAPTION PLACEMENT + SIZING (lib/captions/, lib/overlay/, components/)
Vertical/positioned/simultaneous cues now render at their source location and
writing-mode; new per-site "Subtitle size", vertical nudge, and line-spacing
controls are stored in browser.storage.local. All local rendering — nothing
leaves the browser.

PERMISSIONS
- storage: display preferences, per-site sizing/position, on/off toggles, and
  the corpus consent value (browser.storage.local). Nothing synced.
- webRequest: OBSERVE MODE, YouTube only, filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks/redirects/
  modifies). Reads only the request URL for the per-session token YouTube needs
  to fetch a second caption track.
- host grants: per-site overlay + read-only subtitle fetches for YouTube,
  Netflix, iQIYI, WeTV (unchanged from 0.3.1) and — NEW in 0.4.0 — Prime Video
  (primevideo.com + pv-cdn.net, see section 1); plus
  https://api.loom.nerv-analytic.ai/* for the romanization, definition, and
  (opt-in only) corpus endpoints on that same origin.
The ONLY new permissions in 0.4.0 are the two Prime Video hosts.

OPT-IN QUALITY CORPUS (UNCHANGED from 0.3.1)
Still affirmative-consent, default-OFF in production (lib/corpus/consent.ts):
fresh installs capture nothing until the user accepts the one-time install-time
ask or turns on "Contribute caption data" in the settings panel; declining or
ignoring every prompt means nothing beyond the normal romanization request is
ever sent. Same origin, same "websiteContent" category. No change this release.

DATA / PRIVACY
Data leaving the browser is subtitle text (+ language codes): always for
romanization; a single clicked word for a definition (Japanese/Chinese, on click
only); and — only after affirmative opt-in — subtitle text plus title/platform
provenance for the quality corpus. All to https://api.loom.nerv-analytic.ai.
Matches the declared "websiteContent" data collection and the privacy policy at
https://loom.nerv-analytic.ai/privacy (updated with the per-word lookup and a
"Dictionary data & licenses" section).

KNOWN LIMITATION
Native Picture-in-Picture shows no Loom overlay: the PiP window renders only the
decoded video frame and the browser does not project page DOM into it, so no
extension can draw there. Windowed + fullscreen are fully supported.

BUILD INSTRUCTIONS (rebuild from source to verify it matches)
Environment: Node.js 22.x, npm 10.x. This is an npm-workspaces monorepo; the
extension (apps/extension) depends on local workspace packages, so build from
the repository root.
  1. npm ci
  2. cd apps/extension
  3. npm run build:firefox:prod  -> .output/firefox-mv2/  (unpacked add-on)
     or  npm run zip              -> .output/loomextension-0.4.0-firefox.zip
  Chrome: npm run build:chrome:prod -> .output/chrome-mv3/
Build tooling: WXT 0.20.26 (https://wxt.dev), which uses Vite.
Ship the full-monorepo source (loom-source-0.4.0.zip), not WXT's partial
*-sources.zip — the latter omits the local @loom/* workspace packages and the
root lockfile and is not buildable on its own.

DEV/PROD BUILD SPLIT (why you may see "Loom (Dev)")
wxt.config.ts builds two variants by mode. PRODUCTION (this submission) is
"Loom" (gecko id loom@nerv-analytic.ai). A separate "Loom (Dev)" build is for
local testing only and isn't part of this listing; the dev-only "owner key"
field and the dev default-on corpus behaviour are gated behind an IS_DEV
constant and dead-code-eliminated from prod.

Public source repository: https://github.com/Beyond-InFinnity/Loom
