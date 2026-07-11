// DOM-backed PlayheadSource / ScaleSource implementations (7b,
// MOBILE_ROADMAP.md §3 seam #3) — ALL of the extension's <video>/DOM
// media plumbing lives here now; stream.ts and the overlay hooks consume
// the seam interfaces and never touch the DOM directly.
//
// Two playhead flavors, preserving the exact pre-seam semantics of their
// consumers:
//
//   - acquirePlayhead(signal): waits for the platform video (MutationObserver
//     + 10s timeout — the old CaptionStream.#waitForVideo) and returns a
//     source BOUND to that element (listeners attach to it directly, the old
//     stream behavior).  Netflix MSE reuses one element across episodes, so
//     binding survives episode swaps; Prime's surface migration rebuilds the
//     provider and re-acquires.
//
//   - pausedPlayhead: a "currently tracked video" view over capture-phase
//     document listeners + a 1s resync — the old usePaused semantics.  A page
//     can have other <video>s (Netflix home previews, Prime's autoplay
//     trailer) whose play/pause must not flip the gate, hence the
//     resolveVideo() identity filter; the resync covers element swaps whose
//     state we never observed.

import type { PlayheadSource, ScaleSource } from "@loom/player-ui/seams";
import { getPlatform } from "../captions/platform";

const FALLBACK_VIDEO_SELECTOR = "video.html5-main-video";
const FALLBACK_ROOT_SELECTOR = "#movie_player";
const VIDEO_WAIT_TIMEOUT_MS = 10_000;

/** The platform's tracked <video>, resolved fresh per call (custom resolver
    first — Prime picks the real surface over the preview — then selector). */
export function resolveVideo(): HTMLVideoElement | null {
  const platform = getPlatform();
  const resolved = platform?.resolveVideo?.();
  if (resolved) return resolved;
  const sel = platform?.videoSelector ?? FALLBACK_VIDEO_SELECTOR;
  return document.querySelector<HTMLVideoElement>(sel);
}

/** PlayheadSource bound to one resolved element. */
function videoPlayhead(video: HTMLVideoElement): PlayheadSource {
  return {
    currentTimeMs: () => video.currentTime * 1000,
    onTick(cb) {
      const handler = (): void => cb(video.currentTime * 1000);
      video.addEventListener("timeupdate", handler);
      return () => video.removeEventListener("timeupdate", handler);
    },
    paused: () => video.paused,
    onPausedChange(cb) {
      const onPause = (): void => cb(true);
      const onPlay = (): void => cb(false);
      video.addEventListener("pause", onPause);
      video.addEventListener("play", onPlay);
      video.addEventListener("playing", onPlay);
      return () => {
        video.removeEventListener("pause", onPause);
        video.removeEventListener("play", onPlay);
        video.removeEventListener("playing", onPlay);
      };
    },
  };
}

/** Wait for the platform video (MutationObserver + timeout), then hand back
    an element-bound PlayheadSource.  Null on timeout or abort. */
export function acquirePlayhead(
  signal: AbortSignal,
): Promise<PlayheadSource | null> {
  const existing = resolveVideo();
  if (existing) return Promise.resolve(videoPlayhead(existing));

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const video = resolveVideo();
      if (video) {
        observer.disconnect();
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);
        resolve(videoPlayhead(video));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = setTimeout(() => {
      observer.disconnect();
      signal.removeEventListener("abort", abortHandler);
      resolve(null);
    }, VIDEO_WAIT_TIMEOUT_MS);

    const abortHandler = (): void => {
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(null);
    };
    signal.addEventListener("abort", abortHandler);
  });
}

/** The pause-gate playhead: follows whatever video resolveVideo() currently
    names.  Capture-phase document listeners catch `pause`/`play` from any
    element (they don't bubble but do traverse capture), the identity filter
    keeps stray players out, and the 1s resync inside onPausedChange is the
    element-swap backstop — callers receive possibly-unchanged values there
    (React setState dedupes, matching the old hook). */
export const pausedPlayhead: PlayheadSource = {
  currentTimeMs: () => (resolveVideo()?.currentTime ?? 0) * 1000,
  onTick(cb) {
    const handler = (e: Event): void => {
      if (e.target === resolveVideo()) {
        cb((e.target as HTMLVideoElement).currentTime * 1000);
      }
    };
    document.addEventListener("timeupdate", handler, true);
    return () => document.removeEventListener("timeupdate", handler, true);
  },
  paused: () => resolveVideo()?.paused ?? false,
  onPausedChange(cb) {
    const sync = (): void => {
      const v = resolveVideo();
      cb(v ? v.paused : false);
    };
    const onPause = (e: Event): void => {
      if (e.target === resolveVideo()) cb(true);
    };
    const onPlay = (e: Event): void => {
      if (e.target === resolveVideo()) cb(false);
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
  },
};

const REFERENCE_HEIGHT = 1080;
export { REFERENCE_HEIGHT };

/** ScaleSource over the platform player root: ResizeObserver on the root +
    capture-phase loadedmetadata (intrinsic dimensions landing after mount;
    Netflix MSE reusing one <video> across episodes).  Null when the root
    isn't in the DOM at call time (matches the old hook's early return —
    scale stays at its default). */
export function scaleSource(): ScaleSource | null {
  const platform = getPlatform();
  const rootSelector = platform?.playerRootSelector ?? FALLBACK_ROOT_SELECTOR;
  const videoSelector = platform?.videoSelector ?? "video";
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) return null;

  const measure = (): number => {
    const video = document.querySelector<HTMLVideoElement>(videoSelector);
    return visiblePictureHeight(video, root);
  };

  return {
    pictureHeightPx: measure,
    onResize(cb) {
      const update = (): void => cb(measure());
      const observer = new ResizeObserver(update);
      observer.observe(root);
      // loadedmetadata doesn't bubble → listen in the capture phase.
      document.addEventListener("loadedmetadata", update, true);
      return () => {
        observer.disconnect();
        document.removeEventListener("loadedmetadata", update, true);
      };
    },
  };
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
