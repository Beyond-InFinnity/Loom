// MAIN-world content script for Netflix watch pages.
//
// Netflix's player manifest — which enumerates every subtitle track and
// its signed WebVTT URL — is MSL-encrypted on the wire, so background.ts's
// webRequest observer (the YouTube acquisition path) would see only an
// opaque blob.  The player decrypts MSL in-page and hands the plaintext to
// JSON.parse().  The ONLY way in is from the MAIN world:
//
//   1. JSON.parse hook  — catch the decrypted manifest object
//      ({ result: { movieId, timedtexttracks } }) as the player
//      deserializes it.
//   2. JSON.stringify hook — inject the `webvtt-lssdh-ios8` profile into
//      the OUTGOING manifest request so the server returns WebVTT (text)
//      URLs.  Netflix's default request doesn't ask for WebVTT; without
//      this, WebVTT-capable tracks come back with only image/DFXP
//      downloadables.
//
// This mirrors yt-main.content.ts's ROLE — emit the same
// { source: "loom-main", type: "tracklist", … } message the ISO-world
// discover.ts already consumes — but the acquisition mechanism is
// entirely different: no #movie_player polling, no CC button, no pot
// token, no `trigger-cc` handling.
//
// Discovery is EVENT-DRIVEN: the manifest fires when the user starts
// playback (or switches subtitle language), NOT on page load.  So we
// install the hooks as early as possible (document_start, before the
// player's manifest fetch), cache the latest tracklist, and re-emit on
// ISO's `request-tracklist` so a late-activating overlay still gets it.
//
// Bidirectional postMessage keeps MAIN dependency-free (no browser.*).

import { ISO_SOURCE, MAIN_SOURCE, logDev } from "@/lib/env";
import {
  initialTrackerState,
  reduceManifest,
  reduceMediaSwap,
} from "@/lib/captions/netflix/manifest-tracker";

// The WebVTT profile we both REQUEST (via the stringify hook) and read
// back (from ttDownloadables).  Tracks lacking this profile are
// image-based (IMSC/TTML PNG bitmaps) → OCR-only, out of scope here.
const WEBVTT_PROFILE = "webvtt-lssdh-ios8";

interface CaptionTrackSerialized {
  id: string;
  languageCode: string;
  name: string;
  baseUrl: string;
  kind: "manual" | "asr";
  isCc: boolean;
  /** Base code of the video's primary audio language (from the manifest's
      audio tracks).  Same value on every track of a tracklist; lets ISO's
      auto-pick default the Top layer to the spoken language.  Omitted when
      the manifest carries no recognizable audio-track array. */
  audioLangCode?: string;
}

/** Tracklist payload posted to ISO (sans the source/type envelope).  This
    is the opaque payload the manifest-tracker carries through; only its
    `status` is read by the tracker. */
interface PostPayload {
  videoId: string | null;
  status: "ok" | "no-captions";
  tracks: CaptionTrackSerialized[];
}

// Loose shapes for the Netflix manifest — field names are stable in
// spirit but Netflix rotates them, so we read defensively and never
// assume a key exists.
interface TtDownloadable {
  urls?: Array<Record<string, string> & { url?: string }>;
  downloadUrls?: Record<string, string>;
}
interface TimedTextTrack {
  language?: string;
  languageDescription?: string;
  rawTrackType?: string; // "subtitles" | "closedcaptions"
  isForcedNarrative?: boolean;
  isNoneTrack?: boolean;
  new_track_id?: string;
  trackId?: string;
  ttDownloadables?: Record<string, TtDownloadable>;
}
// Audio tracks live alongside timedtexttracks on the manifest result.
// Netflix rotates the key names (audio_tracks / audioTracks) and the
// per-track shape, so we read both defensively and never assume a key.
interface AudioTrack {
  language?: string;
  bcp47?: string;
  languageDescription?: string;
  // Best-effort "this is the original/native audio" flags — presence and
  // naming vary across manifest versions; any truthy one wins.
  isNative?: boolean;
  isOriginal?: boolean;
}
interface NetflixManifest {
  movieId?: number | string;
  timedtexttracks?: TimedTextTrack[];
  audio_tracks?: AudioTrack[];
  audioTracks?: AudioTrack[];
}

