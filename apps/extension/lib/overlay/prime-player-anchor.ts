// Prime Video overlay-anchor helpers — the Prime counterpart to
// netflix-player-anchor.ts.
//
// ⚠️ SELECTORS ARE BEST-GUESS FROM RESEARCH, NOT LIVE-VERIFIED.  A HAR
// carries no DOM, so — exactly like every prior platform — the real
// selectors must be confirmed in a live dev-build session (the first-run
// probe below logs the player subtree to make that a 2-minute check).
// Prime's web player uses `atvwebplayersdk-*` class names; the historic
// fullscreen container is `.webPlayerSDKContainer` (a descendant
// `.atvwebplayersdk-overlays-container` holds the native captions +
// control chrome).  Apply the platform-gate anchor rule: the anchor must
// be the element that becomes fullscreen OR a descendant of it, and the
// LCA of the <video> and the control chrome — NEVER a comma-list.
//
// TODO(live-recon): replace the guesses below with confirmed selectors.
// Candidates to check, outermost→in:
//   .dv-player-fullscreen  /  .webPlayerSDKContainer
//   .atvwebplayersdk-overlays-container  (likely the LCA + fullscreen desc)
//   video  (single MSE element)
//   .atvwebplayersdk-captions-text / .f35jcaz  (native caption rail)

/** Player root: overlay shadow-host anchor + usePlayerScale target.
    Best-guess; verify live. */
export const PRIME_PLAYER_ROOT = ".webPlayerSDKContainer";

/** The HTML5 <video> CaptionStream hooks for the playhead.  Prime uses a
    single MSE <video>; scoping to the player container avoids matching any
    stray preview video elsewhere on the SPA. */
export const PRIME_VIDEO_SELECTOR = ".webPlayerSDKContainer video";

const STYLE_ID = "loom-prime-caption-suppress";

// Prime renders native captions into an overlay text node inside the
// player SDK container.  Best-guess selectors; the class hashes rotate, so
// we target by the stable data/-attr where possible and fall back to the
// documented class.  Verify + tighten live.
const CSS = `
.atvwebplayersdk-captions-overlay,
.atvwebplayersdk-captions-text,
[class*="atvwebplayersdk-captions"] { display: none !important; }
`;

export function hidePrimeCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restorePrimeCaptions(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Ensure `el` is a positioned containing block so the overlay's
    `position: absolute; inset: 0` host anchors to it (same rationale as
    the Netflix helper — the container may be position:static).
    Idempotent; only touches the property when it's actually static. */
export function ensureAnchorPositioned(el: HTMLElement): void {
  if (getComputedStyle(el).position === "static") {
    el.style.position = "relative";
  }
}
