import { useCaptionStream } from "./caption-context";
import type { CaptionPosition } from "./caption-context";
import { AnnotatedText } from "./annotated-text";
import { classifyLang } from "@/lib/captions/lang-support";
import type { AnnotateSpan } from "@/lib/annotate/types";
import { usePlayerScale } from "@/lib/overlay/player-scale";

// CaptionOverlay — dual-subs surface inside #movie_player's shadow root.
//
// Each track (target + native) is assigned to one of four positions:
//   - top-1     visually highest, top of player
//   - top-2     just below top-1
//   - bottom-1  upper line of bottom zone (where the legacy "Top" sat)
//   - bottom-2  visually lowest, bottom of player (where standard
//               captions sit)
//
// Rendering: two zones (top and bottom).  Each is a position:absolute
// flex-column anchored at its edge.  We populate each zone with the
// tracks whose position is in that zone, sorted by slot number so
// slot-1 renders above slot-2 visually.
//
// Solo case (only one track in a zone) falls out automatically — the
// single layer fills the flex container which is anchored at the zone
// edge, so it lands at the natural "default" position regardless of
// whether it was assigned to slot-1 or slot-2.
//
// Collisions can't happen at runtime because the position setters in
// caption-context.tsx auto-swap when the user picks a position the
// sibling track already occupies.

// All sizes are in CSS px @ 1080p reference; multiplied by usePlayerScale
// at render time.
const TOP_FONT_PX = 52;
const BOTTOM_FONT_PX = 48;
const OUTLINE_PX = 2.5;
const SHADOW_OFFSET_PX = 1.5;
const LAYER_GAP_PX = 4;
const HORIZONTAL_PADDING_PX = 12;
const FONT_STACK =
  "'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans', system-ui, -apple-system, sans-serif";
/** Distance of each zone's anchor from the corresponding player edge.
    8% clears YT's progress bar / controls on the bottom and feels
    natural on the top (where "sign" captions traditionally live). */
const ZONE_INSET_PCT = 8;
/** Reading-to-base font ratio for ruby annotations.  Mirrors
    loom_core/styles.py::annotation_font_ratio — CJK gets 0.5
    (per-character readings are dense and readable at half-size);
    Korean RR and other alphabetic scripts get 0.4 (longer readings
    benefit from being slightly smaller). */
const ANNOTATION_RATIO_CJK = 0.5;
const ANNOTATION_RATIO_ALPHABETIC = 0.4;

interface Layer {
  text: string;
  color: string;
  fontSize: number;
  /** When set, overlay renders the annotated form (per-token <ruby>)
      using these spans.  null → plain text rendering (no annotation
      fetched, disabled, or lang not annotatable). */
  spans?: AnnotateSpan[] | null;
  /** Reading-to-base font ratio (only used when spans is set). */
  annotationRatio?: number;
}