export default defineContentScript({
  matches: ["*://*.netflix.com/watch/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    logDev("[Loom NFLX MAIN] script loaded");

    // Latest tracklist payload we've posted.  ISO can ask us to re-emit
    // this if it subscribed too late to catch the original postMessage
    // (the overlay starts dormant; activation happens well after the
    // manifest fired).  Same role as yt-main's latestPayload.
    let latestPayload: object | null = null;
    let reemittedForCurrentPayload = false;

    // Which title is ACTUALLY playing — the prefetch-vs-advance decision
    // lives in the pure reducer (lib/captions/netflix/manifest-tracker.ts,
    // unit-tested); this script just feeds it manifests + media-swap
    // events and performs the side effects (postMessage + logging) it
    // returns.  See that module's header for the full rationale.
    let tracker = initialTrackerState<PostPayload>();

    installStringifyHook();
    installParseHook(onManifest);
    installMediaSwapWatcher(onMediaSwap);

    /** A <video> loadstart/emptied means the player swapped streams — the
        episode genuinely changed.  Adopt whatever title we were holding. */
    function onMediaSwap(kind: string): void {
      const heldId = tracker.pending?.movieId ?? null;
      const { state, action } = reduceMediaSwap(tracker);
      tracker = state;
      if (action.kind === "post") {
        logDev("[Loom NFLX MAIN] media swap (", kind, ") → adopting held title", heldId);
        postPayload(action.payload);
      } else {
        logDev("[Loom NFLX MAIN] media swap (", kind, ") — nothing held");
      }
    }

    function onManifest(manifest: NetflixManifest): void {
      const movieId =
        manifest.movieId != null ? String(manifest.movieId) : null;
      if (movieId === null) return; // installParseHook guarantees non-null

      const rawTracks = Array.isArray(manifest.timedtexttracks)
        ? manifest.timedtexttracks
        : [];
      const audioLang = primaryAudioLang(manifest);
      const tracks = rawTracks
        .map((raw, i) => serializeTrack(raw, i, audioLang))
        .filter((t): t is CaptionTrackSerialized => t !== null);
      const videoId = movieId;

      // Rich diagnostics: every manifest event, with everything needed to
      // reconstruct the prefetch-vs-advance sequence offline.
      logDev(
        "[Loom NFLX MAIN] manifest: movieId =",
        movieId,
        "active =",
        tracker.activeMovieId ?? "(none)",
        "urlId =",
        readVideoId() ?? "(none)",
        "href =",
        location.href,
        "rawTracks =",
        rawTracks.length,
        "webvtt =",
        tracks.length,
        "audioLang =",
        audioLang ?? "(none)",
        "pending =",
        tracker.pending?.movieId ?? "(none)",
      );

      // Non-final / partial parse with no text tracks at all → ignore and
      // wait for the real manifest.
      if (tracks.length === 0 && rawTracks.length === 0) return;

      // "ok" = fetchable WebVTT; "no-captions" = text tracks exist but all
      // image-only (OCR-only → overlay degrades gracefully).
      const status: "ok" | "no-captions" =
        tracks.length > 0 ? "ok" : "no-captions";
      const payload: PostPayload = { videoId, status, tracks };

      const { state, action } = reduceManifest(tracker, {
        movieId,
        status,
        payload,
      });
      tracker = state;
      if (action.kind === "post") {
        postPayload(action.payload);
      } else if (action.kind === "hold") {
        // Prefetch trap: a different title than what's playing.  Don't
        // adopt it (that reverted Frieren to Chinese mid-episode) — held
        // until onMediaSwap confirms the <video> actually swapped.
        logDev(
          "[Loom NFLX MAIN] holding manifest for different title",
          action.movieId,
          "(awaiting media swap)",
        );
      }
    }

    function postPayload(payload: PostPayload): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      reemittedForCurrentPayload = false;
      window.postMessage(fullPayload, location.origin);
      logDev("[Loom NFLX MAIN] tracklist posted:", payload.status);
    }

    // Listen for messages from ISO.  Netflix only needs request-tracklist
    // (no CC trigger — discovery is passive, driven by the manifest hook).
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as
        | { source?: string; type?: string }
        | undefined;
      if (!data || data.source !== ISO_SOURCE) return;

      if (data.type === "request-tracklist") {
        if (latestPayload && !reemittedForCurrentPayload) {
          logDev("[Loom NFLX MAIN] ISO requested tracklist re-emit");
          reemittedForCurrentPayload = true;
          window.postMessage(latestPayload, location.origin);
        }
        // No-op if we haven't captured a manifest yet (the manifest hook
        // will deliver once the user starts playback) or if we've already
        // re-emitted this payload once.
      }
      // `trigger-cc` is intentionally unhandled — Netflix has no CC-button
      // dance; the manifest is the sole acquisition path.
    });

    /** Inject WEBVTT_PROFILE into the outgoing manifest request's
        `profiles` array so the server returns WebVTT URLs.  The array is
        located by SHAPE (Netflix renames the wrapping keys), capped at a
        shallow depth so a hot JSON.stringify path isn't deep-walked. */
    function installStringifyHook(): void {
      const origStringify = JSON.stringify;
      // Cast: we re-expose the native overloads, just with a side effect.
      JSON.stringify = function (
        this: unknown,
        value: unknown,
        ...rest: unknown[]
      ) {
        try {
          const profs = findProfilesArray(value);
          if (profs && !profs.includes(WEBVTT_PROFILE)) {
            profs.unshift(WEBVTT_PROFILE);
            logDev("[Loom NFLX MAIN] injected", WEBVTT_PROFILE, "into request");
          }
        } catch {
          /* never break the page's stringify */
        }
        return (origStringify as (...a: unknown[]) => string).call(
          this,
          value,
          ...rest,
        );
      } as typeof JSON.stringify;
    }

    /** Hook JSON.parse to catch the decrypted manifest as the player
        deserializes it.  The payload is either the manifest directly or
        wrapped in `{ result: … }`. */
    function installParseHook(cb: (m: NetflixManifest) => void): void {
      const origParse = JSON.parse;
      JSON.parse = function (
        this: unknown,
        text: string,
        ...rest: unknown[]
      ) {
        const val = (origParse as (...a: unknown[]) => unknown).call(
          this,
          text,
          ...rest,
        );
        try {
          const wrapper = val as { result?: NetflixManifest } & NetflixManifest;
          const r: NetflixManifest | undefined =
            wrapper && wrapper.result && wrapper.result.timedtexttracks
              ? wrapper.result
              : wrapper;
          if (r && r.timedtexttracks && r.movieId != null) cb(r);
        } catch {
          /* ignore non-manifest parses */
        }
        return val;
      } as typeof JSON.parse;
    }
  },
});

