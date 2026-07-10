// Merge annotate spans + raw text + variant table → RichSegment[].
//
// Three input combinations the renderer must handle:
//
//   1. spans set, variantTable null
//      → render as today (over-ruby only).  Segments mirror spans 1:1.
//
//   2. spans null, variantTable set
//      → no /annotate output for this layer, but the language has an
//         orthography variant (target == zh-Hant with annotation off).
//         Walk raw text by codepoint; emit one annotated segment per
//         in-table char, plain runs for absent chars.
//
//   3. spans set, variantTable set
//      → both pipelines apply.  For each span:
//         - multi-codepoint base: keep as one annotated segment with
//           the reading; do NOT attempt per-char under-ruby (multi-char
//           bases rarely co-occur with variant tables — Japanese spans
//           can be multi-char but the table is Chinese-only).
//         - single-codepoint base: lookup; if in table, attach
//           variantForm + tier alongside the reading.
//
// The single-codepoint guard preserves the existing per-span shape
// (one over-rt per ruby) and keeps the data flow obvious.

import type { AnnotateSpan } from "@/lib/annotate/types";
import type { OrthographyTable } from "@loom/orthography-tables";
import type { RichSegment } from "./types";

interface BuildOptions {
  /** Annotate spans from /annotate (over-ruby).  null when annotation
   *  is disabled or hasn't been fetched for this event. */
  spans: AnnotateSpan[] | null;
  /** Raw event text — used as the fallback when `spans` is null. */
  rawText: string;
  /** Orthography variant table for this layer's language, or null when
   *  the language has no resolved variant OR the user disabled the
   *  feature in the settings panel. */
  variantTable: OrthographyTable | null;
  /** Coalesce consecutive non-annotated spans into one plain segment
   *  (default true — fewer DOM nodes).  MUST be false when the caller
   *  groups segments into clickable WORDS by span index (per-word vocab
   *  lookup): coalescing makes segment index != span index, which would
   *  mis-wrap tokens after a punctuation/kana run.  Only the target line
   *  while paused sets this false, so playback keeps the coalesced path. */
  coalescePlain?: boolean;
}

/** Returns RichSegment[] for one layer's current event.  Empty array
 * when both spans and rawText are empty/absent. */
export function buildRichSegments(opts: BuildOptions): RichSegment[] {
  const { spans, rawText, variantTable, coalescePlain = true } = opts;

  if (spans !== null && spans.length > 0) {
    return mergeSpansWithTable(spans, variantTable, coalescePlain);
  }
  if (variantTable !== null && rawText.length > 0) {
    return walkRawTextWithTable(rawText, variantTable, coalescePlain);
  }
  if (rawText.length > 0) {
    // No spans and no variant table.  This is a no-ruby language (Latin,
    // Cyrillic, etc.).  When the caller is word-grouping (interactive target
    // line, coalescePlain=false), emit ONE plain segment per CODEPOINT so the
    // segment index equals the character offset — the unit the server uses for
    // token start/length on these languages (e.g. Spanish returns spans:[] with
    // tokens carrying char offsets: "comí" start=3 length=4).  planWordGroups
    // then wraps each word into a clickable element, lighting up per-word vocab
    // lookup for every definable space/character-delimited language, not just
    // the ruby ones.  During playback (coalescePlain=true) keep a single blob —
    // fewer DOM nodes, no interactivity needed.
    if (!coalescePlain) {
      return [...rawText].map((ch): RichSegment => ({ kind: "plain", text: ch }));
    }
    return [{ kind: "plain", text: rawText }];
  }
  return [];
}

function mergeSpansWithTable(
  spans: AnnotateSpan[],
  variantTable: OrthographyTable | null,
  coalescePlain: boolean,
): RichSegment[] {
  const out: RichSegment[] = [];
  for (const span of spans) {
    const reading = span.reading ?? null;
    // Codepoint-count check, not JS string length — single CJK chars
    // outside the BMP are surrogate pairs (length 2 in JS).
    const codepoints = [...span.base];
    const variantEntry =
      variantTable && codepoints.length === 1
        ? variantTable[span.base] ?? null
        : null;

    if (variantEntry === null && reading === null) {
      // No annotation work at all → plain run.  Coalesce with previous
      // plain segment to avoid DOM fragmentation when MeCab/Jieba
      // emitted multiple consecutive non-annotated tokens — UNLESS the
      // caller needs 1 segment : 1 span for word grouping.
      appendPlain(out, span.base, coalescePlain);
      continue;
    }

    out.push({
      kind: "annotated",
      base: span.base,
      reading,
      variantForm: variantEntry?.to ?? null,
      highlightTier: variantEntry
        ? variantEntry.collapse.length > 0
          ? "collapse"
          : "clean"
        : "none",
    });
  }
  return out;
}

function walkRawTextWithTable(
  rawText: string,
  variantTable: OrthographyTable,
  coalescePlain: boolean,
): RichSegment[] {
  const out: RichSegment[] = [];
  // Walk by codepoint so surrogate-pair CJK chars stay intact.
  for (const ch of rawText) {
    const entry = variantTable[ch] ?? null;
    if (entry === null) {
      appendPlain(out, ch, coalescePlain);
      continue;
    }
    out.push({
      kind: "annotated",
      base: ch,
      reading: null,
      variantForm: entry.to,
      highlightTier: entry.collapse.length > 0 ? "collapse" : "clean",
    });
  }
  return out;
}

function appendPlain(
  out: RichSegment[],
  text: string,
  coalesce: boolean,
): void {
  if (coalesce) {
    const last = out[out.length - 1];
    if (last && last.kind === "plain") {
      last.text += text;
      return;
    }
  }
  out.push({ kind: "plain", text });
}
