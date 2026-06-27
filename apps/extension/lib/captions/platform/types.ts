// Caption platform adapter — the seam between Loom's shared caption
// pipeline (discover / auto-pick / stream / annotate / romanize / the
// overlay) and the per-site logic for acquiring caption text.
//
// Everything in lib/captions/ above this boundary is platform-agnostic:
// it speaks CaptionTrack + CaptionEvent and never knows whether the
// captions came from YouTube's pot-gated json3 timedtext endpoint or
// Netflix's MSL-manifest WebVTT URLs.  Each supported site provides one
// CaptionPlatform implementation; discover.ts talks only to this
// interface.
//
// 5h-1 (this file): the ACQUISITION surface — how a session becomes
// ready to fetch, and how one track's events are fetched + parsed.
// Overlay anchoring (player scale + native-caption hiding) is a
// separate, smaller seam added to this interface in 5h-3 when the
// Netflix content entrypoint consumes it.

import type { CaptionTrack } from "../types";
import type { FanoutTrackResult } from "../fanout";

/** Result of acquiring whatever session-level state a platform needs
    before per-track caption fetches can run.  Acquisition runs once
    per video, after the tracklist arrives. */
export interface SessionAcquisition {
  /** True when the platform is ready to fetch tracks for this session. */
  ok: boolean;
  /** Opaque per-session handle, passed back into fetchTrackEvents.
      YouTube: the captured pot-bearing timedtext URL that every track
      is lang-swapped off.  Netflix: null — each track already carries
      its own signed WebVTT URL in CaptionTrack.baseUrl. */
  handle: string | null;
  /** When !ok, a human-readable reason surfaced in the error emit. */
  errorMessage?: string;
}

export interface FetchTrackOpts {
  /** BCP-47 tlang= override (YouTube machine translation).  Ignored by
      platforms whose supportsTranslate is false. */
  tlang?: string;
  /** The session handle returned by acquireSession. */
  handle: string | null;
  /** Abort signal for navigation / unmount cancellation. */
  signal?: AbortSignal;
}

/** A streaming-video site Loom can render dual subtitles on.  One
    implementation per platform (YouTube now; Netflix in 5h-2).  The
    shared caption pipeline depends only on this interface. */
export interface CaptionPlatform {
  readonly id: "youtube" | "netflix" | "iqiyi" | "wetv";

  /** Acquire session-level state needed before any fetchTrackEvents.
      Called once per video, after the tracklist arrives.
      - YouTube: poll background for the pot-bearing timedtext URL
        (natural prefetch first, CC-trigger fallback after ~2s).
      - Netflix: immediate no-op success (handle: null). */
  acquireSession(videoId: string | null): Promise<SessionAcquisition>;

  /** Fetch + parse one track's events.  Encapsulates BOTH URL
      acquisition and format parsing — json3 lang-swap for YouTube,
      a direct signed-URL fetch + WebVTT parse for Netflix.  Returns
      the same FanoutTrackResult diagnostic shape regardless of source
      so discover.ts's caching + error logging stay platform-agnostic. */
  fetchTrackEvents(
    track: CaptionTrack,
    opts: FetchTrackOpts,
  ): Promise<FanoutTrackResult>;

  /** Whether per-layer tlang= machine translation is available.
      YouTube: true.  Netflix: false (each track is its own URL; there
      is no MT-on-the-fly equivalent). */
  readonly supportsTranslate: boolean;

  // ---- Overlay seam (5h-3) ------------------------------------------
  // The shared overlay (caption-overlay, player-scale, stream's playhead)
  // anchors + scales + suppresses-native-captions against the page's
  // player.  These three knobs let one overlay implementation serve any
  // site without baking in per-site selectors.

  /** CSS selector for the player ROOT element — both the overlay's
      shadow-host anchor AND the element usePlayerScale observes to scale
      typography to the rendered player height.  It must be the element
      that becomes fullscreen, so a single ResizeObserver covers default
      / theater / fullscreen.  YouTube: "#movie_player".  Netflix:
      'div[data-uia="video-canvas"]'. */
  readonly playerRootSelector: string;

  /** CSS selector for the <video> element CaptionStream hooks for the
      playhead.  YouTube: "video.html5-main-video".  Netflix:
      "#appMountPoint video". */
  readonly videoSelector: string;

  /** Hide / restore the site's OWN caption rail while Loom's overlay is
      active.  Implemented by injecting + removing a document-level
      <style> (the rule targets the host page's DOM, so it can't live in
      the content script's shadow root). */
  hideNativeCaptions(): void;
  restoreNativeCaptions(): void;
}
