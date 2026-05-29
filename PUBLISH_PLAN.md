# Loom Extension — Publishing Plan

**Status:** Plan phase, started 2026-05-29.  Goal is to get Loom installable by friends/family as a "proper" extension — one-click install from a real store link, not "load this temp add-on from a folder."  Document captures the distribution-channel decisions, the build-infrastructure work needed, the store-prep checklist (mostly non-code), and the phased rollout plan.

**Why this exists:**  The current install path is "load temporary add-on from `.output/firefox-mv2/`."  That's fine for the developer and one or two close beta testers, but every reload of Firefox unloads temp add-ons, install is a manual 4-click process, and there's no update mechanism.  For real testers we need: signed builds, store-hosted listings (or self-distributed signed XPI), automatic updates, and a clean dev/prod separation so the developer's daily work doesn't risk shipping bugs to testers.

---

## Distribution-channel landscape

Five paths exist; only three are realistic for friends/family testing.

| Channel | UX for tester | Searchable? | Friction to ship | Cost |
|---|---|---|---|---|
| **Firefox AMO — public listing** | Search `addons.mozilla.org`, one-click install | Yes | ~1 week for first review (varies); fast after | Free |
| **Firefox AMO — self-distribution** | Click a URL, signed XPI installs in one click | No | Automated signing on upload; no listing review | Free |
| **Chrome Web Store — unlisted** | Click a store link with the unlisted slug, one-click install | No | $5 one-time fee + 3–7 day initial manual review | $5 |
| **Chrome Web Store — public** | Search `chromewebstore.google.com`, one-click install | Yes | Same fee + slightly stricter listing review | $5 |
| ~~Self-hosted CRX~~ | Blocked in stable Chrome since 2014.  User must enable developer mode + drag the file in.  **Do not use.** | — | — | — |

**Recommended sequence:**

1. **Firefox AMO self-distribution first.**  Fastest path to a real install link.  No public listing, no review backlog — just signing.  Loom has been developed/tested on Firefox MV2 throughout, so the tooling is already in place.
2. **Chrome Web Store unlisted second**, after the Firefox flow is validated.  Pays the $5 dev fee and waits out the first manual review.
3. **Public listings on both** when the extension is stable enough for strangers (and we want growth).

Edge Add-ons is a free third store; it accepts both Chrome and Firefox extension packages with minor manifest tweaks.  Add it to step 3 if and when it matters.

---

## Build-time dev/prod split

The technical foundation everything else sits on.  Single source tree; build-time flags produce two distinct extension packages that can be installed side-by-side on the same browser.

**Switches needed:**

| Axis | Dev | Prod |
|---|---|---|
| `manifest.name` | `"Loom (Dev)"` | `"Loom"` |
| Extension ID | dev UUID | prod UUID |
| API base URL | `http://localhost:8000` (or staging) | `https://api.loom.nerv-analytic.ai` |
| Console verbosity | Full `[Loom Romanize] batch start…` etc. | Errors + warnings only |
| Toolbar icon variant | Colored dot/badge on the icon | Clean icon |
| Output directory | `.output/firefox-mv2-dev/` | `.output/firefox-mv2-prod/` |

**Implementation sketch** (~100–150 LOC):

