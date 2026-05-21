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
import { classifyLang } from "./lang-support";
import type { CaptionEvent, CaptionTrack } from "./types";
import { buildAnnotateMap } from "../annotate/build-map";
import {
  annotateCacheKey,
  getCachedAnnotateMap,
  setCachedAnnotateMap,
} from "../annotate/cache";
import type { AnnotateMap, AnnotateSpan } from "../annotate/types";

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

// Annotation prefs — persisted across sessions because they're style
// preferences, not per-page selections.  Target defaults on (the
// headline feature for CJK + Korean videos); native defaults off
// (the user's reading language doesn't need furigana for itself).
const STORAGE_KEY_TARGET_ANNOTATE_ENABLED = "loom_target_annotate_enabled";
const STORAGE_KEY_NATIVE_ANNOTATE_ENABLED = "loom_native_annotate_enabled";
const STORAGE_KEY_TARGET_PHONETIC = "loom_target_phonetic_system";
const STORAGE_KEY_NATIVE_PHONETIC = "loom_native_phonetic_system";
const DEFAULT_TARGET_ANNOTATE_ENABLED = true;
const DEFAULT_NATIVE_ANNOTATE_ENABLED = false;

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
  /** Currently selected SOURCE track for the Top layer.  This is the
      YT track whose pot URL we lang-swap.  Same as the displayed text
      WHEN targetTranslateTo is null; the displayed text is YT's MT
      output otherwise. */
  selectedTarget: CaptionTrack | null;
  /** Currently selected SOURCE track for the Bottom layer.  null when
      the implicit tlang fallback is in play (no en-family track →
      target lang-swap + tlang=nativeLangPref). */
  selectedNative: CaptionTrack | null;
  /** True when the user manually picked the source track; false when
      auto-pick chose it. */
  isUserPickedTarget: boolean;
  isUserPickedNative: boolean;
  /** User's tlang= override for each layer.  null = no MT.  Display
      lang of the rendered text is `selectedX.languageCode` when this
      is null, otherwise this value. */
  targetTranslateTo: string | null;
  nativeTranslateTo: string | null;
  /** Base BCP-47 code the auto-picker uses for native matching.
      Persisted to browser.storage.local. */
  nativeLangPref: string;
  /** Per-track annotation enable flag.  Persisted.  When enabled +
      lang is annotate-romanize, resolveCaptions fans out /annotate
      and re-emits with targetAnnotateMap populated. */
  targetAnnotateEnabled: boolean;
  nativeAnnotateEnabled: boolean;
  /** Per-track phonetic-system override.  null = backend decides
      (Hans→Pinyin, Hant→Zhuyin, yue→Jyutping).  Persisted. */
  targetPhoneticSystem: string | null;
  nativePhoneticSystem: string | null;
  /** Annotation span maps keyed by event text.  null when annotation
      is disabled OR fetch is still in flight; populated by the
      second-stage emit after buildAnnotateMap completes. */
  targetAnnotateMap: AnnotateMap | null;
  nativeAnnotateMap: AnnotateMap | null;
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
  /** User-selected source track for the Top layer.  null = auto-pick. */
  targetOverride: CaptionTrack | null;
  /** User-selected source track for the Bottom layer.  null = auto-pick. */
  nativeOverride: CaptionTrack | null;
  /** User-set tlang= for the Top layer.  null = no translation.
      Independent of targetOverride: any source track can be translated. */
  targetTranslateTo: string | null;
  /** User-set tlang= for the Bottom layer.  null + no en-family native
      track present → implicit fallback to nativeLangPref (preserves the
      "no native track? machine-translate target" behavior from 5b). */
  nativeTranslateTo: string | null;
}

function emptySession(): Session {
  return {
    videoId: null,
    tracks: [],
    capturedUrl: null,
    targetOverride: null,
    nativeOverride: null,
    targetTranslateTo: null,
    nativeTranslateTo: null,
  };
}

let session: Session = emptySession();
let nativeLangPref: string = DEFAULT_NATIVE_LANG;
let nativeLangPrefLoaded = false;

