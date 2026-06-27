import { defineConfig } from "wxt";

// Loom browser extension (Step 5).
//
// Build-time dev/prod split (PUBLISH_PLAN.md). The `--mode` flag is the single
// source of truth: `wxt build` (default) → "production"; `wxt` / `--mode
// development` → "development". Consequences of the split:
//   - Dev and prod build to SEPARATE output dirs via WXT's modeSuffix
//     (`.output/firefox-mv2` for prod, `.output/firefox-mv2-dev` for dev), so
//     a dev build never clobbers the prod artifact.
//   - Distinct extension IDs + names ("Loom" vs "Loom (Dev)") → Firefox keys
//     storage by ID, so both install side-by-side without sharing prefs.
//   - Runtime code reads the injected flags (API base, verbosity) via
//     lib/env.ts; see the `vite.define` block below.

const PROD_API = "https://api.loom.nerv-analytic.ai";
const DEV_API = "http://localhost:8000";

const isDev = (mode: string) => mode !== "production";

// API base resolution. An explicit LOOM_API_BASE env var wins over the
// mode default — this DECOUPLES the API endpoint from the build identity,
// so a dev-IDENTITY build (separate "Loom (Dev)" id + storage + verbose
// logging, installable alongside the daily-driver) can point at the live
// Railway API to diagnose BACKEND issues. localhost would only exercise
// the frontend wiring. Unset (the normal case) → identical to before, so
// prod CI builds are unaffected.
//   LOOM_API_BASE=https://api.loom.nerv-analytic.ai npm run build:firefox:dev
const resolveApiBase = (mode: string): string =>
  process.env.LOOM_API_BASE || (isDev(mode) ? DEV_API : PROD_API);

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  outDir: ".output",

  // Inject the dev/prod flags consumed by lib/env.ts. JSON.stringify keeps the
  // replacement valid JS (a boolean literal / a quoted string).
  vite: ({ mode }) => ({
    define: {
      __LOOM_IS_DEV__: JSON.stringify(isDev(mode)),
      __LOOM_API_BASE__: JSON.stringify(resolveApiBase(mode)),
    },
  }),

  manifest: ({ mode, browser }) => {
    const dev = isDev(mode);
    const variant = dev ? "dev" : "prod";
    const apiBase = resolveApiBase(mode);
    return {
      name: dev ? "Loom (Dev)" : "Loom",
      description:
        "Dual subtitles with romanization for foreign-language video on YouTube.",
      // `storage` for the owner key + display prefs. `webRequest` (observe
      // mode) to learn the YouTube-issued timedtext URL. `scripting` was
      // dropped — the MAIN-world hooks (YouTube tracklist read + Netflix
      // manifest JSON.parse/stringify) use declarative `world: "MAIN"`
      // content scripts, not chrome.scripting, so there's one fewer
      // permission to justify at store review.
      permissions: ["storage", "webRequest"],
      host_permissions: [
        "*://*.youtube.com/*",
        // Netflix (5h): the watch page (MAIN manifest hook + ISO overlay)
        // and the signed WebVTT CDN the ISO-world fetch pulls cue text
        // from (oca.nflxvideo.net et al) — granted so the cross-origin
        // GET isn't blocked by the page's CORS.
        "*://*.netflix.com/*",
        "*://*.nflxvideo.net/*",
        // Crunchyroll: the watch page (MAIN /play fetch hook + ISO overlay).
        // The subtitle files (.ass/.vtt) are fetched cross-origin by the ISO
        // world; their CDN host is captured live during recon and added here
        // (e.g. a *.crunchyroll.com or *.vrv.co origin) so the GET isn't
        // CORS-blocked.  Until confirmed, crunchyroll.com covers same-origin /
        // *.crunchyroll.com-hosted subtitle files.  LIVE-VERIFY.
        "*://*.crunchyroll.com/*",
        // Follows the resolved API base (LOOM_API_BASE override or mode
        // default) so a dev build pointed at prod gets the prod origin
        // granted for the cross-origin /annotate + /romanize fetches.
        `${apiBase}/*`,
      ],
      // Firefox-only block: the gecko `id` (required for AMO signing) + the
      // AMO data-collection disclosure (`websiteContent` — subtitle text sent
      // to the API for romanization/annotation; the ONLY thing collected;
      // surfaces a one-time install consent). Matches /privacy + STORE_LISTING.
      // https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
      //
      // Gated on the firefox target: WXT 0.20.26 does NOT strip
      // browser_specific_settings from the Chrome build (verified in the built
      // .output/chrome-mv3/manifest.json), so leaving it unconditional ships
      // Firefox-only keys in the Chrome package that the Web Store may flag.
      ...(browser === "firefox"
        ? {
            browser_specific_settings: {
              gecko: {
                id: dev
                  ? "loom-dev@nerv-analytic.ai"
                  : "loom@nerv-analytic.ai",
                data_collection_permissions: {
                  required: ["websiteContent"],
                },
              },
            },
          }
        : {}),
      action: { default_title: dev ? "Loom (Dev)" : "Loom" },
      // Explicit per-variant icons (defu gives the user manifest precedence
      // over WXT's public/icon auto-discovery). Regenerate via `npm run icons`.
      icons: {
        16: `icons/${variant}/16.png`,
        32: `icons/${variant}/32.png`,
        48: `icons/${variant}/48.png`,
        96: `icons/${variant}/96.png`,
        128: `icons/${variant}/128.png`,
      },
    };
  },
});
