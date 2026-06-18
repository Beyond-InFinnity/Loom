import { useState } from "react";

import { getPillAnchor } from "@/lib/overlay/pill-position";
import {
  stopToPlayer,
  swallowPlayerEventsExceptClick,
} from "@/lib/overlay/stop-player-events";

// DormantPill — the off-state UI for per-tab activation (5d-perf).
//
// Default state of every fresh YouTube tab.  Renders a small, low-
// opacity power button in the top-right of the player area.  Click
// activates Loom for this tab: full caption discovery, overlay, and
// the annotation pipeline mount.  Persists via sessionStorage in
// LoomApp so reloads of the same tab keep the activation.
//
// In dormant state, NONE of the heavy machinery runs:
// - no CaptionStreamProvider, no useCaptionStream() consumers
// - no subscribeToCaptions → no window.message listener gating
//   live (discover.handleMessage drops MAIN's tracklists)
// - no usePlayerScale ResizeObserver
// - no /timedtext fetches, no /annotate fetches
//
// Just this single button + click handler.  Compositor-layer-
// isolated so YT page repaints don't touch our paint surface.

export interface DormantPillProps {
  onActivate: () => void;
}

export function DormantPill({ onActivate }: DormantPillProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        stopToPlayer(e);
        onActivate();
      }}
      {...swallowPlayerEventsExceptClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={containerStyle(hover)}
      aria-label="Activate Loom on this tab"
      title="Activate Loom on this tab"
    >
      <PowerIcon />
      <span style={labelStyle(hover)}>Loom</span>
    </button>
  );
}

function PowerIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function containerStyle(hover: boolean): React.CSSProperties {
  const anchor = getPillAnchor();
  return {
    position: "absolute",
    top: `${anchor.top}px`,
    right: `${anchor.right}px`,
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px 5px 8px",
    borderRadius: "999px",
    background: hover ? "rgba(20, 20, 24, 0.88)" : "rgba(20, 20, 24, 0.4)",
    color: hover ? "#fff" : "rgba(255, 255, 255, 0.55)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.04em",
    boxShadow: hover
      ? "0 2px 12px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.15)"
      : "0 1px 6px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
    pointerEvents: "auto",
    userSelect: "none",
    cursor: "pointer",
    border: "none",
    // Own compositor layer.  Same rationale as the full pill — YT
    // continuously repaints the player and we don't want it touching
    // our paint surface on the main thread.
    transform: "translateZ(0)",
    willChange: "transform",
    transition:
      "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}

function labelStyle(hover: boolean): React.CSSProperties {
  return {
    opacity: hover ? 1 : 0.85,
    transition: "opacity 120ms ease",
  };
}
