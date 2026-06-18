// Netflix overlay-anchor helpers — the Netflix counterpart to
// player-scale.ts's `#movie_player` + hide-yt-captions.ts.
//
// Selectors are sourced from the live-capture recon (NETFLIX_RECON.md,
// 2026-06-18):
//   - div[data-uia="video-canvas"]  the durable QA-hook player root
//     (preferred over the churning .watch-video--* class names); it's
//     the fullscreen element, so usePlayerScale's single ResizeObserver
//     covers default / fullscreen.
//   - #appMountPoint video          the HTML5 media element the playhead
//     polls (CaptionStream hooks `timeupdate`).
//   - .player-timedtext             Netflix's own subtitle rail, hidden
//     while Loom's overlay is active.

/** Player root: overlay shadow-host anchor + usePlayerScale target. */
export const NETFLIX_PLAYER_ROOT = 'div[data-uia="video-canvas"]';

/** The HTML5 <video> CaptionStream hooks for the playhead. */
export const NETFLIX_VIDEO_SELECTOR = "#appMountPoint video";

const STYLE_ID = "loom-netflix-caption-suppress";

// `.player-timedtext` is the container Netflix renders its own timed-text
// (subtitle) lines into.  Hiding it removes the native caption rail
// without disturbing the player chrome (controls / scrubber live
// elsewhere in the canvas).
const CSS = `.player-timedtext { display: none !important; }`;

export function hideNetflixCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restoreNetflixCaptions(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Ensure `el` is a positioned containing block so the overlay's
    `position: absolute; inset: 0` host anchors to it.  YouTube's
    #movie_player is already positioned; Netflix's video-canvas may be
    `position: static`, in which case our absolute host would escape to
    the nearest positioned ancestor.  Promote it to `relative` (idempotent;
    only touches the property when it's actually static).  This is the one
    spot where we mutate Netflix's own DOM — minimal + reversible. */
export function ensureAnchorPositioned(el: HTMLElement): void {
  const pos = getComputedStyle(el).position;
  if (pos === "static") {
    el.style.position = "relative";
  }
}
