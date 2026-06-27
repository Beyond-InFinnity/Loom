// iQIYI (iq.com) overlay-anchor helpers — the iQIYI counterpart to
// netflix-player-anchor.ts.
//
// ⚠️ LIVE-VERIFY (selectors are best-guess until a logged-in DOM capture):
// the recon could not confirm iq.com's exact player DOM (the page is JS/geo
// gated).  What IS established: the player is INLINE in the top document, not
// a cross-origin iframe (Immersive Translate + DownSub both overlay/inject
// in-page), so our autoMount overlay applies.  Confirm these four constants
// from the first live capture, then drop this note:
//   1. the player-root element that goes fullscreen (autoMount anchor +
//      usePlayerScale target)
//   2. the <video> selector
//   3. the native-subtitle node to hide
// The PLAYER_ROOT is a comma-list of plausible containers so autoMount
// anchors to whichever exists; narrow it once confirmed.

/** Player root: overlay shadow-host anchor + usePlayerScale target.  Comma
    list of best-guess containers — querySelector returns the first match.
    (LIVE-VERIFY) */
export const IQIYI_PLAYER_ROOT =
  ".iqp-player-videolayer, .iqp-player, #flashbox, .intl-video-player";

/** The HTML5 <video> CaptionStream hooks for the playhead. (LIVE-VERIFY)
    A bare `video` is the safe fallback — a play page has exactly one. */
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