export function CaptionOverlay() {
  const {
    status,
    target,
    native,
    topColor,
    bottomColor,
    targetPosition,
    nativePosition,
    targetAnnotateMap,
    nativeAnnotateMap,
  } = useCaptionStream();
  const scale = usePlayerScale();

  if (status.kind !== "tracking") return null;
  const topText = target?.text ?? "";
  const bottomText = native?.text ?? "";
  if (!topText && !bottomText) return null;

  // Look up spans for the currently-active event text.  When the
  // annotation map is null (loading / disabled / not annotatable) OR
  // doesn't have an entry for this exact text, spans stays undefined
  // and the layer renders plain.  Matches buildAnnotateMap's dedup
  // semantics — events with identical text share the same span array.
  const targetSpans = topText
    ? targetAnnotateMap?.get(topText.trim()) ?? null
    : null;
  const nativeSpans = bottomText
    ? nativeAnnotateMap?.get(bottomText.trim()) ?? null
    : null;

  // Bucket each track's layer into its assigned slot.  Slot collisions
  // shouldn't happen (setters guarantee it) — if they ever do, the
  // second write wins and one layer is silently dropped.
  const slots: Record<CaptionPosition, Layer | null> = {
    "top-1": null,
    "top-2": null,
    "bottom-1": null,
    "bottom-2": null,
  };
  if (topText) {
    slots[targetPosition] = {
      text: topText,
      color: topColor,
      fontSize: TOP_FONT_PX,
      spans: targetSpans,
      annotationRatio: annotationRatioFor(status.targetLang),
    };
  }
  if (bottomText) {
    slots[nativePosition] = {
      text: bottomText,
      color: bottomColor,
      fontSize: BOTTOM_FONT_PX,
      spans: nativeSpans,
      annotationRatio: annotationRatioFor(status.nativeLang),
    };
  }

  const topZoneHas = slots["top-1"] !== null || slots["top-2"] !== null;
  const bottomZoneHas =
    slots["bottom-1"] !== null || slots["bottom-2"] !== null;

  return (
    <>
      {topZoneHas && (
        <div style={zoneStyle("top", scale)}>
          {slots["top-1"] && <LayerEl scale={scale} layer={slots["top-1"]} />}
          {slots["top-2"] && <LayerEl scale={scale} layer={slots["top-2"]} />}
        </div>
      )}
      {bottomZoneHas && (
        <div style={zoneStyle("bottom", scale)}>
          {slots["bottom-1"] && (
            <LayerEl scale={scale} layer={slots["bottom-1"]} />
          )}
          {slots["bottom-2"] && (
            <LayerEl scale={scale} layer={slots["bottom-2"]} />
          )}
        </div>
      )}
    </>
  );
}

function LayerEl({ scale, layer }: { scale: number; layer: Layer }) {
  const hasSpans = layer.spans && layer.spans.length > 0;
  return (
    <div style={layerStyle(layer.fontSize, scale, layer.color)}>
      {hasSpans ? (
        <AnnotatedText
          spans={layer.spans!}
          baseFontPxScaled={layer.fontSize * scale}
          annotationRatio={layer.annotationRatio ?? ANNOTATION_RATIO_CJK}
          color={layer.color}
        />
      ) : (
        layer.text
      )}
    </div>
  );
}

/** Pick the reading-to-base font ratio for a language.  Hangul gets
    the alphabetic ratio (longer per-syllable readings); CJK Han +
    Kana get the denser CJK ratio.  Defaults to CJK for unknown langs
    since the annotation pipeline only fires for annotate-romanize
    languages anyway. */
function annotationRatioFor(langCode: string): number {
  const c = classifyLang(langCode);
  if (c.family === "hangul") return ANNOTATION_RATIO_ALPHABETIC;
  return ANNOTATION_RATIO_CJK;
}

function zoneStyle(
  zone: "top" | "bottom",
  scale: number,
): React.CSSProperties {
  // Top zone anchored at top: 8% — first child sits there, second
  // child stacks below.  Bottom zone anchored at bottom: 8% — first
  // child sits at the top of the zone, second child at the bottom
  // (touching the 8% anchor).  Both use flex-column with the JSX in
  // [slot-1, slot-2] order, which yields slot-1-above-slot-2 visually
  // in both zones.
  const base: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: `${LAYER_GAP_PX * scale}px`,
    pointerEvents: "none",
    // Per-zone compositor layer.  YT's overlay-host promotion already
    // isolates us from YT's repaints, but explicit translateZ on each
    // zone keeps in-zone text changes (every dialogue boundary) from
    // re-painting the rest of our shadow tree.
    transform: "translateZ(0)",
  };
  if (zone === "top") {
    return { ...base, top: `${ZONE_INSET_PCT}%` };
  }
  return { ...base, bottom: `${ZONE_INSET_PCT}%` };
}

function layerStyle(
  fontSizePx: number,
  scale: number,
  color: string,
): React.CSSProperties {
  return {
    fontFamily: FONT_STACK,
    fontSize: `${fontSizePx * scale}px`,
    fontWeight: 500,
    color,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    padding: `0 ${HORIZONTAL_PADDING_PX * scale}px`,
    lineHeight: 1.25,
    unicodeBidi: "isolate",
    // 4-corner offset shadows emulate ASS outline; trailing offset
    // shadow emulates ASS shadow.  Mirrors
    // apps/web/lib/raster/build-html.ts::textShadowCss.
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
