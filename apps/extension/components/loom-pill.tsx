import { useCaptionStream } from "./caption-context";
import type { StreamStatus } from "@/lib/captions/types";

// Status-aware pill, top-right of YouTube watch pages.  Reflects the
// stream's lifecycle state.  When the stream is actively tracking,
// the pill also displays the currently-active target + native caption
// text — this is the cheapest verifier that the playhead-matching
// logic is correct before we ship a real overlay in 5c.

export function LoomPill() {
  const { status, target, native } = useCaptionStream();
  const { label, tone } = renderStatus(status);
  const showCaptions = status.kind === "tracking" && (target || native);

  return (
    <div style={containerStyle(tone, !!showCaptions)}>
      <div style={statusRowStyle}>
        <span style={dotStyle(tone)} />
        <span>{label}</span>
      </div>
      {target && (
        <div style={targetTextStyle}>{target.text}</div>
      )}
      {native && (
        <div style={nativeTextStyle}>{native.text}</div>
      )}
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

function containerStyle(tone: Tone, expanded: boolean): React.CSSProperties {
  const accent = toneAccent(tone);
  return {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: 2147483647,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "4px",
    padding: expanded ? "8px 14px" : "6px 12px",
    borderRadius: expanded ? "12px" : "999px",
    maxWidth: expanded ? "360px" : "auto",
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

const statusRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const targetTextStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 400,
  color: "#fff",
  marginTop: "4px",
};

const nativeTextStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 400,
  color: "rgba(255, 255, 255, 0.7)",
};

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
