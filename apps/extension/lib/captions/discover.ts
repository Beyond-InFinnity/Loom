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

import { ISO_SOURCE, MAIN_SOURCE, logDev } from "../env";
import { autoPick, pickPrimary } from "./auto-pick";
import { getPlatform } from "./platform";
import {
  classifyLang,
  defaultPhoneticSystemFor,
  defaultRomanizeLineEnabledFor,
} from "./lang-support";
import type { CaptionEvent, CaptionTrack } from "./types";
import { buildAnnotateMap } from "../annotate/build-map";
import { getDefineCapabilities } from "../annotate/capabilities";
import { isDefinable } from "../annotate/define-lang";
import {
  annotateCacheKey,
  getCachedAnnotateMap,
  setCachedAnnotateMap,
} from "../annotate/cache";
import type { AnnotateMap, AnnotateTokenMap } from "../annotate/types";
import { buildRomanizeMap } from "../romanize/build-map";
import {
  romanizeCacheKey,
  getCachedRomanizeMap,
  setCachedRomanizeMap,
} from "../romanize/cache";
import type { RomanizeMap } from "../romanize/types";
import { captureTracks, type CaptureEntry } from "../corpus/capture";

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

// Romanization prefs (5e — secondary phonetic line).  Same pattern as
// annotation: persisted, per-layer, target defaults on (the full-
// utterance phonetic line is the headline for non-CJK families and
// the third layer for CJK), native defaults off.  long_vowel_mode is
// Japanese-specific and global (per-layer makes no sense — if both
// layers are Japanese they share the mode).
const STORAGE_KEY_TARGET_ROMANIZE_ENABLED = "loom_target_romanize_enabled";
const STORAGE_KEY_NATIVE_ROMANIZE_ENABLED = "loom_native_romanize_enabled";
const STORAGE_KEY_LONG_VOWEL_MODE = "loom_long_vowel_mode";
const DEFAULT_NATIVE_ROMANIZE_ENABLED = false;
const DEFAULT_LONG_VOWEL_MODE: "macrons" | "doubled" | "unmarked" = "macrons";
const _VALID_LONG_VOWEL_MODES: ReadonlySet<string> = new Set([
  "macrons",
  "doubled",
  "unmarked",
]);

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
  /** Word-level token maps keyed by event text (VOCAB_LOOKUP.md Phase 2),
      parallel to the annotate maps.  Drives per-word vocab lookup on the
      target line.  null when disabled / fetch in flight. */
  targetTokenMap: AnnotateTokenMap | null;
  nativeTokenMap: AnnotateTokenMap | null;
  /** Per-track romanization enable flag (5e).  Persisted.  When
      enabled + lang has a phonetic layer, resolveCaptions fans out
      /romanize/batch and re-emits with the layer's map populated. */
  targetRomanizeEnabled: boolean;
  nativeRomanizeEnabled: boolean;
  /** Japanese-specific long-vowel mode threaded through to
      /romanize/batch.  Global (not per-layer); ignored by non-
      Japanese languages.  Persisted. */
  longVowelMode: "macrons" | "doubled" | "unmarked";
  /** Romanization maps keyed by event text — the full-utterance
      phonetic line rendered above the foreign text in the overlay's
      4th slot.  Same lifecycle as the annotate maps. */
  targetRomanizeMap: RomanizeMap | null;
  nativeRomanizeMap: RomanizeMap | null;
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
  /** True once the platform has acquired session-level state, so tracks
      are fetchable.  For YouTube this coincides with a captured pot URL;
      for Netflix the handle is null but acquired is still true. */
  acquired: boolean;
  /** Opaque platform acquisition handle (YouTube: pot-bearing timedtext
      URL that every track is lang-swapped off; Netflix: null). */
  acquisitionHandle: string | null;
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
    acquired: false,
    acquisitionHandle: null,
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

// Romanization prefs (5e).  Same scoping rationale as annotation
// prefs — survive emptySession() on video navigation, loaded once
// during ensureInstalled().
//
// The romanization LINE preference is TRI-STATE *per script family*: the
// map holds an entry for a family → explicit user choice for that family;
// absent → the language-aware default (`defaultRomanizeLineEnabledFor`).
// Keyed by ScriptFamily (not one global boolean) so a romaji line the user
// turns on for Japanese doesn't leak onto Chinese / Korean, whose
// per-character annotation already makes the line redundant.  Native stays
// a plain boolean (rarely used, no language default).
const targetRomanizeEnabledByFamily = new Map<string, boolean>();
let nativeRomanizeEnabled = DEFAULT_NATIVE_ROMANIZE_ENABLED;
let longVowelMode: "macrons" | "doubled" | "unmarked" =
  DEFAULT_LONG_VOWEL_MODE;
