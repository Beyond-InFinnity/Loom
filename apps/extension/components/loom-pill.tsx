import { memo, useCallback, useMemo, useRef, useState } from "react";

import { useCaptionStream } from "./caption-context";
import { SettingsPanel } from "./settings-panel";
import { getPillAnchor } from "@/lib/overlay/pill-position";
import {
  stopToPlayer,
  swallowPlayerEventsExceptClick,
} from "@/lib/overlay/stop-player-events";
import type { DiscoveryStatus } from "@/lib/captions/discover";

// Status pill + settings entry point.  Anchored top-right of the
// player area (player-relative, not viewport-relative — lives inside
// the #movie_player shadow root).
//
// PERF LOAD-BEARING (5f-perf): the pill MUST NOT depend on `target` or
// `native` from caption-context, otherwise it re-renders on every
// dialogue boundary.  Each re-render produced new inline styles that
// triggered CSS transitions on padding / gap / background / box-shadow
// — all main-thread paint+layout properties — and the rapid-fire
// transitions never settled on continuous-dialogue videos.  Combined
// with the pill not being on its own compositor layer, page input lag
// climbed to multi-second range.
//
// Fix: pill reads ONLY status from context (rare changes — once on
// discovery, once on track switch).  Compact-mode based on dialogue
// presence is dropped.  Pill is always the full-form pill.  Slight
// UX regression (pill is always visible at full size during
// dialogue) but it's the load-bearing fix for perf.  Pill is also
// promoted to its own compositor layer via translateZ(0) so YT page
// repaints don't cascade through it.
//
// NO backdrop-filter — see settings-panel.tsx header for the full
// rationale.
//
// NO CSS transitions on layout/paint properties — they triggered
// continuous main-thread work on rapid state changes.  Only the
// box-shadow accent intensity differs between open / closed (no
// animation).

export interface LoomPillProps {
  /** Called when the user clicks "Turn off Loom on this tab" in the
      settings panel.  LoomApp unmounts the active tree in response,
      reverting to the DormantPill. */
  onDeactivate: () => void;
}

export function LoomPill({ onDeactivate }: LoomPillProps) {
  const { status } = useCaptionStream();
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  // Stable onClose ref so SettingsPanel's click-outside useEffect deps
  // don't churn on every pill re-render.
  const handleClose = useCallback(() => setOpen(false), []);
  const handleToggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <>
      <PillButton
        status={status}
        open={open}
        onToggle={handleToggle}
        pillRef={pillRef}
      />
      <SettingsPanel
        open={open}
        onClose={handleClose}
        pillRef={pillRef}
        onDeactivate={onDeactivate}
      />
    </>
  );
}

// Memoized inner component — re-renders only when status or open
// changes, not on every dialogue-driven context update.
const PillButton = memo(function PillButton({
  status,
  open,
  onToggle,
  pillRef,
}: {
  status: DiscoveryStatus;
  open: boolean;
  onToggle: () => void;
  pillRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { label, tone } = useMemo(() => renderStatus(status), [status]);

  return (
    <button
      ref={pillRef}
      type="button"
      onClick={(e) => {
        stopToPlayer(e);
        onToggle();
      }}
      {...swallowPlayerEventsExceptClick}
      style={containerStyle(tone, open)}
      aria-label="Loom settings"
      aria-expanded={open}
    >
      <span style={dotStyle(tone)} />
      <span>{label}</span>
    </button>
  );
});

type Tone = "neutral" | "active" | "inactive" | "error";

function renderStatus(status: DiscoveryStatus): { label: string; tone: Tone } {
  switch (status.kind) {
    case "idle":
      return { label: "Loom", tone: "neutral" };
    case "discovering":
      return { label: "discovering…", tone: "neutral" };
    case "tracking":
      return {
        label: `${status.targetLang} → ${status.nativeLang}`,
        tone: "active",
      };
    case "unsupported":
      return {
        label:
          status.reason === "no-captions"
            ? "no captions"
            : "no supported tracks",
        tone: "inactive",
      };
    case "error":
      return { label: "error (see console)", tone: "error" };
  }
}

function containerStyle(tone: Tone, open: boolean): React.CSSProperties {
  const accent = toneAccent(tone);
  const anchor = getPillAnchor();
  return {
    position: "absolute",
    top: `${anchor.top}px`,
    right: `${anchor.right}px`,
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    borderRadius: "999px",
    background: "rgba(20, 20, 24, 0.94)",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    fontWeight: 500,
    letterSpacing: "0.02em",
    boxShadow: open
      ? `0 2px 12px rgba(0, 0, 0, 0.5), inset 0 0 0 1px ${accent}99`
      : `0 2px 12px rgba(0, 0, 0, 0.5), inset 0 0 0 1px ${accent}33`,
    pointerEvents: "auto",
    userSelect: "none",
    cursor: "pointer",
    border: "none",
    // Own compositor layer so YT page repaints (progress bar tick,
    // auto-hiding controls) don't cascade through the pill on the
    // main thread.  translateZ(0) is the cross-browser standard
    // promotion hint.
    transform: "translateZ(0)",
    willChange: "transform",
  };
}

function dotStyle(tone: Tone): React.CSSProperties {
  return {
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: toneAccent(tone),
    boxShadow: `0 0 6px ${toneAccent(tone)}aa`,
  };
}

function toneAccent(tone: Tone): string {
  switch (tone) {
    case "active":
      return "#5dffaa";
    case "neutral":
      return "#5d5dff";
    case "inactive":
      return "#888";
    case "error":
      return "#ff7a7a";
  }
}
