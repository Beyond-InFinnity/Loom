// Netflix caption platform adapter.
//
// Netflix's path is structurally SIMPLER than YouTube's: there is no
// pot-token to capture and no lang-swap.  The MSL-decrypted manifest
// (caught by entrypoints/netflix-main.content.ts's JSON.parse hook)
// enumerates every subtitle track with its own signed, ~12 h-TTL
// WebVTT URL, already on CaptionTrack.baseUrl.  So:
//
//   acquireSession()  — immediate no-op success; handle is null because
//                       no per-session secret is needed.  (discover.ts
//                       still gates on acq.ok before fetching.)
//   fetchTrackEvents()— a direct GET of track.baseUrl + parseVtt().  No
//                       URL rewriting; tlang is ignored (supportsTranslate
//                       is false — Netflix has no MT-on-the-fly).
//
// The FanoutTrackResult diagnostic shape is reused verbatim so
// discover.ts's caching + the "0 events for …" console.warn breadcrumb
// stay platform-agnostic.

import { parseVtt } from "../netflix/parse-vtt";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import {
  NETFLIX_PLAYER_ROOT,
  NETFLIX_VIDEO_SELECTOR,
  hideNetflixCaptions,
  restoreNetflixCaptions,
} from "../../overlay/netflix-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

export const netflixPlatform: CaptionPlatform = {
  id: "netflix",
  supportsTranslate: false,

  // Overlay seam (5h-3).  Selectors + native-caption hiding from the
  // live-capture recon; see lib/overlay/netflix-player-anchor.ts.
  playerRootSelector: NETFLIX_PLAYER_ROOT,
  videoSelector: NETFLIX_VIDEO_SELECTOR,
  hideNativeCaptions: hideNetflixCaptions,
  restoreNativeCaptions: restoreNetflixCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    // Nothing to acquire — each track already carries its own signed
    // WebVTT URL from the manifest.  Ready to fetch immediately.
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    // baseUrl is the signed WebVTT URL straight off the manifest.  tlang
    // is intentionally ignored (supportsTranslate: false) — there is no
    // Netflix equivalent of YouTube's MT, so a stray tlang override never
    // reaches here from the settings UI (5h-5 hides that control), and we
    // belt-and-braces ignore it if it does.
    const url = track.baseUrl;
    try {
      const response = await fetch(url, { signal: opts.signal });
      const status = response.status;
      if (!response.ok) {
        // A signed URL that has aged past its ~12 h TTL surfaces here as
        // a 403/410; the diagnostic carries the status so discover.ts's
        // warn breadcrumb is actionable ("URL expired, re-trigger play").
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
      const events = parseVtt(text);
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
