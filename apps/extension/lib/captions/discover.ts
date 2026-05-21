// Caption discovery — the ISOLATED-world coordinator for the
// MAIN/background/fanout dance.
//
// Two-phase state machine (split during 5f's settings UI):
//
//   Phase 1 — discoverSession()
//     One-shot per video.  Validates MAIN's tracklist, captures a
//     pot-bearing timedtext URL (natural prefetch first, CC-trigger
//     fallback after 2s).  Stores tracks + URL in module state so the
//     UI can show what's available even before fanout completes.
//
//   Phase 2 — resolveCaptions()
//     Re-runnable.  Uses the user's override (if set) or auto-pick to
//     choose target + native tracks.  Fans out via lang-swap of the
//     cached URL.  Emits a payload with events.  Called automatically
//     on initial discovery; called again whenever the user picks a
//     different track or changes native-language preference.
//
// Re-fanout is fast: per-track events are cached in eventsCache, keyed
// by (videoId, languageCode, tlang).  Once a track is fetched once,
// switching to it from the UI is instant.
//
// Architecture history:
//   5b (2026-05-20): single-phase flow — autoPick + fanout + emit.
//   5c-evening: first-pot URL picker + natural-prefetch-first trigger.
//   5f-diagnostics: phase split.  UI now picks tracks; we re-resolve
//     without re-clicking CC.

import { autoPick } from "./auto-pick";
import { fetchTrackEventsViaSwap } from "./fanout";
import type { CaptionEvent, CaptionTrack } from "./types";

const MAIN_SOURCE = "loom-main";
const ISO_SOURCE = "loom-iso";
const URL_POLL_INTERVAL_MS = 200;
/** First-pass poll: rely on YT's natural prefetch.  If the prefetch
    fired (the common case), the pot URL is captured well before this
    window expires. */
const PREFETCH_POLL_TIMEOUT_MS = 2000;
/** Second-pass poll, after we've asked MAIN to click CC.  Longer
    because YT's fetch can take 600ms+ to fire after the click. */
const TRIGGER_POLL_TIMEOUT_MS = 4000;
const NATIVE_LANG_PREF_STORAGE_KEY = "loom_native_lang_pref";
const DEFAULT_NATIVE_LANG = "en";

interface MainTracklist {
  source: typeof MAIN_SOURCE;
  type: "tracklist";
  videoId: string | null;
  status: "ok" | "no-tracks-found" | "no-captions" | "no-cc-button";
  tracks: CaptionTrack[];
}

export type DiscoveryStatus =
  | { kind: "idle" }
  | { kind: "discovering" }
  | { kind: "tracking"; targetLang: string; nativeLang: string }
  | { kind: "unsupported"; reason: "no-captions" | "no-supported-track" }
  | { kind: "error"; message: string };

/** Single unified payload emitted to subscribers.  Includes both the
    raw caption-stream data (events) AND the session state the UI
    needs (tracks + current selection + override signals).  The stream
    consumes the events; the settings UI consumes the session state. */
export interface CaptionPayload {
  videoId: string | null;
  status: DiscoveryStatus;
  /** All tracks discovered for this video.  Empty until phase 1
      completes; never reset to empty mid-session even if phase 2
      fails — the settings UI needs them to stay visible. */
  tracks: CaptionTrack[];
  /** Currently selected target track (Top layer).  Either the user
      override or the auto-pick. */
  selectedTarget: CaptionTrack | null;
  /** Currently selected native track (Bottom layer).  null when the
      tlang fallback is in use OR when no native track exists. */
  selectedNative: CaptionTrack | null;
  /** True when the user manually picked the target via the UI; false
      when auto-pick chose it.  UI uses this to show "(auto)" badge. */
  isUserPickedTarget: boolean;
  isUserPickedNative: boolean;
  /** Base BCP-47 code the auto-picker uses for native matching.
      Persisted to browser.storage.local. */
  nativeLangPref: string;
  /** Parsed events for the selected target.  null when not yet
      fetched or fetch failed. */
  targetEvents: CaptionEvent[] | null;
  /** Parsed events for the selected native track (or tlang result).
      null when not yet fetched or fetch failed. */
  nativeEvents: CaptionEvent[] | null;
}

