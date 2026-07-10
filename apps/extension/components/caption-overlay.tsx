import { useCallback, useEffect, useState } from "react";

import { useCaptionStream } from "./caption-context";
import type { CaptionPosition } from "./caption-context";
import { AnnotatedText } from "./annotated-text";
import { DefinitionCard } from "./definition-card";
import { buildRichSegments } from "@/lib/orthography/build-segments";
import type { RichSegment } from "@/lib/orthography/types";
import type { AnnotateSpan } from "@/lib/annotate/types";
import {
  resolveOrthographyVariants,
  type OrthographyTable,
} from "@loom/orthography-tables";
import { usePlayerScale } from "@/lib/overlay/player-scale";
import { usePaused } from "@/lib/overlay/use-paused";
import type { CueLayout } from "@/lib/captions/types";

/** A word the user clicked in the target line while paused — drives the
    DefinitionCard (VOCAB_LOOKUP.md Phase 2). */
interface SelectedWord {
  word: string;
  lemma: string;
  /** Contextual reading of the surface (JA; topic は → わ).  null → the
      card falls back to the dictionary reading. */
  reading: string | null;
  rect: DOMRect;
  langCode: string | null;
}

/** Hover-glow for clickable vocab words.  A <style> in the overlay's shadow
    root (inline styles can't express :hover).

    We glow the GLYPHS, not the box: `filter: drop-shadow()` follows the
    rendered alpha shape of the word (its outlined glyphs + furigana), so the
    highlight hugs the text tightly instead of painting a rectangle behind it.
    Two stacked shadows — a crisp inner ring + a soft bloom.  drop-shadow also
    STACKS with the glyphs' own inline text-shadow outline rather than
    clobbering it (a text-shadow override would drop the dark outline on hover
    and hurt legibility over bright video).  GPU-composited; only ever active
    while PAUSED, so it never touches the playback-time paint path.  NO
    backdrop-filter (perf tripwire). */
const VOCAB_WORD_CSS = `
.loom-vocab-word {
  transition: filter 90ms ease;
}
.loom-vocab-word:hover {
  filter: drop-shadow(0 0 1.5px rgba(160, 205, 255, 0.98))
          drop-shadow(0 0 4px rgba(120, 175, 255, 0.85));
}
`;

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
  /** Pre-merged rich segments (plain runs + annotated chars with
      optional over-ruby reading + optional under-ruby variant form).
      Built in CaptionOverlay via buildRichSegments() — keeps LayerEl
      a dumb renderer. */
  segments: RichSegment[];
  color: string;
  /** 0–100; written into the rgba alpha of the base text. */
  alpha: number;
  /** 8-direction text-shadow outline (emulates ASS outline thickness).
      Its alpha is multiplied by the layer's master opacity (see
      buildTextShadow) so the outline fades WITH the text. */
  outlineColor: string;
  /** 0–100. */
  outlineAlpha: number;
  /** Glow halo radius in CSS px @ 1080-scale.  0 = no glow. */
  glowRadius: number;
  glowColor: string;
  /** 0–100. */
  glowAlpha: number;
  fontSizePx: number;
  /** CSS font-family value, or the "auto" sentinel which resolves to
      DEFAULT_FONT_STACK at render time. */
  fontFamily: string;
  /** Reading-to-base font ratio (only used when any segment has a
      reading or variantForm). */
  annotationRatio: number;
  /** Color of the over-ruby <rt> (phonetic reading). */
  annotationColor: string;
  /** Font family of the over-ruby <rt>.  null/auto → inherit. */
  annotationFontFamily: string | null;
  /** Full-utterance phonetic line (5e — the 4th caption layer).
      Rendered ABOVE the AnnotatedText block inside this layer, sized
      relative to the base via `romanizationRatio`.  null when the
      user has disabled romanization for this side OR no map entry
      exists for this event text yet. */
  romanizationLine: string | null;
  romanizationRatio: number;
  romanizationColor: string;
  /** 0–100 opacity for the romanization line.  Resolved by the overlay
      from the Top-group link state (follows the base alpha when linked,
      its own when unlinked). */
  romanizationAlpha: number;
  romanizationFontFamily: string | null;
  /** Color of the under-ruby <rt> (alternate-orthography variant). */
  variantColor: string;
  /** Font family of the under-ruby <rt>.  null/auto → inherit. */
  variantFontFamily: string | null;
  /** Whether tier-A/B base-char highlighting is applied. */
  variantHighlightEnabled: boolean;
  variantCleanHighlightColor: string;
  variantCollapseHighlightColor: string;
  /** Word-level vocab-lookup wiring (VOCAB_LOOKUP.md Phase 2).  Set only
      on the TARGET layer, and only when the video is paused.  null/false
      leave the layer non-interactive (the native layer never sets them). */
  tokens?: import("@/lib/annotate/types").AnnotateToken[] | null;
  interactive?: boolean;
  onWordClick?: (
    word: string,
    lemma: string,
    reading: string | null,
    rect: DOMRect,
  ) => void;
}