// Annotation prefs are STYLE preferences (persist across video
// navigation + page reloads), distinct from per-page Session state.
// Kept as module-level vars so they survive emptySession() on
// isNewVideo.  Loaded once during ensureInstalled().
let targetAnnotateEnabled = DEFAULT_TARGET_ANNOTATE_ENABLED;
let nativeAnnotateEnabled = DEFAULT_NATIVE_ANNOTATE_ENABLED;
let targetPhoneticSystem: string | null = null;
let nativePhoneticSystem: string | null = null;
let annotationPrefsLoaded = false;

/** AbortController for in-flight annotation fan-outs.  Single shared
    controller — new fetch cancels the previous, so we don't stack
    overlapping fan-outs when the user rapid-fires settings changes. */
let annotateAbortController: AbortController | null = null;

/** Currently-active target / native events at the playhead.  Updated
    by caption-context every time CaptionStream's onActiveChange fires.
    Used by ensureAnnotationsAround to anchor the rolling window. */
let activeTargetEvent: CaptionEvent | null = null;
let activeNativeEvent: CaptionEvent | null = null;

/** Rolling-window size for annotation prefetch.  10 events ahead + 2
    behind = ~12 /annotate POSTs per playhead-boundary crossing on the
    common case (no cache hits).  Prefetching the whole episode at once
    (the original 5d behavior) hit slowapi's 100/min ceiling instantly
    on long videos AND wasted work the user often never watched. */
const ANNOTATE_WINDOW_AHEAD = 10;
const ANNOTATE_WINDOW_BEHIND = 2;

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
    session = emptySession();
    session.videoId = data.videoId;
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

  if (target === null) {
    emit({
      ...buildBasePayload(),
      status: { kind: "unsupported", reason: "no-supported-track" },
    });
    return;
  }

  // Native source resolution.  Three cases:
  //   1. User picked a track → use it
  //   2. autoPick found en-family track → use it
  //   3. Nothing found → implicit fallback: target source + tlang=nativeLangPref
  //
  // tlang follows the same precedence: explicit user override beats
  // implicit fallback.
  const nativeUserPicked = session.nativeOverride !== null;
  const nativeSrc: CaptionTrack | null =
    session.nativeOverride ?? autoNative ?? target;
  let nativeTlang: string | null = session.nativeTranslateTo;
  const usingImplicitNativeFallback =
    !nativeUserPicked && autoNative === null && nativeTlang === null;
  if (usingImplicitNativeFallback) {
    nativeTlang = nativeLangPref;
  }

  // Fetch in parallel, but check cache first.
  const videoId = session.videoId ?? "";
  const targetPromise = fetchWithCache(
    videoId,
    session.capturedUrl,
    target,
    session.targetTranslateTo ?? undefined,
  );
  const nativePromise = fetchWithCache(
    videoId,
    session.capturedUrl,
    nativeSrc,
    nativeTlang ?? undefined,
  );

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

  const effectiveTargetLang =
    session.targetTranslateTo ?? target.languageCode;
  const effectiveNativeLang = nativeTlang ?? nativeSrc.languageCode;

  console.log(
    "[Loom ISO] resolve gen",
    generation,
    "target",
    target.languageCode,
    session.targetTranslateTo
      ? `→ tlang=${session.targetTranslateTo}`
      : "(no tlang)",
    "→",
    targetEvents?.length ?? 0,
    "events; native",
    nativeSrc.languageCode,
    nativeTlang ? `→ tlang=${nativeTlang}` : "(no tlang)",
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

  if (nativeTlang !== null && (nativeEvents?.length ?? 0) <= 1) {
    console.warn(
      "[Loom] tlang=" + nativeTlang + " returned only",
      nativeEvents?.length ?? 0,
      "events; Bottom layer will be degraded (known YT MT anomaly)",
    );
  }

  // selectedNative in the payload is null when the implicit fallback
  // is in effect (no real native track) so the UI can show "(auto-MT)"
  // rather than the target-as-source pretense.
  const payloadSelectedNative = usingImplicitNativeFallback
    ? null
    : nativeSrc;

  emit({
    ...buildBasePayload(),
    status: {
      kind: "tracking",
      targetLang: effectiveTargetLang,
      nativeLang: effectiveNativeLang,
    },
    selectedNative: payloadSelectedNative,
    targetEvents,
    nativeEvents: nativeEvents ?? [],
  });

  // Rolling-window annotation prefetch: caption events render
  // immediately on the emit above; the FIRST window (~10 events from
  // the start of the track) populates async via the call below.  As
  // playhead advances, caption-context calls notifyActiveEvent() on
  // every dialogue boundary, and that drives further window
  // prefetches.  Result: ~12 /annotate POSTs per event boundary
  // crossing instead of ~500 at track-load time.
  //
  // We DON'T pass the current active event here — the playhead state
  // lives in CaptionStream which hasn't started yet at this point.
  // Stream.start fires its first onActiveChange synchronously inside
  // CaptionStream.start once the video element is wired up; that
  // routes to notifyActiveEvent() with the real active event.
  //
  // null anchor falls back to idx=0, so the first window covers the
  // start of the track — handles videos played from t=0.
  void ensureAnnotationsAround();
}

