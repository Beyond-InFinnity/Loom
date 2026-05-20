import { defineConfig } from "wxt";

// Loom browser extension (Step 5).
//
// The "blow their minds" demo is dual subs on YouTube watch pages: pull
// the foreign-language CC track, romanize via api.loom.nerv-analytic.ai,
// render a Bottom (native via YT auto-translate) + Top (foreign) +
// Romanized overlay above YT's caption area.  This config is the 5a
// foundation — content script smoke + popup + owner-key path only.

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  outDir: ".output",
  manifest: {
    name: "Loom",
    description:
      "Dual subtitles with romanization for foreign-language video on YouTube.",
    // `storage` for owner-key persistence.  `scripting` reserved for the
    // future YT player-API hook in 5b; harmless to declare now.
    permissions: ["storage", "scripting", "webRequest"],
    host_permissions: [
      "*://*.youtube.com/*",
      "https://api.loom.nerv-analytic.ai/*",
    ],
    // Action (toolbar button) opens the popup defined by entrypoints/popup.
    action: {
      default_title: "Loom",
    },
  },
});
