# Loom 0.1.7 — store submission fields

Two copy-paste blocks for the AMO (and Chrome) submission forms. Everything
inside a `─── COPY ───` / `─── END ───` fence is the literal field content;
the surrounding text is guidance for you, not for the form.

**Upload checklist (AMO listed version):**
- Add-on package (first slot, the one that validates) → `loomextension-0.1.7-firefox.zip`
- Source code (after AMO asks about minifiers/bundlers — answer **Yes**) → **`loom-source-0.1.7.zip`**
  - ⚠️ Do **not** upload `loomextension-0.1.7-sources.zip` here. It contains only
    `apps/extension/` and omits the two workspace packages + the lockfile, so a
    reviewer cannot rebuild it. `loom-source-0.1.7.zip` is the full monorepo
    snapshot and rebuilds cleanly with the steps in the reviewer notes below.

---

## 1) Release notes  (field: "Release notes for this version" / "What's new")

User-facing, shown on the version page. Plain text.

─────────────────────────── COPY ───────────────────────────
Loom shows a second, learner-facing subtitle line on top of YouTube videos: the
original-language captions plus phonetic readings — furigana for Japanese,
Pinyin / Zhuyin / Jyutping for Chinese, Revised Romanization for Korean, and a
full romanization line for Cyrillic, Thai, Indic scripts, Hebrew, and Arabic /
Persian / Urdu.

How to use it: open a YouTube video that has captions, click the small "Loom"
pill over the player to activate it for that tab, then pick your languages and
styling in the settings panel.

In this version:
- New global on/off toggle in the toolbar popup — turn Loom off completely on
  this browser, with no per-page noise, and back on whenever you like.
- Per-tab activation: every tab starts dormant; nothing runs until you click the
  pill, so background YouTube tabs stay idle.
- Per-layer styling, position, machine-translation, alternate-orthography ruby,
  and color presets in the settings panel.
- Added a "Support Loom" link to the settings panel.

Loom only sends subtitle text out of your browser, and only for romanization.
See the privacy policy: https://loom.nerv-analytic.ai/privacy
──────────────────────────── END ────────────────────────────

---

## 2) Notes for reviewers  (field: "Notes for Reviewers")

Required because the add-on is bundled/minified (WXT + Vite). Plain text.

─────────────────────────── COPY ───────────────────────────
WHAT THE ADD-ON DOES
Loom overlays a second subtitle track on YouTube watch pages: the video's
original-language captions plus phonetic readings (furigana, Pinyin, etc.).
Subtitle text is sent to our API (api.loom.nerv-analytic.ai) for romanization
and per-character annotation, because the language tools required (MeCab,
pypinyin, aksharamukha, and others) cannot run in the browser. The API returns
JSON readings. No executable code is ever fetched or run from a remote source —
all JavaScript/WASM is contained in the package.

HOW TO TEST
1. Install the add-on.
2. Open a YouTube video that has captions/subtitles (the CC button is
   available), e.g. a Japanese music video or any video with subtitles.
3. A small "Loom" pill appears over the player. Click it to activate Loom for
   that tab.
4. Wait ~3-4 seconds while readings are fetched in one batch; the extra
   subtitle line(s) then render over playback.
5. The toolbar popup has a global on/off toggle that enables/disables Loom for
   the whole browser.

BUILD INSTRUCTIONS (rebuild the add-on from source to verify it matches)
Environment used to build the submitted package:
  - Node.js 22.x (built with 22.22.0)
  - npm 10.x (built with 10.9.4)

This is an npm-workspaces monorepo. The extension (apps/extension) depends on two
local workspace packages (@loom/api-client, @loom/orthography-tables), so the
build must run from the repository root using the included package-lock.json.

From the root of the provided source archive (loom-source-0.1.7.zip):
  1. npm ci
  2. cd apps/extension
  3. npm run build:firefox:prod
       -> output: apps/extension/.output/firefox-mv2/  (the unpacked add-on)
     Or, to produce the exact .zip that was uploaded:
       npm run zip
       -> output: apps/extension/.output/loomextension-0.1.7-firefox.zip

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
  (chrome.storage.local). Nothing is synced or transmitted.
- webRequest: OBSERVE MODE ONLY, listener filtered to
  *://*.youtube.com/api/timedtext*. The onBeforeRequest listener returns
  undefined — Loom never blocks, redirects, or modifies any request, and never
  reads request bodies. It reads only the request URL to obtain the per-session
  token YouTube requires to fetch a second-language caption track.
- host_permissions *://*.youtube.com/*: run the content script + render the
  overlay on YouTube watch pages.
- host_permissions https://api.loom.nerv-analytic.ai/*: call the romanization
  API (content scripts need an explicit host grant for this cross-origin fetch).

DATA / PRIVACY
The only data leaving the browser is subtitle text (+ a target language code),
sent to the romanization API. This matches the declared data collection
("websiteContent") and the privacy policy at
https://loom.nerv-analytic.ai/privacy.

Public source repository: https://github.com/Beyond-InFinnity/Loom
──────────────────────────── END ────────────────────────────
