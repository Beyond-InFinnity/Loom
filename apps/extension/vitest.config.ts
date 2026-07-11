import { defineConfig } from "vitest/config";

// One `npm test` runs the extension suite AND the @loom/player-ui package
// tests (the pure modules extracted in 7a, MOBILE_ROADMAP.md) so the
// familiar single vitest count keeps covering everything it did before the
// extraction.
export default defineConfig({
  test: {
    include: [
      "**/*.test.{ts,tsx}",
      "../../packages/player-ui/src/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/.output/**", "**/.wxt/**"],
  },
});
