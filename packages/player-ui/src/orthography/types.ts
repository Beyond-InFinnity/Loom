// RichSegment — unified per-render-segment data shape.
//
// Each segment is either:
//   - "plain": a run of text with no over- and no under-ruby
//   - "annotated": exactly one base token (typically one codepoint for
//     Chinese, sometimes a kanji compound for Japanese), with optional
//     over-ruby (phonetic reading from /annotate) and optional
//     under-ruby (alternate-orthography form from the variant table).
//
// `buildRichSegments` produces these from the upstream inputs (annotate
// spans + raw event text + variant table).  The renderer in
// annotated-text.tsx is then a dumb walk of this array.
//
// `highlightTier` reflects the three-tier rule:
//   - "none":     not in the variant table (absent → no styling)
//   - "clean":    in the table with empty `collapse` (1:1 mapping)
//   - "collapse": in the table with non-empty `collapse` (forward-collapse
//                 merge case — reader of the target orthography could not
//                 have uniquely recovered this character)

export interface PlainSegment {
  kind: "plain";
  text: string;
}

export interface AnnotatedSegment {
  kind: "annotated";
  base: string;
  /** Over-ruby reading from /annotate, or null. */
  reading: string | null;
  /** Under-ruby alternate-orthography form, or null. */
  variantForm: string | null;
  /** Tier for the BASE character's highlight color.  Only meaningful
   * when variantForm is non-null; the renderer ignores tier when
   * variantForm is null (a char with reading-only stays uncoloured). */
  highlightTier: "none" | "clean" | "collapse";
}

export type RichSegment = PlainSegment | AnnotatedSegment;
