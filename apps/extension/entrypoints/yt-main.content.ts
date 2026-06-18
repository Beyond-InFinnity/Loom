// MAIN-world content script.  Reads YouTube's #movie_player tracklist
// and triggers YT's tokenized timedtext fetch on demand from ISO.
//
// 5b shipped: MAIN unconditionally clicked .ytp-subtitles-button
// OFF→ON→OFF to make YT fire a pot-bearing fetch.
//
// 5c (2026-05-20): the spike confirmed YT fires a natural page-load
// prefetch with pot at ~t=53ms — well before MAIN could click.  So
// the click is no longer unconditional; it's a fallback.  New flow:
//   1. Wait for #movie_player to hydrate.
//   2. Read captionTracks[].
//   3. Post tracklist to ISO immediately (no click).
//   4. ISO polls background for a pot URL.  If the natural prefetch
//      gave us one, ISO never needs anything else from MAIN.
//   5. If no pot URL appears within ~2000ms, ISO posts a
//      `loom-iso trigger-cc` message back.  MAIN listens, runs the
//      OFF→ON→OFF click sequence (existing logic), and YT fires a
//      fresh pot-bearing fetch.
//
// Bidirectional postMessage keeps MAIN dependency-free (no browser.*).

import { logDev } from "@/lib/env";

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 15_000;
const CC_FETCH_WAIT_MS = 600;
const MAIN_SOURCE = "loom-main";
const ISO_SOURCE = "loom-iso";

interface CaptionTrackRaw {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  /** YouTube's stable per-track id (".en", "a.en", ".en-US", …). */
  vssId?: string;
  name?: { simpleText?: string } | { runs?: Array<{ text: string }> };
}

interface CaptionTrackSerialized {
  id: string;
  languageCode: string;
  name: string;
  baseUrl: string;
  kind: "manual" | "asr";
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrackRaw[];
    };
  };
}