/** Return spans with every reading nulled when `strip` is true (per-character
 *  annotation toggle OFF) — so no ruby renders but the span structure (one
 *  segment per span) is preserved for per-word vocab grouping.  Pass-through
 *  when not stripping or spans are null. */
function stripReadingsIf(
  strip: boolean,
  spans: AnnotateSpan[] | null,
): AnnotateSpan[] | null {
  if (!strip || spans === null) return spans;
  return spans.map((s) => ({ ...s, reading: null }));
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
    targets,
    selectedTarget,
    selectedNative,
    topColor,
    bottomColor,
    annotationColor,
    topFontFamily,
    bottomFontFamily,
    annotationFontFamily,
    topFontSizePx,
    bottomFontSizePx,
    captionSizePct,
    topPositionOffsetPct,
    bottomPositionOffsetPct,
    lineSpacingPx,
    annotationFontRatio,
    targetPosition,
    nativePosition,
    targetAnnotateEnabled,
    targetAnnotateMap,
    nativeAnnotateMap,
    targetTokenMap,
    targetRomanizeMap,
    nativeRomanizeMap,
    romanizationFontFamily,
    romanizationFontRatio,
    romanizationColor,
    targetVariantEnabled,
    nativeVariantEnabled,
    variantHighlightEnabled,
    variantColor: variantColorRaw,
    variantCleanColor,
    variantCollapseColor,
    variantColorSameAsTop,
    topAlpha,
    bottomAlpha,
    annotationAlpha,
    topOutlineColor,
    bottomOutlineColor,
    annotationOutlineColor,
    topOutlineAlpha,
    bottomOutlineAlpha,
    annotationOutlineAlpha,
    topGlowRadius,
    bottomGlowRadius,
    annotationGlowRadius,
    topGlowColor,
    bottomGlowColor,
    annotationGlowColor,
    topGlowAlpha,
    bottomGlowAlpha,
    annotationGlowAlpha,
    romanizationAlpha,
    topGroupOpacityLinked,
    topLineEnabled,
    bottomLineEnabled,
  } = useCaptionStream();
  // Simplified auxiliary-ruby color: tracks the Top color by default so
  // the pair reads as one unit (C-3); falls back to its own color when
  // the user unchecks "same as Top".
  const variantColor = variantColorSameAsTop ? topColor : variantColorRaw;
  // Opacity model (C-5): the Top group (annotation + romanization +
  // alt-orth) follows topAlpha while linked (default); when unlinked the
  // annotation + romanization sub-lines take their own alpha.  The Bottom
  // side is always independent — its children follow bottomAlpha.
  const topAnnoAlpha = topGroupOpacityLinked ? topAlpha : annotationAlpha;
  const topRomanAlpha = topGroupOpacityLinked ? topAlpha : romanizationAlpha;
  void annotationOutlineColor;
  void annotationOutlineAlpha;
  void annotationGlowRadius;
  void annotationGlowColor;
  void annotationGlowAlpha;
  // Annotation rt inherits the parent layer's text-shadow + color via
  // CSS inheritance — explicit annotation-only overlay control would
  // need to apply per-rt style, deferred until a real user request.
  // Global "Subtitle size" knob folds into the player-scale so every
  // typography measurement (top / bottom / annotation / romanization) scales
  // uniformly.  100 = the tuned Prime-look defaults.
  const scale = usePlayerScale() * (captionSizePct / 100);

  // Per-word vocab lookup (VOCAB_LOOKUP.md Phase 2) — active only while
  // paused.  Hooks must run before any early return.
  const paused = usePaused();
  const [selectedWord, setSelectedWord] = useState<SelectedWord | null>(null);
  const targetLangCode = selectedTarget?.languageCode ?? null;
  const handleWordClick = useCallback(
    (word: string, lemma: string, reading: string | null, rect: DOMRect) => {
      setSelectedWord({ word, lemma, reading, rect, langCode: targetLangCode });
    },
    [targetLangCode],
  );
  // Clicking a word only makes sense while paused; drop any selection the
  // moment playback resumes (the card unmounts with it).
  useEffect(() => {
    if (!paused) setSelectedWord(null);
  }, [paused]);

  if (status.kind !== "tracking") return null;
  // Per-line master enable (C-8): a disabled line contributes no text, so
  // its whole layer — base + annotation + romanization + alt-orth — is
  // skipped, and its slot isn't reserved below.
  const topText = topLineEnabled ? (target?.text ?? "") : "";
  const bottomText = bottomLineEnabled ? (native?.text ?? "") : "";

  // Positioned EXTRA cues (substep 3): every active target cue that ISN'T
  // the horizontal primary AND carries source layout is drawn at its own
  // zone + orientation.  This INCLUDES the case where a vertical cue is the
  // ONLY thing on screen (primary is then null — a vertical cue is never
  // promoted to the horizontal main slot), so it stays vertical in place.
  // Cues without layout (YouTube / Netflix) never enter this list.
  const extraCues = topLineEnabled
    ? targets.filter(
        (e) => e !== target && e.layout && !isDefaultZone(e.layout),
      )
    : [];

  // Nothing to draw: no primary text, no native text, no positioned extras.
  if (!topText && !bottomText && extraCues.length === 0) return null;

  // Look up spans for the currently-active event text.  When the
  // annotation map is null (loading / disabled / not annotatable) OR
  // doesn't have an entry for this exact text, spans stays null and
  // buildRichSegments falls through to the table-walk or plain path.
  // Spans are fetched whenever the target lang is definable — even with the
  // per-character annotation toggle OFF — so per-word vocab lookup works
  // independently of ruby.  When the toggle is off, strip the readings so no
  // ruby renders while the span STRUCTURE (one segment per span) is preserved
  // for word grouping.  Alt-orthography (variantTable) is a separate toggle and
  // is unaffected — it renders from the variant table, not the reading.
  const targetSpans = stripReadingsIf(
    !targetAnnotateEnabled,
    topText ? (targetAnnotateMap?.get(topText.trim()) ?? null) : null,
  );
  const nativeSpans = bottomText
    ? (nativeAnnotateMap?.get(bottomText.trim()) ?? null)
    : null;

  // Word-level tokens for the target line (VOCAB_LOOKUP.md Phase 2) — same
  // trimmed-text key as the spans lookup.  Interactivity is gated on paused.
  const targetTokens = topText
    ? (targetTokenMap?.get(topText.trim()) ?? null)
    : null;
  const wordsInteractive = paused && !!targetTokens && targetTokens.length > 0;

  // Romanization line (5e) — same lookup pattern as annotation spans.
  // null when the map hasn't populated yet OR the event text has no
  // romanization (empty / oversized / no phonetic layer for the lang).
  const targetRomanizationLine = topText
    ? (targetRomanizeMap?.get(topText.trim()) ?? null)
    : null;
  const nativeRomanizationLine = bottomText
    ? (nativeRomanizeMap?.get(bottomText.trim()) ?? null)
    : null;

  // Resolve the orthography variant table for each layer, if any.
  // Data-driven gate: today only Traditional Chinese tracks resolve;
  // the resolver consults the registry from @loom/orthography-tables.
  // null when the user has the variant disabled for this layer OR the
  // track's lang has no registered variant table.
  const targetVariantTable = resolveVariantTable(
    selectedTarget?.languageCode ?? null,
    targetVariantEnabled,
  );
  const nativeVariantTable = resolveVariantTable(
    selectedNative?.languageCode ?? null,
    nativeVariantEnabled,
  );

  // Build the per-layer segment array up-front so LayerEl stays dumb.
  // Empty rawText short-circuits to [] inside buildRichSegments.
  const targetSegments = buildRichSegments({
    spans: targetSpans,
    rawText: topText,
    variantTable: targetVariantTable,
    // When words are interactive (paused), keep segments 1:1 with spans so
    // token start/length (span indices) wrap the correct glyphs — coalescing
    // adjacent plains would shift segment indices. See build-segments.ts.
    coalescePlain: !wordsInteractive,
  });
  const nativeSegments = buildRichSegments({
    spans: nativeSpans,
    rawText: bottomText,
    variantTable: nativeVariantTable,
  });

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
  // Only reserve a slot for a line that's enabled — a disabled line
  // leaves no gap.
  if (topLineEnabled) {
    slots[targetPosition].configured = true;
    slots[targetPosition].reservedFontSize = topFontSizePx;
    slots[targetPosition].reservedFontFamily = topFontFamily;
  }
  if (bottomLineEnabled) {
    slots[nativePosition].configured = true;
    slots[nativePosition].reservedFontSize = bottomFontSizePx;
    slots[nativePosition].reservedFontFamily = bottomFontFamily;
  }

  if (topText) {
    slots[targetPosition].layer = {
      segments: targetSegments,
      color: topColor,
      alpha: topAlpha,
      outlineColor: topOutlineColor,
      outlineAlpha: topOutlineAlpha,
      glowRadius: topGlowRadius,
      glowColor: topGlowColor,
      glowAlpha: topGlowAlpha,
      fontSizePx: topFontSizePx,
      fontFamily: topFontFamily,
      annotationRatio: annotationFontRatio,
      annotationColor: hexToRgba(annotationColor, topAnnoAlpha),
      annotationFontFamily,
      romanizationLine: targetRomanizationLine,
      romanizationRatio: romanizationFontRatio,
      romanizationColor,
      romanizationAlpha: topRomanAlpha,
      romanizationFontFamily,
      variantColor: hexToRgba(variantColor, topAnnoAlpha),
      variantFontFamily: null,
      variantHighlightEnabled,
      variantCleanHighlightColor: variantCleanColor,
      variantCollapseHighlightColor: variantCollapseColor,
      tokens: targetTokens,
      interactive: wordsInteractive,
      onWordClick: handleWordClick,
    };
  }
  if (bottomText) {
    slots[nativePosition].layer = {
      segments: nativeSegments,
      color: bottomColor,
      alpha: bottomAlpha,
      outlineColor: bottomOutlineColor,
      outlineAlpha: bottomOutlineAlpha,
      glowRadius: bottomGlowRadius,
      glowColor: bottomGlowColor,
      glowAlpha: bottomGlowAlpha,
      fontSizePx: bottomFontSizePx,
      fontFamily: bottomFontFamily,
      // Native annotations use the SAME ratio + color/family as the
      // target — the panel exposes one set of annotation controls
      // shared across both layers since native is rarely annotated.
      annotationRatio: annotationFontRatio,
      annotationColor: hexToRgba(annotationColor, bottomAlpha),
      annotationFontFamily,
      romanizationLine: nativeRomanizationLine,
      romanizationRatio: romanizationFontRatio,
      romanizationColor,
      romanizationAlpha: bottomAlpha,
      romanizationFontFamily,
      variantColor: hexToRgba(variantColor, bottomAlpha),
      variantFontFamily: null,
      variantHighlightEnabled,
      variantCleanHighlightColor: variantCleanColor,
      variantCollapseHighlightColor: variantCollapseColor,
    };
  }

  return (
    <>
      {wordsInteractive ? <style>{VOCAB_WORD_CSS}</style> : null}
      {renderZone("top", slots, scale, topPositionOffsetPct, lineSpacingPx)}
      {renderZone(
        "bottom",
        slots,
        scale,
        bottomPositionOffsetPct,
        lineSpacingPx,
      )}
      {extraCues.map((e) => (
        <PositionalCue
          key={`${e.start}-${e.end}-${e.layout?.regionId ?? ""}`}
          layout={e.layout!}
          segments={buildRichSegments({
            spans: stripReadingsIf(
              !targetAnnotateEnabled,
              targetAnnotateMap?.get(e.text.trim()) ?? null,
            ),
            rawText: e.text,
            variantTable: targetVariantTable,
          })}
          scale={scale}
          color={topColor}
          alpha={topAlpha}
          fontSizePx={topFontSizePx}
          fontFamily={topFontFamily}
          annotationRatio={annotationFontRatio}
          annotationColor={hexToRgba(annotationColor, topAnnoAlpha)}
          annotationFontFamily={annotationFontFamily}
          outlineColor={topOutlineColor}
          outlineAlpha={topOutlineAlpha}
          glowRadius={topGlowRadius}
          glowColor={topGlowColor}
          glowAlpha={topGlowAlpha}
        />
      ))}
      {paused && selectedWord ? (
        <DefinitionCard
          word={selectedWord.word}
          lemma={selectedWord.lemma}
          reading={selectedWord.reading}
          rect={selectedWord.rect}
          langCode={selectedWord.langCode}
          onDismiss={() => setSelectedWord(null)}
        />
      ) : null}
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
  offsetPct: number,
  lineSpacingPx: number,
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
    <div style={zoneStyle(zone, scale, offsetPct, lineSpacingPx)} key={zone}>
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
        fontFamily: resolveFontFamily(fontFamily),
        fontSize: `${fontSize * scale}px`,
        fontWeight: 500,
        textAlign: "center",
        lineHeight: 1.25,
        padding: `0 ${HORIZONTAL_PADDING_PX * scale}px`,
        maxWidth: "92%",
        visibility: "hidden",
      }}
      aria-hidden="true"
    >
      {" "}
    </div>
  );
}

