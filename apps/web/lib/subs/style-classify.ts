// Port of loom_core/subs/processing.py style classification:
//   detect_ass_styles, _iter_dialogue_events, _strip_animation_tags
//
// Why this matters — Frieren and similar fansub releases pack four kinds
// of events into one ASS track:
//
//   1. Dialogue lines (the readable subtitle, "Default" / "Dialogue" style)
//   2. Sign translations (background text overlays — "Sign", "Caption", etc)
//   3. OP/ED karaoke (animated lyric layers with kfx timing tags)
//   4. Typesetting / chapter cards / logos (decorative shapes via \p1 paths)
//
// Without classification, the web app's romanize fan-out fires /romanize
// on every event — generating garbage phonetic readings on the karaoke
// (already romanized!), the signs (already in the user's language), and
// the typesetting paths (vector shapes with no readable text).  Plus
// each unwanted event becomes its own bitmap frame in the .sup output.
//
// This port keeps the priority order from the Python:
//   1. Names matching _PRESERVE_PATTERNS  → "preserve" (final)
//   2. Literal "Dialogue" / "Default"     → "dialogue"
//   3. 0-event styles                     → "exclude"
//   4. Anything else                      → "dialogue" (best-guess)
//
// _EXCLUDE_PATTERNS is reserved for future use — currently always None on
// the Python side, so we leave the slot open here too.

import type { SSAFile } from "./ssa";
import type { SSAEvent } from "./types";

// Style-name patterns that signal a non-dialogue role.  Same regex as
// loom_core/subs/processing.py to keep the classification consistent
// across desktop + web.  Word-boundary anchors on \bop\b / \bed\b
// prevent "stop" / "wedding" from matching.
//
// Last group (staff / comment / note / eyecatch / credit / preview) covers
// decorative non-dialogue styles common in fansub releases.  Real-world
// example: DBD-Raws Frieren has a "Staff" style holding a single
// animated typesetter signature (translator/editor/timer credits) that
// would otherwise get fanned out to /romanize and emit garbage romaji.
// `\bcomment\b` and `\bnote\b` use word boundaries so "default-with-
// commentary" or "footnote_styling" don't false-match.
const PRESERVE_PATTERNS = new RegExp(
  "sign|screen|title|card|caption|typeset|logo|insert"
    + "|song|lyric|karaoke|kfx|opening|ending"
    + "|\\bop\\b|op_|_op|\\bed\\b|ed_|_ed"
    + "|staff|\\bcomment\\b|\\bnote\\b|eyecatch|credit|preview",
  "i",
);

// Literal style names that indicate dialogue regardless of event count.
// Most ASS files use "Default"; some fansubs use "Dialogue" explicitly.
const DIALOGUE_NAME_RE = /^(?:dialogue|default)$/i;

// Vector-path drawings (\p1, \p2, \p3, \p4 — drawing-mode level).
// These events carry shape commands instead of text.  Always excluded
// from both the dialogue iterator and the per-style sample collection.
const VEC_PATH_RE = /\\p\d/;

