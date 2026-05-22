import { useCaptionStream } from "./caption-context";
import type { CaptionPosition } from "./caption-context";
import { AnnotatedText } from "./annotated-text";
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
// at render time.  Default constants below are kept for backwards
// compatibility — the Layer values now come from caption-context so
// users can override per layer via the settings panel.
const OUTLINE_PX = 2.5;
const SHADOW_OFFSET_PX = 1.5;
const LAYER_GAP_PX = 4;
const HORIZONTAL_PADDING_PX = 12;
/** Default font stack — used when a layer's fontFamily is the "auto"
    sentinel.  Listed in order Noto-JP → Noto-SC/TC/KR → Noto-Thai →
    Noto-Sans (Latin) → system-ui; browser picks the first installed
    family that has a glyph for each char. */
const DEFAULT_FONT_STACK =
  "'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans', system-ui, -apple-system, sans-serif";
const FONT_FAMILY_AUTO = "auto";
/** Distance of each zone's anchor from the corresponding player edge.
    8% clears YT's progress bar / controls on the bottom and feels
    natural on the top (where "sign" captions traditionally live). */
const ZONE_INSET_PCT = 8;

interface Layer {
  text: string;
  color: string;
  fontSizePx: number;
  /** CSS font-family value, or the "auto" sentinel which resolves to
      DEFAULT_FONT_STACK at render time. */
  fontFamily: string;
  /** When set, overlay renders the annotated form (per-token <ruby>)
      using these spans.  null → plain text rendering (no annotation
      fetched, disabled, or lang not annotatable). */
  spans?: AnnotateSpan[] | null;
  /** Reading-to-base font ratio (only used when spans is set). */
  annotationRatio?: number;
  /** Color override for the annotation <rt> (distinct from the base
      text color above).  null → reuse `color`. */
  annotationColor?: string | null;
  /** Font family override for the annotation <rt> (distinct from the
      base text font above).  null/auto → reuse `fontFamily`. */
  annotationFontFamily?: string | null;
}

function resolveFontFamily(family: string): string {
  return family === FONT_FAMILY_AUTO || family.length === 0
    ? DEFAULT_FONT_STACK
    : family;
}

