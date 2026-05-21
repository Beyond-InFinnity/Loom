// Caption discovery — the ISOLATED-world coordinator for the
// MAIN/background/fanout dance.
//
// 5b architecture (verified 2026-05-20): MAIN reads tracklist + clicks
// CC.  Background captures the pot-bearing timedtext URL via webRequest.
// ISO polls background, lang-swaps the captured URL to fetch every
// language's events.
//
// 5c refinement (2026-05-20 evening): the spike showed YT fires MULTIPLE
// timedtext requests per video.  An early page-load PREFETCH carries a
// pot; the user's manual CC clicks fire later URLs WITHOUT pot.
// Last-write-wins picked the no-pot URLs and lang-swap returned empty
// bodies.  Two pieces of the fix live elsewhere — background returns
// the FIRST pot-bearing URL by firing order (lib/captions/url-picker.ts),
// and MAIN now posts the tracklist immediately rather than clicking
// unconditionally.  This module's job is:
//
//   1. Receive MAIN's tracklist message.
//   2. Auto-pick target + native tracks.
//   3. Poll background for a pot URL (relies on YT's natural prefetch)
//      for up to ~2000ms.
//   4. If no pot URL within that window, request a CC trigger from
//      MAIN via window.postMessage and poll again for ~4000ms.
//   5. Fan out lang-swap fetches.
//   6. Notify subscribers.
//
// The common case (YT prefetched the captions on page load) involves
// ZERO DOM interaction from us — no CC click, no button toggling.  The
// click is now a genuine fallback.

import { autoPickTrack } from "./auto-pick";
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
    because YT's fetch can take 600ms+ to fire after the click, and
    network latency on top of that. */
const TRIGGER_POLL_TIMEOUT_MS = 4000;
const NATIVE_LANG = "en";

interface MainTracklist {
  source: typeof MAIN_SOURCE;
  type: "tracklist";
  videoId: string | null;
  status: "ok" | "no-tracks-found" | "no-captions" | "no-cc-button";
  tracks: CaptionTrack[];
}

export interface CaptionPayload {
  videoId: string | null;
  /** Discriminator on outcome.  `tracking` = target + native events
      both populated; `unsupported` = no supported track for romanize
      (or no captions at all); `error` = something broke. */
  status:
    | { kind: "tracking"; targetLang: string; nativeLang: string }
    | { kind: "unsupported"; reason: "no-captions" | "no-supported-track" }
    | { kind: "error"; message: string };
  targetEvents: CaptionEvent[] | null;
  nativeEvents: CaptionEvent[] | null;
}

type Listener = (payload: CaptionPayload) => void;

let latest: CaptionPayload | null = null;
const listeners: Set<Listener> = new Set();
let installed = false;

function handleMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data as MainTracklist | undefined;
  if (!data || data.source !== MAIN_SOURCE) return;
  if (data.type !== "tracklist") return;
  processMainMessage(data).catch((e) => {
    console.error("[Loom] discover.processMainMessage threw:", e);
    emit({
      videoId: data.videoId,
      status: { kind: "error", message: String(e) },
      targetEvents: null,
      nativeEvents: null,
    });
  });
}

