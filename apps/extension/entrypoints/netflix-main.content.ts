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
  reduceWatchChange,
  reduceWatchLeft,
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

/** Swappable handlers stashed on `window` so a re-injected MAIN script
    (extension reload) updates the logic instead of re-wrapping JSON. */
interface LoomMainHolder {
  onManifest: (m: NetflixManifest) => void;
  onMediaSwap: (kind: string) => void;
  onWatchChanged: (videoId: string) => void;
  onWatchLeft: () => void;
  handleRequestTracklist: () => void;
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
  // Track id + downloadable map. Netflix's 2026-07-02 camelCase migration
  // renamed `trackId`/`new_track_id` → `id` and `ttDownloadables` →
  // `downloadables` (same profile-keyed shape). All spellings read
  // new-first, old-fallback so both A/B cohorts work.
  id?: string;
  new_track_id?: string;
  trackId?: string;
  downloadables?: Record<string, TtDownloadable>;
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
  // Netflix migrated the manifest to camelCase ~2026-07-02:
  // `timedtexttracks` → `textTracks`, `audio_tracks` → `audioTracks`.
  // Both spellings are read (new first, old fallback) so the hook works
  // across any A/B cohort still on the old shape.
  textTracks?: TimedTextTrack[];
  timedtexttracks?: TimedTextTrack[];
  audio_tracks?: AudioTrack[];
  audioTracks?: AudioTrack[];
}

/** The manifest's text-track array under whichever key this cohort uses. */
function textTracksOf(m: NetflixManifest): TimedTextTrack[] {
  if (Array.isArray(m.textTracks)) return m.textTracks;
  if (Array.isArray(m.timedtexttracks)) return m.timedtexttracks;
  return [];
}