type Listener = (payload: CaptionPayload) => void;

// ---- Module state ---------------------------------------------------

interface Session {
  videoId: string | null;
  tracks: CaptionTrack[];
  capturedUrl: string | null;
  /** User-selected target.  When null, autoPick decides. */
  targetOverride: CaptionTrack | null;
  /** User-selected native.  When null, autoPick decides. */
  nativeOverride: CaptionTrack | null;
}

function emptySession(): Session {
  return {
    videoId: null,
    tracks: [],
    capturedUrl: null,
    targetOverride: null,
    nativeOverride: null,
  };
}

let session: Session = emptySession();
let nativeLangPref: string = DEFAULT_NATIVE_LANG;
let nativeLangPrefLoaded = false;

/** (videoId :: languageCode :: tlang) → parsed events.  Re-pick is
    instant after the first fetch.  Cleared on video navigation so the
    map doesn't grow unbounded across long browsing sessions. */
const eventsCache = new Map<string, CaptionEvent[]>();

function cacheKey(
  videoId: string,
  languageCode: string,
  tlang?: string | null,
): string {
  return `${videoId}::${languageCode}::${tlang ?? ""}`;
}

let latest: CaptionPayload | null = null;
const listeners: Set<Listener> = new Set();
let installed = false;
/** Monotonic generation counter — guards async resolves from emitting
    after a newer resolve has superseded them (e.g., user clicks
    rapidly, or video navigation interrupts a fanout). */
let resolveGeneration = 0;

// ---- Discovery phase ------------------------------------------------

function handleMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data as MainTracklist | undefined;
  if (!data || data.source !== MAIN_SOURCE) return;
  if (data.type !== "tracklist") return;
  discoverSession(data).catch((e) => {
    console.error("[Loom] discover.discoverSession threw:", e);
    emit({
      ...buildBasePayload(),
      videoId: data.videoId,
      status: { kind: "error", message: String(e) },
    });
  });
}

async function discoverSession(data: MainTracklist): Promise<void> {
  console.log(
    "[Loom ISO] tracklist received: status =",
    data.status,
    "tracks =",
    data.tracks.length,
  );

  // New video?  Reset state.  videoId changing means tracks differ
  // and the cached URL no longer applies.  Overrides are intentionally
  // cleared — they were per-page UI selections.
  const isNewVideo = data.videoId !== session.videoId;
  if (isNewVideo) {
    eventsCache.clear();
    session = {
      videoId: data.videoId,
      tracks: [],
      capturedUrl: null,
      targetOverride: null,
      nativeOverride: null,
    };
  }

  if (data.status === "no-tracks-found") {
    session.tracks = [];
    emit({
      ...buildBasePayload(),
      status: {
        kind: "error",
        message: "MAIN couldn't read tracks from #movie_player",
      },
    });
    return;
  }
  if (data.status === "no-captions" || data.tracks.length === 0) {
    session.tracks = [];
    emit({
      ...buildBasePayload(),
      status: { kind: "unsupported", reason: "no-captions" },
    });
    return;
  }
  if (data.status === "no-cc-button") {
    session.tracks = data.tracks;
    emit({
      ...buildBasePayload(),
      status: {
        kind: "error",
        message: "CC button not found on this page (YT DOM change?)",
      },
    });
    return;
  }

  session.tracks = data.tracks;

  // Surface tracks to the UI immediately, even before URL capture.
  // The settings panel can populate while we wait for the pot URL.
  emit({ ...buildBasePayload(), status: { kind: "discovering" } });

  // Phase 1: rely on YT's natural prefetch.
  console.log(
    "[Loom ISO] polling for pot URL (prefetch phase, up to",
    PREFETCH_POLL_TIMEOUT_MS,
    "ms)...",
  );
  let capturedUrl = await pollBackgroundForUrl(
    data.videoId,
    PREFETCH_POLL_TIMEOUT_MS,
  );

  if (!capturedUrl) {
    console.log(
      "[Loom ISO] no prefetch pot URL — requesting CC trigger from MAIN",
    );
    requestCcTrigger();
    capturedUrl = await pollBackgroundForUrl(
      data.videoId,
      TRIGGER_POLL_TIMEOUT_MS,
    );
  }

  console.log(
    "[Loom ISO] poll result:",
    capturedUrl ? `URL captured, len=${capturedUrl.length}` : "null (timeout)",
  );

  if (!capturedUrl) {
    emit({
      ...buildBasePayload(),
      status: {
        kind: "error",
        message:
          "no pot-bearing timedtext URL captured (prefetch + trigger both failed)",
      },
    });
    return;
  }

  session.capturedUrl = capturedUrl;
  await resolveCaptions();
}

