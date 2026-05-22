import type { AnnotateSpan } from "@/lib/annotate/types";

// Renders an annotated caption line as a flow of <ruby> elements
// (with <rt> readings) interspersed with plain <span> elements for
// tokens that don't need annotation (punctuation, hiragana on its
// own in a Japanese sentence, Latin letters embedded in Chinese, etc.).
//
// Uses the browser-native <ruby>/<rt> rendering — no custom CSS for
// positioning, the browser puts the rt above the base.  The rt's
// font-size is set inline as a fraction of the base font; the user's
// annotationFontRatio from caption-context drives the actual value
// (default 0.5, matches loom_core/styles.py::annotation_font_ratio).
//
// Color and fontFamily are passed in from caption-overlay, which
// reads them from the user's per-layer style settings.  Color
// defaults to the base text's color; fontFamily defaults to "inherit"
// (which falls back to the parent layer's CSS).

interface AnnotatedTextProps {
  spans: AnnotateSpan[];
  /** Base layer font size in CSS px (already scaled by usePlayerScale). */
  baseFontPxScaled: number;
  /** Ratio of reading font to base font (0.2–1.0). */
  annotationRatio: number;
  /** Color applied to the <rt> reading.  Pass the base layer's color
      for traditional ruby; pass a distinct value to give annotations
      a different hue (e.g., yellow furigana over white kanji). */
  color: string;
  /** CSS font-family for the <rt>.  When null, the <rt> inherits
      whatever font the parent <ruby> / surrounding layer is using
      (the base text's font). */
  fontFamily: string | null;
}

export function AnnotatedText({
  spans,
  baseFontPxScaled,
  annotationRatio,
  color,
  fontFamily,
}: AnnotatedTextProps) {
  const rtFontPx = baseFontPxScaled * annotationRatio;
  return (
    <>
      {spans.map((span, i) => {
        if (span.reading) {
          return (
            <ruby key={i}>
              {span.base}
              <rt style={rtStyle(rtFontPx, color, fontFamily)}>
                {span.reading}
              </rt>
            </ruby>
          );
        }
        return <span key={i}>{span.base}</span>;
      })}
    </>
  );
}

function rtStyle(
  fontPx: number,
  color: string,
  fontFamily: string | null,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: `${fontPx}px`,
    color,
    // Slight letter-spacing on small ruby text for legibility over
    // varied video backgrounds.
    letterSpacing: "0.02em",
    // <rt> inherits font-weight from the parent; ensure consistent
    // weight even if the parent's was changed.
    fontWeight: 500,
  };
  if (fontFamily) {
    base.fontFamily = fontFamily;
  }
  return base;
}
