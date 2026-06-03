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
| Version | `0.1.5` (listed-channel submission; includes the stale-captured-URL fix; `0.1.x` already consumed on the unlisted channel) |
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

**Data collection (Firefox consent).** The manifest declares
`browser_specific_settings.gecko.data_collection_permissions.required = ["websiteContent"]`
— the subtitle text sent to the API for romanization/annotation. AMO requires
this disclosure (it rejects the upload without it); Firefox shows a one-time
consent prompt at install. No other categories are collected — matches the
privacy policy.

---

## Screenshots — captured 2026-06-04 (on `~/Desktop`, suffix `*_Loom_Preview.png`)

Recommended AMO upload order (first = hero/gallery cover):

1. **`Hikaru_Utada_Loom_Preview.png`** (1735×1599) — HERO. Japanese music video
   showing the full 4-layer stack: romanization line + per-kanji furigana +
   Japanese + English. Best single image of what Loom does.
2. **`Three_Body_Chinese_Loom_Preview.png`** (1436×1077) — Simplified Chinese
   drama, Pinyin ruby above the Chinese + English below.
3. **`Brian_Tseng_Loom_Preview.png`** (1312×1078) — Taiwan Mandarin talk show,
   Pinyin ruby + English.
4. **`User_Interface_Loom_Preview.png`** (310×599) — settings panel: native /
   target track pickers (AUTO/MANUAL badges) + position grid. ⚠️ **Low-res**
   (310 px wide) — acceptable but will look soft in the gallery; recapture at a
   higher device-pixel-ratio for a crisp version if desired.

**Gaps vs the original plan (optional, not blockers):** no Traditional-Chinese
*alternate-orthography under-ruby* shot, and no *non-CJK* (Russian / Thai)
pure-romanization shot. The four above are CJK-only. Screenshots are NOT
required to submit a listed AMO add-on — these can be added/expanded post-launch.

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
- ✅ **Screenshots** — 4 captured 2026-06-04 (`~/Desktop/*_Loom_Preview.png`); see the Screenshots section for upload order. CJK-only; non-CJK + alt-orthography shots optional/post-launch. The settings-panel shot is low-res (310 px) — recapture for crispness if desired.
