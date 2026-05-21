import { useCaptionStream } from "./caption-context";
import type { StreamStatus } from "@/lib/captions/types";

// Status indicator for non-tracking states + brief inter-event gaps
// during tracking.  Lives in the same shadow root as CaptionOverlay,
// anchored top-right of the player area (player-relative, not
// viewport-relative).  When the overlay is actively rendering
// captions, the pill is hidden — the captions themselves are the
// indicator.  When the user is on a tracking video but between
// dialogue events, the pill stays visible as a small "still here"
// signal.  Also the sole surface for unsupported / error states.

export function LoomPill() {
  const { status, target, native } = useCaptionStream();
  const captionsShowing = !!(target?.text || native?.text);
  if (status.kind === "tracking" && captionsShowing) return null;

  const { label, tone } = renderStatus(status);

  return (
    <div style={containerStyle(tone)}>
      <span style={dotStyle(tone)} />
      <span>{label}</span>
    </div>
  );
}

type Tone = "neutral" | "active" | "inactive" | "error";

function renderStatus(status: StreamStatus): { label: string; tone: Tone } {
  switch (status.kind) {
    case "idle":
      return { label: "Loom", tone: "neutral" };
    case "detecting":
      return { label: "detecting…", tone: "neutral" };
    case "tracking":
      return {
        label: `tracking ${status.targetLang} → ${status.nativeLang}`,
        tone: "active",
      };
    case "unsupported":
      return {
        label:
          status.reason === "no-captions"
            ? "no captions on this video"
            : "no supported tracks",
        tone: "inactive",
      };
    case "error":
      return { label: "error (see console)", tone: "error" };
  }
}

function containerStyle(tone: Tone): React.CSSProperties {
  const accent = toneAccent(tone);
  return {
    position: "absolute",
    top: "16px",
    right: "16px",
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    borderRadius: "999px",
    background: "rgba(20, 20, 24, 0.92)",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    fontWeight: 500,
    letterSpacing: "0.02em",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: `0 2px 12px rgba(0, 0, 0, 0.4), inset 0 0 0 1px ${accent}33`,
    pointerEvents: "none",
    userSelect: "none",
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