// Animation/timing tags that mark a style as having karaoke / motion
// effects.  Used as a hint for downstream PGS rendering — animated
// styles need _strip_animation_tags before bitmap render.
const ANIM_DETECT_RE = /\\(?:k[fo]?\d|K\d|t\(|move\(|fad(?:e)?\()/;

// Tags to strip when rendering preserved events for static bitmap output.
// Same set as the Python — strips motion (\k, \t, \move, \fad, \clip,
// \org) but preserves visual styling (\fn, \fs, \c, \3c, \bord, \shad,
// \pos, \an, \i, \b, etc).
const ANIMATION_TAG_RE = new RegExp(
  "\\\\(?:k[fo]?\\d*|K\\d*"
    + "|t\\([^)]*\\)|move\\([^)]*\\)|fad(?:e)?\\([^)]*\\)"
    + "|i?clip\\([^)]*\\)|org\\([^)]*\\))",
  "g",
);

// ── Public types ────────────────────────────────────────────────────

export type StyleRole = "dialogue" | "preserve" | "exclude";

export interface StyleInfo {
  event_count: number;
  role: StyleRole;
  sample_text: string;
  has_animation: boolean;
}

// ── detectAssStyles ─────────────────────────────────────────────────

/** Classify every named style in `subs` as dialogue / preserve / exclude.
 *
 *  Returns null for files with ≤1 style (SRT files, simple ASS) — the
 *  caller treats that as "no classification needed, all events are
 *  dialogue".  See iterDialogueEvents for the matching consumer.
 *
 *  Mirrors loom_core/subs/processing.py::detect_ass_styles exactly.  Keep
 *  the two implementations in sync — drift between desktop and web
 *  classification would mean the same .ass file generates differently
 *  on each platform.  The full Python test corpus (test_style_mapping.py
 *  in tests/) exercises edge cases this implementation should also pass.
 */
export function detectAssStyles(subs: SSAFile): Map<string, StyleInfo> | null {
  if (subs.styles.size <= 1) return null;

  const styleCounts = new Map<string, number>();
  const styleSamples = new Map<string, string>();
  const styleHasAnimation = new Map<string, boolean>();

  for (const event of subs.events) {
    if (event.type === "Comment") continue;
    if (VEC_PATH_RE.test(event.text)) continue;

    const name = event.style;
    styleCounts.set(name, (styleCounts.get(name) ?? 0) + 1);

    if (!styleSamples.has(name)) {
      let cleaned = event.text.replace(/\{[^}]*\}/g, "");
      cleaned = cleaned.replace(/\\N/g, " ").replace(/\\n/g, " ").replace(/\n/g, " ").trim();
      styleSamples.set(name, cleaned.slice(0, 80));
    }

    if (!styleHasAnimation.get(name) && ANIM_DETECT_RE.test(event.text)) {
      styleHasAnimation.set(name, true);
    }
  }

  if (styleCounts.size === 0 && subs.styles.size === 0) return null;

  const result = new Map<string, StyleInfo>();
  const unassigned: string[] = [];

  // Pass 1: pattern-based roles (final — count doesn't override these).
  for (const styleName of subs.styles.keys()) {
    const count = styleCounts.get(styleName) ?? 0;
    let role: StyleRole | null;

    if (count === 0) {
      role = "exclude";
    } else if (PRESERVE_PATTERNS.test(styleName)) {
      role = "preserve";
    } else if (DIALOGUE_NAME_RE.test(styleName)) {
      role = "dialogue";
    } else {
      role = null; // deferred to pass 2
      unassigned.push(styleName);
    }

    result.set(styleName, {
      event_count: count,
      role: role ?? "dialogue", // placeholder; pass 2 overwrites unassigned
      sample_text: styleSamples.get(styleName) ?? "",
      has_animation: styleHasAnimation.get(styleName) ?? false,
    });
  }

  // Pass 2: unassigned styles all get "dialogue" — matches Python behavior
  // (though the docstring says "most events wins, rest excluded", the
  // implementation makes everything dialogue; we mirror the implementation
  // since that's what tests cover).
  for (const name of unassigned) {
    const info = result.get(name)!;
    result.set(name, { ...info, role: "dialogue" });
  }

  if (result.size <= 1) return null;
  return result;
}

// ── iterDialogueEvents ──────────────────────────────────────────────

/** Yield only the main dialogue events from `subs`.  Filters out:
 *
 *    - Comment events (always)
 *    - Vector-path drawings (\p1+, never readable text)
 *    - Events whose style isn't classified as "dialogue"
 *    - Compositing layers within dialogue styles (multi-layer fansubs
 *      pack shadow/sweep/highlight clips on extra layers; only the
 *      main layer carries readable text)
 *
 *  Without `mapping` (single-style files, SRT, simple ASS), runs the
 *  layer heuristic across all non-comment events.  With `mapping`,
 *  pre-filters to dialogue-role styles before the layer heuristic.
 *
 *  Returns an array — the Python implementation is a generator, but
 *  the consumers (generate-ass, timeline) iterate twice (once to count
 *  + once to emit) so eager materialization keeps the call sites simple.
 */
export function iterDialogueEvents(
  subs: SSAFile,
  mapping?: Map<string, StyleInfo> | null,
): SSAEvent[] {
  const dialogueStyles: Set<string> | null = mapping
    ? new Set(
        [...mapping.entries()]
          .filter(([, info]) => info.role === "dialogue")
          .map(([name]) => name),
      )
    : null;

  // Count non-drawing events per layer to pick the main one.
  const layerCounts = new Map<number, number>();
  for (const event of subs.events) {
    if (event.type === "Comment") continue;
    if (VEC_PATH_RE.test(event.text)) continue;
    if (dialogueStyles !== null && !dialogueStyles.has(event.style)) continue;
    layerCounts.set(event.layer, (layerCounts.get(event.layer) ?? 0) + 1);
  }

  if (layerCounts.size === 0) return [];

  const isMultilayer = layerCounts.size > 1;
  let mainLayer: number;
  if (isMultilayer) {
    let best = -1;
    let bestCount = -1;
    for (const [layer, count] of layerCounts) {
      if (count > bestCount) {
        bestCount = count;
        best = layer;
      }
    }
    mainLayer = best;
  } else {
    mainLayer = layerCounts.keys().next().value!;
  }

  const out: SSAEvent[] = [];
  for (const event of subs.events) {
    if (event.type === "Comment") continue;
    if (VEC_PATH_RE.test(event.text)) continue;
    if (dialogueStyles !== null && !dialogueStyles.has(event.style)) continue;
    if (isMultilayer && event.layer !== mainLayer) continue;
    out.push(event);
  }
  return out;
}

// ── iterPreservedEvents ─────────────────────────────────────────────

/** Yield events whose style is classified as "preserve" (signs / karaoke
 *  / typeset / OP-ED layers).  These bypass the romanize/annotate
 *  pipeline entirely — the generate-ass path copies them through with
 *  their original styling intact (animation tags preserved for renderable
 *  .ass output).  Vector-path drawings are still excluded because they
 *  carry shape commands, not text.  Comment events excluded too.
 *
 *  Returns [] when mapping is null (single-style files have no preserved
 *  styles by definition).
 */
export function iterPreservedEvents(
  subs: SSAFile,
  mapping: Map<string, StyleInfo> | null,
): SSAEvent[] {
  if (!mapping) return [];

  const preservedStyles = new Set(
    [...mapping.entries()]
      .filter(([, info]) => info.role === "preserve")
      .map(([name]) => name),
  );
  if (preservedStyles.size === 0) return [];

  const out: SSAEvent[] = [];
  for (const event of subs.events) {
    if (event.type === "Comment") continue;
    if (VEC_PATH_RE.test(event.text)) continue;
    if (!preservedStyles.has(event.style)) continue;
    out.push(event);
  }
  return out;
}

// ── stripAnimationTags ──────────────────────────────────────────────

/** Strip ASS animation/timing tags while keeping visual styling tags.
 *
 *  Strips:  \k, \kf, \ko, \K, \t(...), \move(...), \fad(...), \fade(...),
 *           \clip(...), \iclip(...), \org(...).
 *  Keeps:   \fn, \fs, \c, \3c, \bord, \shad, \pos, \an, \i, \b, \frz,
 *           \fscx, \fscy, etc.
 *
 *  Used when rendering preserved events to static PGS bitmaps — the
 *  motion/karaoke effects can't render as a single frame, but the
 *  visual styling (color, position, font) must survive.  Empty
 *  override blocks (`{}`) left after stripping get cleaned up.
 */
export function stripAnimationTags(text: string): string {
  let out = text.replace(ANIMATION_TAG_RE, "");
  out = out.replace(/\{\s*\}/g, "");
  return out;
}
