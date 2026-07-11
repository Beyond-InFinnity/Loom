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

NO NEW PERMISSIONS AND NO NEW HOSTS THIS RELEASE. wxt.config.ts (the source of
permissions + host_permissions) is unchanged since 0.4.0. Everything new in
0.5.0 is either local UI/rendering, or a richer response from the SAME
already-granted API origin (https://api.loom.nerv-analytic.ai). No new data
category.

WHAT CHANGED (all permission-neutral)
- Per-word dictionary lookup now covers ~20 languages (was Japanese/Chinese).
  The extension asks the existing /define endpoint which languages are available
  and makes words clickable accordingly. Dictionaries are entirely server-side;
  the extension ships none. Adding a language is a server change.
- Grammar breakdown (Japanese & Korean): /define now returns an optional grammar
  object (dictionary form + inflection); the card renders it.
- "Dictionary language" dropdown: sends a gloss-language parameter on the same
  /define call.
- UI internationalization: interface strings are chosen at load from the browser
  language; bundled, no network.
- Single-line mode, collapsed settings, preset swatches: local UI only.

PERMISSIONS (unchanged from 0.4.0)
- storage: preferences/toggles + corpus-consent value (browser.storage.local;
  not synced).
- webRequest: OBSERVE only, YouTube, filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks/redirects/
  modifies) — reads the URL for the per-session token needed to fetch a second
  caption track.
- hosts: overlay + read-only subtitle fetches for YouTube, Netflix, Prime Video,
  iQIYI, WeTV; plus https://api.loom.nerv-analytic.ai/* for romanization,
  definitions, and (opt-in only) corpus.

DATA / PRIVACY (boundary unchanged): subtitle-derived text (+ language codes)
leaves the browser — always for romanization; one clicked word for a definition
(on click, while paused); and only after affirmative opt-in, subtitle text +
title/platform for the corpus. All to api.loom.nerv-analytic.ai; declared
"websiteContent". Privacy: https://loom.nerv-analytic.ai/privacy

DICTIONARY SOURCES (server-side; named on each card + privacy page): JMdict (ja)
+ CC-CEDICT (zh), CC BY-SA 4.0; KRDict / NIKL (ko), CC BY-SA 2.0 KR; Wiktionary
via kaikki Wiktextract (other languages), CC BY-SA 4.0 + GFDL.

OPT-IN CORPUS (unchanged): affirmative-consent, default-OFF in production; fresh
installs capture nothing unless the user opts in.

BUILD (npm-workspaces monorepo — build from repo root; Node 22.x, npm 10.x):
1) npm ci  2) cd apps/extension  3) npm run build:firefox:prod (-> .output/
firefox-mv2/), or npm run zip; Chrome: npx wxt zip -b chrome --mode production.
Ship loom-source-0.5.0.zip (full monorepo), not WXT's partial *-sources.zip
(omits @loom/* packages + lockfile). Tooling: WXT (wxt.dev) / Vite.
Repo: https://github.com/Beyond-InFinnity/Loom

KNOWN LIMITATION: no overlay in native Picture-in-Picture (PiP shows only the
video frame; no extension can draw there). Windowed + fullscreen fully supported.
