# Release notes

Loom shows a second, learner-facing subtitle line on top of streaming video:
the original-language captions plus phonetic readings — furigana for Japanese,
Pinyin / Zhuyin / Jyutping for Chinese, Revised Romanization for Korean, and a
full romanization line for Cyrillic, Thai, Indic scripts, Hebrew, and Arabic /
Persian / Urdu. Works on YouTube, Netflix, iQIYI (iq.com), and WeTV (wetv.vip).

How to use it: open a video that has captions, click the small "Loom" pill over
the player to activate it for that tab, then pick your languages and styling in
the settings panel.

In this version (0.3.1):
- FIX: Netflix subtitle discovery. Netflix changed the internal shape of its
  player manifest (field names moved to camelCase), which left Loom hanging at
  "discovering languages" on Netflix. Loom now reads both the new and old shape,
  so discovery works again. YouTube, iQIYI, and WeTV were unaffected.
- NEW: a "Loominate (Default)" colour preset. Fresh installs now show a named
  preset for Loom's factory colours instead of "(no preset — custom colours)",
  so it's obvious what the defaults are and easy to return to them.
- NEW (opt-in): you can now help improve Loom's romanization and annotation
  quality by contributing the subtitle text of what you watch. This is OFF by
  default. On install, Loom asks once; you can also turn it on or off any time
  in the settings panel. If you say no (or ignore the ask), nothing extra is
  ever sent. See the privacy policy for exactly what this covers.

Loom only sends subtitle text out of your browser — for romanization always,
and (only if you opt in) for the quality-improvement corpus. No account, no
browsing history, no personal identifiers.
Privacy policy: https://loom.nerv-analytic.ai/privacy

Known limitation: Loom's overlay can't appear in the browser's native
Picture-in-Picture window (PiP shows only the raw video frame — no extension
can draw into it). Windowed and fullscreen playback are fully supported.

# Notes for reviewers

WHAT CHANGED SINCE 0.3.0 (three things)
1. Netflix hotfix (entrypoints/netflix-main.content.ts). Netflix migrated its
   in-page player manifest to camelCase field names (e.g. timedtexttracks →
   textTracks, ttDownloadables → downloadables, new_track_id → id). Loom's
   MAIN-world manifest reader now reads new-name-first with the old names as
   fallback, at four sites (track array, track id, WebVTT downloadable, and the
   "has tracks" guard). No new permissions, no behaviour change on other sites.
   This is the urgent reason for the release — the store build was hanging on
   Netflix for all users.
2. "Loominate (Default)" preset (components/caption-context.tsx,
   settings-panel.tsx). Purely a UI/labelling change: the built-in default
   colours are now surfaced as a named, selectable preset. No data or
   permission impact.
3. Opt-in quality corpus (NEW data path — details below).

THE OPT-IN CORPUS — WHAT IT IS AND HOW CONSENT WORKS
Purpose: improve Loom's romanization/annotation accuracy and (later) train an
open subtitle-OCR model, using the raw subtitle text of watched titles.

WHAT IS SENT (only when the user has opted in): the subtitle text of the
tracks, plus lightweight provenance — the platform (e.g. "netflix"), the
video's title/id as the site exposes it, and the language codes of the tracks.
NO account data, NO cookies, NO viewing history beyond the title being
annotated, NO personal identifiers, NO IP-linking on our side. It goes to the
SAME origin already granted for romanization (https://api.loom.nerv-analytic.ai)
— there is NO new host permission and NO new declared data category beyond the
existing "websiteContent" (subtitle text).

CONSENT IS AFFIRMATIVE AND DEFAULT-OFF (verifiable in lib/corpus/consent.ts):
- Fresh production install: capture is OFF. The consent value is tri-state
  (unanswered / true / false); in a production build, "unanswered" resolves to
  OFF (`resolveCaptureEnabled` returns false unless the build is the dev/owner
  build). It NEVER defaults on in production — enforced and commented in code.
- On install, a one-time onboarding page (entrypoints/onboarding/) opens and
  asks the user to opt in or decline.
- A single, at-most-once in-overlay re-ask may appear after the first episode
  (components/corpus-consent-prompt.tsx); showing it sets a "asked" flag so it
  can never nag again.
- The settings panel has an explicit on/off toggle (Data section), so the user
  can change their mind at any time in either direction.
- If the user declines or ignores every prompt, capture stays OFF and nothing
  beyond the existing romanization request is ever sent.

The capture call is fire-and-forget and de-duplicated per title; it never
blocks playback or the overlay.

PERMISSIONS (UNCHANGED from 0.3.0)
- storage: display preferences + on/off toggles + the corpus consent value
  (browser.storage.local). Nothing synced.
- webRequest: OBSERVE MODE, YouTube only, filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks/redirects/
  modifies). Reads only the request URL for the per-session token YouTube needs
  to fetch a second caption track.
- host grants: per-site overlay + read-only subtitle fetches (YouTube, Netflix,
  iQIYI, WeTV — same list as 0.3.0); https://api.loom.nerv-analytic.ai/* for the
  romanization API and (opt-in only) the corpus endpoint on that same origin.
No new permissions were added in 0.3.1.

DATA / PRIVACY
Data leaving the browser is subtitle text (+ language codes): always for
romanization, and — only after affirmative opt-in — the same text plus
title/platform provenance for the quality corpus. Matches the declared
"websiteContent" data collection and the privacy policy at
https://loom.nerv-analytic.ai/privacy (updated with a "Training corpus (opt-in)"
section).

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
     or  npm run zip              -> .output/loomextension-0.3.1-firefox.zip
  Chrome: npm run build:chrome:prod -> .output/chrome-mv3/
Build tooling: WXT 0.20.26 (https://wxt.dev), which uses Vite.
Ship the full-monorepo source (loom-source-0.3.1.zip), not WXT's partial
*-sources.zip — the latter omits the local @loom/* workspace packages and the
root lockfile and is not buildable on its own.

DEV/PROD BUILD SPLIT (why you may see "Loom (Dev)")
wxt.config.ts builds two variants by mode. PRODUCTION (this submission) is
"Loom" (gecko id loom@nerv-analytic.ai). A separate "Loom (Dev)" build is for
local testing only and isn't part of this listing; the dev-only "owner key"
field and the dev default-on corpus behaviour are gated behind an IS_DEV
constant and dead-code-eliminated from prod.

Public source repository: https://github.com/Beyond-InFinnity/Loom
