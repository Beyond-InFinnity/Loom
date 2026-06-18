// Netflix overlay-anchor helpers — the Netflix counterpart to
// player-scale.ts's `#movie_player` + hide-yt-captions.ts.
//
// Selectors are sourced from the live-capture recon (NETFLIX_RECON.md,
// 2026-06-18) + the 5h-3 first-run DOM probe (2026-06-18):
//   - div[data-uia="player"]        the overlay anchor.  It is the lowest
//     common ancestor of BOTH the <video> (inside data-uia="video-canvas")
//     AND Netflix's control chrome (back button / bottom bar), confirmed
//     by the LCA probe.  Anchoring here — rather than the lower
//     video-canvas — puts Loom's shadow host in the SAME stacking context
//     as the controls, so its max z-index actually wins and the pill /
//     settings panel stay clickable while the chrome is up.  (Mounting
//     inside video-canvas trapped us one context below the controls.)
//     `player` also wraps video-canvas tightly (same box), so caption
//     positioning + usePlayerScale are unchanged; and the controls live
//     inside it, so it's inside whatever Netflix fullscreens.
//   - #appMountPoint video          the HTML5 media element the playhead
//     polls (CaptionStream hooks `timeupdate`).
//   - .player-timedtext             Netflix's own subtitle rail, hidden
//     while Loom's overlay is active.

/** Player root: overlay shadow-host anchor + usePlayerScale target.
    The LCA of the video and the control chrome — see header. */
export const NETFLIX_PLAYER_ROOT = 'div[data-uia="player"]';

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