function LayerEl({ scale, layer }: { scale: number; layer: Layer }) {
  return (
    <div style={layerStyle(layer, scale)}>
      {layer.romanizationLine ? (
        <RomanizationLine layer={layer} scale={scale} />
      ) : null}
      <AnnotatedText
        segments={layer.segments}
        baseFontPxScaled={layer.fontSizePx * scale}
        annotationRatio={layer.annotationRatio}
        color={layer.annotationColor}
        fontFamily={normalizeFontFamily(layer.annotationFontFamily)}
        variantColor={layer.variantColor}
        variantFontFamily={normalizeFontFamily(layer.variantFontFamily)}
        highlightEnabled={layer.variantHighlightEnabled}
        cleanHighlightColor={layer.variantCleanHighlightColor}
        collapseHighlightColor={layer.variantCollapseHighlightColor}
        tokens={layer.tokens}
        interactive={layer.interactive}
        onWordClick={layer.onWordClick}
      />
    </div>
  );
}

/** The 4th caption layer (5e — secondary phonetic line).  Renders
    above the AnnotatedText block inside its parent layer.  Inherits
    the parent layer's text-shadow + outline via CSS (the .layer div
    sets text-shadow on the whole subtree); only color, font-size,
    and font-family override the inherited values. */
function RomanizationLine({ layer, scale }: { layer: Layer; scale: number }) {
  const fontPx = layer.fontSizePx * layer.romanizationRatio * scale;
  // Romanization opacity is resolved by the overlay (C-5): it follows the
  // base alpha while the Top group is linked, or its own when unlinked.
  const color = hexToRgba(layer.romanizationColor, layer.romanizationAlpha);
  return (
    <div
      style={{
        fontFamily: layer.romanizationFontFamily
          ? resolveFontFamily(layer.romanizationFontFamily)
          : "inherit",
        fontSize: `${fontPx}px`,
        lineHeight: 1.15,
        color,
        // text-shadow inherits via CSS from the .layer style — the
        // 4-corner outline + drop-shadow apply to this child too,
        // matching how AnnotatedText's <rt> picks up the same shadow.
      }}
    >
      {layer.romanizationLine}
    </div>
  );
}

