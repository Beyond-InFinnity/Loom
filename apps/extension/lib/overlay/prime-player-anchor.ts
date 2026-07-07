// Prime Video overlay-anchor helpers — the Prime counterpart to
// netflix-player-anchor.ts.
//
// Selectors from the live DOM probe (2026-07-07).  Prime's player exposes
// only a handful of STABLE `atvwebplayersdk-*` classes (the rest are
// per-build hashes like `fk9ydtn` we can't anchor to).  Crucially, NO
// single stable element holds BOTH the <video> and the control chrome:
//   - `.atvwebplayersdk-video-surface`   holds the <video> (video layer)
//   - `.atvwebplayersdk-player-container` holds the controls/overlays
// and their common ancestor is a hash-classed <div> with no stable
// selector.  So we anchor to the VIDEO SURFACE: it's stable, video-sized
// (a good usePlayerScale reference), and inside the fullscreen subtree.
//
// Tradeoff vs the Netflix LCA rule: because the controls live in a
// SIBLING container (player-container) with its own stacking context, the
// pill can be occluded WHILE the control chrome is up.  Prime's chrome
// auto-hides on idle, so the pill is clickable the rest of the time —
// acceptable for a first pass.  A later refinement can anchor to the
// computed LCA via a function anchor if the occlusion proves annoying.

/** Player root: overlay shadow-host anchor + usePlayerScale target.
    The video-surface layer — stable, video-sized, inside fullscreen. */
export const PRIME_PLAYER_ROOT = ".atvwebplayersdk-video-surface";

/** The HTML5 <video> CaptionStream hooks for the playhead.  Scoped to the
    video surface so a stray preview <video> elsewhere on the SPA can't
    match.  (Fallback selector; the real binding goes through
    resolvePrimeVideo below, which picks the SAME surface the overlay
    mounts on.) */
export const PRIME_VIDEO_SELECTOR = ".atvwebplayersdk-video-surface video";

/** The REAL player surface: the LARGEST sized `.atvwebplayersdk-video-
    surface` that holds a <video>.  Prime keeps a hidden 0x0 preview
    surface (and sometimes a small background-preview one) alongside the
    playing surface, so "largest with a video" is the reliable pick.  null
    until one exists.  Shared by BOTH the overlay anchor and the playhead
    video binding so they can't diverge onto different <video> elements —
    the divergence that left the playhead on an empty (duration=NaN)
    placeholder while the overlay mounted on the real player. */
export function resolvePrimePlayerSurface(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll<HTMLElement>(PRIME_PLAYER_ROOT)) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area >= 40000 && el.querySelector("video") && area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/** The <video> inside the real player surface — the element the playhead
    must track.  Prefers a video that actually has media (finite duration)
    when several surfaces qualify; else the largest surface's video. */
export function resolvePrimeVideo(): HTMLVideoElement | null {
  const surface = resolvePrimePlayerSurface();
  const inSurface = surface?.querySelector<HTMLVideoElement>("video") ?? null;
  if (inSurface && Number.isFinite(inSurface.duration) && inSurface.duration > 0) {
    return inSurface;
  }
  // If the largest surface's video hasn't loaded media yet, prefer ANY
  // matching video that already has a finite duration (the playing one),
  // else fall back to the largest surface's (soon-to-load) video.
  let withMedia: HTMLVideoElement | null = null;
  for (const v of document.querySelectorAll<HTMLVideoElement>(PRIME_VIDEO_SELECTOR)) {
    if (Number.isFinite(v.duration) && v.duration > 0) {
      withMedia = v;
      break;
    }
  }
  return withMedia ?? inSurface;
}

const STYLE_ID = "loom-prime-caption-suppress";

// Prime renders native captions into an overlay inside the player.  The
// probe didn't surface a captions element (none was displaying), so this
// targets the SDK's caption classes broadly by prefix; refine once the
// live element is seen (the probe now logs it).  Harmless if it matches
// nothing — Loom provides the subtitle track, so the native rail is
// normally off anyway.
const CSS = `
[class*="atvwebplayersdk-captions"],
[class*="atvwebplayersdk-subtitle"],
[class*="atvwebplayersdk-timedtext"] { display: none !important; }
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
