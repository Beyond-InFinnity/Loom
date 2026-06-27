// iQIYI (iq.com) caption platform adapter.
//
// Like Netflix, there is no per-session token to capture and
// no lang-swap: the player's `cache-video.iq.com/dash` JSON response (caught
// by entrypoints/iqiyi-main.content.ts's fetch/XHR hook) enumerates every
// subtitle track with its own file URL, already on CaptionTrack.baseUrl.  And
// iQIYI serves WebVTT directly (alongside SRT/TTML) — so:
//
//   acquireSession()  — immediate no-op success; handle is null.
//   fetchTrackEvents()— a direct GET of track.baseUrl (the WebVTT file) +
//                       parseVtt().  No new parser; we reuse the Netflix
//                       WebVTT parser verbatim.
//
// supportsTranslate is false — iQIYI subs are pre-authored.
//
// The FanoutTrackResult diagnostic shape is reused verbatim so discover.ts's
// caching + the "0 events for …" breadcrumb stay platform-agnostic.

import { parseVtt } from "../netflix/parse-vtt";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import {
  IQIYI_PLAYER_ROOT,
  IQIYI_VIDEO_SELECTOR,
  hideIqiyiCaptions,
  restoreIqiyiCaptions,
} from "../../overlay/iqiyi-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

export const iqiyiPlatform: CaptionPlatform = {
  id: "iqiyi",
  supportsTranslate: false,

  // Overlay seam — selectors + native-caption hiding (LIVE-VERIFY; see
  // lib/overlay/iqiyi-player-anchor.ts).
  playerRootSelector: IQIYI_PLAYER_ROOT,
  videoSelector: IQIYI_VIDEO_SELECTOR,
  hideNativeCaptions: hideIqiyiCaptions,
  restoreNativeCaptions: restoreIqiyiCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    // Nothing to acquire — each track already carries its own WebVTT file URL
    // from the /dash response.  Ready to fetch immediately.
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    // baseUrl is the WebVTT file URL straight off the /dash response (resolved
    // against `dstl` / meta.video.iqiyi.com in the MAIN hook).  tlang is
    // intentionally ignored (supportsTranslate: false).
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
