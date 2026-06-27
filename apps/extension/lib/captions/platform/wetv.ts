// WeTV (wetv.vip) caption platform adapter.
//
// Like Netflix / iQIYI (and unlike YouTube), there is no per-track lang-swap:
// the player's `play.wetv.vip/getvinfo` JSONP response (caught by
// entrypoints/wetv-main.content.ts) enumerates every subtitle track with its
// own file URL on CaptionTrack.baseUrl.  So acquireSession is a no-op.
//
// THE ONE WRINKLE (confirmed from a live HAR): WeTV gives each subtitle URL
// as `…/<file>.vtt.m3u8` — an HLS wrapper that resolves to a single full
// WebVTT file (`…/<file>.vtt`).  So fetchTrackEvents handles three shapes
// behind one helper:
//   1. body is WebVTT            → parseVtt directly
//   2. body is an m3u8 playlist  → resolve segments, fetch + parse + merge
//   3. neither, but URL is .m3u8 → strip `.m3u8` and refetch the .vtt
// All resolved cues use Loom's existing WebVTT parser — no new format parser.
//
// supportsTranslate is false — WeTV subs are pre-authored.

import { parseVtt } from "../netflix/parse-vtt";
import { parseM3u8Segments } from "../wetv/parse-m3u8";
import type { FanoutTrackResult } from "../fanout";
import type { CaptionEvent, CaptionTrack } from "../types";
import {
  WETV_PLAYER_ROOT,
  WETV_VIDEO_SELECTOR,
  hideWetvCaptions,
  restoreWetvCaptions,
} from "../../overlay/wetv-player-anchor";
import type {
  CaptionPlatform,
  FetchTrackOpts,
  SessionAcquisition,
} from "./types";

const isVtt = (t: string) => /^﻿?WEBVTT/.test(t.trimStart());
const isM3u8 = (t: string) => /^﻿?#EXTM3U/.test(t.trimStart());

/** Resolve one WeTV subtitle URL → CaptionEvent[], unwrapping HLS if needed. */
async function resolveCues(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ events: CaptionEvent[]; bodyLength: number }> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();

  if (isVtt(text)) return { events: parseVtt(text), bodyLength: text.length };

  if (isM3u8(text)) {
    const segs = parseM3u8Segments(text, url);
    const all: CaptionEvent[] = [];
    for (const seg of segs) {
      const r = await fetch(seg, { signal });
      if (!r.ok) continue;
      const t = await r.text();
      if (isVtt(t)) all.push(...parseVtt(t));
    }
    if (all.length > 0) {
      all.sort((a, b) => a.start - b.start);
      return { events: all, bodyLength: text.length };
    }
  }

  // Fallback: WeTV's `<file>.vtt.m3u8` collapses to `<file>.vtt`.
  if (/\.m3u8(\?|$)/.test(url)) {
    const alt = url.replace(/\.m3u8(\?|$)/, "$1");
    const r = await fetch(alt, { signal });
    if (r.ok) {
      const t = await r.text();
      if (isVtt(t)) return { events: parseVtt(t), bodyLength: t.length };
    }
  }

  return { events: [], bodyLength: text.length };
}

export const wetvPlatform: CaptionPlatform = {
  id: "wetv",
  supportsTranslate: false,

  // Overlay seam — selectors + native-caption hiding (LIVE-VERIFY; see
  // lib/overlay/wetv-player-anchor.ts).
  playerRootSelector: WETV_PLAYER_ROOT,
  videoSelector: WETV_VIDEO_SELECTOR,
  hideNativeCaptions: hideWetvCaptions,
  restoreNativeCaptions: restoreWetvCaptions,

  acquireSession(): Promise<SessionAcquisition> {
    return Promise.resolve({ ok: true, handle: null });
  },

  async fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult> {
    const url = track.baseUrl;
    try {
      const { events, bodyLength } = await resolveCues(url, opts.signal);
      return {
        track,
        url,
        status: 200,
        bodyLength,
        events,
        firstText: events.length > 0 ? events[0].text : null,
        error: events.length > 0 ? null : "no cues resolved",
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
