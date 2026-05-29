// Build-time dev/prod environment split (PUBLISH_PLAN.md → "Build-time
// dev/prod split").
//
// The two underscore-wrapped globals are injected by Vite `define` in
// wxt.config.ts, keyed off the build mode (`--mode`, the single source of
// truth):
//   - production builds (`wxt build`, the default)            → live API + quiet logging
//   - development builds (`wxt`, or `wxt build --mode development`) → localhost API + verbose
//
// The `typeof` guards let this module also load OUTSIDE a WXT build (e.g.
// under vitest, where the defines aren't injected) without throwing — it
// falls back to dev-ish defaults. In a real build, Vite folds these to
// constants so the `if (IS_DEV)` branch in `logDev` is dead-code-eliminated.

declare const __LOOM_IS_DEV__: boolean;
declare const __LOOM_API_BASE__: string;

export const IS_DEV: boolean =
  typeof __LOOM_IS_DEV__ === "boolean" ? __LOOM_IS_DEV__ : true;

export const API_BASE_URL: string =
  typeof __LOOM_API_BASE__ === "string"
    ? __LOOM_API_BASE__
    : "https://api.loom.nerv-analytic.ai";

/** Verbose, dev-only logging. No-op in production builds so the shipped
 *  extension stays quiet in the user's console. Use `console.warn` /
 *  `console.error` (always on) for anything a user bug report would need. */
export function logDev(...args: unknown[]): void {
  if (IS_DEV) console.log(...args);
}
