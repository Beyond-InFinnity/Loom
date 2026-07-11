import { useEffect, useState } from "react";

import { pausedPlayhead } from "../host-dom/media-sources";

// usePaused — true when the tracked streaming <video> is paused.
//
// Per-word vocab lookup (VOCAB_LOOKUP.md Phase 2) activates ONLY while
// paused, so the whole feature hangs off this one boolean.  The DOM
// mechanics (capture-phase document listeners, tracked-video identity
// filter, 1s element-swap resync) live in the PlayheadSource impl
// (lib/host-dom/media-sources.ts, 7b); this hook is a dumb subscriber.
//
// Perf-safe: the source may call back with unchanged values (the resync);
// setState with an unchanged value is a no-op re-render in React, so state
// still flips only on the play↔pause EDGE.

export function usePaused(): boolean {
  const [paused, setPaused] = useState<boolean>(() => pausedPlayhead.paused());

  useEffect(() => {
    setPaused(pausedPlayhead.paused()); // video may have mounted after first render
    return pausedPlayhead.onPausedChange(setPaused);
  }, []);

  return paused;
}