let romanizationPrefsLoaded = false;

// ---- Language-aware target defaults ---------------------------------
//
// The romanization LINE and the phonetic SYSTEM have sensible per-target-
// language defaults (defaultRomanizeLineEnabledFor / defaultPhoneticSystemFor
// in lang-support.ts), applied only when the user hasn't explicitly
// overridden them.  These wrappers fold in that override + a null-lang
// guard, and are used at BOTH the fetch gate and in the emitted payload so
// the settings UI shows the same state the pipeline acts on.
function effectiveTargetRomanizeEnabled(lang: string | null): boolean {
  if (!lang) return false;
  const override = targetRomanizeEnabledByFamily.get(classifyLang(lang).family);
  if (override !== undefined) return override;
  return defaultRomanizeLineEnabledFor(lang);
}
function effectiveTargetPhoneticSystem(lang: string | null): string | null {
  if (targetPhoneticSystem !== null) return targetPhoneticSystem;
  return lang ? defaultPhoneticSystemFor(lang) : null;
}

/** AbortController for in-flight annotation fan-outs.  Single shared
    controller — new fetch cancels the previous, so we don't stack
    overlapping fan-outs when the user rapid-fires settings changes. */
let annotateAbortController: AbortController | null = null;
/** Parallel controller for /romanize/batch fan-outs.  Kept separate
    from the annotate one so a phonetic-system change can refetch
    annotations without also re-running romanization (and vice-versa
    for long_vowel_mode flips). */
let romanizeAbortController: AbortController | null = null;

// 5d-perf v3: replaced the rolling-window prefetch with a single
// /annotate/batch call at track-resolve time.  Rationale: even the
// rolling window produced a constant trickle of network activity
// (~1 /annotate POST per dialogue boundary for the entire video) and
// per-boundary React re-renders churning through the context tree.
// Single batch trades ~3-4 seconds of startup wait for permanent
// quiet until the user changes tracks / phonetic system.  See
// lib/annotate/build-map.ts for the batch wire shape.

/** (videoId :: trackId :: tlang) → parsed events.  Re-pick is instant
    after the first fetch.  Keyed by trackId (NOT languageCode) so two
    same-language tracks — plain "English" vs "English (CC)" — don't
    collide on one cache slot.  Cleared on video navigation so the map
    doesn't grow unbounded across long browsing sessions. */
const eventsCache = new Map<string, CaptionEvent[]>();

function cacheKey(
  videoId: string,
  trackId: string,
  tlang?: string | null,
): string {
  return `${videoId}::${trackId}::${tlang ?? ""}`;
}

let latest: CaptionPayload | null = null;
const listeners: Set<Listener> = new Set();
let installed = false;
/** Per-tab activation gate (5d-perf).  When no React subscribers are
    attached (LoomApp is dormant), MAIN's tracklist postMessages are
    silently dropped — no /timedtext fetch, no annotation fan-out, no
    React state churn.  Goes 0→1 when LoomApp activates, 1→0 when the
    user clicks "Turn off Loom on this tab".  Window message listener
    stays attached for the page lifetime; the gate is cheap. */
let activeSubscriberCount = 0;
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
  // Per-tab activation gate (5d-perf).  When LoomApp is dormant there
  // are no React subscribers, so we drop MAIN's tracklist on the floor
  // — no /timedtext fetch, no annotation work.  MAIN caches the
  // tracklist server-side in its `latestPayload`, so when the user
  // later activates and subscribeToCaptions sends request-tracklist,
  // MAIN re-emits and we pick up here.
  if (activeSubscriberCount === 0) return;
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
  logDev(
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

  // Surface tracks to the UI immediately, even before acquisition.
  // The settings panel can populate while the platform captures its
  // session handle.
  emit({ ...buildBasePayload(), status: { kind: "discovering" } });

  // Acquire session-level state via the platform.  YouTube captures a
  // pot-bearing timedtext URL (natural prefetch → CC-trigger fallback);
  // Netflix returns immediately with a null handle.  Either way,
  // success means every track is now fetchable.
  const platform = getPlatform();
  if (!platform) {
    emit({
      ...buildBasePayload(),
      status: { kind: "error", message: "no caption platform for this host" },
    });
    return;
  }

  const acq = await platform.acquireSession(data.videoId);
  if (!acq.ok) {
    emit({
      ...buildBasePayload(),
      status: {
        kind: "error",
        message: acq.errorMessage ?? "caption acquisition failed",
      },
    });
    return;
  }

  session.acquisitionHandle = acq.handle;
  session.acquired = true;
  await resolveCaptions();
}

