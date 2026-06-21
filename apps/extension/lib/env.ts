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

/** postMessage channel tags for the MAIN↔ISO content-script handshake
 *  (tracklist delivery + re-emit requests).
 *
 *  Namespaced by build mode.  A dev build is routinely loaded SIDE-BY-SIDE
 *  with the prod "Loom" for live testing, and both inject content scripts
 *  into the same page — which SHARES one `window`, so a `window.postMessage`
 *  from either build's MAIN is seen by BOTH builds' ISO listeners.  With a
 *  shared tag, the prod MAIN's (old-code) tracklist leaked into the dev ISO
 *  and silently overrode the dev build's behavior — e.g. prod posting a
 *  prefetched next-episode manifest the dev build had correctly held,
 *  re-triggering the very mid-episode track switch the dev build fixes.
 *  Distinct tags per build keep the two channels isolated. */
export const MAIN_SOURCE: string = IS_DEV ? "loom-main-dev" : "loom-main";
export const ISO_SOURCE: string = IS_DEV ? "loom-iso-dev" : "loom-iso";

/** Verbose `[Loom …]` logging — dev builds only.
 *
 *  Gated behind `IS_DEV` so production ships quiet. (This was temporarily
 *  always-on in 0.1.3 to diagnose a production-only caption bug — Chinese /
 *  ASR tracks failing while Japanese rendered — which 0.1.3 resolved; re-gated
 *  here for the public listing.) Vite folds `IS_DEV` to a constant in a real
 *  build, so this whole call is dead-code-eliminated from prod. */
export function logDev(...args: unknown[]): void {
  if (IS_DEV) console.log(...args);
}
