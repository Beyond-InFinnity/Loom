import { useEffect, useState } from "react";

import {
  REFERENCE_HEIGHT,
  scaleSource,
} from "../host-dom/media-sources";

// usePlayerScale — return (visible video picture height)/1080.
//
// Mirrors the desktop convention from apps/web/lib/raster/build-html.ts
// (scale = target_height / 1080).  Every typography measurement in the
// overlay multiplies by this scale, so the captions feel right at the
// player's actual rendered size — small in default mode, real-sized
// in theater mode, full-sized in fullscreen.
//
// The measurement itself — VIDEO PICTURE height, not the player container,
// via the <video>'s intrinsic aspect under object-fit: contain — lives in
// the ScaleSource impl (lib/host-dom/media-sources.ts, 7b) along with the
// ResizeObserver + capture-phase loadedmetadata plumbing; this hook is a
// dumb subscriber.  Don't revert the measurement to the player root: that's
// why Netflix/YT/WeTV/iQIYI once rendered oversized vs Prime.

export function usePlayerScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const src = scaleSource();
    if (!src) return;
    const apply = (h: number): void => {
      if (h > 0) setScale(h / REFERENCE_HEIGHT);
    };
    apply(src.pictureHeightPx());
    return src.onResize(apply);
  }, []);

  return scale;
}
