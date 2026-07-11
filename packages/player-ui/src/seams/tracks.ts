// CaptionTrackSource — seam #4 (MOBILE_ROADMAP.md §3).
//
// Replaces the extension's MAIN-world postMessage discovery channel
// (`lib/captions/discover.ts` + the per-site `CaptionPlatform` acquisition).
// A host implements this by handing over its track list and, on demand, the
// parsed events for one track:
//
//   - extension (7b): wraps the existing discover/acquisition flow
//   - native player: libmpv `track-list` + demuxed ASS/SRT text (the
//     "local-file CaptionPlatform" — desktop via ffmpeg/sidecar, Android via
//     Media3 MatroskaExtractor)
//
// Everything downstream of `CaptionTrack[]`/`CaptionEvent[]` — auto-pick,
// the annotate/romanize/define batch fetches, CaptionStream — is
// host-agnostic and consumes this seam.

import type { CaptionEvent, CaptionTrack } from "../captions/types";

export interface CaptionTrackSource {
  /** Tracks available for the current media.  Resolves after the host has
      enumerated them (native: demux done; extension: tracklist message). */
  listTracks(): Promise<CaptionTrack[]>;
  /** Parsed events for one track (by `CaptionTrack.id`). */
  fetchTrackEvents(trackId: string): Promise<CaptionEvent[]>;
  /** Fires when the track list changes identity — new media loaded,
      episode swap.  Returns unsubscribe. */
  onTracksChanged(cb: (tracks: CaptionTrack[]) => void): () => void;
  /** Whether the host can machine-translate a track server-side (YouTube
      tlang).  Native players and most platforms: false. */
  supportsTranslate: boolean;
}