// ---- Resolution phase -----------------------------------------------

/** Choose target + native (override or auto-pick), fan out lang-swap
    fetches, emit the payload.  Re-runnable: triggered on initial URL
    capture AND on every user override change. */
async function resolveCaptions(): Promise<void> {
  if (!session.capturedUrl) {
    // Tracks known but URL still being captured.  Just surface the
    // intended selection so the UI reflects user clicks; events will
    // arrive when discovery completes.
    emit({ ...buildBasePayload(), status: { kind: "discovering" } });
    return;
  }

  const generation = ++resolveGeneration;

  const { target: autoTarget, native: autoNative } = autoPick(
    session.tracks,
    nativeLangPref,
  );
  const target = session.targetOverride ?? autoTarget;
  const native = session.nativeOverride ?? autoNative;

  if (target === null) {
    emit({
      ...buildBasePayload(),
      status: { kind: "unsupported", reason: "no-supported-track" },
    });
    return;
  }

  // Fetch in parallel, but check cache first.
  const videoId = session.videoId ?? "";
  const useTlangFallback = !native;
  const targetPromise = fetchWithCache(videoId, session.capturedUrl, target);
  const nativePromise = native
    ? fetchWithCache(videoId, session.capturedUrl, native)
    : fetchWithCache(videoId, session.capturedUrl, target, nativeLangPref);

  const [targetEvents, nativeEvents] = await Promise.all([
    targetPromise,
    nativePromise,
  ]);

  // Generation check — if a newer resolve started while we were
  // fetching, drop this emit.
  if (generation !== resolveGeneration) {
    console.log(
      "[Loom ISO] resolve gen",
      generation,
      "superseded by",
      resolveGeneration,
      "— dropping emit",
    );
    return;
  }

  console.log(
    "[Loom ISO] resolve gen",
    generation,
    "target",
    target.languageCode,
    "→",
    targetEvents?.length ?? 0,
    "events; native",
    native?.languageCode ?? `tlang=${nativeLangPref}`,
    "→",
    nativeEvents?.length ?? 0,
    "events",
  );

  if (!targetEvents || targetEvents.length === 0) {
    emit({
      ...buildBasePayload(),
      status: {
        kind: "error",
        message: `target fetch returned no events (${target.languageCode})`,
      },
    });
    return;
  }

  if (useTlangFallback && (nativeEvents?.length ?? 0) <= 1) {
    console.warn(
      "[Loom] tlang=" + nativeLangPref + " fallback returned only",
      nativeEvents?.length ?? 0,
      "events; Bottom layer will be degraded",
    );
  }

  emit({
    ...buildBasePayload(),
    status: {
      kind: "tracking",
      targetLang: target.languageCode,
      nativeLang: native
        ? native.languageCode
        : `${target.languageCode} → ${nativeLangPref}`,
    },
    targetEvents,
    nativeEvents: nativeEvents ?? [],
  });
}

async function fetchWithCache(
  videoId: string,
  capturedUrl: string,
  track: CaptionTrack,
  tlang?: string,
): Promise<CaptionEvent[] | null> {
  const key = cacheKey(videoId, track.languageCode, tlang);
  const cached = eventsCache.get(key);
  if (cached) return cached;

  const result = await fetchTrackEventsViaSwap(capturedUrl, track, { tlang });
  if (result.events && result.events.length > 0) {
    eventsCache.set(key, result.events);
    return result.events;
  }
  return result.events;
}

// ---- Helpers --------------------------------------------------------

