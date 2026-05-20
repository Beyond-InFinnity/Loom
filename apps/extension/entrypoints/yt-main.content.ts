// MAIN-world content script.  Reads YouTube's #movie_player to get the
// caption tracklist, then programmatically triggers YT's own caption
// fetch by toggling the CC button.  The background script's webRequest
// listener captures the resulting (pot-bearing) timedtext URL.  Once
// captured, the URL can be lang-swapped to fetch any track's events.
//
// MAIN script flow:
//   1. Wait for #movie_player to hydrate (poll for getPlayerResponse).
//   2. Read captionTracks[] from the response.
//   3. Click .ytp-subtitles-button ON to fire YT's tokenized fetch.
//   4. Brief delay so the fetch fires.
//   5. Click .ytp-subtitles-button OFF so YT's own captions don't show.
//   6. Post {tracks, videoId} to ISOLATED via window.postMessage.
//      The ISOLATED side (entrypoints/spike.content.ts) then talks to
//      the background script for the captured URL.
//
// MAIN has no browser.* APIs — dependency-free.

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 15_000;
const CC_FETCH_WAIT_MS = 600;
const MESSAGE_SOURCE = "loom-main";

interface CaptionTrackRaw {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string } | { runs?: Array<{ text: string }> };
}

interface CaptionTrackSerialized {
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
    console.log("[Loom MAIN] script loaded");

    let lastVideoId: string | null = null;

    async function run(): Promise<void> {
      const videoId = readVideoId();
      console.log("[Loom MAIN] run() for videoId =", videoId);

      const rawTracks = await pollForTracks();
      if (rawTracks === null) {
        console.warn("[Loom MAIN] poll timed out, no tracks");
        postPayload({ videoId, status: "no-tracks-found", tracks: [] });
        return;
      }

      const tracks = rawTracks
        .map(serializeTrack)
        .filter((t): t is CaptionTrackSerialized => t !== null);
      console.log("[Loom MAIN]", tracks.length, "tracks normalized");

      if (tracks.length === 0) {
        postPayload({ videoId, status: "no-captions", tracks });
        return;
      }

      // Trigger YouTube's own caption fetch by toggling CC on briefly.
      // The background script's webRequest listener captures the
      // resulting URL (with pot).
      const triggered = await triggerCaptionFetch();
      if (!triggered) {
        console.warn(
          "[Loom MAIN] could not find CC button to trigger fetch",
        );
        postPayload({ videoId, status: "no-cc-button", tracks });
        return;
      }
      console.log("[Loom MAIN] CC toggle complete; tracks posted");

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

    /** Toggle the CC button on, wait briefly for YT's fetch to fire,
        then toggle back off so the user doesn't see YT's captions.
        Returns true if the button was found + clicked. */
    async function triggerCaptionFetch(): Promise<boolean> {
      const btn = document.querySelector<HTMLElement>(
        ".ytp-subtitles-button",
      );
      if (!btn) return false;

      const wasOn = btn.getAttribute("aria-pressed") === "true";
      console.log("[Loom MAIN] CC button initial aria-pressed =", wasOn);

      if (!wasOn) {
        btn.click();
        console.log("[Loom MAIN] CC clicked ON");
        await sleep(CC_FETCH_WAIT_MS);
        btn.click();
        console.log("[Loom MAIN] CC clicked OFF");
      } else {
        // Captions already on (YT remembered from previous session).
        // YT may have already fetched on page load using cached
        // settings.  Toggle off then on to force a fresh fetch.
        console.log("[Loom MAIN] CC already on; toggling OFF→ON→OFF to force refetch");
        btn.click();
        await sleep(150);
        console.log("[Loom MAIN] CC clicked OFF (1/3)");
        btn.click();
        console.log("[Loom MAIN] CC clicked ON (2/3, expecting fetch)");
        await sleep(CC_FETCH_WAIT_MS);
        btn.click();
        console.log("[Loom MAIN] CC clicked OFF (3/3)");
      }
      return true;
    }

    function postPayload(payload: object): void {
      window.postMessage(
        { source: MESSAGE_SOURCE, type: "tracklist", ...payload },
        location.origin,
      );
    }

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
  return {
    languageCode: raw.languageCode,
    name: extractName(raw.name) ?? raw.languageCode,
    baseUrl: raw.baseUrl,
    kind: raw.kind === "asr" ? "asr" : "manual",
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
