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
}

/** Returns RichSegment[] for one layer's current event.  Empty array
 * when both spans and rawText are empty/absent. */
export function buildRichSegments(opts: BuildOptions): RichSegment[] {
  const { spans, rawText, variantTable } = opts;

  if (spans !== null && spans.length > 0) {
    return mergeSpansWithTable(spans, variantTable);
  }
  if (variantTable !== null && rawText.length > 0) {
    return walkRawTextWithTable(rawText, variantTable);
  }
  if (rawText.length > 0) {
    return [{ kind: "plain", text: rawText }];
  }
  return [];
}

function mergeSpansWithTable(
  spans: AnnotateSpan[],
  variantTable: OrthographyTable | null,
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
      // emitted multiple consecutive non-annotated tokens.
      appendPlain(out, span.base);
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
): RichSegment[] {
  const out: RichSegment[] = [];
  // Walk by codepoint so surrogate-pair CJK chars stay intact.
  for (const ch of rawText) {
    const entry = variantTable[ch] ?? null;
    if (entry === null) {
      appendPlain(out, ch);
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

function appendPlain(out: RichSegment[], text: string): void {
  const last = out[out.length - 1];
  if (last && last.kind === "plain") {
    last.text += text;
    return;
  }
  out.push({ kind: "plain", text });
}