/** Rolling-window annotation prefetch.  Looks up the currently-active
    target + native events (from module state, updated by
    notifyActiveEvent), computes a window of ~12 surrounding events,
    fetches /annotate for any text not already cached, merges the new
    spans into the cached map, and emits a fresh map reference so
    React picks up the change.

    Called from:
    - resolveCaptions (initial kickstart — null active events → idx 0)
    - notifyActiveEvent (every onActiveChange — playhead anchor)
    - rerunAnnotations (annotation-setting change — re-anchor at
      current active) */
async function ensureAnnotationsAround(): Promise<void> {
  if (!latest || latest.status.kind !== "tracking") return;

  // Abort previous wave.  Partial results saved to cache (via
  // setCachedAnnotateMap inside fetchLayerWindow) survive the abort,
  // so the next call picks up from there.
  annotateAbortController?.abort();
  annotateAbortController = new AbortController();
  const signal = annotateAbortController.signal;

  const status = latest.status;
  const videoId = session.videoId ?? "";

  // Both layers fetched in parallel — they share the abort signal so
  // a single abort cancels both.
  const [tMap, nMap] = await Promise.all([
    fetchLayerWindow({
      events: latest.targetEvents,
      activeEvent: activeTargetEvent,
      enabled: targetAnnotateEnabled,
      lang: status.targetLang,
      phoneticSystem: targetPhoneticSystem,
      videoId,
      signal,
      layerName: "target",
    }),
    fetchLayerWindow({
      events: latest.nativeEvents,
      activeEvent: activeNativeEvent,
      enabled: nativeAnnotateEnabled,
      lang: status.nativeLang,
      phoneticSystem: nativePhoneticSystem,
      videoId,
      signal,
      layerName: "native",
    }),
  ]);

  if (signal.aborted) return;
  if (!latest || latest.status.kind !== "tracking") return;

  // Emit fresh map references (or null when the layer is disabled /
  // not annotatable / no events).  fetchLayerWindow returns the
  // appropriate value for each case.
  emit({
    ...latest,
    targetAnnotateMap: tMap,
    nativeAnnotateMap: nMap,
  });
}

interface FetchLayerWindowOpts {
  events: CaptionEvent[] | null;
  activeEvent: CaptionEvent | null;
  enabled: boolean;
  lang: string;
  phoneticSystem: string | null;
  videoId: string;
  signal: AbortSignal;
  /** "target" / "native" — used only for log labels. */
  layerName: string;
}

/** Compute the rolling window around `activeEvent`, identify texts
    not already in the cache, fetch them, merge, and return a fresh
    Map reference.  Returns null when the layer is disabled, the lang
    isn't annotatable, or there are no events — the caller emits null
    to clear React state. */