interface PlayerElement extends Element {
  getPlayerResponse?: () => PlayerResponse | undefined;
}

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*"],
  world: "MAIN",
  runAt: "document_idle",

  main() {
    logDev("[Loom MAIN] script loaded");

    let lastVideoId: string | null = null;
    let ccTriggerInFlight = false;
    // Latest tracklist payload we've posted.  ISO can ask us to
    // re-emit this if it subscribed too late to catch the original
    // postMessage (race between MAIN's pollForTracks completing and
    // ISO's waitForElement + shadow-root mount + React-effect chain).
    let latestPayload: object | null = null;
    // Dedup: ISO posts request-tracklist eagerly on install.  If we
    // hadn't posted yet, the request is a no-op; we post normally a
    // moment later.  But if we HAD already posted, we'd re-emit and
    // ISO would process the tracklist twice (running fanout twice +
    // stream.start twice with a stop in between, briefly nulling the
    // active caption).  Track whether we've already replied, and
    // skip subsequent re-emit requests until run() posts a NEW
    // payload (e.g., on yt-navigate-finish for a new video).
    let reemittedForCurrentPayload = false;

    async function run(): Promise<void> {
      const videoId = readVideoId();
      logDev("[Loom MAIN] run() for videoId =", videoId);

      const rawTracks = await pollForTracks();
      if (rawTracks === null) {
        console.warn("[Loom MAIN] poll timed out, no tracks");
        postPayload({ videoId, status: "no-tracks-found", tracks: [] });
        return;
      }

      const tracks = rawTracks
        .map(serializeTrack)
        .filter((t): t is CaptionTrackSerialized => t !== null);
      logDev("[Loom MAIN]", tracks.length, "tracks normalized");

      if (tracks.length === 0) {
        postPayload({ videoId, status: "no-captions", tracks });
        return;
      }

      // Post immediately — let ISO try the natural prefetch first.
      // If ISO needs us to click, it'll send `trigger-cc`.
      postPayload({ videoId, status: "ok", tracks });
    }

    async function pollForTracks(): Promise<CaptionTrackRaw[] | null> {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const player = document.querySelector<PlayerElement>("#movie_player");
        const fn = player?.getPlayerResponse;
        if (typeof fn === "function") {
          try {
            const response = fn.call(player);
            const tracks =
              response?.captions?.playerCaptionsTracklistRenderer
                ?.captionTracks;
            if (tracks !== undefined) return tracks ?? [];
          } catch {
            // continue polling
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
      return null;
    }

    /** Toggle the CC button.  Same shape as the 5b implementation —
        OFF→ON→OFF if it starts off, ON→OFF→ON→OFF if it starts on.
        Returns true if the button was found + clicked. */
    async function triggerCaptionFetch(): Promise<boolean> {
      const btn = document.querySelector<HTMLElement>(
        ".ytp-subtitles-button",
      );
      if (!btn) {
        console.warn("[Loom MAIN] CC button not found");
        return false;
      }

      const wasOn = btn.getAttribute("aria-pressed") === "true";
      logDev("[Loom MAIN] CC button initial aria-pressed =", wasOn);

      if (!wasOn) {
        btn.click();
        logDev("[Loom MAIN] CC clicked ON");
        await sleep(CC_FETCH_WAIT_MS);
        btn.click();
        logDev("[Loom MAIN] CC clicked OFF");
      } else {
        // Captions already on (YT remembered from previous session).
        // Toggle off then on to force a fresh fetch.
        logDev("[Loom MAIN] CC already on; toggling OFF→ON→OFF to force refetch");
        btn.click();
        await sleep(150);
        logDev("[Loom MAIN] CC clicked OFF (1/3)");
        btn.click();
        logDev("[Loom MAIN] CC clicked ON (2/3, expecting fetch)");
        await sleep(CC_FETCH_WAIT_MS);
        btn.click();
        logDev("[Loom MAIN] CC clicked OFF (3/3)");
      }
      return true;
    }

    function postPayload(payload: object): void {
      const fullPayload = { source: MAIN_SOURCE, type: "tracklist", ...payload };
      latestPayload = fullPayload;
      reemittedForCurrentPayload = false;
      window.postMessage(fullPayload, location.origin);
      logDev("[Loom MAIN] tracklist posted");
    }

    // Listen for messages from ISO:
    //   - trigger-cc: ISO's 2000ms prefetch-poll came up empty; click
    //     CC to provoke a fresh YT timedtext fetch.
    //   - request-tracklist: ISO subscribed late and missed our
    //     original postPayload.  Re-emit the cached payload so the
    //     ISO flow can continue.
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data as
        | { source?: string; type?: string }
        | undefined;
      if (!data || data.source !== ISO_SOURCE) return;

      if (data.type === "trigger-cc") {
        if (ccTriggerInFlight) {
          logDev("[Loom MAIN] trigger-cc already in flight; ignoring");
          return;
        }
        ccTriggerInFlight = true;
        logDev("[Loom MAIN] ISO requested CC trigger");
        triggerCaptionFetch().finally(() => {
          ccTriggerInFlight = false;
        });
        return;
      }

      if (data.type === "request-tracklist") {
        if (latestPayload && !reemittedForCurrentPayload) {
          logDev("[Loom MAIN] ISO requested tracklist re-emit");
          reemittedForCurrentPayload = true;
          window.postMessage(latestPayload, location.origin);
        }
        // No-op if we haven't posted yet (the normal postPayload at
        // the end of run() will deliver to ISO's now-installed
        // listener) or if we've already re-emitted this payload once
        // (avoids the double-start cycle observed during 5c testing).
        return;
      }
    });

    function readVideoId(): string | null {
      try {
        return new URL(location.href).searchParams.get("v");
      } catch {
        return null;
      }
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    run();

    document.addEventListener("yt-navigate-finish", () => {
      const newVideoId = readVideoId();
      if (newVideoId !== null && newVideoId !== lastVideoId) {
        lastVideoId = newVideoId;
        run();
      } else if (newVideoId === null) {
        lastVideoId = null;
      }
    });

    lastVideoId = readVideoId();
  },
});

function serializeTrack(raw: CaptionTrackRaw): CaptionTrackSerialized | null {
  if (!raw.baseUrl || !raw.languageCode) return null;
  const kind = raw.kind === "asr" ? "asr" : "manual";
  return {
    // vssId is YouTube's stable per-track id; fall back to lang+kind
    // (rare to have two same-(lang,kind) tracks without a vssId).
    id: raw.vssId || `${raw.languageCode}::${kind}`,
    languageCode: raw.languageCode,
    name: extractName(raw.name) ?? raw.languageCode,
    baseUrl: raw.baseUrl,
    kind,
  };
}

function extractName(
  name:
    | { simpleText?: string }
    | { runs?: Array<{ text: string }> }
    | undefined,
): string | null {
  if (!name) return null;
  if ("simpleText" in name && name.simpleText) return name.simpleText;
  if ("runs" in name && name.runs) {
    return name.runs.map((r) => r.text).join("");
  }
  return null;
}
