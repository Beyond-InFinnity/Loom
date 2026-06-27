import { useCallback, useEffect, useRef, useState } from "react";

import { getPillAnchor } from "@/lib/overlay/pill-position";
import {
  stopToPlayer,
  swallowPlayerEventsExceptClick,
} from "@/lib/overlay/stop-player-events";

// DormantPill — the off-state UI for per-tab activation (5d-perf).
//
// Default state of every fresh tab.  Renders a small, low-opacity power
// button in the top-right of the player area.  Click activates Loom for this
// tab: full caption discovery, overlay, and the annotation pipeline mount.
// Persists via sessionStorage in LoomApp so reloads of the same tab keep the
// activation.
//
// In dormant state, NONE of the heavy machinery runs (no CaptionStreamProvider,
// no usePlayerScale, no fetches).  Just this button + a single passive
// document-activity listener that drives the first-run "gold-dust" cue.
//
// FIRST-RUN CUE: new users don't always realize the greyed pill is the
// activate button.  So whenever the pointer moves over the player (any
// document mousemove/keydown — the overlay host is pointer-transparent except
// the pill), the pill lights up with an undulating gold glow, then settles
// back to grey after idle.  This mirrors how the active language pill wakes on
// activity.  PERF: the glow animates ONLY opacity + transform on a separate,
// compositor-promoted layer (never box-shadow), and `awakeRef` gates setState
// to the idle↔awake EDGES so the high-frequency mousemove never re-renders.

export interface DormantPillProps {
  onActivate: () => void;
}

/** Idle delay before the gold cue settles back to grey (ms).  Matches the
    active pill's fade feel. */
const IDLE_MS = 3000;

// Keyframes live in a <style> inside the shadow root (inline styles can't
// declare @keyframes).  Undulates opacity + scale only → GPU-composited.
const GLOW_CSS = `
@keyframes loomDormantGold {
  0%   { opacity: 0.35; transform: scale(0.88); }
  50%  { opacity: 0.95; transform: scale(1.12); }
  100% { opacity: 0.35; transform: scale(0.88); }
}`;

export function DormantPill({ onActivate }: DormantPillProps) {
  const [hover, setHover] = useState(false);
  const [awake, setAwake] = useState(false);
  // Synchronous mirror of `awake` so the per-move handler short-circuits
  // without setState on every mousemove — state only flips on the edges.
  const awakeRef = useRef(false);
  const hoveredRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback((pinned: boolean) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!awakeRef.current) {
      awakeRef.current = true;
      setAwake(true);
    }
    // Don't arm the idle timer while the pointer rests on the pill — letting
    // the cue settle out from under the cursor would feel broken.
    if (!pinned && !hoveredRef.current) {
      hideTimer.current = setTimeout(() => {
        awakeRef.current = false;
        setAwake(false);
      }, IDLE_MS);
    }
  }, []);

  // Wake on any page-wide pointer / key activity (mouse moving over the
  // player surfaces as a document mousemove — the overlay host is
  // pointer-transparent except the pill itself).
  useEffect(() => {
    const onActivity = () => wake(false);
    document.addEventListener("mousemove", onActivity, { passive: true });
    document.addEventListener("keydown", onActivity, { passive: true });
    return () => {
      document.removeEventListener("mousemove", onActivity);
      document.removeEventListener("keydown", onActivity);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [wake]);

  const lit = hover || awake;

  return (
    <>
      <style>{GLOW_CSS}</style>
      <button
        type="button"
        onClick={(e) => {
          stopToPlayer(e);
          onActivate();
        }}
        {...swallowPlayerEventsExceptClick}
        onMouseEnter={() => {
          hoveredRef.current = true;
          setHover(true);
          wake(true);
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
          setHover(false);
          wake(false);
        }}
        style={containerStyle(lit)}
        aria-label="Activate Loom on this tab"
        title="Activate Loom on this tab"
      >
        <span aria-hidden="true" style={glowWrapStyle(lit)}>
          <span style={glowInnerStyle(lit)} />
        </span>
        <span style={contentStyle}>
          <PowerIcon />
        </span>
        <span style={{ ...contentStyle, ...labelStyle(lit) }}>Loom</span>
      </button>
    </>
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

function containerStyle(lit: boolean): React.CSSProperties {
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
    // Greyed by default; warms to a gold tint while the cue is lit.
    background: lit ? "rgba(28, 22, 8, 0.92)" : "rgba(20, 20, 24, 0.4)",
    color: lit ? "#ffe2a6" : "rgba(255, 255, 255, 0.55)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.04em",
    // Static gold ring when lit (changes once on the idle↔awake edge, not per
    // frame — the *undulation* is the separate glow layer, not this shadow).
    boxShadow: lit
      ? "0 2px 14px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 205, 110, 0.6)"
      : "0 1px 6px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
    pointerEvents: "auto",
    userSelect: "none",
    cursor: "pointer",
    border: "none",
    // Let the gold glow halo extend beyond the pill bounds.
    overflow: "visible",
    // Own compositor layer so player repaints don't touch our paint surface.
    transform: "translateZ(0)",
    willChange: "transform",
    transition: "background 160ms ease, color 160ms ease, box-shadow 160ms ease",
  };
}

// The gold-dust halo is split into two layers to avoid a compositing artifact:
//   - WRAPPER owns the idle↔lit gate via a plain opacity transition. Fading a
//     stable layer's opacity is clean.
//   - INNER owns the perpetual undulation (opacity + scale keyframe). We NEVER
//     toggle `animation` to `none` — that snapped the layer's transform on the
//     way out and left a scaled, blurred ghost ("double image"). Instead we
//     freeze it with `animation-play-state: paused` when idle, so the layer is
//     never recreated and the transform never jumps. Paused = no GPU tick while
//     dormant, so we keep the "no work while dormant" property too.

/** Idle↔lit opacity gate (stable layer, clean fade). */
function glowWrapStyle(lit: boolean): React.CSSProperties {
  return {
    position: "absolute",
    inset: "-7px",
    borderRadius: "999px",
    zIndex: 0,
    pointerEvents: "none",
    opacity: lit ? 1 : 0,
    transition: "opacity 350ms ease",
    willChange: "opacity",
  };
}

/** The undulating, blurred gold-dust gradient. */
function glowInnerStyle(lit: boolean): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    borderRadius: "999px",
    background:
      "radial-gradient(45% 65% at 30% 38%, rgba(255, 230, 160, 0.60), transparent 70%)," +
      "radial-gradient(55% 75% at 72% 64%, rgba(255, 188, 84, 0.50), transparent 72%)," +
      "radial-gradient(40% 50% at 55% 50%, rgba(255, 214, 120, 0.45), transparent 75%)",
    filter: "blur(5px)",
    animation: "loomDormantGold 2.4s ease-in-out infinite",
    animationPlayState: lit ? "running" : "paused",
    willChange: "transform, opacity",
  };
}

/** Pill content sits above the glow layer. */
const contentStyle: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "inline-flex",
  alignItems: "center",
};

function labelStyle(lit: boolean): React.CSSProperties {
  return {
    opacity: lit ? 1 : 0.85,
    transition: "opacity 160ms ease",
  };
}