async function fetchLayerWindow(
  opts: FetchLayerWindowOpts,
): Promise<AnnotateMap | null> {
  if (!opts.enabled) return null;
  if (!opts.events || opts.events.length === 0) return null;

  const cls = classifyLang(opts.lang);
  if (cls.processing !== "annotate-romanize") {
    return null;
  }

  // Anchor index: find the active event by reference identity.
  // Fall back to 0 when no active event (initial kickstart, or
  // playhead is before the first event).
  let idx = opts.activeEvent ? opts.events.indexOf(opts.activeEvent) : -1;
  if (idx < 0) idx = 0;

  const start = Math.max(0, idx - ANNOTATE_WINDOW_BEHIND);
  const end = Math.min(
    opts.events.length,
    idx + ANNOTATE_WINDOW_AHEAD + 1,
  );
  const slice = opts.events.slice(start, end);

  const cacheKey = annotateCacheKey(
    opts.videoId,
    opts.lang,
    opts.phoneticSystem,
  );
  const existing =
    getCachedAnnotateMap(cacheKey) ?? new Map<string, AnnotateSpan[]>();

  // Skip texts already in cache.  Dedupe + trim to align with
  // buildAnnotateMap's normalization.
  const toFetch = Array.from(
    new Set(
      slice
        .map((e) => e.text.trim())
        .filter((t) => t.length > 0 && !existing.has(t)),
    ),
  );

  if (toFetch.length === 0) {
    // Window fully cached — just hand back a fresh reference to the
    // existing map so React re-renders with current entries.
    return new Map(existing);
  }

  console.log(
    "[Loom Annotate] window " +
      opts.layerName +
      " " +
      opts.lang +
      ": idx=" +
      idx +
      " slice=[" +
      start +
      "," +
      end +
      ") fetch=" +
      toFetch.length +
      " cached=" +
      existing.size,
  );

  try {
    const fresh = await buildAnnotateMap(toFetch, {
      langCode: opts.lang,
      phoneticSystem: opts.phoneticSystem,
      signal: opts.signal,
    });
    if (opts.signal.aborted) return null;
    for (const [text, spans] of fresh) {
      existing.set(text, spans);
    }
    setCachedAnnotateMap(cacheKey, existing);
    return new Map(existing);
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return null;
    console.warn(
      "[Loom Annotate] fetchLayerWindow threw:",
      opts.layerName,
      err.message,
    );
    return new Map(existing);
  }
}

/** Update the active-event anchors and trigger a rolling-window
    fetch.  Called by caption-context on every CaptionStream
    onActiveChange.  Cheap when the window is fully cached. */
