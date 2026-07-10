import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCaptionStream } from "./caption-context";
import { SettingsPanel } from "./settings-panel";
import { t } from "@/lib/i18n";
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

/** Idle delay before the active pill fades out (ms).  Matches the feel
    of the player's own auto-hiding controls. */
const PILL_IDLE_MS = 3000;

export function LoomPill({ onDeactivate }: LoomPillProps) {
  const { status } = useCaptionStream();
  const [open, setOpen] = useState(false);
  // Auto-fade state: the active pill dims after PILL_IDLE_MS of pointer
  // inactivity and reappears on any movement, so it isn't a constant
  // distraction during playback (the dormant pill already self-dims; this
  // brings the active pill in line).  `visibleRef` mirrors `visible`
  // synchronously so the high-frequency mousemove handler can short-
  // circuit WITHOUT calling setState on every move — state only flips on
  // the idle↔active edges, never per-frame, preserving the pill's
  // perf-critical "doesn't re-render during playback" contract.
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const hoveredRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  // Stable onClose ref so SettingsPanel's click-outside useEffect deps
  // don't churn on every pill re-render.
  const handleClose = useCallback(() => setOpen(false), []);
  const handleToggle = useCallback(() => setOpen((v) => !v), []);

  const show = useCallback(
    (forcePinned: boolean) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (!visibleRef.current) {
        visibleRef.current = true;
        setVisible(true);
      }
      // Never arm the hide timer while the panel is open or the pointer
      // is resting on the pill — fading the control out from under the
      // cursor / an open menu would be hostile.
      if (!forcePinned && !open && !hoveredRef.current) {
        hideTimer.current = setTimeout(() => {
          visibleRef.current = false;
          setVisible(false);
        }, PILL_IDLE_MS);
      }
    },
    [open],
  );

  // Listen for page-wide pointer / key activity to wake the pill.  The
  // overlay's host is pointer-transparent except the pill itself, so the
  // user's mouse moving over the video surfaces as a document mousemove.
  useEffect(() => {
    const onActivity = () => show(false);
    document.addEventListener("mousemove", onActivity, { passive: true });
    document.addEventListener("keydown", onActivity, { passive: true });
    // Re-running on `open` change re-arms (or, while open, suppresses)
    // the timer; show(false) here also force-wakes the pill when the
    // panel closes.
    show(false);
    return () => {
      document.removeEventListener("mousemove", onActivity);
      document.removeEventListener("keydown", onActivity);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [show]);

  const handleMouseEnter = useCallback(() => {
    hoveredRef.current = true;
    show(true);
  }, [show]);
  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = false;
    show(false);
  }, [show]);

  return (
    <>
      <PillButton
        status={status}
        open={open}
        visible={visible || open}
        onToggle={handleToggle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
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
  visible,
  onToggle,
  onMouseEnter,
  onMouseLeave,
  pillRef,
}: {
  status: DiscoveryStatus;
  open: boolean;
  visible: boolean;
  onToggle: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
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
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={containerStyle(tone, open, visible)}
      aria-label={t("pill.settings")}
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
      return { label: t("pill.discovering"), tone: "neutral" };
    case "tracking":
      return {
        label: `${status.targetLang} → ${status.nativeLang}`,
        tone: "active",
      };
    case "unsupported":
      return {
        label:
          status.reason === "no-captions"
            ? t("pill.noCaptions")
            : t("pill.noSupportedTracks"),
        tone: "inactive",
      };
    case "error":
      return { label: t("pill.error"), tone: "error" };
  }
}

function containerStyle(
  tone: Tone,
  open: boolean,
  visible: boolean,
): React.CSSProperties {
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
    // Idle auto-fade (mirrors the player's own controls).  `opacity` is a
    // compositor-only property on this already-promoted layer, so the
    // transition is GPU-composited — no main-thread paint/layout, and it
    // fires only on the rare idle↔active toggle (never per dialogue), so
    // it stays within the pill's perf contract.  Dimmed (not fully gone)
    // so the user can still find + hover it to wake it.
    opacity: visible ? 1 : 0.12,
    transition: "opacity 350ms ease",
    // Own compositor layer so YT page repaints (progress bar tick,
    // auto-hiding controls) don't cascade through the pill on the
    // main thread.  translateZ(0) is the cross-browser standard
    // promotion hint.
    transform: "translateZ(0)",
    willChange: "transform, opacity",
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