/** Map "auto" / null / "" → null (the AnnotatedText "inherit from parent
    layer" sentinel).  Any other CSS family value passes through. */
function normalizeFontFamily(family: string | null): string | null {
  if (!family || family === FONT_FAMILY_AUTO) return null;
  return family;
}

/** Returns the variant table for `langCode` when the user has the
    variant enabled for this layer, else null.  Today only Traditional
    Chinese lang codes resolve.  See @loom/orthography-tables registry. */
function resolveVariantTable(
  langCode: string | null,
  enabled: boolean,
): OrthographyTable | null {
  if (!enabled || !langCode) return null;
  const variants = resolveOrthographyVariants(langCode);
  return variants[0]?.table ?? null;
}

/** A concurrently-active cue drawn at its OWN source position + writing
    orientation (vertical Japanese with right-side furigana; a positioned
    horizontal description at mid/top).  Ambient-light: foreign text +
    furigana (via AnnotatedText) with the layer outline for legibility, no
    romanization line, no native pairing.  Absolutely positioned within the
    overlay root (which fills the player), so the coarse zone maps straight
    to the frame. */
function PositionalCue({
  layout,
  segments,
  scale,
  color,
  alpha,
  fontSizePx,
  fontFamily,
  annotationRatio,
  annotationColor,
  annotationFontFamily,
  outlineColor,
  outlineAlpha,
  glowRadius,
  glowColor,
  glowAlpha,
}: {
  layout: CueLayout;
  segments: RichSegment[];
  scale: number;
  color: string;
  alpha: number;
  fontSizePx: number;
  fontFamily: string;
  annotationRatio: number;
  annotationColor: string;
  annotationFontFamily: string | null;
  outlineColor: string;
  outlineAlpha: number;
  glowRadius: number;
  glowColor: string;
  glowAlpha: number;
}) {
  const vertical = layout.writingMode !== "horizontal";
  const shadow = buildTextShadow(
    { alpha, outlineColor, outlineAlpha, glowRadius, glowColor, glowAlpha },
    scale,
  );
  const style: React.CSSProperties = {
    ...zoneAnchor(layout),
    fontFamily: resolveFontFamily(fontFamily),
    fontSize: `${fontSizePx * scale}px`,
    fontWeight: 500,
    color: hexToRgba(color, alpha),
    lineHeight: 1.25,
    textShadow: shadow,
    pointerEvents: "none",
    unicodeBidi: "isolate",
    // Vertical column caps at the frame height; horizontal cue caps at a
    // fraction of the width so a positioned line doesn't span edge-to-edge.
    ...(vertical
      ? {
          writingMode: layout.writingMode as "vertical-rl" | "vertical-lr",
          maxHeight: "84%",
        }
      : {
          maxWidth: "44%",
          textAlign:
            layout.textAlign === "start"
              ? "start"
              : layout.textAlign === "end"
                ? "end"
                : "center",
          whiteSpace: "pre-wrap",
        }),
  };
  return (
    <div style={style}>
      <AnnotatedText
        segments={segments}
        baseFontPxScaled={fontSizePx * scale}
        annotationRatio={annotationRatio}
        color={annotationColor}
        fontFamily={normalizeFontFamily(annotationFontFamily)}
        variantColor={annotationColor}
        variantFontFamily={null}
        highlightEnabled={false}
        cleanHighlightColor={annotationColor}
        collapseHighlightColor={annotationColor}
      />
    </div>
  );
}

