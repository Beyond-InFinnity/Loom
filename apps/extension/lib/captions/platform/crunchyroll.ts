// Crunchyroll caption platform adapter.
//
// Like Netflix (and unlike YouTube), there is no per-session token to
// capture and no lang-swap: the player's `/playback/v*/.../play` JSON
// response (caught by entrypoints/crunchyroll-main.content.ts's fetch hook)
// enumerates every soft-subtitle track with its OWN file URL, already on
// CaptionTrack.baseUrl.  So:
//
//   acquireSession()  — immediate no-op success; handle is null.
//   fetchTrackEvents()— a direct GET of track.baseUrl, then parse.  Crunchyroll
//                       serves two text formats: ASS (the primary, original-
//                       language tracks) and WebVTT (newer English CC).  We
//                       CONTENT-SNIFF the body (a "WEBVTT" header → parseVtt,
//                       else parseAss) rather than thread a per-track format
//                       field through the shared CaptionTrack type.
//
// supportsTranslate is false — Crunchyroll subs are pre-authored; there's no
// MT-on-the-fly equivalent of YouTube's tlang.
//
// The FanoutTrackResult diagnostic shape is reused verbatim so discover.ts's
// caching + the "0 events for …" breadcrumb stay platform-agnostic.

import { parseAss } from "../crunchyroll/parse-ass";
import { parseVtt } from "../netflix/parse-vtt";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionTrack } from "../types";
import {
  CRUNCHYROLL_PLAYER_ROOT,
  CRUNCHYROLL_VIDEO_SELECTOR,
  hideCrunchyrollCaptions,
  restoreCrunchyrollCaptions,
} from "../../overlay/crunchyroll-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

/** Pick the parser by sniffing the body: WebVTT documents start with the
    "WEBVTT" signature; everything else from Crunchyroll is ASS. */
function parseByFormat(text: string) {
  return /^﻿?WEBVTT/.test(text.trimStart()) ? parseVtt(text) : parseAss(text);
}

export const crunchyrollPlatform: CaptionPlatform = {
  id: "crunchyroll",
  supportsTranslate: false,

  // Overlay seam — selectors + native-caption hiding (LIVE-VERIFY; see
  // lib/overlay/crunchyroll-player-anchor.ts).
  playerRootSelector: CRUNCHYROLL_PLAYER_ROOT,
  videoSelector: CRUNCHYROLL_VIDEO_SELECTOR,
  hideNativeCaptions: hideCrunchyrollCaptions,
  restoreNativeCaptions: restoreCrunchyrollCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    // Nothing to acquire — each track already carries its own file URL from
    // the /play response.  Ready to fetch immediately.
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    // baseUrl is the subtitle file URL straight off the /play response.
    // tlang is intentionally ignored (supportsTranslate: false).
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
      const events = parseByFormat(text);
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
