// Port of loom_core/subs/processing.py::_build_pgs_timeline.
//
// Computes the union of all timing boundaries from native + target
// subtitle tracks, and emits one interval per resulting segment.
// 4d-4's PGS encoder uses these intervals as Display Set windows —
// when only one track changes between consecutive intervals, only
// that region needs to be re-encoded (epoch system "Normal" update).
//
// 4d-3 scope (path A): top_html and bottom_text only.  Romanized +
// annotation are deferred to 4e wiring; the timeline still has the
// fields ready for them so future expansion is mechanical.

import type { SSAEvent } from "../subs/types";
import type { SSAFile } from "../subs/ssa";
import { detectAssStyles, iterDialogueEvents } from "../subs/style-classify";

export interface PgsTimelineEvent {
  /** Subtitle event from the source SSAFile, in source order. */
  event: SSAEvent;
  /** Plain text after stripping ASS override tags `{\\...}`. */
  plain_text: string;
}

export interface PgsTimelineInterval {
  start_ms: number;
  end_ms: number;
  /** Active target event during this interval, or null. */
  top: PgsTimelineEvent | null;
  /** Active native event during this interval, or null. */
  bottom: PgsTimelineEvent | null;
}

export interface BuildTimelineOptions {
  native: SSAFile;
  target: SSAFile;
  /** When false, ignores the native track entirely (simpler timeline). */
  bottom_enabled?: boolean;
  /** When false, ignores the target track. */
  top_enabled?: boolean;
}

/** Strip ASS override blocks `{\\...}` from text — same regex used in
    Python (`re.sub(r'\\{[^}]*\\}', '', t)`). */
function stripOverrides(s: string): string {
  return s.replace(/\{[^}]*\}/g, "");
}

function toEvents(subs: SSAFile): PgsTimelineEvent[] {
  // Filter to dialogue events only — same classifier the .ass generator
  // uses, so the rasterized .sup and the stitched .ass agree on which
  // events are "real" content.  Karaoke / signs / typesetting drop out
  // here (1.5 will render preserved events too via a separate pass).
  const mapping = detectAssStyles(subs);
  return iterDialogueEvents(subs, mapping)
    .map((event) => ({ event, plain_text: stripOverrides(event.text) }));
}

/** Returns a list of disjoint intervals covering the union of native +
    target event time ranges.  Intervals where both layers are empty
    (no overlap with any event) are skipped — those become "clear" gaps
    in the PGS output that the writer emits as an empty Display Set. */
export function buildPgsTimeline(opts: BuildTimelineOptions): PgsTimelineInterval[] {
  const bottomEnabled = opts.bottom_enabled !== false;
  const topEnabled = opts.top_enabled !== false;

  const targetEvents = topEnabled ? toEvents(opts.target) : [];
  const nativeEvents = bottomEnabled ? toEvents(opts.native) : [];

  // Degenerate cases: one side disabled → return target-only or native-only.
  if (nativeEvents.length === 0 && targetEvents.length === 0) return [];

  // Collect every boundary timestamp from both tracks.
  const boundarySet = new Set<number>();
  for (const e of targetEvents) {
    boundarySet.add(e.event.start);
    boundarySet.add(e.event.end);
  }
  for (const e of nativeEvents) {
    boundarySet.add(e.event.start);
    boundarySet.add(e.event.end);
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  const result: PgsTimelineInterval[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const ivStart = boundaries[i];
    const ivEnd = boundaries[i + 1];
    if (ivStart >= ivEnd) continue;

    // First-overlap match for each track (matches Python).  Concurrent
    // events from the same track aren't merged in 4d-3 — that's a
    // refinement that lands when we port _merge_concurrent_target_events.
    const top = targetEvents.find((e) => e.event.start < ivEnd && e.event.end > ivStart) ?? null;
    const bottom = nativeEvents.find((e) => e.event.start < ivEnd && e.event.end > ivStart) ?? null;

    if (top === null && bottom === null) continue;

    result.push({ start_ms: ivStart, end_ms: ivEnd, top, bottom });
  }

  return result;
}