/** Map a cue's coarse zone (block × inline) to absolute-position CSS within
    the overlay root.  Uses the precise `origin` fraction when the source
    region carried one, else snaps to the zone's edge/center.  A single
    compositor promotion (translateZ) is folded into the centering
    transform. */
function zoneAnchor(layout: CueLayout): React.CSSProperties {
  const s: React.CSSProperties = {
    position: "absolute",
    transform: "translateZ(0)",
  };
  const tx: string[] = [];

  // Precise placement when the source region defined tts:origin.
  if (layout.origin) {
    s.left = `${clampPct(layout.origin.x * 100)}%`;
    s.top = `${clampPct(layout.origin.y * 100)}%`;
    tx.push("translateZ(0)");
    s.transform = tx.join(" ");
    return s;
  }

  // Coarse zone placement.
  if (layout.inline === "left") s.left = `${ZONE_INSET_PCT / 2}%`;
  else if (layout.inline === "right") s.right = `${ZONE_INSET_PCT / 2}%`;
  else {
    s.left = "50%";
    tx.push("translateX(-50%)");
  }
  if (layout.block === "top") s.top = `${ZONE_INSET_PCT}%`;
  else if (layout.block === "bottom") s.bottom = `${ZONE_INSET_PCT}%`;
  else {
    s.top = "50%";
    tx.push("translateY(-50%)");
  }
  tx.push("translateZ(0)");
  s.transform = tx.join(" ");
  return s;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** A layout that resolves to the ordinary bottom-center horizontal spot —
    i.e. the main slot's position.  Such a cue must NOT render as a positional
    extra (it would overlap the primary dual-subs stack).  Netflix already
    drops layout for these at parse time; this also covers Prime, whose
    bottom cues carry an explicit {horizontal,bottom,center} region. */
function isDefaultZone(layout: CueLayout): boolean {
  return (
    layout.writingMode === "horizontal" &&
    layout.block === "bottom" &&
    layout.inline === "center"
  );
}

function zoneStyle(
  zone: "top" | "bottom",
  scale: number,
  offsetPct: number,
  lineSpacingPx: number,
): React.CSSProperties {
  // Top zone anchored at top: 8% — first child sits there, second
  // child stacks below.  Bottom zone anchored at bottom: 8% — first
  // child sits at the top of the zone, second child at the bottom
  // (touching the 8% anchor).  Both use flex-column with the JSX in
  // [slot-1, slot-2] order, which yields slot-1-above-slot-2 visually
  // in both zones.
  //
  // `offsetPct` (user "vertical nudge", % of player height) is ADDED to
  // the anchor inset: positive grows the inset, moving the zone away from
  // its edge = toward the picture center for BOTH zones (down for top, up
  // for bottom).  `lineSpacingPx` overrides the inter-line gap.  Clamp the
  // resulting inset ≥ 0 so a large negative nudge can't push it off-screen.
  const inset = Math.max(0, ZONE_INSET_PCT + offsetPct);
  const base: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: `${lineSpacingPx * scale}px`,
    pointerEvents: "none",
    // Per-zone compositor layer.  YT's overlay-host promotion already
    // isolates us from YT's repaints, but explicit translateZ on each
    // zone keeps in-zone text changes (every dialogue boundary) from
    // re-painting the rest of our shadow tree.
    transform: "translateZ(0)",
  };
  if (zone === "top") {
    return { ...base, top: `${inset}%` };
  }
  return { ...base, bottom: `${inset}%` };
}

