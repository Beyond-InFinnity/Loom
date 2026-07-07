# Signing the Firefox build (self-distribution)

How to turn the build into a signed, installable `.xpi` via Firefox AMO's
**self-distribution ("unlisted")** channel — the first ship per `PUBLISH_PLAN.md`.
Needs your Mozilla account. The artifacts below are already built.

## Artifacts (`cd apps/extension && npm run zip`)

- `.output/loomextension-0.1.0-firefox.zip` — the extension package (upload this).
- `.output/loomextension-0.1.0-sources.zip` — sources; AMO asks for these because
  the build is minified.

The prod manifest already declares the extension ID **`loom@nerv-analytic.ai`**
(`browser_specific_settings.gecko.id`), which AMO requires for signing.

## Path A — AMO web uploader (recommended; no API key)

1. Sign in at https://addons.mozilla.org/developers/ .
2. **Submit a New Add-on** → choose **"On your own"** (self-distribution).
   *Not* "On this site" — that's a public listing (a later step).
3. Upload `loomextension-0.1.0-firefox.zip`.
4. When prompted about the minified build, upload `loomextension-0.1.0-sources.zip`.
5. AMO runs automated validation and signs it (seconds to minutes).
6. Download the signed `.xpi` — installable in any Firefox.

## Path B — web-ext sign (CLI / scriptable)

1. AMO Developer Hub → **Manage API Keys** → generate a **JWT issuer** + **JWT
   secret** (the secret is shown once).
2. From `apps/extension/`:

   ```sh
   npx web-ext@latest sign \
     --channel=unlisted \
     --api-key=<JWT_ISSUER> \
     --api-secret=<JWT_SECRET> \
     --source-dir=.output/firefox-mv2 \
     --artifacts-dir=.output/signed
   ```

   `--channel=unlisted` = self-distribution; the signed `.xpi` lands in
   `.output/signed/`. (web-ext zips the source dir itself — no manual zip needed
   on this path.) **Keep the secret out of git** — pass it inline or via env.

## Installing / sharing the signed XPI

- **Drag-and-drop:** open the `.xpi` in Firefox, or drag it onto `about:addons`.
- **Share a link:** Firefox treats the URL as an *install* (not a download) only
  if served with `Content-Type: application/x-xpinstall`. AMO's hosted download
  URL does this; if self-hosting at e.g. `loom.nerv-analytic.ai/loom.xpi`, set
  that header.
- Unlisted builds aren't in AMO search — you share the file/URL.
- **⚠️ Self-distributed builds DO NOT auto-update.** AMO does not serve
  updates for unlisted versions; a self-distributed XPI only updates if its
  manifest carries `browser_specific_settings.gecko.update_url` pointing at a
  self-hosted `updates.json` — ours never did. **Empirically confirmed
  2026-07:** the 0.1.5/0.1.7 hub-XPI installs stayed pinned for a month of
  daily use while store installs rolled forward (Firefox checks AMO ~daily,
  Chrome/Brave the Web Store ~5-hourly — but only for STORE installs).
  Consequence: any XPI handed out directly is stranded at that version until
  the human reinstalls from the store. If self-distribution is ever needed
  again (e.g. testers), add `update_url` first — but never on store builds
  (AMO rejects listed versions carrying it).
  (An earlier revision of this doc claimed AMO auto-updates unlisted builds —
  that was wrong.)

## After it's installed — the Step-1 side-by-side check

Load the dev build alongside the signed prod one: `about:debugging` → **This
Firefox** → **Load Temporary Add-on** → pick `.output/firefox-mv2-dev/manifest.json`.
Confirm **"Loom (Dev)"** (red-badged icon) sits beside the signed **"Loom"** as a
separate entry — distinct IDs mean distinct storage, no pref bleed.

## Notes

- AMO enforces monotonically-increasing versions per ID — you can't re-sign
  `0.1.0` once it's used. Bump `package.json` `version` for the next build.
- Listing copy + screenshots are NOT needed for self-distribution — those are for
  the later public-listing / Chrome steps (see `STORE_LISTING.md`).
- `wxt submit` (publish-extension under the hood) is an alternative for the later
  *listed*/store-publish flow; for self-distribution now, Path A or B is simplest.
