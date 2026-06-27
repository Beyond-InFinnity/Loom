// WeTV (wetv.vip) overlay-anchor helpers — the WeTV counterpart to
// netflix-player-anchor.ts.
//
// Selectors confirmed from a live DOM ancestor-chain capture (2026-06-27):
// the player is INLINE (same-origin wetv.vip, Next.js SPA, Tencent "txp"
// player). The <video> ancestor chain is:
//   video → .txp_videos_container → #internal-player-wrapper →
//   #player-wrapper.player__wrapper (1267×551, position:relative — the video
//   box) → #player--playback (1267×631, video + control bar) → … →
//   .play__block--player (1822px, FULL PAGE WIDTH).
// The earlier `.play__block--player` guess matched that page-width block — an
// ANCESTOR of the player, so the overlay sat over the whole page AND vanished
// in fullscreen (an ancestor of the fullscreened element isn't rendered).
// `#player-wrapper` is the tight, video-sized, positioned box INSIDE the
// player subtree: correct alignment (control bar is below it) and it survives
// fullscreen. Comma fallbacks are its nested descendants, just in case.

/** Player root: overlay shadow-host anchor + usePlayerScale target. The
    video-sized box inside the player subtree (1267×551, position:relative —
    descendant of the fullscreen element, so the overlay survives fullscreen).
    SINGLE selector on purpose: a comma list let the mount logic latch onto a
    churning nested sibling. The WeTV entrypoint reconciles mount state on DOM
    mutations (the player rebuilds this node on resume). */
export const WETV_PLAYER_ROOT = "#player-wrapper";

/** The HTML5 <video> CaptionStream hooks for the playhead. */
export const WETV_VIDEO_SELECTOR = "#player-wrapper video, video";

const STYLE_ID = "loom-wetv-caption-suppress";

// WeTV renders its native subtitle into a `.text-track` element (confirmed
// from a live capture: <div class="text-track text-track-8319a">…</div>; the
// hashed suffix is a CSS-module id that can change across builds, so we match
// the stable base class via [class*="text-track"]).  The document-level rule
// can't reach Loom's own subs — they live in a shadow root.
const CSS = `
[class*="text-track"] { display: none !important; }
`;

export function hideWetvCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restoreWetvCaptions(): void {
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