function layerStyle(layer: Layer, scale: number): React.CSSProperties {
  return {
    fontFamily: resolveFontFamily(layer.fontFamily),
    fontSize: `${layer.fontSizePx * scale}px`,
    fontWeight: 500,
    color: hexToRgba(layer.color, layer.alpha),
    textAlign: "center",
    whiteSpace: "pre-wrap",
    padding: `0 ${HORIZONTAL_PADDING_PX * scale}px`,
    lineHeight: 1.25,
    unicodeBidi: "isolate",
    // 8-direction offset shadows emulate the ASS outline; a trailing
    // offset shadow emulates the ASS drop-shadow; an optional `0 0 Npx`
    // halo is the glow.  See buildTextShadow for the full rationale.
    // NOTE: this INTENTIONALLY diverges from apps/web/lib/raster/
    // build-html.ts::textShadowCss (which is corners-only + independent
    // outline alpha).  The web path rasterizes to PGS and needs pixel
    // parity with the desktop reference; this live-HTML overlay does not,
    // so it uses a smoother 8-way ring and couples outline/glow opacity
    // to the line's master opacity.  Don't "resync" them.
    textShadow: buildTextShadow(layer, scale),
    maxWidth: "92%",
  };
}

/** The subset of a layer's style buildTextShadow needs — so positioned
    extra cues (which aren't full Layers) can reuse the same outline ring. */
