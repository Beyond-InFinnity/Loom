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

In this version (0.5.1):
- FIX (Netflix): subtitles now load reliably when you open a title or move
  between episodes WITHOUT refreshing the page — previously the Loom pill would
  appear but the subtitles never loaded until you pressed F5.
- FIX (Netflix): after using the player's back button and opening a DIFFERENT
  title, Loom no longer keeps showing the previous title's subtitles.
- IMPROVED: the definition card now opens directly under the word you clicked
  instead of flashing in the corner and jumping into place, and its text is
  now selectable so you can copy a reading or definition out (e.g. into a
  translator).
- NEW: resize the definition card. Drag the little corner grip and the whole
  card — text and all — scales up or down; your size is remembered.
- NEW: two caption spacing controls in the settings panel (Position section) —
  "Line spacing" adjusts the gap between lines of a multi-line caption, and
  "Annotation spacing" adjusts the gap between the furigana / Pinyin reading (and
  the romanization line) and the main text. Both are saved per platform.

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
permissions + host_permissions) is unchanged since 0.4.0. Everything in 0.5.1
is local UI / rendering or a bug fix in already-granted content scripts. No new
data category, no new network destination.

WHAT CHANGED (all permission-neutral)
- Netflix reliability fixes: state-machine logic only in the existing Netflix
  content scripts. Netflix (a single-page app) parses a title's caption manifest
  at varying times relative to the URL change and reuses one media element across
  episodes; the manifest reader now HOLDS every parsed manifest keyed by title
  and adopts the right one on the URL/media signal (instead of dropping ones that
  arrived early), and clears state on leaving a watch page. Same scripts + hosts.
- Definition card: stable positioning, selectable text, and a corner resize grip
  (a CSS-scaled zoom, size saved to browser.storage.local). Local rendering only.
- Two caption line-spacing controls: local styling, saved per platform.

PERMISSIONS (unchanged from 0.4.0 / 0.5.0)
- storage: preferences/toggles + corpus-consent value (browser.storage.local;
  not synced).
- webRequest: OBSERVE only, YouTube, filtered to
  *://*.youtube.com/api/timedtext*; returns undefined (never blocks/redirects/
  modifies) — reads the URL for the per-session token to fetch a second track.
- hosts: overlay + read-only subtitle fetches for YouTube, Netflix, Prime Video,
  iQIYI, WeTV; plus https://api.loom.nerv-analytic.ai/* for romanization/
  definitions and (opt-in only) corpus.

DATA / PRIVACY (boundary unchanged): subtitle-derived text (+ language codes)
leaves the browser — always for romanization; one clicked word for a definition
(on click, while paused); and only after affirmative opt-in (default-OFF),
subtitle text + title/platform for the corpus. All to api.loom.nerv-analytic.ai;
declared "websiteContent". Privacy: https://loom.nerv-analytic.ai/privacy

BUILD (npm-workspaces monorepo, Node 22.x / npm 10.x): 1) npm ci at repo root
2) cd apps/extension 3) npm run build:firefox:prod (or npm run zip); Chrome:
npx wxt zip -b chrome --mode production. Source: loom-source-0.5.1.zip (full
monorepo), NOT WXT's partial *-sources.zip (omits @loom/* + lockfile). WXT/Vite.
Repo: https://github.com/Beyond-InFinnity/Loom

KNOWN LIMITATION: no overlay in native Picture-in-Picture (PiP shows only the
video frame; no extension can draw there). Windowed + fullscreen fully supported.
