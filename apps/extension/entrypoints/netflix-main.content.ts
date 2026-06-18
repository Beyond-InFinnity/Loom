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

import { logDev } from "@/lib/env";

const MAIN_SOURCE = "loom-main";
const ISO_SOURCE = "loom-iso";

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
interface NetflixManifest {
  movieId?: number | string;
  timedtexttracks?: TimedTextTrack[];
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
    // Dedup: Netflix re-parses the manifest several times per playback.
    // Once we've posted an OK tracklist for a movieId, skip identical
    // re-captures.  Empty captures DON'T set this — a later capture
    // (after the injected profile takes effect) may carry WebVTT tracks.
    let lastOkMovieId: string | null = null;

    installStringifyHook();
    installParseHook(onManifest);

    function onManifest(manifest: NetflixManifest): void {
      const movieId =
        manifest.movieId != null ? String(manifest.movieId) : null;
      const rawTracks = Array.isArray(manifest.timedtexttracks)
        ? manifest.timedtexttracks
        : [];

      const tracks = rawTracks
        .map(serializeTrack)
        .filter((t): t is CaptionTrackSerialized => t !== null);

      const videoId = movieId ?? readVideoId();
      logDev(
        "[Loom NFLX MAIN] manifest captured: movieId =",
        movieId,
        "rawTracks =",
        rawTracks.length,
        "webvtt tracks =",
        tracks.length,
      );

      if (tracks.length === 0) {
        // No fetchable WebVTT.  If the manifest carried no text tracks at
        // all, it's likely a non-final/partial parse — ignore it and wait
        // for the real one.  If it DID carry text tracks but none are
        // WebVTT, this is an image-only title → surface no-captions so the
        // overlay degrades gracefully instead of spinning forever.
        if (rawTracks.length === 0) return;
        postPayload({ videoId, status: "no-captions", tracks });
        return;
      }

      if (movieId !== null && movieId === lastOkMovieId) return; // dup
      lastOkMovieId = movieId;
      postPayload({ videoId, status: "ok", tracks });
    }

    function postPayload(payload: {
      videoId: string | null;
      status: "ok" | "no-captions";
      tracks: CaptionTrackSerialized[];
    }): void {
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
  };
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
