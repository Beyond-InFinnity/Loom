import type { AnnotateToken } from "./types";

// Plan how a line's rendered segments (one per annotation span) group into
// clickable words for per-word vocab lookup (VOCAB_LOOKUP.md Phase 2).
//
// Each token covers spans[start : start+length]; segment index == span index
// (buildRichSegments is 1:1 with spans).  So a token maps to that run of
// segment elements.  Segments not covered by any token (punctuation, gaps
// between words) stay "loose" — rendered as-is, non-interactive.

export type WordGroupRun =
  | { kind: "word"; token: AnnotateToken; start: number; length: number }
  | { kind: "loose"; index: number };

/** Walk `segmentCount` segments left→right.  A token starting at the current
    index whose run fits within the segments becomes a "word" run; everything
    else is a "loose" single segment.  Tokens whose range would overflow the
    segment count are skipped defensively (guards against any span/token
    drift so we never mis-wrap). */
export function planWordGroups(
  segmentCount: number,
  tokens: AnnotateToken[] | null | undefined,
): WordGroupRun[] {
  const byStart = new Map<number, AnnotateToken>();
  if (tokens) {
    for (const t of tokens) {
      if (t.length > 0) byStart.set(t.start, t);
    }
  }
  const runs: WordGroupRun[] = [];
  for (let i = 0; i < segmentCount;) {
    const tok = byStart.get(i);
    if (tok && i + tok.length <= segmentCount) {
      runs.push({ kind: "word", token: tok, start: i, length: tok.length });
      i += tok.length;
    } else {
      runs.push({ kind: "loose", index: i });
      i += 1;
    }
  }
  return runs;
}
