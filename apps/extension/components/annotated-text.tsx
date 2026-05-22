import type { RichSegment } from "@/lib/orthography/types";

// Renders one layer of caption text as a flow of segments.
//
// Each segment is either a plain run (no ruby) or an annotated single
// token with optional over-ruby (phonetic reading) and/or under-ruby
// (alternate-orthography form).
//
// DOUBLE-SIDED RUBY — CROSS-BROWSER NESTED-RUBY PATTERN.
//
// Per-<rt> `ruby-position` is in the CSS Ruby spec but is broken in
// Firefox when two <rt> children share one <ruby>: both <rt>'s get
// stacked on the same side regardless of their individual
// ruby-position values.  Chrome behaves similarly in older versions.
//
// Workaround that works on Firefox MV2 + Chromium today: NEST the
// rubies.  The OUTER <ruby> carries the under-rt; its base is the
// INNER <ruby>, which carries its own (default-over) rt for the
// phonetic reading.  Each <ruby> has exactly one <rt>, so the per-rt
// position is unambiguous.
//
//   <ruby>                          <!-- outer: provides under-rt -->
//     <ruby>                        <!-- inner: provides over-rt  -->
//       {base}
//       <rt>{reading}</rt>          <!-- default over             -->
//     </ruby>
//     <rt style="ruby-position: under">{variantForm}</rt>
//   </ruby>
//
// Single-side cases use a plain <ruby> with one <rt> (no nesting).
//
// Vertical gap on the under-rt is via `transform: translateY()`, not
// margin — Chromium's ruby box model breaks margins on <rt>; the
// desktop's annotation_gap uses translateY for the same reason on
// the over side.  See CLAUDE.md Style System note.
//
// Highlight tiers re-color the BASE glyph when the segment is in the
// orthography table:
//   - "clean" → cleanHighlightColor (default cyan: 1:1 mapping).
//   - "collapse" → collapseHighlightColor (default amber: forward-
//     collapse merge case, identity hidden in simplification).
// Highlight is suppressed when highlightEnabled is false OR when the
// segment has no variantForm.

interface AnnotatedTextProps {
  segments: RichSegment[];
  /** Base layer font size in CSS px (already scaled by usePlayerScale). */
  baseFontPxScaled: number;
  /** Ratio of reading font to base font (0.2–1.0). */
  annotationRatio: number;
  /** Color applied to the over-ruby <rt> (phonetic reading). */
  color: string;
  /** CSS font-family for the over-ruby <rt>.  When null, inherits. */
  fontFamily: string | null;
  /** Color applied to the under-ruby <rt> (orthography variant). */
  variantColor: string;
  /** CSS font-family for the under-ruby <rt>.  When null, inherits. */
  variantFontFamily: string | null;
  /** When false, all `highlightTier` values render as default text
   *  color — only the under-rt is added.  Lets the user keep the
   *  under-ruby line visible without colorising the base text. */
  highlightEnabled: boolean;
  /** Base-text color for clean-tier highlighted segments. */
  cleanHighlightColor: string;
  /** Base-text color for collapse-tier highlighted segments. */
  collapseHighlightColor: string;
  /** Downward translate for the under-rt — keeps space between the
   *  rt baseline and whatever sits below the layer (other slot in
   *  the same zone, or YT chrome).  In CSS px @ scale. */
  underRtTranslateYPx?: number;
}

export function AnnotatedText({
  segments,
  baseFontPxScaled,
  annotationRatio,
  color,
  fontFamily,
  variantColor,
  variantFontFamily,
  highlightEnabled,
  cleanHighlightColor,
  collapseHighlightColor,
  underRtTranslateYPx = 2,
}: AnnotatedTextProps) {
  const rtFontPx = baseFontPxScaled * annotationRatio;
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        const baseColor =
          highlightEnabled && seg.variantForm
            ? seg.highlightTier === "collapse"
              ? collapseHighlightColor
              : seg.highlightTier === "clean"
                ? cleanHighlightColor
                : undefined
            : undefined;
        const baseEl = baseColor ? (
          <span style={{ color: baseColor }}>{seg.base}</span>
        ) : (
          <>{seg.base}</>
        );

        // Three structural cases — picked deliberately to keep every
        // <ruby> at single-rt for cross-browser ruby-position reliability.
        //
        //   1. reading only            → flat <ruby>{base}<rt over/></ruby>
        //   2. variantForm only        → flat <ruby>{base}<rt under/></ruby>
        //   3. both                    → nested: outer ruby holds under-rt,
        //                                inner ruby holds base + over-rt.
        const overRt = seg.reading ? (
          <rt style={overRtStyle(rtFontPx, color, fontFamily)}>
            {seg.reading}
          </rt>
        ) : null;
        const underRt = seg.variantForm ? (
          <rt
            style={underRtStyle(
              rtFontPx,
              variantColor,
              variantFontFamily,
              underRtTranslateYPx,
            )}
          >
            {seg.variantForm}
          </rt>
        ) : null;

        if (overRt && underRt) {
          return (
            <ruby key={i}>
              <ruby>
                {baseEl}
                {overRt}
              </ruby>
              {underRt}
            </ruby>
          );
        }
        if (overRt) {
          return (
            <ruby key={i}>
              {baseEl}
              {overRt}
            </ruby>
          );
        }
        if (underRt) {
          return (
            <ruby key={i}>
              {baseEl}
              {underRt}
            </ruby>
          );
        }
        // No annotation work after all — render the base as a plain
        // span (preserves the highlight color if applied).
        return <span key={i}>{baseEl}</span>;
      })}
    </>
  );
}

function overRtStyle(
  fontPx: number,
  color: string,
  fontFamily: string | null,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: `${fontPx}px`,
    color,
    letterSpacing: "0.02em",
    fontWeight: 500,
    rubyPosition: "over",
  };
  if (fontFamily) base.fontFamily = fontFamily;
  return base;
}

function underRtStyle(
  fontPx: number,
  color: string,
  fontFamily: string | null,
  translateYPx: number,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: `${fontPx}px`,
    color,
    letterSpacing: "0.02em",
    fontWeight: 500,
    rubyPosition: "under",
    transform: `translateY(${translateYPx}px)`,
  };
  if (fontFamily) base.fontFamily = fontFamily;
  return base;
}