async function processMainMessage(data: MainTracklist): Promise<void> {
  console.log(
    "[Loom ISO] tracklist received: status =",
    data.status,
    "tracks =",
    data.tracks.length,
  );

  if (data.status === "no-tracks-found") {
    emit({
      videoId: data.videoId,
      status: {
        kind: "error",
        message: "MAIN couldn't read tracks from #movie_player",
      },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }
  if (data.status === "no-captions" || data.tracks.length === 0) {
    emit({
      videoId: data.videoId,
      status: { kind: "unsupported", reason: "no-captions" },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }
  if (data.status === "no-cc-button") {
    emit({
      videoId: data.videoId,
      status: {
        kind: "error",
        message: "CC button not found on this page (YT DOM change?)",
      },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }

  const target = autoPickTrack(data.tracks);
  if (target === null) {
    emit({
      videoId: data.videoId,
      status: { kind: "unsupported", reason: "no-supported-track" },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }

  // Native track: prefer a real en-family track from the tracklist
  // (lang-swap of the captured pot URL works for any listed track).
  // Fall back to tlang=en on the target only when no en track exists
  // (degraded — see tlang anomaly in memory note).
  const nativeTrack = findNativeTrack(data.tracks);

  // Phase 1: rely on YT's natural prefetch.  Background's picker
  // returns null until a pot-bearing URL has been captured.
  console.log("[Loom ISO] polling for pot URL (prefetch phase, up to",
    PREFETCH_POLL_TIMEOUT_MS, "ms)...");
  let capturedUrl = await pollBackgroundForUrl(
    data.videoId,
    PREFETCH_POLL_TIMEOUT_MS,
  );

  if (!capturedUrl) {
    // Phase 2: ask MAIN to click CC and trigger a fresh YT fetch.
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
    capturedUrl ? "URL captured, len=" + capturedUrl.length : "null (timeout)",
  );

  if (!capturedUrl) {
    emit({
      videoId: data.videoId,
      status: {
        kind: "error",
        message:
          "no pot-bearing timedtext URL captured (prefetch + trigger both failed)",
      },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }

  // Fan out: target track (native lang-swap) + native track (either
  // lang-swap of the native track, or tlang=en on target as fallback).
  const targetResultPromise = fetchTrackEventsViaSwap(capturedUrl, target);
  const nativeResultPromise = nativeTrack
    ? fetchTrackEventsViaSwap(capturedUrl, nativeTrack)
    : fetchTrackEventsViaSwap(capturedUrl, target, { tlang: NATIVE_LANG });

  const [targetResult, nativeResult] = await Promise.all([
    targetResultPromise,
    nativeResultPromise,
  ]);
  console.log(
    "[Loom ISO] fanout: target",
    target.languageCode,
    "→ bodyLen",
    targetResult.bodyLength,
    "events",
    targetResult.events?.length ?? 0,
    "err",
    targetResult.error ?? "—",
    "; native",
    nativeTrack?.languageCode ?? "tlang=en",
    "→ bodyLen",
    nativeResult.bodyLength,
    "events",
    nativeResult.events?.length ?? 0,
    "err",
    nativeResult.error ?? "—",
  );

  if (!targetResult.events || targetResult.events.length === 0) {
    emit({
      videoId: data.videoId,
      status: {
        kind: "error",
        message: `target fetch returned no events (bodyLen=${targetResult.bodyLength}, err=${targetResult.error ?? "none"})`,
      },
      targetEvents: null,
      nativeEvents: null,
    });
    return;
  }

  const nativeEvents = nativeResult.events ?? [];
  if (!nativeTrack && nativeEvents.length <= 1) {
    // tlang fallback path returned the known-degraded 1-event response.
    // Log but continue — target layer still works.
    console.warn(
      "[Loom] tlang=en fallback returned only",
      nativeEvents.length,
      "events; Bottom layer will be degraded",
    );
  }

  emit({
    videoId: data.videoId,
    status: {
      kind: "tracking",
      targetLang: target.languageCode,
      nativeLang: nativeTrack ? nativeTrack.languageCode : `${target.languageCode} → ${NATIVE_LANG}`,
    },
    targetEvents: targetResult.events,
    nativeEvents,
  });
}

function findNativeTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const matches = tracks.filter((t) => normalizeEn(t.languageCode));
  if (matches.length === 0) return null;
  const manual = matches.find((t) => t.kind === "manual");
  return manual ?? matches[0];
}

function normalizeEn(code: string): boolean {
  const c = code.toLowerCase();
  return c === "en" || c.startsWith("en-");
}

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

/** Tell MAIN to click .ytp-subtitles-button.  Used when YT's natural
    page-load prefetch didn't produce a pot URL — fallback only. */
function requestCcTrigger(): void {
  window.postMessage(
    { source: ISO_SOURCE, type: "trigger-cc" },
    location.origin,
  );
}

function emit(payload: CaptionPayload): void {
  latest = payload;
  for (const listener of listeners) {
    listener(payload);
  }
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("message", handleMessage);
  // Race-condition guard: MAIN content script + ISO content script
  // both run at document_idle in undefined order.  If MAIN finished
  // pollForTracks() and posted its tracklist BEFORE this listener was
  // installed (which happens whenever ISO's waitForElement +
  // shadow-root mount + React-effect chain is slower than MAIN's
  // poll), the message is lost.  Ask MAIN to re-emit; MAIN caches
  // its latest tracklist payload and replays on request.
  window.postMessage(
    { source: ISO_SOURCE, type: "request-tracklist" },
    location.origin,
  );
}

/** Install the window.message listener eagerly — call this from
    content.tsx BEFORE awaiting waitForElement(#movie_player) so the
    listener is in place by the time MAIN posts.  Safe to call
    multiple times (idempotent). */
export function installCaptionDiscovery(): void {
  ensureInstalled();
}

/** Subscribe to caption discovery results.  Listener is called
    synchronously for any already-latched value (handles late
    subscribers), then on every subsequent MAIN message. */
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
