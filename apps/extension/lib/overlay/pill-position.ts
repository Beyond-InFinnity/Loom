// Where the Loom pill (dormant + active) anchors inside the player.
//
// Default is the top-right corner (16/16), which is clear on YouTube.
// On Netflix the very top-right is Netflix's "report a problem" flag and
// the top-left is the back button, so we drop the pill DOWN the right
// edge to clear the flag — a vertical offset is more robust than guessing
// the flag's width, and the right edge below the flag is reliably empty
// (the bottom control bar + the back button are the only other chrome).
//
// Platform-resolved (via the PlayerAdapter seam, 7b) rather than a prop so
// both pill components stay dumb; the id is constant per page.

import { player } from "../host";

export interface PillAnchor {
  /** Distance from the player's top edge, in CSS px. */
  top: number;
  /** Distance from the player's right edge, in CSS px. */
  right: number;
}

const DEFAULT_ANCHOR: PillAnchor = { top: 16, right: 16 };
const NETFLIX_ANCHOR: PillAnchor = { top: 56, right: 16 };

export function getPillAnchor(): PillAnchor {
  return player.id === "netflix" ? NETFLIX_ANCHOR : DEFAULT_ANCHOR;
}