export function notifyActiveEvent(
  target: CaptionEvent | null,
  native: CaptionEvent | null,
): void {
  activeTargetEvent = target;
  activeNativeEvent = native;
  void ensureAnnotationsAround();
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
    targetTranslateTo: session.targetTranslateTo,
    nativeTranslateTo: session.nativeTranslateTo,
    nativeLangPref,
    targetAnnotateEnabled,
    nativeAnnotateEnabled,
    targetPhoneticSystem,
    nativePhoneticSystem,
    targetAnnotateMap: null,
    nativeAnnotateMap: null,
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

/** Set tlang= for the Top layer.  Pass null to clear (no translation).
    Independent of source-track override — any source can be MT'd into
    any supported language. */
export function setTargetTranslateTo(code: string | null): void {
  session.targetTranslateTo =
    code === null || code.trim() === "" ? null : code.trim();
  void resolveCaptions();
}

/** Set tlang= for the Bottom layer.  Pass null to clear (which falls
    through to the implicit nativeLangPref fallback when no native
    track exists, preserving the 5b auto-MT behavior). */
export function setNativeTranslateTo(code: string | null): void {
  session.nativeTranslateTo =
    code === null || code.trim() === "" ? null : code.trim();
  void resolveCaptions();
}

/** Set the base BCP-47 code used for auto-pick's native matching.
    Persisted to browser.storage.local so it survives page reloads. */
export function setNativeLangPref(code: string): void {
  nativeLangPref = code.trim() || DEFAULT_NATIVE_LANG;
  void persistNativeLangPref(nativeLangPref);
  void resolveCaptions();
}

// ---- Annotation setters (5d) ---------------------------------------

/** Toggle target annotation.  Off → clear the map in the next emit
    immediately (no re-fetch needed).  On → kick off annotation fetch
    using cached events; result re-emits when ready. */
export function setTargetAnnotateEnabled(v: boolean): void {
  targetAnnotateEnabled = v;
  void browser.storage.local
    .set({ [STORAGE_KEY_TARGET_ANNOTATE_ENABLED]: v })
    .catch((e) => console.warn("[Loom] persist targetAnnotateEnabled:", e));
  rerunAnnotations();
}

export function setNativeAnnotateEnabled(v: boolean): void {
  nativeAnnotateEnabled = v;
  void browser.storage.local
    .set({ [STORAGE_KEY_NATIVE_ANNOTATE_ENABLED]: v })
    .catch((e) => console.warn("[Loom] persist nativeAnnotateEnabled:", e));
  rerunAnnotations();
}

/** Override target phonetic system.  null = backend auto.  Triggers
    annotation re-fetch (different system → different ruby reading). */
export function setTargetPhoneticSystem(code: string | null): void {
  targetPhoneticSystem =
    code === null || code.trim() === "" ? null : code.trim();
  void browser.storage.local
    .set({ [STORAGE_KEY_TARGET_PHONETIC]: targetPhoneticSystem ?? "" })
    .catch((e) => console.warn("[Loom] persist targetPhoneticSystem:", e));
  rerunAnnotations();
}

export function setNativePhoneticSystem(code: string | null): void {
  nativePhoneticSystem =
    code === null || code.trim() === "" ? null : code.trim();
  void browser.storage.local
    .set({ [STORAGE_KEY_NATIVE_PHONETIC]: nativePhoneticSystem ?? "" })
    .catch((e) => console.warn("[Loom] persist nativePhoneticSystem:", e));
  rerunAnnotations();
}

/** Shared re-runner for the four annotation setters.  When the user
    flips a setting and we're currently tracking, immediately:
      1. Emit `latest` with the now-stale maps cleared (so the UI
         doesn't show wrong-system annotations during the in-flight
         refetch).
      2. Kick off ensureAnnotationsAround to fetch a fresh window
         around the current active event.  Phonetic-system changes
         get a fresh cache key, so the new map starts empty and
         populates from the playhead outward (no need to refetch
         events the user already passed). */
function rerunAnnotations(): void {
  if (!latest || latest.status.kind !== "tracking") return;
  emit({
    ...latest,
    targetAnnotateEnabled,
    nativeAnnotateEnabled,
    targetPhoneticSystem,
    nativePhoneticSystem,
    targetAnnotateMap: null,
    nativeAnnotateMap: null,
  });
  void ensureAnnotationsAround();
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

async function loadAnnotationPrefs(): Promise<void> {
  if (annotationPrefsLoaded) return;
  annotationPrefsLoaded = true;
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEY_TARGET_ANNOTATE_ENABLED,
      STORAGE_KEY_NATIVE_ANNOTATE_ENABLED,
      STORAGE_KEY_TARGET_PHONETIC,
      STORAGE_KEY_NATIVE_PHONETIC,
    ]);
    const tEnabled = result[STORAGE_KEY_TARGET_ANNOTATE_ENABLED];
    const nEnabled = result[STORAGE_KEY_NATIVE_ANNOTATE_ENABLED];
    const tPhon = result[STORAGE_KEY_TARGET_PHONETIC];
    const nPhon = result[STORAGE_KEY_NATIVE_PHONETIC];
    if (typeof tEnabled === "boolean") targetAnnotateEnabled = tEnabled;
    if (typeof nEnabled === "boolean") nativeAnnotateEnabled = nEnabled;
    if (typeof tPhon === "string")
      targetPhoneticSystem = tPhon.length > 0 ? tPhon : null;
    if (typeof nPhon === "string")
      nativePhoneticSystem = nPhon.length > 0 ? nPhon : null;
  } catch (e) {
    console.warn("[Loom] failed to load annotation prefs:", e);
  }
}

// ---- Subscription API -----------------------------------------------

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  void loadNativeLangPref();
  void loadAnnotationPrefs();
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
