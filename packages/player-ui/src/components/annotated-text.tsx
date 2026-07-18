import type { RichSegment } from "../orthography/types";
import type { AnnotateToken } from "../annotate/types";
import { planWordGroups } from "../annotate/group-segments";
import {
  stopToPlayer,
  swallowPlayerEventsExceptClick,
} from "../overlay/stop-player-events";

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
// rubies.  Each <ruby> has exactly one <rt>, so the per-rt position
// is unambiguous from the browser's perspective.
//
//   <ruby>                          <!-- outer: variantForm rt    -->
//     <ruby>                        <!-- inner: reading rt        -->
//       {base}
//       <rt>{reading}</rt>          <!-- default over             -->
//     </ruby>
//     <rt style="ruby-position: under">{variantForm}</rt>
//   </ruby>
//
// OBSERVED RENDERED ORDER on Firefox MV2 (2026-05-23):
//
//     variantForm       ← outer rt, visually at the TOP
//     reading           ← inner rt, above the inner base
//     {base}            ← the Traditional char
//
// I.e. Firefox renders the outer rt ABOVE the inner ruby block
// regardless of its `ruby-position: under` style — the per-rt
// position is honoured for FLAT single-rt rubies (the panel preview
// component is one) but inverted/ignored when an rt sits at the
// outer level of a nested ruby.  We're keeping the result as a
// happy accident: the auxiliary Simplified form floats at the top
// where it reads as supplementary info, while the Traditional
// stays in its natural reading position with Pinyin annotating it
// directly above.  Pedagogically nicer than the original spec
// intent of "Simplified below the Traditional."
//
// Single-side cases use a flat <ruby> with one <rt> (no nesting).
// In those cases `ruby-position: under` IS honoured by Firefox,
// which is why the panel preview correctly shows Simplified below
// the Traditional — that preview uses single-rt rubies, not
// nested.  Don't be confused if you tweak the preview and see
// different behaviour from the live overlay.
//
// Vertical gap on the rt is via `transform: translateY()`, not
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
  /** Extra UPWARD gap (CSS px @ scale) between the over-rt (furigana /
   *  pinyin annotation) and its base token — the user "Annotation spacing"
   *  control.  0 = the browser's default ruby gap. */
  overRtTranslateYPx?: number;
  /** Word-level tokens for this line (VOCAB_LOOKUP.md Phase 2).  When
   *  `interactive` and present, each token's run of segments
   *  (`start..start+length`) is wrapped in a clickable word element.
   *  null/absent → flat rendering, identical to before. */
  tokens?: AnnotateToken[] | null;
  /** Enable per-word hover/click (gated on the video being PAUSED).
   *  When false, renders exactly as before — no wrappers, no handlers,
   *  no pointer-events — so playback is untouched. */
  interactive?: boolean;
  /** Called with the clicked word, its dictionary lemma (for /define), its
   *  contextual reading (JA; null → card uses the dictionary reading), and
   *  the word element's bounding rect (for positioning the card). */
  onWordClick?: (
    word: string,
    lemma: string,
    reading: string | null,
    rect: DOMRect,
  ) => void;
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
  overRtTranslateYPx = 0,
  tokens = null,
  interactive = false,
  onWordClick,
}: AnnotatedTextProps) {
  const rtFontPx = baseFontPxScaled * annotationRatio;
  const els = segments.map((seg, i): React.ReactNode => {
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
      <rt style={overRtStyle(rtFontPx, color, fontFamily, overRtTranslateYPx)}>
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
  });

  // Word-level grouping for per-word vocab lookup (VOCAB_LOOKUP.md Phase 2).
  // Only when interactive (video PAUSED) AND tokens are present — otherwise
  // render the flat segment flow exactly as before (zero playback-time
  // change: no wrappers, no pointer-events, no handlers).
  if (!interactive || !tokens || tokens.length === 0) {
    return <>{els}</>;
  }
  const out = planWordGroups(els.length, tokens).map((run) => {
    if (run.kind === "loose") return els[run.index];
    const tok = run.token;
    return (
      <span
        key={`w${run.start}`}
        className="loom-vocab-word"
        style={{ pointerEvents: "auto", cursor: "pointer" }}
        {...swallowPlayerEventsExceptClick}
        onClick={(e) => {
          stopToPlayer(e);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onWordClick?.(
            tok.word,
            tok.lemma ?? tok.word,
            tok.reading ?? null,
            rect,
          );
        }}
      >
        {els.slice(run.start, run.start + run.length)}
      </span>
    );
  });
  return <>{out}</>;
}

function overRtStyle(
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
    rubyPosition: "over",
  };
  // Negative = up, away from the token → a bigger furigana↔token gap.
  if (translateYPx) base.transform = `translateY(${-translateYPx}px)`;
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
