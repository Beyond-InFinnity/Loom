// Crunchyroll overlay-anchor helpers — the Crunchyroll counterpart to
// netflix-player-anchor.ts.
//
// ⚠️ LIVE-VERIFY (selectors are best-guess until a logged-in DOM capture):
// these mirror Crunchyroll's current inline React player on
// crunchyroll.com/watch/<id>/<slug>.  The top open questions to confirm in
// the browser before trusting them:
//   1. INLINE vs IFRAME.  Older Crunchyroll embedded the Vilos player in an
//      iframe (static.crunchyroll.com/vilos-v2/...).  If the player is still
//      iframed, the ISO + MAIN entrypoints need that origin in `matches`
//      plus `allFrames: true`, and these selectors resolve INSIDE the frame.
//      The scaffold assumes the modern INLINE player.
//   2. The player-root element that becomes fullscreen (the autoMount anchor
//      + usePlayerScale target).
//   3. The <video> element id/selector.
//   4. The native-subtitle node to hide (Crunchyroll renders ASS via a
//      libass canvas overlay).
//
// Update all four constants from the first live capture, then drop this note.

/** Player root: overlay shadow-host anchor + usePlayerScale target.
    Must be the element that goes fullscreen. (LIVE-VERIFY) */
export const CRUNCHYROLL_PLAYER_ROOT = "#vilosRoot";

/** The HTML5 <video> CaptionStream hooks for the playhead. (LIVE-VERIFY)
    A bare `video` is the safe fallback — a watch page has exactly one. */
export const CRUNCHYROLL_VIDEO_SELECTOR = "#vilosRoot video, video";

const STYLE_ID = "loom-crunchyroll-caption-suppress";

// Crunchyroll renders its primary (ASS) subtitles through a libass canvas
// overlay, and VTT captions through a text-track display.  Hide both so only
// Loom's overlay shows.  (LIVE-VERIFY — confirm the actual node class.)
const CSS = `
canvas.libassjs-canvas,
.libassjs-canvas,
.vjs-text-track-display { display: none !important; }
`;

export function hideCrunchyrollCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restoreCrunchyrollCaptions(): void {
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