export default defineContentScript({
  // ALL of netflix.com, not just /watch/* (no-refresh fix): Netflix is a
  // SPA, so navigating home→title (and autoplay episode→episode) is a
  // history.pushState with NO document reload — a /watch/-only content
  // script never injects on those navigations.  We monkey-patch
  // window-level JSON.parse/stringify, and those patches PERSIST across
  // SPA navigations within the same document, so installing them on the
  // first Netflix page (home included, at document_start) means the hooks
  // are already in place before the player fetches any manifest later.
  // The hooks no-op unless a manifest shape is seen, so running on
  // non-watch pages is cheap.  (The ISO overlay handles its own SPA
  // mount/unmount in netflix.content.tsx.)
  matches: ["*://*.netflix.com/*"],
  world: "MAIN",
  runAt: "document_start",

  main() {
    // Dev diagnostics: every line carries a per-generation seq + ms-since-
    // load stamp so ONE console capture reconstructs the exact ordering of
    // manifest / URL / media events across the MAIN and ISO worlds.
    let seq = 0;
    const t0 = performance.now();
    const dbg = (...args: unknown[]) =>
      logDev(
        `[Loom NFLX MAIN #${++seq} t=${Math.round(performance.now() - t0)}ms]`,
        ...args,
      );
    dbg(
      "script loaded — href =",
      location.href,
      "readyState =",
      document.readyState,
    );

    // Latest tracklist payload we've posted.  ISO can ask us to re-emit
    // this if it subscribed too late to catch the original postMessage
    // (the overlay starts dormant; activation happens well after the
    // manifest fired).  Same role as yt-main's latestPayload.
    let latestPayload: object | null = null;

    // Which title is ACTUALLY playing — the prefetch-vs-advance decision
    // lives in the pure reducer (lib/captions/netflix/manifest-tracker.ts,
    // unit-tested); this script just feeds it manifests + media-swap
    // events and performs the side effects (postMessage + logging) it
    // returns.  See that module's header for the full rationale.
    let tracker = initialTrackerState<PostPayload>();

    // Reload-safe install (see file header).  Firefox re-injects this MAIN
    // script into an already-open tab on every extension reload, and the
    // JSON.parse/stringify wrappers patch the PAGE's window.JSON — which the
    // add-on reload does NOT unwrap.  Re-wrapping each time stacks wrappers:
    // multiple generations of this code then process every manifest with
    // independent tracker state (observed as two different `active` titles
    // for one manifest → wrong subs).  So install the window-level hooks +
    // message listener EXACTLY ONCE and route them through a mutable holder;
    // each (re)injection just swaps in its fresh handlers so the newest code
    // wins with no stacking.  Keyed by MAIN_SOURCE so dev/prod (and only
    // those) keep separate holders.  A full page reload (fresh window.JSON)
    // is the only thing that truly clears the wrappers — this keeps an
    // extension-reload-without-page-reload from doubling up.
    const HOLDER_KEY = "__loomNflxMainHolder_" + MAIN_SOURCE;
    const w = window as unknown as Record<string, LoomMainHolder | undefined>;
    const existing = w[HOLDER_KEY];
    if (existing) {
      existing.onManifest = onManifest;
      existing.onMediaSwap = onMediaSwap;
      existing.onWatchChanged = onWatchChanged;
      existing.onWatchLeft = onWatchLeft;
      existing.handleRequestTracklist = handleRequestTracklist;
      dbg("re-attached after reload (hooks not re-wrapped)");
      return;
    }
    const holder: LoomMainHolder = {
      onManifest,
      onMediaSwap,
      onWatchChanged,
      onWatchLeft,
      handleRequestTracklist,
    };
    w[HOLDER_KEY] = holder;

    installStringifyHook();
    installParseHook((m) => holder.onManifest(m));
    installMediaSwapWatcher((k) => holder.onMediaSwap(k), dbg);

    /** A <video> loadstart/emptied means the player swapped streams — the
        episode genuinely changed.  Adopt the held manifest for whatever
        title the URL now names (URL-anchored: browse-preview loadstarts,
        where the URL has no /watch/ id, can never adopt anything). */
    function onMediaSwap(kind: string): void {
      const urlId = readVideoId();
      const activeBefore = tracker.activeMovieId ?? "(none)";
      const { state, action } = reduceMediaSwap(tracker, urlId);
      tracker = state;
      if (action.kind === "post") {
        dbg(
          "media swap (",
          kind,
          ") → ADOPTING held title",
          urlId,
          "(replaces active =",
          activeBefore,
          ")",
        );
        postPayload(action.payload);
      } else {
        dbg(
          "media swap (",
          kind,
          ") — no held match for urlId =",
          urlId ?? "(none)",
          "; active stays",
          activeBefore,
        );
      }
    }

    /** The ISO overlay reported a /watch/<id> URL change (autoplay or manual
        advance).  This is the reliable swap signal — Netflix's MSE playback
        doesn't fire loadstart/emptied on episode change, so onMediaSwap never
        sees them.  Adopt the held manifest for the new id. */
    function onWatchChanged(videoId: string): void {
      const activeBefore = tracker.activeMovieId ?? "(none)";
      const pendingBefore =
        tracker.held.map((h) => h.movieId).join(",") || "(none)";
      const { state, action } = reduceWatchChange(tracker, videoId);
      tracker = state;
      if (action.kind === "post") {
        dbg(
          "watch-changed →",
          videoId,
          "ADOPTING held manifest (replaces active =",
          activeBefore,
          ")",
        );
        postPayload(action.payload);
      } else if (activeBefore === videoId) {
        dbg("watch-changed →", videoId, "(dup — already the active title)");
      } else {
        // Genuinely never parsed this title (held map has no entry) —
        // reset and wait for its manifest.  With the held map this
        // should now only happen when the manifest truly hasn't been
        // parsed YET (it arrives → reduceManifest adopts via the URL
        // match); a persistent stall here means Netflix never parsed it.
        dbg(
          "watch-changed →",
          videoId,
          "NOT HELD → tracker RESET (was active =",
          activeBefore,
          ", held =",
          pendingBefore,
          ") — awaiting this title's manifest",
        );
      }
    }

    /** The URL left /watch/ entirely (back button → browse / detail
        page).  Clear the committed title AND the cached tracklist so
        nothing stale can be re-emitted to a fresh overlay on the NEXT
        title.  Held manifests stay — re-entering a title re-adopts. */
    function onWatchLeft(): void {
      const activeBefore = tracker.activeMovieId ?? "(none)";
      tracker = reduceWatchLeft(tracker);
      latestPayload = null;
      dbg(
        "watch-left → cleared active (was",
        activeBefore,
        ") + cached tracklist; held titles retained:",
        tracker.held.map((h) => h.movieId).join(",") || "(none)",
      );
    }

    function onManifest(manifest: NetflixManifest): void {
      const movieId =
        manifest.movieId != null ? String(manifest.movieId) : null;
      if (movieId === null) return; // installParseHook guarantees non-null

      // NOTE the old SPA drop-gate is GONE (the F5-only bug): a manifest
      // that parsed before the URL flipped to its /watch/<id> was DROPPED
      // here and Netflix never re-parsed it → no tracklist until refresh.
      // The reducer now HOLDS every manifest keyed by movieId and adopts
      // only on an explicit title-naming signal (URL match at parse time,
      // watch-changed, media-swap), so home-preview pollution stays
      // impossible while pre-watch manifests stay recoverable.

      const rawTracks = textTracksOf(manifest);
      const audioLang = primaryAudioLang(manifest);
      const tracks = rawTracks
        .map((raw, i) => serializeTrack(raw, i, audioLang))
        .filter((t): t is CaptionTrackSerialized => t !== null);
      const videoId = movieId;

      // Rich diagnostics: every manifest event, with everything needed to
      // reconstruct the prefetch-vs-advance sequence offline.
      dbg(
        "manifest: movieId =",
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
        "held =",
        tracker.held.map((h) => h.movieId).join(",") || "(none)",
      );

      // Non-final / partial parse with no text tracks at all → ignore and
      // wait for the real manifest.
      if (tracks.length === 0 && rawTracks.length === 0) {
        dbg("manifest DECISION: skip (partial parse — zero raw tracks)");
        return;
      }

      // "ok" = fetchable WebVTT; "no-captions" = text tracks exist but all
      // image-only (OCR-only → overlay degrades gracefully).
      const status: "ok" | "no-captions" =
        tracks.length > 0 ? "ok" : "no-captions";
      const payload: PostPayload = { videoId, status, tracks };

      const activeBefore = tracker.activeMovieId;
      const { state, action } = reduceManifest(
        tracker,
        { movieId, status, payload },
        readVideoId(),
      );
      tracker = state;
      if (action.kind === "post") {
        dbg(
          "manifest DECISION: ADOPT + post (",
          activeBefore === null
            ? "matches current /watch/ URL, nothing active"
            : "WebVTT upgrade of active",
          ")",
        );
        postPayload(action.payload);
      } else if (action.kind === "hold") {
        // Not adoptable YET: a next-episode prefetch while another title
        // plays (the Frieren trap), a home-preview, or a pre-watch parse
        // of the title being navigated to.  Retained in the held map —
        // watch-changed / media-swap / a request-tracklist for its URL
        // adopts it the moment a signal names it.
        dbg(
          "manifest DECISION: HELD",
          action.movieId,
          activeBefore === null
            ? "(nothing active; URL doesn't name it yet — pre-watch/preview)"
            : `(differs from active ${activeBefore} — prefetch/preview)`,
          "— adoptable on watch-changed/media-swap",
        );
      } else {
        dbg("manifest DECISION: ignore (dup of active", activeBefore, ")");
      }
    }

    function postPayload(payload: PostPayload): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      window.postMessage(fullPayload, location.origin);
      dbg(
        "tracklist POSTED → ISO: videoId =",
        payload.videoId,
        "status =",
        payload.status,
        "tracks =",
        payload.tracks.length,
      );
    }

    /** ISO asks us to re-emit the latest tracklist when it subscribed too
        late to catch the original postMessage (the overlay starts dormant /
        mounts after the manifest fired).  IDENTITY-GUARDED: the cached
        payload is only re-emitted when it matches the current /watch/
        title — a stale one (previous episode) is never served.  When the
        cache can't answer, fall back to ADOPTING a held manifest for the
        current URL (this recovers a manifest that parsed before the URL
        flipped — the activation path of the F5-only bug).

        DELIBERATELY NOT once-per-payload: an earlier one-shot flag could
        permanently starve a remounting overlay (the single re-emit lands
        while the overlay is mid-remount → dropped as dormant → flag says
        "consumed" → every later request suppressed).  Requests are rare
        (activation edges only) and the ISO side dedups identical payloads,
        so always answering is safe. */
    function handleRequestTracklist(): void {
      const urlId = readVideoId();
      const cachedId =
        (latestPayload as { videoId?: string | null } | null)?.videoId ?? null;

      // Cached payload matches the current title (or we're not on a watch
      // page at all — nothing better to offer) → re-emit it.
      if (latestPayload && (urlId === null || cachedId === urlId)) {
        dbg(
          "ISO requested tracklist re-emit — re-emitting cached videoId =",
          cachedId ?? "(?)",
          "urlId =",
          urlId ?? "(none)",
        );
        window.postMessage(latestPayload, location.origin);
        return;
      }

      // Cache is stale for this URL (or empty).  Adopt from the held map
      // if we parsed this title's manifest already (pre-watch parse).
      if (urlId !== null) {
        const { state, action } = reduceWatchChange(tracker, urlId);
        tracker = state;
        if (action.kind === "post") {
          dbg(
            "ISO requested tracklist — cached videoId =",
            cachedId ?? "(none)",
            "is stale/absent for urlId =",
            urlId,
            "→ ADOPTING held manifest for the current title",
          );
          postPayload(action.payload);
          return;
        }
      }
      dbg(
        "ISO requested tracklist — nothing to serve (cached videoId =",
        cachedId ?? "(none)",
        ", urlId =",
        urlId ?? "(none)",
        ", held =",
        tracker.held.map((h) => h.movieId).join(",") || "(none)",
        ") — awaiting this title's manifest",
      );
    }

    // Listen for messages from ISO.  Netflix only needs request-tracklist
    // (no CC trigger — discovery is passive, driven by the manifest hook).
    // Registered once (the reload guard above returned early on re-injection)
    // and routes through `holder` so the newest generation's handler runs.
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as
        | { source?: string; type?: string; videoId?: string }
        | undefined;
      if (!data || data.source !== ISO_SOURCE) return;

      // `trigger-cc` is intentionally unhandled — Netflix has no CC-button
      // dance; the manifest is the sole acquisition path.
      if (data.type === "request-tracklist") {
        holder.handleRequestTracklist();
      } else if (data.type === "watch-changed" && typeof data.videoId === "string") {
        holder.onWatchChanged(data.videoId);
      } else if (data.type === "watch-left") {
        holder.onWatchLeft();
      }
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
          const hasTracks = (m?: NetflixManifest) =>
            !!m && (Array.isArray(m.textTracks) || Array.isArray(m.timedtexttracks));
          const r: NetflixManifest | undefined =
            wrapper && wrapper.result && hasTracks(wrapper.result)
              ? wrapper.result
              : wrapper;
          if (hasTracks(r) && r!.movieId != null) cb(r as NetflixManifest);
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
  const dl = (raw.downloadables ?? raw.ttDownloadables)?.[WEBVTT_PROFILE];
  const url = urlFromDownloadable(dl);
  if (!url) return null;
  return {
    // Stable per-track id from the manifest (unique across the 2–4
    // per-language variants); index fallback is purely defensive.
    id: raw.id || raw.new_track_id || raw.trackId || `nf-${index}-${raw.language}`,
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

    We deliberately do NOT filter by ancestry.  An earlier `[data-uia=
    "player"]` filter rejected EVERY swap: Netflix's real <video> lives under
    `#appMountPoint` (the same node CaptionStream binds via
    `#appMountPoint video`), NOT inside the `[data-uia="player"]` chrome
    container the overlay anchors to — and `loadstart` can even fire before
    the element is attached to the DOM at all, so any `closest()` test is
    null at that moment.  Net effect: the held next-episode manifest was
    never adopted (no swap ever "fired"), so autoplay/advance kept showing
    the previous episode's subs.  Instead we accept any <video> swap; the
    pure reducer is URL-ANCHORED (reduceMediaSwap adopts only a held
    manifest for the title the /watch/ URL currently names), so incidental
    media — home-preview <video>s, where the URL has no /watch/ id — can
    never adopt anything.  durationchange is logged only (it can fire
    mid-stream under MSE). */
function installMediaSwapWatcher(
  onSwap: (kind: string) => void,
  log: (...args: unknown[]) => void,
): void {
  const handler = (kind: string) => (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLVideoElement)) return;
    const container = t.closest("#appMountPoint")
      ? "#appMountPoint"
      : t.closest('[data-uia="player"]')
        ? '[data-uia="player"]'
        : t.isConnected
          ? "(other)"
          : "(detached)";
    log(
      "video",
      kind,
      "container =",
      container,
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
