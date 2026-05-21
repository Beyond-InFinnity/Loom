import type { AnnotateSpan } from "@/lib/annotate/types";

// Renders an annotated caption line as a flow of <ruby> elements
// (with <rt> readings) interspersed with plain <span> elements for
// tokens that don't need annotation (punctuation, hiragana on its
// own in a Japanese sentence, Latin letters embedded in Chinese, etc.).
//
// Uses the browser-native <ruby>/<rt> rendering — no custom CSS for
// positioning, the browser puts the rt above the base.  The rt's
// font-size is set inline as a fraction of the base font (CJK = 0.5,
// alphabetic = 0.4, matching loom_core/styles.py::annotation_font_ratio).
//
// Color of the ruby reading matches the base text by default — saves
// the user from a separate color picker.  If we ever want a distinct
// ruby color, add an `annotationColor` prop and feed it from settings.

interface AnnotatedTextProps {
  spans: AnnotateSpan[];
  /** Base layer font size in CSS px (already scaled by usePlayerScale). */
  baseFontPxScaled: number;
  /** Ratio of reading font to base font — 0.5 for CJK, 0.4 for ko/etc. */
  annotationRatio: number;
  /** Color applied to the <rt> reading (matches base by default). */
  color: string;
}

export function AnnotatedText({
  spans,
  baseFontPxScaled,
  annotationRatio,
  color,
}: AnnotatedTextProps) {
  const rtFontPx = baseFontPxScaled * annotationRatio;
  return (
    <>
      {spans.map((span, i) => {
        if (span.reading) {
          return (
            <ruby key={i}>
              {span.base}
              <rt style={rtStyle(rtFontPx, color)}>{span.reading}</rt>
            </ruby>
          );
        }
        return <span key={i}>{span.base}</span>;
      })}
    </>
  );
}

function rtStyle(fontPx: number, color: string): React.CSSProperties {
  return {
    fontSize: `${fontPx}px`,
    color,
    // Slight letter-spacing on small ruby text for legibility over
    // varied video backgrounds.
    letterSpacing: "0.02em",
    // <rt> inherits font-weight from the parent; ensure consistent
    // weight even if the parent's was changed.
    fontWeight: 500,
  };
}
