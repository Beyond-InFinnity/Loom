// YouTube caption platform adapter.
//
// Encapsulates the YouTube-specific acquisition dance that used to live
// inline in discover.ts:
//   1. acquireSession() — capture a pot-bearing timedtext URL.  YT's
//      natural prefetch usually fires it during page load; if not, ask
//      MAIN to click the CC button and poll again.  The pot is
//      session-bound (not language-bound), so ONE captured URL serves
//      every track on the video.
//   2. fetchTrackEvents() — lang-swap that captured URL onto the
//      requested track (+ optional tlang=) and parse YouTube's json3.
//
// The pot URL is captured by background.ts's webRequest listener and
// handed over via the GET_CAPTURED_URL message; the CC trigger is the
// `trigger-cc` postMessage to the MAIN-world script.  Both are YouTube
// protocol details that no longer leak into the shared pipeline.

import { logDev } from "../../env";
import { fetchTrackEventsViaSwap } from "../fanout";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import { hideYtCaptions, restoreYtCaptions } from "../../overlay/hide-yt-captions";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

const ISO_SOURCE = "loom-iso";
const URL_POLL_INTERVAL_MS = 200;
/** First-pass poll: rely on YT's natural prefetch.  If the prefetch
    fired (the common case), the pot URL is captured well before this
    window expires. */
const PREFETCH_POLL_TIMEOUT_MS = 2000;
/** Second-pass poll, after we've asked MAIN to click CC.  Longer
    because YT's fetch can take 600ms+ to fire after the click. */
const TRIGGER_POLL_TIMEOUT_MS = 4000;

async function pollBackgroundForUrl(
  videoId: string | null,
  timeoutMs: number,
): Promise<string | null> {
  if (!videoId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = (await browser.runtime.sendMessage({
      type: "GET_CAPTURED_URL",
      videoId,
    })) as { url: string | null } | undefined;
    if (reply?.url) return reply.url;
    await new Promise((resolve) => setTimeout(resolve, URL_POLL_INTERVAL_MS));
  }
  return null;
}

function requestCcTrigger(): void {
  window.postMessage(
    { source: ISO_SOURCE, type: "trigger-cc" },
    location.origin,
  );
}

export const youtubePlatform: CaptionPlatform = {
  id: "youtube",
  supportsTranslate: true,

  // Overlay seam (5h-3) — the selectors + native-caption hiding that
  // used to be hardcoded in player-scale.ts / stream.ts / caption-context.
  playerRootSelector: "#movie_player",
  videoSelector: "video.html5-main-video",
  hideNativeCaptions: hideYtCaptions,
  restoreNativeCaptions: restoreYtCaptions,

  async acquireSession(videoId: string | null): Promise<SessionAcquisition> {
    // Phase 1: rely on YT's natural prefetch.
    logDev(
      "[Loom ISO] polling for pot URL (prefetch phase, up to",
      PREFETCH_POLL_TIMEOUT_MS,
      "ms)...",
    );
    let capturedUrl = await pollBackgroundForUrl(
      videoId,
      PREFETCH_POLL_TIMEOUT_MS,
    );

    if (!capturedUrl) {
      logDev(
        "[Loom ISO] no prefetch pot URL — requesting CC trigger from MAIN",
      );
      requestCcTrigger();
      capturedUrl = await pollBackgroundForUrl(videoId, TRIGGER_POLL_TIMEOUT_MS);
    }

    logDev(
      "[Loom ISO] poll result:",
      capturedUrl
        ? `URL captured, len=${capturedUrl.length}`
        : "null (timeout)",
    );

    if (!capturedUrl) {
      return {
        ok: false,
        handle: null,
        errorMessage:
          "no pot-bearing timedtext URL captured (prefetch + trigger both failed)",
      };
    }
    return { ok: true, handle: capturedUrl };
  },

  fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    // handle is the captured pot-bearing URL; lang-swap it onto this
    // track.  An empty handle should never reach here (acquireSession
    // guards it), but fetchTrackEventsViaSwap tolerates it as a fetch
    // error rather than throwing.
    return fetchTrackEventsViaSwap(opts.handle ?? "", track, {
      tlang: opts.tlang,
      signal: opts.signal,
    });
  },
};
