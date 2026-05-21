import { useEffect, useState } from "react";

// usePlayerScale — observe #movie_player's size, return playerHeight/1080.
//
// Mirrors the desktop convention from apps/web/lib/raster/build-html.ts
// (scale = target_height / 1080).  Every typography measurement in the
// overlay multiplies by this scale, so the captions feel right at the
// player's actual rendered size — small in default mode, real-sized
// in theater mode, full-sized in fullscreen.
//
// #movie_player IS the fullscreen element, so a single ResizeObserver
// on it covers default mode, theater mode, and fullscreen transitions
// without any explicit fullscreenchange handling.

const PLAYER_SELECTOR = "#movie_player";
const REFERENCE_HEIGHT = 1080;

export function usePlayerScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const player = document.querySelector<HTMLElement>(PLAYER_SELECTOR);
    if (!player) return;

    const update = () => {
      const h = player.clientHeight;
      if (h > 0) setScale(h / REFERENCE_HEIGHT);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(player);
    return () => observer.disconnect();
  }, []);

  return scale;
}
