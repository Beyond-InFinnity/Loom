// Prime Video caption platform adapter.
//
// Structurally identical to Netflix's adapter: the MAIN-world hook
// (entrypoints/prime-main.content.ts) intercepts the plain-JSON
// GetVodPlaybackResources response, enumerates every subtitle track with
// its own whole-file TTML2 URL, and posts them as CaptionTrack.baseUrl.
// So here:
//   acquireSession()  — immediate no-op success (handle null); each track
//                       already carries its TTML URL.
//   fetchTrackEvents()— a direct GET of track.baseUrl + parseTtml().  The
//                       CDN (cf-timedtext.aux.pv-cdn.net) is
//                       unauthenticated and ACAO:* (recon 2026-07-07), so
//                       no proxy / credentials needed.  tlang is ignored
//                       (supportsTranslate: false — Prime has no MT).
//
// The FanoutTrackResult diagnostic shape is reused verbatim so discover.ts
// stays platform-agnostic.

import { parseTtml } from "../prime/parse-ttml";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import {
  PRIME_PLAYER_ROOT,
  PRIME_VIDEO_SELECTOR,
  hidePrimeCaptions,
  restorePrimeCaptions,
  resolvePrimeVideo,
} from "../../overlay/prime-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

export const primePlatform: CaptionPlatform = {
  id: "primevideo",
  supportsTranslate: false,

  // Overlay seam.  playerRootSelector is the fallback; the ISO entrypoint
  // anchors via resolvePrimePlayerSurface (largest sized surface).  The
  // playhead binds via resolveVideo → resolvePrimeVideo so it tracks the
  // SAME real surface the overlay mounts on (not a placeholder video).
  playerRootSelector: PRIME_PLAYER_ROOT,
  videoSelector: PRIME_VIDEO_SELECTOR,
  resolveVideo: resolvePrimeVideo,
  hideNativeCaptions: hidePrimeCaptions,
  restoreNativeCaptions: restorePrimeCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    // Nothing to acquire — each track carries its own TTML URL from the
    // GetVodPlaybackResources JSON.  Ready to fetch immediately.
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    const url = track.baseUrl;
    try {
      const response = await fetch(url, { signal: opts.signal });
      const status = response.status;
      if (!response.ok) {
        return {
          track,
          url,
          status,
          bodyLength: 0,
          events: null,
          firstText: null,
          error: `HTTP ${status}`,
          isTlang: false,
        };
      }
      const text = await response.text();
      if (text.length === 0) {
        return {
          track,
          url,
          status,
          bodyLength: 0,
          events: null,
          firstText: null,
          error: "empty response body",
          isTlang: false,
        };
      }
      const events = parseTtml(text);
      return {
        track,
        url,
        status,
        bodyLength: text.length,
        events,
        firstText: events.length > 0 ? events[0].text : null,
        error: null,
        isTlang: false,
      };
    } catch (e) {
      return {
        track,
        url,
        status: null,
        bodyLength: 0,
        events: null,
        firstText: null,
        error: e instanceof Error ? e.message : String(e),
        isTlang: false,
      };
    }
  },
};