- `wxt.config.ts` becomes a function that branches on `WXT_MODE` env var (or uses WXT's built-in modes feature).
- New `lib/env.ts` exports `API_BASE_URL` + `IS_DEV` flags computed at build time via `import.meta.env` (Vite primitive WXT exposes).
- `lib/api-client.ts` reads `API_BASE_URL` from `env.ts` instead of hardcoding the prod URL.
- All `console.log` calls scoped to `if (IS_DEV)` (or wrap in a `logDev()` helper to keep call sites clean).  Errors + warnings stay unconditional.
- `package.json` scripts:
  - `build:firefox:dev` → `WXT_MODE=development wxt build -b firefox`
  - `build:firefox:prod` → `WXT_MODE=production wxt build -b firefox`
  - `build:chrome:dev` / `build:chrome:prod` — same shape.
  - Aliases: `npm run build` defaults to `build:firefox:prod` (the most common "I want to ship" case).

**Icon variants:**  Easiest path is to keep one PNG set and apply a Firefox/Chrome theme-color overlay at build time, OR maintain two icon sets in `public/icons-dev/` and `public/icons-prod/` and select via `wxt.config.ts`.  The two-folder approach is dumb but obvious; pick that for v1.

**Extension IDs:**

- Firefox MV2 IDs are arbitrary strings (e.g. `loom-dev@nerv-analytic.ai` and `loom@nerv-analytic.ai`).  Set via `manifest.browser_specific_settings.gecko.id`.
- Chrome IDs are derived from the public key; you generate one keypair per env, commit the public key in the manifest, store the private key in a secret-management path (NOT in git).  WXT can do this for you.

**Verification when the split lands:** install both `.output/firefox-mv2-dev/` and `.output/firefox-mv2-prod/` simultaneously.  Both show up in `about:addons`, one labeled "Loom (Dev)" with the badged icon, one labeled "Loom" with the clean icon.  Each talks to its own API base.  No cross-contamination of `browser.storage.local` (different extension IDs → different storage scopes).

---

## Required for any store submission (the non-code work)

Most of the publishing work is writing and asset-prep, not coding.

### Privacy policy

**Status:** Required, doesn't exist yet, ~30 min to write.

Hosted at `loom.nerv-analytic.ai/privacy`.  Must disclose:

- What data leaves the user's browser.  For Loom: **subtitle text strings** (sent to `/annotate/batch` + `/romanize/batch` for processing) and a stable per-device **owner-key token** if present (sent as `X-Loom-Auth` header to bypass rate limits).  Nothing else — no userId, no video metadata, no playhead, no analytics.
- Why.  Romanization and per-character annotation require server-side language pipelines (MeCab, pypinyin, aksharamukha, etc.) that can't run in the browser.
- Retention.  Currently the API doesn't archive requests.  If the OCR training-data pipeline (Step 6) ever lands, the `opt_in_training` flag governs archival and remains user-controlled.
- Sharing.  None.  No third parties, no advertising, no analytics services.
- User rights.  Uninstall removes all locally-stored preferences and the owner key.  The API holds no per-user state to delete.
- Contact.  An email address for privacy questions.

**Draft outline** (replace `[email]` and refine before publishing):

> **Loom Privacy Policy.**  Last updated 2026-MM-DD.
>
> Loom is a browser extension that renders dual-language subtitles with phonetic annotations on YouTube.  This page explains what data Loom sends out of your browser and why.
>
> **What we send.**  When you activate Loom on a YouTube video, the extension reads the subtitle text from the tracks YouTube already serves to your browser, deduplicates it, and sends the unique subtitle strings to `api.loom.nerv-analytic.ai` for romanization (e.g. "東京" → "Tōkyō") and per-character annotation (e.g. furigana, Pinyin).  Each video produces one request per subtitle track on activation; we do not send anything during playback after that.
>
> **What we don't send.**  We do not send your YouTube account information, your video viewing history, your playhead position, any unique device identifier, or any browser-level telemetry.  The API receives only the subtitle text and the target language code.
>
> **Optional owner key.**  Users who set an owner key (via `loom.nerv-analytic.ai/?owner_key=...`) have that key sent as an HTTP header on every API request to bypass rate limits.  The key is stored only in your browser's local storage and is removed when you uninstall.
>
> **Retention.**  The Loom API processes requests in-memory and does not archive subtitle text by default.  A future opt-in research pipeline may store anonymized text for language-model training; if and when that ships, it will be governed by an explicit per-request opt-in flag controllable from the extension settings.
>
> **Third parties.**  We do not share data with third parties.  We do not use analytics services.  We do not run advertising.
>
> **Your rights.**  Uninstalling the extension removes all locally-stored preferences and the owner key.  The Loom API does not hold per-user records to delete.
>
> **Contact.**  Privacy questions: [email]

### Permission justifications

Reviewers (especially Mozilla) reject extensions that request broad permissions without a clear "why."  We have three permissions to justify:

- **`webRequest`** — *"We need webRequest to intercept the URL of YouTube's caption-track API requests so we can fetch the user's chosen secondary subtitle track in parallel.  We never read user-identifying request bodies; we only use the URL pattern to learn the YouTube-issued, per-session token needed to fetch caption text."*  This is the most-scrutinized permission; the explanation needs to be specific.
- **`storage`** — *"For saving the user's display preferences (colors, font sizes, layer toggles) and the optional owner key.  Local to the browser; nothing is synced."*
- **`scripting`** — *"Reserved for future YouTube-player API hooks; currently unused.  Will be removed if it remains unused at first public listing."*  (Or: just remove it from the manifest now and add it back when actually needed.)
- **`host_permissions: ["*://*.youtube.com/*"]`** — *"To run the extension's content script on YouTube watch pages, where it inserts the dual-subtitles overlay."*
- **`host_permissions: ["https://api.loom.nerv-analytic.ai/*"]`** — *"To call the Loom romanization/annotation API.  CORS is required because Firefox content scripts don't get the page's CORS context by default."*

### Screenshots (1–5 per store)

- **Screenshot 1:** Loom active on a Japanese video, showing Bottom (English) + Top (Japanese) + Furigana annotation + Romanization line.  This is the headline image.
- **Screenshot 2:** The settings panel open, showing track pickers + style controls.
- **Screenshot 3:** A Traditional Chinese video showing the alternate-orthography under-ruby feature (Simplified next to Traditional).
- **Screenshot 4:** A non-CJK video (Russian or Thai) showing the pure-romanization path (no ruby, full phonetic line).
- **Screenshot 5:** Reserved for "color presets in action" or a comparison shot.

Capture at 1920×1080.  Both stores accept lossless PNG up to several MB each.

### Detailed description (for the store listing page)

3–4 paragraphs.  Draft:

> **Loom — Dual-language subtitles for YouTube, with romanization.**
>
> Loom is a language-learning tool for anyone who watches YouTube videos in a language they're studying.  It renders TWO subtitle tracks at once — the original (foreign) language on top, your native language on the bottom — so you can follow the dialogue without switching back and forth.
>
> For non-Latin scripts, Loom adds a third layer: a full romanization line above the foreign text (e.g. "konnichi wa" above "こんにちは") so you can read along even before you know the characters.  For CJK languages, Loom additionally adds per-character readings — furigana for Japanese, Pinyin or Zhuyin for Chinese, Jyutping for Cantonese, Revised Romanization for Korean.  For Traditional Chinese, Loom can also show the Simplified form of each character right beneath it.
>
> Every visual aspect is customizable: per-layer colors, fonts, sizes, outlines, glow, alpha.  28 thematic color presets ship out of the box.  Settings persist per device.  Loom works on any YouTube video that has manual (not auto-generated) captions in your target language.
>
> Loom is a research project from `nerv-analytic.ai`.  It's free, has no ads, and doesn't collect personal data.  See our privacy policy at loom.nerv-analytic.ai/privacy for details.

### Icon set

Need 16×16, 48×48, 128×128 (Chrome also asks for 32×32 for some surfaces).  Current placeholder is auto-generated by WXT.  Replace with intentional art before listing:

- A clean wordmark "L" or "Loom" works for v1.  Doesn't need to be illustrative.
- Optional: a small dot, ribbon, or border treatment to mark the dev variant.

### Other small items

- **Support URL / homepage:** `https://loom.nerv-analytic.ai` works for both.
- **Categories:** Firefox AMO has "Language Tools" and "Productivity"; Chrome has "Accessibility" and "Education".  Pick one per store.
- **Loom version indicator in the settings panel** — tiny line at the bottom showing `v0.x.x (manifest version)`.  Makes bug reports easier.
- **Feedback channel** — a simple Google Form linked from the settings panel ("Report a bug / Send feedback").  Avoids scattered DMs.  Can switch to GitHub Issues later if the volume warrants it.

---

## Versioning & release cadence

- Start at **`0.1.0`**.  Bump the minor for feature releases (5g, 5e tweaks, Chrome MV3 verification), patch for bug fixes.
- `1.0.0` when feature-complete for the YouTube use case AND we've shipped enough bug fixes to feel confident about a public-listing transition.
- Both stores enforce monotonically-increasing versions per extension ID — you can't ship `0.1.0` after `0.2.0`.
- Auto-updates: once installed via store, users get the next version within hours.  No manual reinstall.

---

## Phased rollout

1. **Build-time dev/prod split** — ✅ **landed 2026-05-30** (see Tracking log).  Deliverable met: `npm run build:firefox:prod` → `.output/firefox-mv2/` ("Loom", prod API) and `npm run build:firefox:dev` → `.output/firefox-mv2-dev/` ("Loom (Dev)", localhost) build to separate dirs with distinct extension IDs, ready to install side-by-side.
2. **Polish for review** — ~1–2 days, mostly writing.  Privacy policy hosted, permission justifications drafted, screenshots captured at high quality, icons replaced, version bumped to `0.1.0`, support URL pointed at the homepage, version indicator added to the settings panel.
3. **Firefox AMO self-distribution** — ~3–5 days including review wait.  Outcome: a signed XPI URL you can share.  Install on your own Firefox profile from that URL (not from the temp-add-on path) to verify the full flow.
4. **Closed beta — 5–10 testers** — ~1 week of feedback gathering.  Tighten anything that breaks at scale: rate-limit messaging, "how do I activate it" confusion, the dormant-pill discoverability.  Track via the Google Form.
5. **Chrome Web Store unlisted** — ~1 week, includes the $5 fee and the initial manual review (3–7 days).  Same prep work as Firefox; submission flow is slightly different (UI checklist).
6. **Public listings on both** — when you're ready for strangers.  Same builds, just toggle listing visibility on AMO + Chrome dashboard.  Edge Add-ons (free) can land here too.

Total realistic effort to reach step 5: **2–3 weeks of focused work**, mostly non-code.  Steps 1–2 are the technical bottleneck; 3–6 are submission flows + waiting on store reviews.

---

## Risks & gotchas

**The `webRequest` permission is the review hot-button.**  Both stores scrutinize it heavily because it's the surface most often abused by malware.  A clear, specific justification (see above) is the difference between a 3-day automated approval and a 3-week back-and-forth with reviewers.

**Manifest V2 vs V3.**  Firefox MV2 still works fine and is what we test on.  Chrome requires MV3.  WXT handles both from one config but the `webRequest` permission shape differs slightly (MV3 uses `declarativeNetRequest` for blocking; we use webRequest in observe-mode which works in MV3).  Verify Chrome MV3 build of the existing extension *before* trying to submit — there's a known owed follow-up "5g — Chrome MV3 verification" that's on the active focus list and should land before any Chrome submission.

**Rate limits will bite during beta.**  Slowapi caps at 100/min, 2000/day per IP.  A single tester on a 25-min video produces 2 requests (annotate batch + romanize batch).  That's nowhere near the cap.  But if a tester opens 50 videos in an afternoon, they'll hit the daily cap.  Either (a) add a clear in-extension message when rate-limited ("you've hit Loom's API limit; try again tomorrow or request an owner key"), or (b) raise the cap during the beta window via `LOOM_RATE_LIMIT` env on Railway, or (c) issue owner keys to all testers.  (c) is cleanest if the tester pool is small.

**No telemetry means no usage data.**  Once we ship, we won't know how many people activate Loom, on what videos, with what settings.  That's intentional for privacy + simpler review, but it means feedback is the only signal source.  Make the Google Form prominent.

**Loom's branding is tied to the `nerv-analytic.ai` domain.**  If you ever want to spin Loom off as a standalone project, the rebrand involves the manifest description, the screenshots, the homepage, and the privacy policy URL.  Cheap if done before listing; annoying after.

**Mozilla's self-distribution flow has a quirk:** the signed XPI's "install link" must be served with `Content-Type: application/x-xpinstall` for Firefox to recognize it as an extension install (vs a download).  Either configure that header at `loom.nerv-analytic.ai/loom.xpi`, or use AMO's hosted-download URL which serves it correctly.  Cheap to get right; annoying to debug if you miss it.

---

## Open questions

- **One extension or two?**  Could the YouTube path and (eventually) Netflix path be one extension that activates on both domains, or two separate listings?  Decision deferrable until Netflix recon completes; doesn't affect the YouTube-only first release.
- **Edge browser variant — separate listing or skip?**  Edge accepts Chrome packages with minor manifest tweaks.  Free.  Reach is small but non-zero.  Probably skip until after Chrome public listing is stable.
- **Mobile.**  Both Firefox Android and Chrome Android support a limited extension set.  Loom's `webRequest` interception specifically may not work on Chrome Android.  Defer until we hear demand.
- **Public source repository.**  Will the repo be open source?  Mozilla appreciates (but doesn't require) source links during AMO review.  Chrome doesn't ask.  Cheap to make `apps/extension/` (or the whole repo) public on GitHub once you're ready.

---

## Tracking log

> Fill in as the publishing work progresses.  Each entry: date + which step + what landed or what blocked.  Failures/blockers as valuable as successes.

### 2026-05-29
- Document created.  Publishing work not started yet.
- Decision: Firefox AMO self-distribution first; Chrome Web Store unlisted second.
- Next concrete action: build-time dev/prod split (~1 day of work).

### 2026-05-30 — Step 1 (build-time dev/prod split) ✅ landed

**What shipped:**
- `lib/env.ts` (new) — exports `IS_DEV`, `API_BASE_URL`, and `logDev()`.  Values injected at build time; `typeof` guards let it load under vitest (no defines) without throwing.
- `wxt.config.ts` — `manifest` + `vite` are now functions of `env.mode`.  Per-mode: name (`Loom` / `Loom (Dev)`), gecko id (`loom@` / `loom-dev@nerv-analytic.ai`), API host_permission, and icons.  `vite.define` injects `__LOOM_IS_DEV__` / `__LOOM_API_BASE__`.
- `lib/api-client.ts` + `entrypoints/popup/app.tsx` — read `API_BASE_URL` from env instead of hardcoding; popup footer shows the active API host.
- Logging split — all 35 debug `console.log` calls across 8 files (discover, yt-main, romanize/annotate build-map, stream, presets/fetch, content, background) → `logDev()` (dev-only).  `console.warn`/`console.error` left unconditional.
- `package.json` — `build:firefox:{dev,prod}`, `build:chrome:{dev,prod}`, `icons` scripts; `build` now defaults to `build:firefox:prod`.
- `scripts/gen-icons.mjs` (new) + `public/icons/{prod,dev}/{16,32,48,96,128}.png` — placeholder marks (indigo / amber+red-dot), pure-Node PNG encoder.

**Decisions / deviations from the original sketch (worth knowing):**
- Used WXT's native `--mode` flag, not a `WXT_MODE` env var.  WXT's `modeSuffix` auto-routes dev → `.output/firefox-mv2-dev/` and prod → `.output/firefox-mv2/` with zero `outDirTemplate` config — exactly the dirs the plan wanted.  `wxt build` defaults to production; `wxt` (dev server) to development.
- **Dropped the `scripting` permission** entirely (the plan offered "justify or remove").  It was never used — the MAIN-world hook is a declarative `world: "MAIN"` content script, not `chrome.scripting`.  One fewer permission to justify at AMO review.  Add it back only if a real `chrome.scripting` use appears.
- **Promoted the `[Loom Fetch]` "0 events" diagnostic to `console.warn`** (it was `console.log` per commit a382449).  Rationale: it's the load-bearing "why did this video yield no captions" message — silencing it in prod (as `logDev` would) defeats its purpose, and the plan keeps warnings on in prod.  Trade-off: in dev it now sits behind Firefox's warnings filter again, but the surrounding `logDev` breadcrumbs cover the dev trace.
- Icons are intentional **placeholders** generated by `npm run icons`.  Real art is the separate "Icon set" polish item; keep the same paths and the wiring is unchanged.

**Verified:** `npm run compile` clean · `npm test` 164/164 · both builds succeed to separate dirs · prod manifest = Loom/loom@/api.loom/icons-prod, dev manifest = Loom (Dev)/loom-dev@/localhost/icons-dev · prod bundle carries the prod URL and zero `localhost`, dev bundle the reverse (DCE confirmed) · only surviving `console.log(` is inside `logDev` itself.

**Minor follow-ups (non-blocking):** (a) `public/` copies BOTH icon variants into every build, so the prod package ships the unused dev icons (~1.5 KB, not manifest-referenced — harmless, tidy later if a reviewer ever asks).  (b) Not yet installed side-by-side in a live Firefox — that's the human verification step before moving to store prep.

- Next concrete action: Step 2 — polish for review (privacy policy hosted, permission justifications, screenshots, real icons, version indicator in settings panel).

<!-- New entries below this line, newest at the bottom -->
