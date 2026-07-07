import { useEffect, useState } from "react";

import { getPlatform } from "@/lib/captions/platform";

// usePaused — true when the tracked streaming <video> is paused.
//
// Per-word vocab lookup (VOCAB_LOOKUP.md Phase 2) activates ONLY while
// paused, so the whole feature hangs off this one boolean.  Capture-phase
// play/pause listeners on `document` catch whichever <video> fired: `pause`
// doesn't bubble but DOES traverse the capture phase from document down, so
// one capturing listener covers the video without per-element rebinding
// (same technique as lib/overlay/caption-probe.ts).
//
// Perf-safe: state flips only on the play↔pause EDGE (never per frame /
// per timeupdate).  A 1s resync covers <video> element swaps (Netflix MSE
// reuse, Prime surface migration) whose current state we haven't observed;
// setState with an unchanged value is a no-op re-render in React.

function resolveVideo(): HTMLVideoElement | null {
  const platform = getPlatform();
  const resolved = platform?.resolveVideo?.();
  if (resolved) return resolved;
  const sel = platform?.videoSelector ?? "video";
  return document.querySelector<HTMLVideoElement>(sel);
}

export function usePaused(): boolean {
  const [paused, setPaused] = useState<boolean>(
    () => resolveVideo()?.paused ?? false,
  );

  useEffect(() => {
    const sync = () => {
      const v = resolveVideo();
      setPaused(v ? v.paused : false);
    };
    sync(); // video may have mounted after first render

    // Only react to the TRACKED video — a page can have other <video>s
    // (Netflix home previews, Prime's autoplay trailer surface) whose
    // play/pause must not flip our gate.  The resync is the backstop.
    const onPause = (e: Event) => {
      if (e.target === resolveVideo()) setPaused(true);
    };
    const onPlay = (e: Event) => {
      if (e.target === resolveVideo()) setPaused(false);
    };
    document.addEventListener("pause", onPause, true);
    document.addEventListener("play", onPlay, true);
    document.addEventListener("playing", onPlay, true);
    const id = window.setInterval(sync, 1000);

    return () => {
      document.removeEventListener("pause", onPause, true);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("playing", onPlay, true);
      window.clearInterval(id);
    };
  }, []);

  return paused;
}
