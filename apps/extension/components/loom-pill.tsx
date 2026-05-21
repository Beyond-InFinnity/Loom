import { useRef, useState } from "react";

import { useCaptionStream } from "./caption-context";
import { SettingsPanel } from "./settings-panel";
import type { DiscoveryStatus } from "@/lib/captions/discover";

// Status pill + settings entry point.  Anchored top-right of the
// player area (player-relative, not viewport-relative — lives inside
// the #movie_player shadow root).
//
// 5f-diagnostics: pill is now ALWAYS visible (no longer hides during
// active dialogue) because it doubles as the open-settings affordance.
// During active dialogue, the pill shrinks to a compact form so it
// doesn't compete with the captions visually; click to open the
// settings panel regardless of state.

export function LoomPill() {
  const { status, target, native } = useCaptionStream();
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  const captionsShowing = !!(target?.text || native?.text);
  const compact = status.kind === "tracking" && captionsShowing && !open;
  const { label, tone } = renderStatus(status, compact);

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={containerStyle(tone, compact, open)}
        aria-label="Loom settings"
        aria-expanded={open}
      >
        <span style={dotStyle(tone)} />
        {!compact && <span>{label}</span>}
        {compact && <GearIcon />}
      </button>
      <SettingsPanel
        open={open}
        onClose={() => setOpen(false)}
        pillRef={pillRef}
      />
    </>
  );
}

type Tone = "neutral" | "active" | "inactive" | "error";

function renderStatus(
  status: DiscoveryStatus,
  _compact: boolean,
): { label: string; tone: Tone } {
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

function GearIcon() {
  // Inline SVG so we don't ship an asset file.  Compact-mode glyph.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function containerStyle(
  tone: Tone,
  compact: boolean,
  open: boolean,
): React.CSSProperties {
  const accent = toneAccent(tone);
  return {
    position: "absolute",
    top: "16px",
    right: "16px",
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: compact ? "0" : "8px",
    padding: compact ? "5px 7px" : "6px 12px",
    borderRadius: "999px",
    background: compact
      ? "rgba(20, 20, 24, 0.55)"
      : "rgba(20, 20, 24, 0.92)",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    fontWeight: 500,
    letterSpacing: "0.02em",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: open
      ? `0 2px 12px rgba(0, 0, 0, 0.4), inset 0 0 0 1px ${accent}99`
      : `0 2px 12px rgba(0, 0, 0, 0.4), inset 0 0 0 1px ${accent}33`,
    pointerEvents: "auto",
    userSelect: "none",
    cursor: "pointer",
    border: "none",
    transition:
      "padding 120ms ease, background 120ms ease, gap 120ms ease, box-shadow 120ms ease",
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
