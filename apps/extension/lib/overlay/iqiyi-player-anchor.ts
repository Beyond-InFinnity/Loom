// iQIYI (iq.com) overlay-anchor helpers — the iQIYI counterpart to
// netflix-player-anchor.ts.
//
// Selectors confirmed from a live DOM + fullscreen capture (2026-06-27).
// The <video> ancestor chain is:
//   video → iqpdiv.iqp-player (837×471, position:relative — THE FULLSCREEN
//   ELEMENT; gains .iqp-full-screen when fullscreen) → #flashbox →
//   .intl-video-area → … → .main-content (1822px, full page width).
// The earlier comma-list anchor resolved to #flashbox — the PARENT of the
// fullscreen element — because querySelector returns the first match in
// document order and the ancestor opens first.  Anchoring an ancestor of the
// fullscreen element means the overlay isn't rendered in fullscreen (subs
// vanished).  `.iqp-player` is the fullscreen element itself AND video-sized,
// so the overlay survives fullscreen and aligns to the video.

/** Player root: overlay shadow-host anchor + usePlayerScale target. The
    iqp-player element IS the fullscreen target (and is video-sized). */
export const IQIYI_PLAYER_ROOT = ".iqp-player";

/** The HTML5 <video> CaptionStream hooks for the playhead. */
export const IQIYI_VIDEO_SELECTOR = ".iqp-player video, video";

const STYLE_ID = "loom-iqiyi-caption-suppress";

// iQIYI renders its own subtitle rail; hide it so only Loom's overlay shows.
// (LIVE-VERIFY — confirm the actual node class.)
const CSS = `
.iqp-subtitle,
.iqp-logo-subtitle,
.textTrack { display: none !important; }
`;

export function hideIqiyiCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restoreIqiyiCaptions(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Promote `el` to a positioned containing block so the overlay's
    `position: absolute; inset: 0` host anchors to it (idempotent; only
    touches `position` when it's actually static).  Same rationale as the
    Netflix anchor helper. */
export function ensureAnchorPositioned(el: HTMLElement): void {
  const pos = getComputedStyle(el).position;
  if (pos === "static") {
    el.style.position = "relative";
  }
}
