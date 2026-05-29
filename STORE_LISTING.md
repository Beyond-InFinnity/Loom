# Loom — Store Listing Kit

Copy-paste-ready submission copy for Firefox AMO + Chrome Web Store. This is
the **canonical source for listing text** (PUBLISH_PLAN.md is the process doc;
this is the finalized copy). Update here when the listing changes.

**Status:** drafted 2026-05-30. A few fields need a human decision before
submission — see **Open decisions** at the bottom.

---

## Identity

| Field | Value |
|---|---|
| Extension name | **Loom** (dev build: "Loom (Dev)") |
| Version | `0.1.0` |
| Homepage / Support URL | `https://loom.nerv-analytic.ai` |
| Privacy policy URL | `https://loom.nerv-analytic.ai/privacy` ✅ (page shipped — `apps/web/app/privacy/page.tsx`) |
| Source code | `https://github.com/Beyond-InFinnity/Loom` (public) |
| Feedback / bug reports | `https://github.com/Beyond-InFinnity/Loom/issues` (linked from settings panel footer) |
| Category — Firefox AMO | Language Tools (alt: Productivity) |
| Category — Chrome | Education (alt: Accessibility) |

## Summary (short description)

> Dual-language subtitles with romanization and per-character readings (furigana, Pinyin, Jyutping, RR) on YouTube.

(112 chars — under Chrome's 132 limit and AMO's 250.)

## Detailed description

> **Loom — Dual-language subtitles for YouTube, with romanization.**
>
> Loom is a language-learning tool for anyone who watches YouTube videos in a
> language they're studying. It renders TWO subtitle tracks at once — the
> original (foreign) language on top, your native language on the bottom — so
> you can follow the dialogue without switching back and forth.
>
> For non-Latin scripts, Loom adds a romanization line above the foreign text
> (e.g. "konnichi wa" above "こんにちは") so you can read along even before you
> know the characters. For CJK languages it additionally adds per-character
> readings — furigana for Japanese, Pinyin or Zhuyin for Chinese, Jyutping for
> Cantonese, Revised Romanization for Korean. For Traditional Chinese, Loom can
> also show the Simplified form of each character beneath it.
>
> Every visual aspect is customizable: per-layer colors, fonts, sizes,
> outlines, glow, and opacity. 28 thematic color presets ship out of the box.
> Settings persist per device. Loom works on any YouTube video that has manual
> (not auto-generated) captions in your target language.
>
> Loom is a research project from nerv-analytic.ai. It's free, has no ads, and
> doesn't collect personal data. See the privacy policy at
> loom.nerv-analytic.ai/privacy for details.

---

## Permission justifications

The manifest requests **two** API permissions + **two** host permissions.
(`scripting` was deliberately removed in the dev/prod-split commit — the
MAIN-world hook is a declarative `world: "MAIN"` content script, not
`chrome.scripting` — so it is NOT requested and needs no justification.)

- **`storage`** — Saves your display preferences (colors, fonts, sizes, layer
  toggles, track choices) and the optional owner key. Local to the browser;
  nothing is synced or sent.
- **`webRequest`** (observe mode only) — Reads the *URL* of YouTube's own
  caption-track requests so Loom can fetch the second subtitle track in the
  language you're learning. Loom does not block, redirect, or modify any
  request, and does not read request bodies — only the URL pattern, to learn
  the per-session token YouTube requires to fetch caption text.
- **`host_permissions: *://*.youtube.com/*`** — Runs the content script on
  YouTube watch pages, where the dual-subtitle overlay is inserted.
- **`host_permissions: https://api.loom.nerv-analytic.ai/*`** — Calls the Loom
  romanization/annotation API. A host permission is required because content
  scripts don't share the page's CORS context.

> `webRequest` is the most-scrutinized permission at review (both stores). The
> justification above is intentionally specific: observe-mode, URL-only, no
> bodies, no blocking. That specificity is the difference between fast approval
> and a multi-week reviewer back-and-forth.

---

## Screenshots (capture at 1920×1080, lossless PNG) — TODO, needs live extension

1. **Headline.** Loom active on a Japanese video: Bottom (English) + Top
   (Japanese) + furigana annotation + romanization line.
2. **Settings panel** open: track pickers + style controls.
3. **Traditional Chinese** video showing the alternate-orthography under-ruby
   (Simplified beneath Traditional).
4. **Non-CJK** video (Russian or Thai): the pure-romanization path (full
   phonetic line, no ruby).
5. Reserved — color presets in action, or a before/after comparison.

---

## Submission sequence (from PUBLISH_PLAN.md)

1. **Firefox AMO — self-distribution** (first). Just signs a build into a
   shareable XPI; no public listing review. Needs: privacy URL ✅, correct
   manifest ✅, signed `build:firefox:prod` artifact. The listing copy above is
   NOT required for this step.
2. **Chrome Web Store — unlisted** (second). $5 dev fee + 3–7 day review. Needs
   the full copy above + screenshots + icons. Requires the Chrome MV3 build to
   be verified first (owed: "5g Chrome MV3 verification").
3. **Public listings** (both) when ready for strangers. Same copy; toggle
   listing visibility.

## Versioning

- Start `0.1.0`; minor for features, patch for fixes. `1.0.0` at feature-complete
  + confident-for-public. Both stores enforce monotonically-increasing versions
  per extension ID.

---

## Decisions (resolved 2026-05-30 unless noted)

- ✅ **Contact email** — `privacy@nerv-analytic.ai` (Proton mailbox set up). Live on the privacy page.
- ✅ **Feedback channel** — GitHub Issues (repo is public). Linked from the settings-panel footer.
- ✅ **Icons** — derived from the Nerv-Analytica brand favicon (the purple-neuron mark): native 16/32/48 frames used verbatim, 96/128 Lanczos-upscaled; dev variant carries a red corner badge. Regenerate via `npm run icons` (`scripts/gen-icons.py`; needs Pillow + the nerv-analytica-website favicon). *Minor:* 96/128 are slightly soft (the favicon source maxes at 48px) — optional future polish is compositing the high-res neuron for a crisp 128.
- ✅ **Repo public** — `github.com/Beyond-InFinnity/Loom`; source link available for AMO review.
- ⬜ **Screenshots** — still TODO (need the live extension). Required only for the public AMO listing + Chrome, NOT for AMO self-distribution.