async function pollBackgroundForUrl(
  videoId: string | null,
  timeoutMs: number,
): Promise<string | null> {
  if (!videoId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = (await browser.runtime.sendMessage({
      type: "GET_CAPTURED_URL",
      videoId,
    })) as { url: string | null } | undefined;
    if (reply?.url) return reply.url;
    await new Promise((resolve) => setTimeout(resolve, URL_POLL_INTERVAL_MS));
  }
  return null;
}

function requestCcTrigger(): void {
  window.postMessage(
    { source: ISO_SOURCE, type: "trigger-cc" },
    location.origin,
  );
}

/** Build a payload skeleton from current session state, with empty
    events.  Callers spread + override specific fields. */
function buildBasePayload(): CaptionPayload {
  const { target: autoTarget, native: autoNative } = autoPick(
    session.tracks,
    nativeLangPref,
  );
  const selectedTarget = session.targetOverride ?? autoTarget;
  const selectedNative = session.nativeOverride ?? autoNative;
  return {
    videoId: session.videoId,
    status: { kind: "idle" },
    tracks: session.tracks,
    selectedTarget,
    selectedNative,
    isUserPickedTarget: session.targetOverride !== null,
    isUserPickedNative: session.nativeOverride !== null,
    nativeLangPref,
    targetEvents: null,
    nativeEvents: null,
  };
}

function emit(payload: CaptionPayload): void {
  latest = payload;
  for (const listener of listeners) {
    listener(payload);
  }
}

// ---- User actions ---------------------------------------------------

/** Override the target track.  Pass null to revert to auto-pick.
    Triggers an immediate re-resolve (fanout from cached URL). */
export function setTargetTrack(track: CaptionTrack | null): void {
  session.targetOverride = track;
  void resolveCaptions();
}

/** Override the native track.  Pass null to revert to auto-pick
    (which may produce null + trigger tlang fallback). */
export function setNativeTrack(track: CaptionTrack | null): void {
  session.nativeOverride = track;
  void resolveCaptions();
}

/** Set the base BCP-47 code used for auto-pick's native matching.
    Persisted to browser.storage.local so it survives page reloads. */
export function setNativeLangPref(code: string): void {
  nativeLangPref = code.trim() || DEFAULT_NATIVE_LANG;
  void persistNativeLangPref(nativeLangPref);
  void resolveCaptions();
}

async function persistNativeLangPref(code: string): Promise<void> {
  try {
    await browser.storage.local.set({ [NATIVE_LANG_PREF_STORAGE_KEY]: code });
  } catch (e) {
    console.warn("[Loom] failed to persist nativeLangPref:", e);
  }
}

async function loadNativeLangPref(): Promise<void> {
  if (nativeLangPrefLoaded) return;
  nativeLangPrefLoaded = true;
  try {
    const result = await browser.storage.local.get(
      NATIVE_LANG_PREF_STORAGE_KEY,
    );
    const value = result[NATIVE_LANG_PREF_STORAGE_KEY];
    if (typeof value === "string" && value.length > 0) {
      nativeLangPref = value;
    }
  } catch (e) {
    console.warn("[Loom] failed to load nativeLangPref:", e);
  }
}

// ---- Subscription API -----------------------------------------------

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  void loadNativeLangPref();
  window.addEventListener("message", handleMessage);
  // Race-condition guard (5c): MAIN content script + ISO content
  // script both run at document_idle in undefined order.  If MAIN
  // finished pollForTracks() and posted before our listener installed,
  // the message is lost.  Ask MAIN to re-emit its cached payload.
  window.postMessage(
    { source: ISO_SOURCE, type: "request-tracklist" },
    location.origin,
  );
}

/** Install the message listener eagerly — call this from content.tsx
    BEFORE awaiting waitForElement(#movie_player) so the listener is
    in place by the time MAIN posts.  Safe to call multiple times. */
export function installCaptionDiscovery(): void {
  ensureInstalled();
}

/** Subscribe to discovery results.  Listener fires immediately with
    any latched value (handles late subscribers) then on every update. */
export function subscribeToCaptions(listener: Listener): () => void {
  ensureInstalled();
  listeners.add(listener);
  if (latest !== null) {
    listener(latest);
  }
  return () => {
    listeners.delete(listener);
  };
}
