import { useEffect, useState } from "react";

import { getPlatform } from "../captions/platform";

// usePlayerScale — return (visible video picture height)/1080.
//
// Mirrors the desktop convention from apps/web/lib/raster/build-html.ts
// (scale = target_height / 1080).  Every typography measurement in the
// overlay multiplies by this scale, so the captions feel right at the
// player's actual rendered size — small in default mode, real-sized
// in theater mode, full-sized in fullscreen.
//
// Measure the VIDEO PICTURE, not the player container.  This is why Prime
// already looked right: its playerRootSelector (`.atvwebplayersdk-video-
// surface`) is video-sized, whereas Netflix (`div[data-uia="player"]`),
// YouTube (`#movie_player`), WeTV, and iQIYI resolve to player containers
// that overshoot the picture — so the same 1080-scale font sizes rendered
// noticeably larger there.  Sizing to the picture (via the <video>'s
// intrinsic aspect, since every player uses object-fit: contain) makes the
// captions consistent across platforms and hug the picture like each
// platform's native rail.  A ResizeObserver on the player root covers
// default / theater / fullscreen transitions; a capture-phase
// loadedmetadata listener catches intrinsic dimensions landing after mount
// (and Netflix MSE reusing one <video> across episodes).

const FALLBACK_SELECTOR = "#movie_player";
const REFERENCE_HEIGHT = 1080;

export function usePlayerScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const platform = getPlatform();
    const rootSelector = platform?.playerRootSelector ?? FALLBACK_SELECTOR;
    const videoSelector = platform?.videoSelector ?? "video";
    const root = document.querySelector<HTMLElement>(rootSelector);
    if (!root) return;

    const update = () => {
      const video = document.querySelector<HTMLVideoElement>(videoSelector);
      const h = visiblePictureHeight(video, root);
      if (h > 0) setScale(h / REFERENCE_HEIGHT);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(root);
    // loadedmetadata doesn't bubble → listen in the capture phase.
    document.addEventListener("loadedmetadata", update, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("loadedmetadata", update, true);
    };
  }, []);

  return scale;
}

/** Height of the VISIBLE video picture, letterbox/pillarbox excluded.
    Players size the <video> to fill their box and letterbox the content
    with object-fit: contain, so the picture is centered and its height is
    `min(elementH, elementW · intrinsicH/intrinsicW)`.  Falls back to the
    element box (then the player root) before intrinsic dimensions load. */
function visiblePictureHeight(
  video: HTMLVideoElement | null,
  root: HTMLElement,
): number {
  if (video) {
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    if (cw > 0 && ch > 0) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw > 0 && vh > 0) return Math.min(ch, (cw * vh) / vw);
      return ch;
    }
  }
  return root.clientHeight;
}