// ---- Resolution phase -----------------------------------------------

/** Choose target + native (override or auto-pick), fan out lang-swap
    fetches, emit the payload.  Re-runnable: triggered on initial URL
    capture AND on every user override change. */
async function resolveCaptions(): Promise<void> {
  if (!session.acquired) {
    // Tracks known but the platform hasn't finished acquiring its
    // session handle.  Just surface the intended selection so the UI
    // reflects user clicks; events arrive when discovery completes.
    emit({ ...buildBasePayload(), status: { kind: "discovering" } });
    return;
  }

  const generation = ++resolveGeneration;

  const { target: autoTarget, native: autoNative } = autoPick(
    session.tracks,
    nativeLangPref,
  );

  // Target (Top line) resolution.  When there's no FOREIGN track relative to
  // the user's native language (e.g. English-only media for an English user),
  // autoTarget is null — but we no longer bail.  Instead pickPrimary promotes
  // the cleanest available track into the target role so the one line still
  // gets the full Top treatment (styling + annotation + dictionary if the
  // language is definable).  A single line is independently worth showing.
  const target =
    session.targetOverride ?? autoTarget ?? pickPrimary(session.tracks);

  if (target === null) {
    // Genuinely nothing to show — an empty tracklist.
    emit({
      ...buildBasePayload(),
      status: { kind: "unsupported", reason: "no-supported-track" },
    });
    return;
  }

  // Native (Bottom line) source resolution.  Cases:
  //   1. User picked a native track → use it.
  //   2. autoPick found a DISTINCT native-family track → use it.
  //   3. Real foreign target, no native track, platform can translate →
  //      implicit fallback: target source + tlang=nativeLangPref (YouTube MT).
  //   4. Otherwise → SINGLE-LINE MODE: no Bottom at all.  Covers a single
  //      foreign track on a non-translate platform (Netflix / Prime / iQIYI /
  //      WeTV) AND all-native media (English-only for an English user).
  //
  // Two guards make single-line correct:
  //  - `targetIsPromotedNative`: when there's no foreign track, pickPrimary put
  //    a NATIVE-language track on top.  There's no foreign→native translation
  //    to make, so the MT fallback must not fire (it would MT English→English).
  //  - `autoNativeDistinct`: in that same case autoPick's native match IS the
  //    track we promoted to Top — drawing it as Bottom too would duplicate the
  //    one line.  Only a native track with a DIFFERENT id counts.
  // The fallback is also gated on supportsTranslate: a platform that ignores
  // tlang would refetch the SAME track → the foreign line rendered twice.
  const canTranslate = getPlatform()?.supportsTranslate ?? false;
  const nativeUserPicked = session.nativeOverride !== null;
  let nativeTlang: string | null = session.nativeTranslateTo;
  const targetIsPromotedNative =
    session.targetOverride === null && autoTarget === null;
  const autoNativeDistinct =
    autoNative !== null && autoNative.id !== target.id ? autoNative : null;
  const usingImplicitNativeFallback =
    !targetIsPromotedNative &&
    !nativeUserPicked &&
    autoNativeDistinct === null &&
    nativeTlang === null &&
    canTranslate;
  if (usingImplicitNativeFallback) {
    nativeTlang = nativeLangPref;
  }
  // The Bottom line exists only if something anchors it: a picked track, a
  // distinct auto native track, or a tlang (explicit or implicit-fallback).
  const wantsNative =
    nativeUserPicked || autoNativeDistinct !== null || nativeTlang !== null;
  const singleLine = !wantsNative;
  const nativeSrc: CaptionTrack | null = singleLine
    ? null
    : session.nativeOverride ?? autoNativeDistinct ?? target;

  // Fetch in parallel, but check cache first.
  const videoId = session.videoId ?? "";
  const targetPromise = fetchWithCache(
    videoId,
    session.acquisitionHandle,
    target,
    session.targetTranslateTo ?? undefined,
  );
  // Single-line mode has no Bottom source — skip the fetch entirely rather
  // than fabricate/duplicate a line.
  const nativePromise: Promise<CaptionEvent[] | null> = nativeSrc
    ? fetchWithCache(
        videoId,
        session.acquisitionHandle,
        nativeSrc,
        nativeTlang ?? undefined,
      )
    : Promise.resolve(null);

  const [targetEvents, nativeEvents] = await Promise.all([
    targetPromise,
    nativePromise,
  ]);

  // Generation check — if a newer resolve started while we were
  // fetching, drop this emit.
  if (generation !== resolveGeneration) {
    logDev(
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
  // "" in single-line mode (no Bottom); harmless — the native annotation /
  // romanization fetches no-op on empty nativeEvents regardless of lang.
  const effectiveNativeLang = nativeTlang ?? nativeSrc?.languageCode ?? "";

  logDev(
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
    nativeSrc?.languageCode ?? "(single-line: none)",
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

  // 5d-perf v3 (batch): one /annotate/batch POST per layer per
  // (lang, phonetic_system).  No per-boundary fetches, no rolling
  // window, no React re-render churn during playback.  The user
  // experiences a 3-4s startup wait (Railway + pypinyin processing
  // of ~700 texts on a long episode) then silence for the rest of
  // the playback session.
  void fetchAllAnnotationsForLayers(
    targetEvents,
    nativeEvents ?? [],
    effectiveTargetLang,
    effectiveNativeLang,
  );
  // 5e: parallel /romanize/batch for the secondary phonetic line.
  // Independent of annotation: a Japanese track gets BOTH ruby +
  // romaji line; a Russian track gets ONLY the romanization line.
  // Fired with its own AbortController so a long-vowel-mode flip
  // doesn't disturb in-flight annotations.
  void fetchAllRomanizationsForLayers(
    targetEvents,
    nativeEvents ?? [],
    effectiveTargetLang,
    effectiveNativeLang,
  );

  // Corpus capture (Layer 2, consent-gated — CORPUS_WIRING.md §1f).
  // AUTHENTIC platform tracks only: a tlang layer is machine-translation
  // output (synthetic), and the implicit-native-MT fallback has no real
  // track behind it — both are skipped, not captured.  Fire-and-forget:
  // captureTracks resolves without throwing and checks consent itself.
  const captureEntries: CaptureEntry[] = [];
  if (session.targetTranslateTo === null) {
    captureEntries.push({ track: target, events: targetEvents });
  }
  if (
    payloadSelectedNative !== null &&
    nativeTlang === null &&
    nativeEvents &&
    nativeEvents.length > 0
  ) {
    captureEntries.push({ track: payloadSelectedNative, events: nativeEvents });
  }
  const capturePlatform = getPlatform();
  if (captureEntries.length > 0 && capturePlatform !== null) {
    void captureTracks(
      {
        platform: capturePlatform.id,
        videoId: session.videoId,
        title: document.title,
        pathname: location.pathname,
        // Netflix: document.title is literally "Netflix" (junk → null'd by
        // cleanTitle), so the real name comes from the player chrome via
        // the platform's DOM reader, polled inside captureTracks.
        readTitle: capturePlatform.readMediaTitle?.bind(capturePlatform),
      },
      captureEntries,
    );
  }
}

/** Fire one /annotate/batch per layer.  Both run in parallel and
    each emits independently when its layer completes, so a slow
    native fetch doesn't block target ruby from appearing as soon as
    target's batch lands.

    Called from:
    - resolveCaptions (initial fetch for the resolved tracks)
    - rerunAnnotations (annotation toggle / phonetic-system change) */
async function fetchAllAnnotationsForLayers(
  targetEvents: CaptionEvent[] | null,
  nativeEvents: CaptionEvent[],
  effectiveTargetLang: string,
  effectiveNativeLang: string,
): Promise<void> {
  // Abort previous wave so a track-switch mid-fetch doesn't waste the
  // outstanding batch.  Both layer fetches share the same signal.
  annotateAbortController?.abort();
  annotateAbortController = new AbortController();
  const signal = annotateAbortController.signal;
  const videoId = session.videoId ?? "";

  await Promise.all([
    fetchLayerAnnotations({
      events: targetEvents,
      enabled: targetAnnotateEnabled,
      lang: effectiveTargetLang,
      phoneticSystem: effectiveTargetPhoneticSystem(effectiveTargetLang),
      videoId,
      signal,
      layerName: "target",
    }),
    fetchLayerAnnotations({
      events: nativeEvents,
      enabled: nativeAnnotateEnabled,
      lang: effectiveNativeLang,
      phoneticSystem: nativePhoneticSystem,
      videoId,
      signal,
      layerName: "native",
    }),
  ]);
}

interface FetchLayerAnnotationsOpts {
  events: CaptionEvent[] | null;
  enabled: boolean;
  lang: string;
  phoneticSystem: string | null;
  videoId: string;
  signal: AbortSignal;
  /** "target" / "native" — used for log labels + selecting which
      field on the payload to update on emit. */
  layerName: "target" | "native";
}

/** Fetch annotations for a single layer (target OR native).  Checks
    cache first; if missing, fires one /annotate/batch with every
    unique event text.  Emits the payload with the layer's map
    populated once the batch lands.  No-op when disabled or
    not annotatable. */
async function fetchLayerAnnotations(
  opts: FetchLayerAnnotationsOpts,
): Promise<void> {
  if (!opts.enabled) return;
  if (!opts.events || opts.events.length === 0) return;

  // Fetch when the language needs ruby (annotate-romanize) OR — for the target
  // layer — when the server says it's definable, so per-word tokens are pulled
  // for a language even if it has no ruby (e.g. a future space-delimited dict).
  // Definability is server-driven (capabilities.ts), so a new dictionary needs
  // no extension release.  For today's ja/zh both conditions coincide → no
  // behaviour change.
  const cls = classifyLang(opts.lang);
  const caps = await getDefineCapabilities();
  const wantTokens = opts.layerName === "target" && isDefinable(caps, opts.lang);
  if (cls.processing !== "annotate-romanize" && !wantTokens) return;

  const cacheKey = annotateCacheKey(
    opts.videoId,
    opts.lang,
    opts.phoneticSystem,
  );

  let result = getCachedAnnotateMap(cacheKey);
  if (!result) {
    // Cache miss — fire the batch.  buildAnnotateMap already dedups
    // + trims, so we can hand it the raw events list.
    logDev(
      "[Loom Annotate] batch start for layer=" +
        opts.layerName +
        " lang=" +
        opts.lang +
        " events=" +
        opts.events.length,
    );
    result = await buildAnnotateMap(
      opts.events.map((e) => e.text),
      {
        langCode: opts.lang,
        phoneticSystem: opts.phoneticSystem,
        signal: opts.signal,
      },
    );
    if (opts.signal.aborted) return;
    if (result.spans.size > 0 || result.tokens.size > 0) {
      setCachedAnnotateMap(cacheKey, result);
    }
  } else {
    logDev(
      "[Loom Annotate] cache hit for layer=" +
        opts.layerName +
        " lang=" +
        opts.lang +
        " map_size=" +
        result.spans.size,
    );
  }

  if (opts.signal.aborted) return;
  if (!latest || latest.status.kind !== "tracking") return;

  // Emit fresh reference so React picks up the change.  Only update
  // this layer's fields; preserve the other layer's current maps.
  const spans = result.spans;
  const tokens = result.tokens;
  emit({
    ...latest,
    targetAnnotateMap:
      opts.layerName === "target" ? new Map(spans) : latest.targetAnnotateMap,
    nativeAnnotateMap:
      opts.layerName === "native" ? new Map(spans) : latest.nativeAnnotateMap,
    targetTokenMap:
      opts.layerName === "target" ? new Map(tokens) : latest.targetTokenMap,
    nativeTokenMap:
      opts.layerName === "native" ? new Map(tokens) : latest.nativeTokenMap,
  });
}

// ---- Romanization batch fetch (5e — mirror of annotation flow) -----
//
// Same shape as fetchAllAnnotationsForLayers + fetchLayerAnnotations,
// pointed at /romanize/batch instead of /annotate/batch.  Kept as a
// parallel function rather than merged so the two surfaces can fire,
// abort, and cache independently — a phonetic-system flip only
// refetches annotations, a long-vowel-mode flip only refetches
// romanizations.

async function fetchAllRomanizationsForLayers(
  targetEvents: CaptionEvent[] | null,
  nativeEvents: CaptionEvent[],
  effectiveTargetLang: string,
  effectiveNativeLang: string,
): Promise<void> {
  romanizeAbortController?.abort();
  romanizeAbortController = new AbortController();
  const signal = romanizeAbortController.signal;
  const videoId = session.videoId ?? "";

  await Promise.all([
    fetchLayerRomanization({
      events: targetEvents,
      enabled: effectiveTargetRomanizeEnabled(effectiveTargetLang),
      lang: effectiveTargetLang,
      phoneticSystem: effectiveTargetPhoneticSystem(effectiveTargetLang),
      longVowelMode,
      videoId,
      signal,
      layerName: "target",
    }),
    fetchLayerRomanization({
      events: nativeEvents,
      enabled: nativeRomanizeEnabled,
      lang: effectiveNativeLang,
      phoneticSystem: nativePhoneticSystem,
      longVowelMode,
      videoId,
      signal,
      layerName: "native",
    }),
  ]);
}

interface FetchLayerRomanizationOpts {
  events: CaptionEvent[] | null;
  enabled: boolean;
  lang: string;
  phoneticSystem: string | null;
  longVowelMode: "macrons" | "doubled" | "unmarked";
  videoId: string;
  signal: AbortSignal;
  layerName: "target" | "native";
}

/** Fetch full-utterance romanization for a single layer.  Eligibility
    gate: classifier.processing must be "annotate-romanize" (CJK +
    Korean — these also get the phonetic line above the ruby) or
    "romanize" (Cyrillic / Thai / Indic / Hebrew / Arabic-Persian-
    Urdu — these get the phonetic line as their entire phonetic
    surface).  Latin-script and unsupported langs short-circuit out
    before any network call. */
async function fetchLayerRomanization(
  opts: FetchLayerRomanizationOpts,
): Promise<void> {
  if (!opts.enabled) return;
  if (!opts.events || opts.events.length === 0) return;

  const cls = classifyLang(opts.lang);
  if (cls.processing !== "annotate-romanize" && cls.processing !== "romanize") {
    return;
  }

  const cacheKey = romanizeCacheKey(
    opts.videoId,
    opts.lang,
    opts.phoneticSystem,
    opts.longVowelMode,
  );

  let map = getCachedRomanizeMap(cacheKey);
  if (!map) {
    logDev(
      "[Loom Romanize] batch start for layer=" +
        opts.layerName +
        " lang=" +
        opts.lang +
        " events=" +
        opts.events.length,
    );
    map = await buildRomanizeMap(
      opts.events.map((e) => e.text),
      {
        langCode: opts.lang,
        phoneticSystem: opts.phoneticSystem,
        longVowelMode: opts.longVowelMode,
        signal: opts.signal,
      },
    );
    if (opts.signal.aborted) return;
    if (map.size > 0) {
      setCachedRomanizeMap(cacheKey, map);
    }
  } else {
    logDev(
      "[Loom Romanize] cache hit for layer=" +
        opts.layerName +
        " lang=" +
        opts.lang +
        " map_size=" +
        map.size,
    );
  }

  if (opts.signal.aborted) return;
  if (!latest || latest.status.kind !== "tracking") return;

  emit({
    ...latest,
    targetRomanizeMap:
      opts.layerName === "target" ? new Map(map) : latest.targetRomanizeMap,
    nativeRomanizeMap:
      opts.layerName === "native" ? new Map(map) : latest.nativeRomanizeMap,
  });
}

async function fetchWithCache(
  videoId: string,
  handle: string | null,
  track: CaptionTrack,
  tlang?: string,
): Promise<CaptionEvent[] | null> {
  const key = cacheKey(videoId, track.id, tlang);
  const cached = eventsCache.get(key);
  if (cached) return cached;

  const platform = getPlatform();
  if (!platform) return null;
  const result = await platform.fetchTrackEvents(track, { handle, tlang });
  if (result.events && result.events.length > 0) {
    eventsCache.set(key, result.events);
    return result.events;
  }
  // Empty/error path — surface the actual reason instead of letting
  // the caller log a bare "→ 0 events" with no context.  This is the
  // load-bearing diagnostic for "video looked fine but neither layer
  // had captions": HTTP error code, pot-rejection, parse failure, or
  // the URL just doesn't carry to this track's lang via swap.
  //
  // Emitted at console.warn (not logDev) so it SURVIVES production's
  // quiet logging — this failure reason is exactly what a user bug
  // report needs.  (In dev, the logDev breadcrumbs above give the full
  // trace.)  Captured URL
  // included separately from swapped URL: if the captured URL's lang
  // param matches the track we tried to swap to, that's a pot-binding
  // mismatch (YT bound the pot to a specific videoId+lang and our
  // swap was a no-op).
  console.warn(
    "[Loom Fetch]",
    "0 events for",
    track.languageCode + (tlang ? `→tlang=${tlang}` : ""),
    "kind=" + track.kind,
    "status=" + (result.status ?? "n/a"),
    "bodyLen=" + result.bodyLength,
    "error=" + (result.error ?? "(no error string)"),
    "swappedUrl=" + result.url,
    "handle=" + handle,
  );
  return result.events;
}

// ---- Helpers --------------------------------------------------------

/** Build a payload skeleton from current session state, with empty
    events.  Callers spread + override specific fields. */
function buildBasePayload(): CaptionPayload {
  const { target: autoTarget, native: autoNative } = autoPick(
    session.tracks,
    nativeLangPref,
  );
  // Mirror resolveCaptions' target resolution (incl. the single-line
  // promotion) so the settings panel shows the language + phonetic defaults the
  // pipeline actually acts on for all-native / single-track media.
  const selectedTarget =
    session.targetOverride ?? autoTarget ?? pickPrimary(session.tracks);
  // Don't show the promoted single-line track as the Bottom source too: in
  // all-native media autoNative is that very track.  Only a DISTINCT auto
  // native counts (an explicit override always wins).
  const selectedNative =
    session.nativeOverride ??
    (autoNative && autoNative.id !== selectedTarget?.id ? autoNative : null);
  // Resolve the Top layer's display language so the romanize-enable +
  // phonetic-system defaults shown in the UI match what the pipeline
  // actually fetches (tlang override beats the source track's lang).
  const targetLangForDefaults =
    session.targetTranslateTo ?? selectedTarget?.languageCode ?? null;
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
    targetPhoneticSystem: effectiveTargetPhoneticSystem(targetLangForDefaults),
    nativePhoneticSystem,
    targetAnnotateMap: null,
    nativeAnnotateMap: null,
    targetTokenMap: null,
    nativeTokenMap: null,
    targetRomanizeEnabled: effectiveTargetRomanizeEnabled(targetLangForDefaults),
    nativeRomanizeEnabled,
    longVowelMode,
    targetRomanizeMap: null,
    nativeRomanizeMap: null,
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
  // phonetic_system also drives romanizer choice (Chinese Pinyin vs
  // Zhuyin produces different output strings, Thai paiboon vs RTGS,
  // etc.), so the romanize maps need to refetch too.
  rerunRomanizations();
}

export function setNativePhoneticSystem(code: string | null): void {
  nativePhoneticSystem =
    code === null || code.trim() === "" ? null : code.trim();
  void browser.storage.local
    .set({ [STORAGE_KEY_NATIVE_PHONETIC]: nativePhoneticSystem ?? "" })
    .catch((e) => console.warn("[Loom] persist nativePhoneticSystem:", e));
  rerunAnnotations();
  rerunRomanizations();
}

/** Shared re-runner for the four annotation setters.  When the user
    flips a setting and we're currently tracking, immediately:
      1. Emit `latest` with the now-stale maps cleared (so the UI
         doesn't show wrong-system annotations during the in-flight
         refetch).
      2. Kick off a fresh /annotate/batch for whichever layer needs
         it.  Phonetic-system changes get a fresh cache key — the
         cache miss triggers a full batch refetch for the new
         system.  Toggle on with cache hit is instant (no network). */
function rerunAnnotations(): void {
  if (!latest || latest.status.kind !== "tracking") return;
  const status = latest.status;
  const targetEvents = latest.targetEvents;
  const nativeEvents = latest.nativeEvents ?? [];
  emit({
    ...latest,
    targetAnnotateEnabled,
    nativeAnnotateEnabled,
    targetPhoneticSystem: effectiveTargetPhoneticSystem(status.targetLang),
    nativePhoneticSystem,
    targetAnnotateMap: null,
    nativeAnnotateMap: null,
    targetTokenMap: null,
    nativeTokenMap: null,
  });
  void fetchAllAnnotationsForLayers(
    targetEvents,
    nativeEvents,
    status.targetLang,
    status.nativeLang,
  );
}

// ---- Romanization setters (5e) -------------------------------------

export function setTargetRomanizeEnabled(v: boolean): void {
  const lang =
    latest?.status.kind === "tracking" ? latest.status.targetLang : null;
  if (lang) targetRomanizeEnabledByFamily.set(classifyLang(lang).family, v);
  const persisted: Record<string, boolean> = {};
  for (const [fam, val] of targetRomanizeEnabledByFamily) persisted[fam] = val;
  void browser.storage.local
    .set({ [STORAGE_KEY_TARGET_ROMANIZE_ENABLED]: persisted })
    .catch((e) => console.warn("[Loom] persist targetRomanizeEnabled:", e));
  rerunRomanizations();
}

export function setNativeRomanizeEnabled(v: boolean): void {
  nativeRomanizeEnabled = v;
  void browser.storage.local
    .set({ [STORAGE_KEY_NATIVE_ROMANIZE_ENABLED]: v })
    .catch((e) => console.warn("[Loom] persist nativeRomanizeEnabled:", e));
  rerunRomanizations();
}

/** Japanese long-vowel mode (macrons / doubled / unmarked).  Global,
    not per-layer — if both layers happen to be Japanese they share
    the mode.  Threaded through /romanize/batch's long_vowel_mode. */
export function setLongVowelMode(
  mode: "macrons" | "doubled" | "unmarked",
): void {
  if (!_VALID_LONG_VOWEL_MODES.has(mode)) return;
  longVowelMode = mode;
  void browser.storage.local
    .set({ [STORAGE_KEY_LONG_VOWEL_MODE]: mode })
    .catch((e) => console.warn("[Loom] persist longVowelMode:", e));
  rerunRomanizations();
}

/** Mirror of rerunAnnotations for the romanize surface.  Phonetic-
    system changes go through rerunAnnotations because they also
    drive romanization choice (Pinyin vs Zhuyin uses different output
    forms); we add rerunRomanizations to the same setters so the
    romanize maps stay in sync. */
function rerunRomanizations(): void {
  if (!latest || latest.status.kind !== "tracking") return;
  const status = latest.status;
  const targetEvents = latest.targetEvents;
  const nativeEvents = latest.nativeEvents ?? [];
  emit({
    ...latest,
    targetRomanizeEnabled: effectiveTargetRomanizeEnabled(status.targetLang),
    nativeRomanizeEnabled,
    longVowelMode,
    targetRomanizeMap: null,
    nativeRomanizeMap: null,
  });
  void fetchAllRomanizationsForLayers(
    targetEvents,
    nativeEvents,
    status.targetLang,
    status.nativeLang,
  );
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

async function loadRomanizationPrefs(): Promise<void> {
  if (romanizationPrefsLoaded) return;
  romanizationPrefsLoaded = true;
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEY_TARGET_ROMANIZE_ENABLED,
      STORAGE_KEY_NATIVE_ROMANIZE_ENABLED,
      STORAGE_KEY_LONG_VOWEL_MODE,
    ]);
    const tEnabled = result[STORAGE_KEY_TARGET_ROMANIZE_ENABLED];
    const nEnabled = result[STORAGE_KEY_NATIVE_ROMANIZE_ENABLED];
    const lvm = result[STORAGE_KEY_LONG_VOWEL_MODE];
    // New shape: { [family]: boolean }.  A legacy plain-boolean value is
    // intentionally DISCARDED — the old global setting leaked a Japanese
    // romaji-line choice onto Chinese / Korean; dropping it lets every
    // family fall back to its language-aware default (line on for Japanese
    // + pure-romanize scripts, off for Han / Hangul).
    if (tEnabled && typeof tEnabled === "object") {
      for (const [fam, val] of Object.entries(tEnabled)) {
        if (typeof val === "boolean") {
          targetRomanizeEnabledByFamily.set(fam, val);
        }
      }
    }
    if (typeof nEnabled === "boolean") nativeRomanizeEnabled = nEnabled;
    if (typeof lvm === "string" && _VALID_LONG_VOWEL_MODES.has(lvm)) {
      longVowelMode = lvm as "macrons" | "doubled" | "unmarked";
    }
  } catch (e) {
    console.warn("[Loom] failed to load romanization prefs:", e);
  }
}

// ---- Subscription API -----------------------------------------------

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  void loadNativeLangPref();
  void loadAnnotationPrefs();
  void loadRomanizationPrefs();
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
    any latched value (handles late subscribers) then on every update.

    Per-tab activation gate (5d-perf): the FIRST subscriber flips the
    activeSubscriberCount 0→1, ungating handleMessage to start
    processing MAIN's tracklists.  Sends request-tracklist so MAIN
    re-emits its cached payload (since previous tracklists arriving
    during dormant state were dropped).  The LAST unsubscribe (count
    1→0) re-gates handleMessage — dormant state again. */
export function subscribeToCaptions(listener: Listener): () => void {
  ensureInstalled();
  listeners.add(listener);
  const wasDormant = activeSubscriberCount === 0;
  activeSubscriberCount += 1;
  if (latest !== null) {
    listener(latest);
  }
  if (wasDormant) {
    // Going active.  Ask MAIN to re-emit its cached tracklist so we
    // pick up whatever was dropped while dormant.
    window.postMessage(
      { source: ISO_SOURCE, type: "request-tracklist" },
      location.origin,
    );
  }
  return () => {
    listeners.delete(listener);
    activeSubscriberCount = Math.max(0, activeSubscriberCount - 1);
    if (activeSubscriberCount === 0) {
      // Going dormant.  Abort any in-flight annotation / romanization
      // fetches so they don't continue burning CPU after the user
      // explicitly turned Loom off.
      annotateAbortController?.abort();
      romanizeAbortController?.abort();
    }
  };
}