/** Serialize one manifest track to the shared CaptionTrack wire shape.
    Drops forced-narrative + "none" tracks (5h-4 will further prefer plain
    subtitles over SDH closedcaptions) and any track without a fetchable
    WebVTT URL (image-based / OCR-only). */
function serializeTrack(
  raw: TimedTextTrack,
  index: number,
  audioLang: string | undefined,
): CaptionTrackSerialized | null {
  if (!raw || raw.isForcedNarrative || raw.isNoneTrack) return null;
  if (!raw.language) return null;
  const dl = raw.ttDownloadables?.[WEBVTT_PROFILE];
  const url = urlFromDownloadable(dl);
  if (!url) return null;
  return {
    // Stable per-track id from the manifest (trackId is unique across the
    // 2–4 per-language variants); index fallback is purely defensive.
    id: raw.new_track_id || raw.trackId || `nf-${index}-${raw.language}`,
    languageCode: raw.language,
    name: raw.languageDescription || raw.language,
    baseUrl: url,
    // Netflix tracks are author-provided (subtitles / closedcaptions);
    // none are ASR.
    kind: "manual",
    // SDH / closed-captions carry "[music]"-style non-speech cues;
    // auto-pick prefers a plain `subtitles` track when one exists.
    isCc: raw.rawTrackType === "closedcaptions",
    ...(audioLang ? { audioLangCode: audioLang } : {}),
  };
}

