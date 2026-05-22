import type { RichSegment } from "@/lib/orthography/types";

// Renders one layer of caption text as a flow of segments.
//
// Each segment is either a plain run (no ruby) or an annotated single
// token with optional over-ruby (phonetic reading) and/or under-ruby
// (alternate-orthography form).  The double-sided <ruby> case puts
// `ruby-position: over` on the reading <rt> and `ruby-position: under`
// on the variant <rt>; Chromium and Firefox both handle this correctly.
//
// Vertical gap on the under-rt is via `transform: translateY()` — never
// margin.  Chromium's ruby box model breaks margins on <rt> in subtle
// ways; the desktop's annotation_gap uses translateY for the same
// reason on the over side.  See CLAUDE.md Style System note.
//
// Highlight tiers re-color the BASE glyph when the segment is in the
// orthography table:
//   - "clean" → cleanHighlightColor (default cyan: 1:1 mapping, the
//     reader of the target orthography could uniquely recover this).
//   - "collapse" → collapseHighlightColor (default amber: forward-
//     collapse merge case, identity is hidden in simplification).
// Highlight is suppressed entirely when highlightEnabled is false, OR
// when the segment has no variantForm (reading-only annotated chars
// stay at their normal color).

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
          seg.base
        );
        return (
          <ruby key={i}>
            {baseEl}
            {seg.reading && (
              <rt style={overRtStyle(rtFontPx, color, fontFamily)}>
                {seg.reading}
              </rt>
            )}
            {seg.variantForm && (
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
            )}
          </ruby>
        );
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
