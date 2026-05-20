// Caption discovery — the ISOLATED-world coordinator for the
// MAIN/background/fanout dance.  This is the "production" path now
// that the spike (2026-05-20) empirically verified that the pot is
// session-bound and one captured URL works for all tracks via
// lang-swap.  See memory/reference_youtube_caption_acquisition_2026.md.
//
// Flow on each YT page / SPA navigation:
//   1. MAIN (entrypoints/yt-main.content.ts) reads the tracklist via
//      #movie_player.getPlayerResponse() and toggles CC briefly to
//      make YT fire a tokenized timedtext request.  Posts a
//      "tracklist" message via window.postMessage.
//   2. Background (entrypoints/background.ts) sees the timedtext
//      request via webRequest and stashes the full URL keyed by
//      videoId.
//   3. THIS module receives the tracklist message, polls background
//      for the captured URL (with timeout), then fans out lang-swap
//      fetches via lib/captions/fanout.ts.
//   4. Auto-picks a target track from the configured preferred-langs.
//      Picks a native (Bottom) track — preferring a native "en" track
//      if available, falling back to tlang=en on the target as a
//      last resort (degraded — see tlang anomaly in memory note).
//   5. Notifies subscribers with the parsed event arrays.  The
//      React provider (components/caption-context.tsx) is the
//      primary subscriber and drives the CaptionStream.

import { autoPickTrack } from "./auto-pick";
import { fetchTrackEventsViaSwap } from "./fanout";
import type { CaptionEvent, CaptionTrack } from "./types";

const MESSAGE_SOURCE = "loom-main";
const URL_POLL_INTERVAL_MS = 200;
const URL_POLL_TIMEOUT_MS = 8000;
const NATIVE_LANG = "en";

interface MainTracklist {
  source: typeof MESSAGE_SOURCE;
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
  if (!data || data.source !== MESSAGE_SOURCE) return;
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

  // Pick a target track from our preferred-lang preference list.
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

  // Native track: prefer an actual native "en" track from the
  // tracklist (lang-swap of the captured URL — known to work).
  // Fall back to tlang=en on the target track only when no native en
  // track exists (note tlang anomaly: parser may only extract 1
  // event for tlang responses — see memory note).
  const nativeTrack = findNativeTrack(data.tracks);

  // Wait for background to have captured the URL after MAIN's CC click.
  console.log("[Loom ISO] polling background for URL...");
  const capturedUrl = await pollBackgroundForUrl(data.videoId);
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
          "background never captured a timedtext URL — webRequest didn't see YT's fetch",
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
  // Look for any en-family manual track first, then any en-family ASR.
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
): Promise<string | null> {
  if (!videoId) return null;
  const deadline = Date.now() + URL_POLL_TIMEOUT_MS;
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