export function CaptionOverlay() {
  const {
    status,
    target,
    native,
    topColor,
    bottomColor,
    annotationColor,
    topFontFamily,
    bottomFontFamily,
    annotationFontFamily,
    topFontSizePx,
    bottomFontSizePx,
    annotationFontRatio,
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

  // Per-slot state: a slot is "configured" when one of the two layers
  // (target/native) is assigned to it via the user's position picker,
  // regardless of whether that layer has text at this instant.
  // `layer` is non-null only when both configured AND currently has
  // content.  `reservedFontSize` is the size we'd use for either the
  // populated layer or an invisible placeholder.
  const slots: Record<CaptionPosition, SlotState> = {
    "top-1": defaultSlotState(),
    "top-2": defaultSlotState(),
    "bottom-1": defaultSlotState(),
    "bottom-2": defaultSlotState(),
  };

  // Mark configured slots + their reserved font sizes.  These survive
  // even when the corresponding layer has no text in this frame —
  // that's what keeps the sibling slot from "bouncing" to the zone
  // anchor when both layers are in the same zone but only one has
  // content.
  slots[targetPosition].configured = true;
  slots[targetPosition].reservedFontSize = topFontSizePx;
  slots[targetPosition].reservedFontFamily = topFontFamily;
  slots[nativePosition].configured = true;
  slots[nativePosition].reservedFontSize = bottomFontSizePx;
  slots[nativePosition].reservedFontFamily = bottomFontFamily;

  if (topText) {
    slots[targetPosition].layer = {
      text: topText,
      color: topColor,
      fontSizePx: topFontSizePx,
      fontFamily: topFontFamily,
      spans: targetSpans,
      annotationRatio: annotationFontRatio,
      annotationColor,
      annotationFontFamily,
    };
  }
  if (bottomText) {
    slots[nativePosition].layer = {
      text: bottomText,
      color: bottomColor,
      fontSizePx: bottomFontSizePx,
      fontFamily: bottomFontFamily,
      spans: nativeSpans,
      // Native annotations use the SAME ratio + color/family as the
      // target — the panel exposes one set of annotation controls
      // shared across both layers since native is rarely annotated.
      annotationRatio: annotationFontRatio,
      annotationColor,
      annotationFontFamily,
    };
  }

  return (
    <>
      {renderZone("top", slots, scale)}
      {renderZone("bottom", slots, scale)}
    </>
  );
}

interface SlotState {
  /** Populated layer for this slot, or null when no text. */
  layer: Layer | null;
  /** True when one of the two tracks (target/native) is assigned to
      this slot via the position picker.  Survives the layer going
      empty between captions — that's the load-bearing distinction
      vs `layer !== null`. */
  configured: boolean;
  /** Font size for the configured layer.  Used for both the
      populated layer's actual render AND the placeholder reserve. */
  reservedFontSize: number;
  /** Font family for the configured layer — kept on the slot state
      so the placeholder uses the same line-height as the populated
      layer would.  "auto" sentinel resolves to DEFAULT_FONT_STACK. */
  reservedFontFamily: string;
}

function defaultSlotState(): SlotState {
  return {
    layer: null,
    configured: false,
    reservedFontSize: 52,
    reservedFontFamily: FONT_FAMILY_AUTO,
  };
}

/** Render one zone (top or bottom) using its two slot states.
    Slot positions are stable even when the sibling slot's layer
    drops out — empty slots in a both-configured zone get an
    invisible placeholder that reserves one line of vertical space,
    so the visible slot stays at its assigned position. */
function renderZone(
  zone: "top" | "bottom",
  slots: Record<CaptionPosition, SlotState>,
  scale: number,
): React.ReactNode {
  const key1: CaptionPosition = zone === "top" ? "top-1" : "bottom-1";
  const key2: CaptionPosition = zone === "top" ? "top-2" : "bottom-2";
  const s1 = slots[key1];
  const s2 = slots[key2];

  // Zone renders only if at least one of its configured slots has a
  // populated layer right now.  Both-empty (between captions, or
  // unsupported) → no zone container, no placeholder either.
  const anyVisible =
    (s1.configured && s1.layer !== null) ||
    (s2.configured && s2.layer !== null);
  if (!anyVisible) return null;

  // Critical decision: do we reserve placeholder space for the empty
  // sibling slot?
  //   - Both slots configured in this zone: YES — the visible slot
  //     would otherwise fall to the zone anchor, swapping places
  //     with where its sibling would be.  Placeholder pins it.
  //   - Only one slot configured: NO placeholder — the other layer
  //     lives in the OTHER zone, so there's no sibling to "bounce
  //     against" here.  Single configured slot just renders at the
  //     zone anchor naturally.
  const bothConfigured = s1.configured && s2.configured;

  return (
    <div style={zoneStyle(zone, scale)} key={zone}>
      <SlotNode state={s1} scale={scale} bothConfigured={bothConfigured} />
      <SlotNode state={s2} scale={scale} bothConfigured={bothConfigured} />
    </div>
  );
}

function SlotNode({
  state,
  scale,
  bothConfigured,
}: {
  state: SlotState;
  scale: number;
  bothConfigured: boolean;
}) {
  if (!state.configured) return null;
  if (state.layer !== null) {
    return <LayerEl scale={scale} layer={state.layer} />;
  }
  // Configured but empty.  Reserve space only when the sibling slot
  // is also configured — see renderZone for the rationale.
  if (!bothConfigured) return null;
  return (
    <LayerPlaceholder
      fontSize={state.reservedFontSize}
      fontFamily={state.reservedFontFamily}
      scale={scale}
    />
  );
}

/** Invisible 1-line placeholder.  Reserves vertical space equal to
    one line at `fontSize × scale × line-height` so the sibling slot
    in the zone keeps its assigned position even when this slot has
    no content.  nbsp gives the box text content (line-height needs
    something to apply to); visibility:hidden hides the glyph +
    outline + shadow without affecting layout. */
function LayerPlaceholder({
  fontSize,
  fontFamily,
  scale,
}: {
  fontSize: number;
  fontFamily: string;
  scale: number;
}) {
  return (
    <div
      style={{
        ...layerStyle(fontSize, fontFamily, scale, "transparent"),
        visibility: "hidden",
      }}
      aria-hidden="true"
    >
      {" "}
    </div>
  );
}

function LayerEl({ scale, layer }: { scale: number; layer: Layer }) {
  const hasSpans = layer.spans && layer.spans.length > 0;
  return (
    <div style={layerStyle(layer.fontSizePx, layer.fontFamily, scale, layer.color)}>
      {hasSpans ? (
        <AnnotatedText
          spans={layer.spans!}
          baseFontPxScaled={layer.fontSizePx * scale}
          annotationRatio={layer.annotationRatio ?? 0.5}
          color={layer.annotationColor ?? layer.color}
          fontFamily={
            layer.annotationFontFamily &&
            layer.annotationFontFamily !== FONT_FAMILY_AUTO
              ? layer.annotationFontFamily
              : null
          }
        />
      ) : (
        layer.text
      )}
    </div>
  );
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
  fontFamily: string,
  scale: number,
  color: string,
): React.CSSProperties {
  return {
    fontFamily: resolveFontFamily(fontFamily),
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
