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

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  outDir: ".output",

  // Inject the dev/prod flags consumed by lib/env.ts. JSON.stringify keeps the
  // replacement valid JS (a boolean literal / a quoted string).
  vite: ({ mode }) => ({
    define: {
      __LOOM_IS_DEV__: JSON.stringify(isDev(mode)),
      __LOOM_API_BASE__: JSON.stringify(isDev(mode) ? DEV_API : PROD_API),
    },
  }),

  manifest: ({ mode }) => {
    const dev = isDev(mode);
    const variant = dev ? "dev" : "prod";
    return {
      name: dev ? "Loom (Dev)" : "Loom",
      description:
        "Dual subtitles with romanization for foreign-language video on YouTube.",
      // `storage` for the owner key + display prefs. `webRequest` (observe
      // mode) to learn the YouTube-issued timedtext URL. `scripting` was
      // dropped — the MAIN-world hook uses a declarative `world: "MAIN"`
      // content script, not chrome.scripting, so there's one fewer permission
      // to justify at store review.
      permissions: ["storage", "webRequest"],
      host_permissions: [
        "*://*.youtube.com/*",
        dev ? `${DEV_API}/*` : `${PROD_API}/*`,
      ],
      // WXT strips browser_specific_settings for Chrome builds; this only
      // affects the Firefox output.
      browser_specific_settings: {
        gecko: {
          id: dev ? "loom-dev@nerv-analytic.ai" : "loom@nerv-analytic.ai",
          // AMO requires a data-collection disclosure (Firefox built-in data
          // consent). Loom transmits subtitle text — "website content" — to the
          // API for romanization/annotation; that's required for the core
          // feature, and is the ONLY thing collected. Surfaces a one-time
          // consent prompt at install. Matches /privacy + STORE_LISTING.md.
          // https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
          data_collection_permissions: {
            required: ["websiteContent"],
          },
        },
      },
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
