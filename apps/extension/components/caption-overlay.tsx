import { useCaptionStream } from "./caption-context";
import { usePlayerScale } from "@/lib/overlay/player-scale";

// CaptionOverlay — the real dual-subs surface for 5c.
//
// Mounted inside #movie_player's shadow-root host.  Renders Top
// (target / foreign) text above Bottom (native / English) text,
// centered, anchored ~8% above the player bottom — slotting into
// where YT's native caption rail would have lived.
//
// Typography defaults mirror apps/web/lib/raster/build-html.ts
// (size 52 top / 48 bottom @ 1080p, white + 4-corner outline +
// offset shadow).  Sizes scale with usePlayerScale() so default
// / theater / fullscreen all look right.
//
// 5f will swap these constants for a user-driven StyleConfig.

// All sizes are in CSS px @ 1080p reference; multiplied by scale
// at render time.
const TOP_FONT_PX = 52;
const BOTTOM_FONT_PX = 48;
const OUTLINE_PX = 2.5;
const SHADOW_OFFSET_PX = 1.5;
const LAYER_GAP_PX = 4;
const HORIZONTAL_PADDING_PX = 12;
const FONT_STACK =
  "'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans', system-ui, -apple-system, sans-serif";
// 8% above player bottom — clears YT's progress bar / controls strip
// while feeling at home where captions live.
const BOTTOM_OFFSET_PCT = 8;

export function CaptionOverlay() {
  const { status, target, native } = useCaptionStream();
  const scale = usePlayerScale();

  if (status.kind !== "tracking") return null;
  const topText = target?.text ?? "";
  const bottomText = native?.text ?? "";
  if (!topText && !bottomText) return null;

  return (
    <div style={containerStyle(scale)}>
      {topText && (
        <div style={layerStyle(TOP_FONT_PX, scale)}>{topText}</div>
      )}
      {bottomText && (
        <div style={layerStyle(BOTTOM_FONT_PX, scale)}>{bottomText}</div>
      )}
    </div>
  );
}

function containerStyle(scale: number): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: `${BOTTOM_OFFSET_PCT}%`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: `${LAYER_GAP_PX * scale}px`,
    pointerEvents: "none",
    // Promote to its own compositor layer so YT redrawing controls
    // underneath doesn't repaint the overlay text every frame.
    transform: "translateZ(0)",
  };
}

function layerStyle(
  fontSizePx: number,
  scale: number,
): React.CSSProperties {
  return {
    fontFamily: FONT_STACK,
    fontSize: `${fontSizePx * scale}px`,
    fontWeight: 500,
    color: "#fff",
    textAlign: "center",
    whiteSpace: "pre-wrap",
    padding: `0 ${HORIZONTAL_PADDING_PX * scale}px`,
    lineHeight: 1.25,
    unicodeBidi: "isolate",
    // 4-corner offset shadows emulate ASS outline; trailing offset
    // shadow emulates ASS shadow.  See
    // apps/web/lib/raster/build-html.ts::textShadowCss for the
    // canonical shape we mirror here.
    textShadow: buildTextShadow(scale),
    maxWidth: "92%",
  };
}

function buildTextShadow(scale: number): string {
  const d = OUTLINE_PX * scale;
  const s = SHADOW_OFFSET_PX * scale;
  const outlineRgba = "rgba(0, 0, 0, 1)";
  const shadowRgba = "rgba(0, 0, 0, 0.7)";
  return [
    `-${d}px -${d}px 0 ${outlineRgba}`,
    `${d}px -${d}px 0 ${outlineRgba}`,
    `-${d}px ${d}px 0 ${outlineRgba}`,
    `${d}px ${d}px 0 ${outlineRgba}`,
    `${s}px ${s}px 0 ${shadowRgba}`,
  ].join(", ");
}