/** Derive the video's primary/original audio language from the manifest's
    audio-track array.  Read by shape (Netflix rotates `audio_tracks` /
    `audioTracks` and the per-track fields): prefer a track explicitly
    flagged native/original, else fall back to the FIRST audio track —
    Netflix conventionally lists the original-language audio first.
    Returns undefined when no recognizable audio array is present, so the
    consumer just keeps its existing tier-based auto-pick. */
function primaryAudioLang(manifest: NetflixManifest): string | undefined {
  const audio = Array.isArray(manifest.audio_tracks)
    ? manifest.audio_tracks
    : Array.isArray(manifest.audioTracks)
      ? manifest.audioTracks
      : null;
  if (!audio || audio.length === 0) return undefined;
  const langOf = (t: AudioTrack): string | undefined =>
    t.language || t.bcp47 || undefined;
  const flagged = audio.find((t) => (t.isNative || t.isOriginal) && langOf(t));
  return langOf(flagged ?? audio[0]);
}

/** Extract the first usable URL from a ttDownloadable descriptor.  The
    shape varies (`urls[0].url`, an opaque first value of `urls[0]`, or
    `downloadUrls`), so we try each in the order the spike validated. */
function urlFromDownloadable(dl: TtDownloadable | undefined): string | null {
  if (!dl) return null;
  if (dl.urls && dl.urls[0]) {
    const first = dl.urls[0];
    return first.url || Object.values(first)[0] || null;
  }
  if (dl.downloadUrls) {
    return Object.values(dl.downloadUrls)[0] || null;
  }
  return null;
}

/** Find the manifest-request `profiles` array by shape (Netflix rotates
    the wrapping key names), shallow-bounded so we don't deep-walk every
    object the page ever stringifies. */
function findProfilesArray(obj: unknown, depth = 0): string[] | null {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  const rec = obj as Record<string, unknown>;
  if (
    Array.isArray(rec.profiles) &&
    rec.profiles.some((p) => typeof p === "string")
  ) {
    return rec.profiles as string[];
  }
  for (const k of Object.keys(rec)) {
    const found = findProfilesArray(rec[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Netflix watch URL → numeric title id, e.g. /watch/81616251 → "81616251".
    Fallback only; the manifest's movieId is preferred when present. */
function readVideoId(): string | null {
  const m = location.pathname.match(/\/watch\/(\d+)/);
  return m ? m[1] : null;
}

/** Watch the player's <video> for stream swaps (= episode changes).
    Media events don't bubble, so we listen in the CAPTURE phase at window
    level — that catches loadstart/emptied/durationchange on any descendant
    <video> without needing a (possibly not-yet-existent) element ref.
    Filtered to the main player video so incidental media (hover previews,
    PiP) can't trip it.  loadstart/emptied drive the swap; durationchange
    is logged only (it can fire mid-stream under MSE). */
function installMediaSwapWatcher(onSwap: (kind: string) => void): void {
  const handler = (kind: string) => (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLVideoElement)) return;
    if (!t.closest('[data-uia="player"]')) return;
    logDev(
      "[Loom NFLX MAIN] video",
      kind,
      "currentTime =",
      Math.round(t.currentTime),
      "duration =",
      Math.round(Number.isFinite(t.duration) ? t.duration : 0),
    );
    if (kind === "loadstart" || kind === "emptied") onSwap(kind);
  };
  for (const kind of ["loadstart", "emptied", "durationchange"]) {
    window.addEventListener(kind, handler(kind), true);
  }
}
