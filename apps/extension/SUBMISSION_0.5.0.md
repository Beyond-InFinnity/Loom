# Release notes

Loom shows a second, learner-facing subtitle line on top of streaming video:
the original-language captions plus phonetic readings — furigana for Japanese,
Pinyin / Zhuyin / Jyutping for Chinese, Revised Romanization for Korean, and a
full romanization line for Cyrillic, Thai, Indic scripts, Hebrew, and Arabic /
Persian / Urdu. Works on YouTube, Netflix, Prime Video, iQIYI (iq.com), and
WeTV (wetv.vip).

How to use it: open a video that has captions, click the small "Loom" pill over
the player to activate it for that tab, then pick your languages and styling in
the settings panel. Pause the video and click a word in the top line to see its
definition.

In this version (0.5.0):
- NEW: per-word dictionary lookup now covers ~20 languages, not just Japanese
  and Chinese. Pause and click a word in the top line and you get its definition
  for Korean, Spanish, French, German, Italian, Portuguese, Russian, Hindi,
  Ukrainian, and more — wherever a dictionary is available. (This came from the
  server; the extension needed no new permission for it.)
- NEW: grammar breakdown (Japanese & Korean). The definition card now shows an
  inflected word's dictionary form and what it is doing grammatically — e.g.
  Japanese 食べさせられた → 食べる · causative · passive · past, or Korean
  가셨어요 → 가다 · honorific · past · polite.
- NEW: "Dictionary language" picker. Choose the language your definitions are
  written in — from the card's bottom-right dropdown or a new settings line —
  when more than one is available for that video's language.
- NEW: the whole Loom interface (popup, onboarding, settings panel, definition
  card) is now translated into your browser's language across 12 locales
  (English, Japanese, Chinese Simplified/Traditional, Cantonese, Korean, German,
  French, Spanish, Italian, Ukrainian, Russian); anything else falls back to
  English.
- NEW: single-line mode. Media that carries only one caption track (a lone
  foreign track, or an all-native track) now activates and gets Loom's styling,
  annotation, and dictionary instead of staying dormant.
- IMPROVED: clicking a word to look it up no longer requires the per-character
  annotation (ruby) layer to be turned on.
- POLISH: settings sections default to collapsed with a one-line summary, and
  the color-preset picker now shows swatch previews.

Loom only sends subtitle text out of your browser — for romanization always,
for a per-word definition when you click a word, and (only if you opt in) for
the quality-improvement corpus. No account, no browsing history, no personal
identifiers.
Privacy policy: https://loom.nerv-analytic.ai/privacy

Known limitation: Loom's overlay can't appear in the browser's native
Picture-in-Picture window (PiP shows only the raw video frame — no extension
can draw into it). Windowed and fullscreen playback are fully supported.

# Notes for reviewers

THIS RELEASE ADDS NO NEW PERMISSIONS AND NO NEW HOSTS.
wxt.config.ts (the permission + host_permissions source) is byte-for-byte
unchanged since 0.4.0. Everything new in 0.5.0 is either (a) local rendering /
UI in the extension, or (b) a richer response from the SAME already-granted API
origin (https://api.loom.nerv-analytic.ai). No new data category, no new host,
no new permission.

WHAT CHANGED SINCE 0.4.0 (all permission-neutral)
1. Dictionary lookup for more languages — the extension asks the existing
   /define endpoint (same origin as romanization) which languages are
   available and lights up clickable words accordingly. The dictionaries live
   entirely server-side; the extension ships no dictionary data and gained no
   permission. Adding a language is a server change, not an extension change.
2. Grammar breakdown (Japanese & Korean) — the /define response now includes an
   optional grammar object (dictionary form + inflection features); the card
   renders it. Pure server data + local rendering.
3. "Dictionary language" picker — a local dropdown that sends a gloss-language
   parameter on the same /define call. Local UI + an existing endpoint.
4. UI internationalization — the interface strings are chosen at load time from
   the browser's UI language (browser.i18n / navigator.language). No network,
   no permission; strings are bundled.
5. Single-line mode, annotation/lookup decoupling, collapsed settings, preset
   swatches — all local rendering / UI behavior.

PERMISSIONS (UNCHANGED FROM 0.4.0)
- storage: display preferences, per-site sizing/position, on/off toggles, UI
  and dictionary-language preferences, and the corpus consent value
  (browser.storage.local). Nothing synced.
- webRequest: OBSERVE MODE, YouTube only, filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks / redirects
  / modifies). Reads only the request URL for the per-session token YouTube
  needs to fetch a second caption track.
- host grants: per-site overlay + read-only subtitle fetches for YouTube,
  Netflix, Prime Video, iQIYI, WeTV (all unchanged from 0.4.0); plus
  https://api.loom.nerv-analytic.ai/* for the romanization, definition, and
  (opt-in only) corpus endpoints on that same origin.

DATA / PRIVACY (boundary unchanged)
Data leaving the browser is subtitle-derived text (+ language codes): always
for romanization; a single clicked word for a definition (on click, while
paused); and — only after affirmative opt-in — subtitle text plus title/platform
provenance for the quality corpus. All to https://api.loom.nerv-analytic.ai.
Matches the declared "websiteContent" data collection and the privacy policy.
The per-word definition now covers more languages, but it is the same request,
same origin, same data category as 0.4.0's Japanese/Chinese lookup — just more
dictionaries behind it.

DICTIONARY SOURCES & LICENSING (server-side; the extension ships none)
Definitions are served from community dictionaries, each named on the card and
attributed with license links on the privacy page:
  - JMdict (Japanese, © EDRDG) and CC-CEDICT (Chinese) — CC BY-SA 4.0.
  - KRDict / NIKL 한국어기초사전 (Korean) — CC BY-SA 2.0 KR.
  - Wiktionary, via kaikki.org Wiktextract (Spanish, French, German, and other
    languages) — CC BY-SA 4.0 + GFDL.

OPT-IN QUALITY CORPUS (UNCHANGED from 0.4.0)
Still affirmative-consent, default-OFF in production (lib/corpus/consent.ts):
fresh installs capture nothing until the user accepts the one-time install-time
ask or turns on "Contribute caption data" in the settings panel; declining or
ignoring every prompt means nothing beyond the normal romanization request is
ever sent. Same origin, same "websiteContent" category. No change this release.

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
     or  npm run zip              -> .output/loomextension-0.5.0-firefox.zip
  Chrome: npm run build:chrome:prod -> .output/chrome-mv3/
     or  npx wxt zip -b chrome --mode production
                                 -> .output/loomextension-0.5.0-chrome.zip
Build tooling: WXT (https://wxt.dev), which uses Vite.
Ship the full-monorepo source (loom-source-0.5.0.zip), not WXT's partial
*-sources.zip — the latter omits the local @loom/* workspace packages and the
root lockfile and is not buildable on its own.

DEV/PROD BUILD SPLIT (why you may see "Loom (Dev)")
wxt.config.ts builds two variants by mode. PRODUCTION (this submission) is
"Loom" (gecko id loom@nerv-analytic.ai). A separate "Loom (Dev)" build is for
local testing only and isn't part of this listing; the dev-only "owner key"
field and the dev default-on corpus behaviour are gated behind an IS_DEV
constant and dead-code-eliminated from prod.

Public source repository: https://github.com/Beyond-InFinnity/Loom
