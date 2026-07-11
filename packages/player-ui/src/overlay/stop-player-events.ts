// Keep clicks on Loom's chrome (pill + settings panel) from reaching the
// host page's player surface.
//
// Netflix toggles play/pause on a bubble-phase `click` on the player and
// fullscreen on `dblclick`, and our pill/panel live inside that player
// (anchored to div[data-uia="player"]).  Without this, every pill toggle
// or in-menu click also drives the video.  We stopPropagation on the
// pointer/mouse/click/dbl events at the pill + panel boundary so they
// never reach the player's ancestor handlers.
//
// stopPropagation, NOT preventDefault — the pill's own onClick + the
// panel widgets still work; we only block the leak upward.  The panel's
// click-outside-to-close uses a CAPTURE-phase document mousedown listener
// (settings-panel.tsx), which fires before these bubble handlers, so
// dismissal is unaffected.  YouTube doesn't pause on overlay clicks, so
// applying this there is a harmless no-op.

import type { SyntheticEvent } from "react";

export function stopToPlayer(e: SyntheticEvent): void {
  e.stopPropagation();
}

/** Spread onto an element that has NO onClick of its own (e.g. the panel
    root) to swallow every player-driving event. */
export const swallowPlayerEvents = {
  onPointerDown: stopToPlayer,
  onMouseDown: stopToPlayer,
  onClick: stopToPlayer,
  onDoubleClick: stopToPlayer,
} as const;

/** Same, minus onClick — for elements that need their own click handler
    (the pill buttons); wrap their onClick with stopToPlayer manually. */
export const swallowPlayerEventsExceptClick = {
  onPointerDown: stopToPlayer,
  onMouseDown: stopToPlayer,
  onDoubleClick: stopToPlayer,
} as const;