interface ShadowSpec {
  alpha: number;
  outlineColor: string;
  outlineAlpha: number;
  glowRadius: number;
  glowColor: string;
  glowAlpha: number;
}

function buildTextShadow(layer: ShadowSpec, scale: number): string {
  const d = OUTLINE_PX * scale;
  const s = SHADOW_OFFSET_PX * scale;
  // Master line opacity fades the outline + shadow + glow ALONG WITH the
  // text fill, so lowering a line's opacity dims the whole layer as one
  // unit instead of just hollowing out the fill and leaving the outline
  // ring floating at full strength.  (`layer.alpha` is the same 0–100
  // the fill color uses in layerStyle.)
  const masterA = Math.max(0, Math.min(100, layer.alpha)) / 100;
  const outlineRgba = hexToRgba(
    layer.outlineColor,
    layer.outlineAlpha * masterA,
  );
  // Shadow stays hard-coded black — the desktop's StyleConfig splits
  // shadow_color from outline_color, but the extension hasn't surfaced
  // shadow color separately yet.  Acceptable: shadow is the dimmer
  // drop-stroke; outline is the visible-stroke users pick a color for.
  const shadowRgba = `rgba(0, 0, 0, ${0.7 * masterA})`;
  // 8-direction ring (4 cardinals + 4 corners) instead of corners-only.
  // The old 4-corner set thickened the outline at the diagonals and left
  // the top/bottom/left/right edges bare, producing an uneven, layered
  // "stylised"/chrome look.  Sampling all 8 directions at one radius
  // gives a smooth, even stroke that reads as a single outline.
  const parts = [
    `${d}px 0 0 ${outlineRgba}`,
    `-${d}px 0 0 ${outlineRgba}`,
    `0 ${d}px 0 ${outlineRgba}`,
    `0 -${d}px 0 ${outlineRgba}`,
    `${d}px ${d}px 0 ${outlineRgba}`,
    `-${d}px -${d}px 0 ${outlineRgba}`,
    `${d}px -${d}px 0 ${outlineRgba}`,
    `-${d}px ${d}px 0 ${outlineRgba}`,
    `${s}px ${s}px 0 ${shadowRgba}`,
  ];
  if (layer.glowRadius > 0 && layer.glowAlpha > 0) {
    const r = layer.glowRadius * scale;
    const glowRgba = hexToRgba(layer.glowColor, layer.glowAlpha * masterA);
    // Glow goes LAST so it composites on top of the outline ring,
    // matching the desktop's PGS glow blur behavior.
    parts.push(`0 0 ${r}px ${glowRgba}`);
  }
  return parts.join(", ");
}

/** Convert "#RRGGBB" + alpha-percent → "rgba(r,g,b,a)".  Falls back to
    the input string on parse failure (callers can still pass named
    colors like "transparent" — the rgba conversion is skipped). */
function hexToRgba(hex: string, alphaPct: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const a = Math.max(0, Math.min(100, alphaPct)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
